import { createHash } from "node:crypto";
import { categorySerpQuery, CATEGORY_ANY } from "../../shared/categories.js";
import type { SearchCriteria } from "../../shared/types.js";
import { boundsCenter, zoomForBounds, zoomForRadius } from "../../shared/geo.js";
import type { AppConfig } from "../config.js";
import { SourceError } from "../errors.js";
import { requestJson } from "./http.js";
import type {
  ParseRejections,
  ParsedPlace,
  ParsedReview,
  SerpApiDetailsResult,
  SerpApiReviewsResult,
  SourceSearchPage,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function safeHttpUrl(value: unknown): string | null {
  const text = asString(value);
  if (!text || !/^https?:\/\//i.test(text)) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function searchQuery(criteria: SearchCriteria): string {
  const category = criteria.category === CATEGORY_ANY ? "" : categorySerpQuery(criteria.category);
  const keyword = criteria.keyword.trim();
  if (keyword && category) return `${keyword} ${category}`;
  return keyword || category || "places";
}

function parseCoordinates(record: JsonRecord): { lat: number; lon: number } | null {
  const gps = asRecord(record.gps_coordinates) ?? asRecord(record.coordinates);
  const lat = asNumber(gps?.latitude ?? record.latitude);
  const lon = asNumber(gps?.longitude ?? record.longitude);
  if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

function parseDescription(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  const record = asRecord(value);
  return asString(record?.text ?? record?.snippet);
}

/**
 * SerpApi returns `hours` either as a flat string, as a weekly object of
 * `{ "Monday": "9 AM–5 PM", ... }`, or as `{ [day]: { open, close } }` pairs,
 * and it reports when the schedule was last verified in `hours_last_updated`
 * (a string like "Monday, 12:00 AM" or an object with a raw timestamp).
 *
 * Weekly object forms are normalized into a stable `{ days: [...] }` shape so
 * the UI can render a per-day chart. Normalization is confined to this field:
 * it only re-labels known day keys and re-orders them Monday-first, and every
 * value is still copied from the provider verbatim (a day is never invented,
 * and nothing is coerced into a schedule it did not return). A flat string is
 * kept as a string because there is no day structure to chart.
 */
function parseHours(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  const record = asRecord(value);
  if (!record) return Array.isArray(value) ? value : null;
  const daysByName = new Map<WeekDay, unknown>();
  for (const key of Object.keys(record)) {
    const day = normalizeDayKey(key);
    if (day && !daysByName.has(day)) daysByName.set(day, record[key]);
  }
  if (daysByName.size !== 7) return record;
  const days = [...daysByName.entries()]
    .map(([day, hours]) => ({ day, hours }))
    .sort((a, b) => DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day));
  return { days };
}

const DAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
type WeekDay = (typeof DAY_ORDER)[number];

function normalizeDayKey(key: string): WeekDay | null {
  const normalized = key.trim().toLowerCase().slice(0, 3);
  const match = DAY_ORDER.find((day) => day.toLowerCase().startsWith(normalized) && normalized.length === 3);
  return match ?? null;
}

function parseHoursLastUpdated(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  return asRecord(value) ?? (Array.isArray(value) ? value : null);
}

/**
 * `popular_times` is a nested hourly busyness graph. Array/object payloads are
 * preserved verbatim; anything else is treated as absent rather than coerced,
 * because a malformed busyness graph is worse than an explicit absence.
 */
function parsePopularTimes(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  return asRecord(value) ?? (Array.isArray(value) ? value : null);
}

/**
 * `at_this_place` is a list of in-place offerings (e.g. dine-in, takeout) that
 * SerpApi may return as strings, objects, or a mix. Normalize to strings when
 * they are simple, otherwise keep the raw entries.
 */
function parseAtThisPlace(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.trim() || null;
  return asRecord(value);
}

/** `location_summary` may be a plain string or a structured summary object. */
function parseLocationSummary(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  return asRecord(value) ?? (Array.isArray(value) ? value : null);
}

function placeRejection(record: JsonRecord): keyof ParseRejections | null {
  if (!asString(record.title ?? record.name)) return "missingName";
  if (!parseCoordinates(record)) return "unusableCoordinates";
  if (!asString(record.place_id) && !asString(record.data_id) && !asString(record.data_cid)) {
    return "missingIdentifier";
  }
  return null;
}

function parsePlace(record: JsonRecord, retrievedAt: string): ParsedPlace | null {
  const name = asString(record.title ?? record.name);
  const coordinates = parseCoordinates(record);
  if (!name || !coordinates) return null;
  const placeId = asString(record.place_id);
  const dataId = asString(record.data_id);
  const dataCid = asString(record.data_cid);
  const identifier = placeId
    ? `place_id:${placeId}`
    : dataId
      ? `data_id:${dataId}`
      : dataCid
        ? `data_cid:${dataCid}`
        : null;
  if (!identifier) return null;

  const address = asString(record.address);
  const category = asString(record.type) ?? asString(record.category);
  const website = safeHttpUrl(record.website ?? record.website_url);
  const phone = asString(record.phone ?? record.phone_number);
  const hours = parseHours(record.hours);
  const hoursLastUpdated = parseHoursLastUpdated(record.hours_last_updated);
  const popularTimes = parsePopularTimes(record.popular_times);
  const locationSummary = parseLocationSummary(record.location_summary);
  const atThisPlace = parseAtThisPlace(record.at_this_place);
  const price = asString(record.price);
  const description = parseDescription(record.description);
  const rating = asNumber(record.rating);
  const reviews = asNumber(record.reviews ?? record.review_count);
  const openState = asString(record.open_state);
  const types = Array.isArray(record.types)
    ? record.types.filter((value): value is string => typeof value === "string")
    : null;
  const serviceOptions = asRecord(record.service_options);
  const accessibility = asRecord(record.accessibility);
  const sourceUrl = placeId
    ? `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`
    : null;

  const fields: Record<string, unknown> = {
    place_id: placeId,
    data_id: dataId,
    data_cid: dataCid,
    rating,
    reviews,
    price,
    open_state: openState,
    hours,
    hours_last_updated: hoursLastUpdated,
    popular_times: popularTimes,
    location_summary: locationSummary,
    at_this_place: atThisPlace,
    website,
    phone,
    description,
    types,
    provider_id: asString(record.provider_id),
    service_options: serviceOptions,
    accessibility,
    place_topics: record.place_topics ?? null,
  };
  for (const key of Object.keys(fields)) {
    if (fields[key] === null || fields[key] === undefined) delete fields[key];
  }

  const provenance: ParsedPlace["provenance"] = {
    name: { source: "serpapi", retrievedAt },
    ...(address ? { address: { source: "serpapi", retrievedAt } } : {}),
    ...(category ? { category: { source: "serpapi", retrievedAt } } : {}),
    lat: { source: "serpapi", retrievedAt },
    lon: { source: "serpapi", retrievedAt },
  };
  for (const key of ["website", "phone", "hours", "hours_last_updated", "popular_times", "location_summary", "at_this_place", "rating", "reviews", "price", "description", "place_topics"]) {
    if (fields[key] !== undefined) provenance[key] = { source: "serpapi", retrievedAt };
  }

  return {
    source: "serpapi",
    sourceType: "serpapi",
    sourceId: identifier,
    sourceUrl,
    name,
    address,
    category,
    lat: coordinates.lat,
    lon: coordinates.lon,
    fields,
    provenance,
    detailsStatus: "not_fetched",
  };
}

function pageFingerprint(records: JsonRecord[]): string {
  const ids = records
    .map((record) => asString(record.place_id ?? record.data_id ?? record.data_cid ?? record.title) ?? "")
    .join("|");
  return createHash("sha256").update(ids || JSON.stringify(records).slice(0, 20_000)).digest("hex");
}

export function buildSerpApiSearchParams(
  criteria: SearchCriteria,
  page: number,
  appConfig: AppConfig,
): URLSearchParams {
  const center = criteria.center ?? (criteria.bounds ? boundsCenter(criteria.bounds) : null);
  if (!center) throw new SourceError("invalid_area", "SerpApi search requires a center point");
  const countryCode = criteria.countryCode?.trim();
  if (!countryCode) {
    throw new SourceError(
      "country_required",
      "Select a country before using SerpApi discovery. This sets the Google Maps search locale and prevents results from the wrong country.",
    );
  }
  const zoom =
    criteria.mode === "boundary" && criteria.bounds
      ? zoomForBounds(criteria.bounds)
      : zoomForRadius(criteria.radiusMeters);
  const params = new URLSearchParams();
  params.set("engine", "google_maps");
  params.set("type", "search");
  params.set("q", searchQuery(criteria));
  params.set("ll", `@${center.lat.toFixed(6)},${center.lon.toFixed(6)},${zoom}z`);
  params.set("start", String(page * 20));
  params.set("hl", appConfig.serpapi.hl);
  params.set("gl", countryCode.toLowerCase());
  params.set("google_domain", "google.com");
  return params;
}

export async function searchSerpApiPage(
  criteria: SearchCriteria,
  page: number,
  appConfig: AppConfig,
): Promise<SourceSearchPage> {
  if (!appConfig.serpapi.apiKey) {
    throw new SourceError("not_configured", "SerpApi is not configured on this server");
  }
  const params = buildSerpApiSearchParams(criteria, page, appConfig);
  const sanitizedParams = Object.fromEntries(params.entries());
  const url = new URL(appConfig.serpapi.baseUrl);
  for (const [key, value] of params.entries()) url.searchParams.set(key, value);
  url.searchParams.set("api_key", appConfig.serpapi.apiKey);

  const response = await requestJson(url.toString(), {
    headers: { Accept: "application/json", "User-Agent": "PlacesDiscovery/1.0" },
    timeoutMs: appConfig.serpapi.timeoutMs,
    // Each provider dispatch may consume a credit; the runner reserves one per page.
    retries: 0,
  });
  const data = asRecord(response.data);
  if (!data) throw new SourceError("invalid_response", "SerpApi returned an unexpected response");
  const metadata = asRecord(data.search_metadata);
  const emptySuccess = metadata?.status === "Success" && data.local_results_state === "Fully empty";
  if (typeof data.error === "string" && !emptySuccess) {
    throw new SourceError("serpapi_error", `SerpApi error: ${data.error.slice(0, 300)}`);
  }

  const localResults = Array.isArray(data.local_results)
    ? data.local_results.filter((item): item is JsonRecord => asRecord(item) !== null)
    : [];
  const malformedRecords = Array.isArray(data.local_results) ? data.local_results.length - localResults.length : 0;
  const placeResults = asRecord(data.place_results);
  const rawRecords = placeResults ? [placeResults, ...localResults] : localResults;
  const retrievedAt = new Date().toISOString();
  const parseRejections: ParseRejections = {
    unusableCoordinates: 0,
    missingName: 0,
    missingIdentifier: 0,
    other: malformedRecords,
  };
  const parsed: ParsedPlace[] = [];
  for (const record of rawRecords) {
    const reason = placeRejection(record);
    if (reason) {
      parseRejections[reason]++;
      continue;
    }
    const place = parsePlace(record, retrievedAt);
    if (place) parsed.push(place);
    else parseRejections.other++;
  }
  const pagination = asRecord(data.serpapi_pagination);
  const hasNext = !emptySuccess && Boolean(pagination?.next);
  const nextPageToken = asString(pagination?.next_page_token);

  return {
    places: parsed,
    returned: rawRecords.length + malformedRecords,
    parseRejections,
    hasNext,
    pageFingerprint: pageFingerprint(rawRecords),
    sanitizedParams,
    nextPageToken,
  };
}

function normalizedDetailFields(record: JsonRecord): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const candidates: Array<[string, unknown]> = [
    ["place_id", record.place_id],
    ["data_id", record.data_id],
    ["data_cid", record.data_cid],
    ["provider_id", record.provider_id],
    ["rating", asNumber(record.rating)],
    ["reviews", asNumber(record.reviews)],
    ["price", asString(record.price)],
    ["open_state", asString(record.open_state)],
    ["hours", parseHours(record.hours)],
    ["hours_last_updated", parseHoursLastUpdated(record.hours_last_updated)],
    ["website", safeHttpUrl(record.website ?? record.website_url)],
    ["phone", asString(record.phone ?? record.phone_number)],
    ["description", parseDescription(record.description)],
    ["types", Array.isArray(record.types) ? record.types.filter((v): v is string => typeof v === "string") : null],
    ["service_options", asRecord(record.service_options)],
    ["accessibility", asRecord(record.accessibility)],
    ["place_topics", record.place_topics ?? null],
    ["popular_times", parsePopularTimes(record.popular_times)],
    ["location_summary", parseLocationSummary(record.location_summary)],
    ["at_this_place", parseAtThisPlace(record.at_this_place)],
  ];
  for (const [key, value] of candidates) {
    if (value !== null && value !== undefined && value !== "") fields[key] = value;
  }
  return fields;
}

export async function getSerpApiDetails(
  fields: Record<string, unknown>,
  appConfig: AppConfig,
): Promise<SerpApiDetailsResult> {
  if (!appConfig.serpapi.apiKey) {
    throw new SourceError("not_configured", "SerpApi is not configured on this server");
  }
  const placeId = asString(fields.place_id);
  const dataId = asString(fields.data_id);
  const dataCid = asString(fields.data_cid);
  const params = new URLSearchParams({
    engine: "google_maps",
    type: "place",
    hl: appConfig.serpapi.hl,
  });
  if (placeId) params.set("place_id", placeId);
  else if (dataId) params.set("data_id", dataId);
  else if (dataCid) params.set("data_cid", dataCid);
  else {
    throw new SourceError(
      "missing_place_id",
      "This record has no place_id, data_id, or data_cid, so on-demand place details are unavailable.",
    );
  }
  const url = new URL(appConfig.serpapi.baseUrl);
  for (const [key, value] of params.entries()) url.searchParams.set(key, value);
  url.searchParams.set("api_key", appConfig.serpapi.apiKey);
  const response = await requestJson(url.toString(), {
    headers: { Accept: "application/json", "User-Agent": "PlacesDiscovery/1.0" },
    timeoutMs: appConfig.serpapi.timeoutMs,
    // Each dispatch may be billable; callers reserve only one credit.
    retries: 0,
  });
  const data = asRecord(response.data);
  if (!data) throw new SourceError("invalid_response", "SerpApi returned an unexpected response");
  if (typeof data.error === "string") {
    throw new SourceError("serpapi_error", `SerpApi error: ${data.error.slice(0, 300)}`);
  }
  const record = asRecord(data.place_results) ?? asRecord((Array.isArray(data.local_results) ? data.local_results[0] : null));
  if (!record) throw new SourceError("not_found", "SerpApi did not return details for this place");
  const retrievedAt = new Date().toISOString();
  const normalized = normalizedDetailFields(record);
  const coords = parseCoordinates(record);
  const provenance: SerpApiDetailsResult["provenance"] = {};
  for (const key of Object.keys(normalized)) {
    provenance[key] = { source: "serpapi", retrievedAt };
  }
  return {
    fields: normalized,
    provenance,
    name: asString(record.title ?? record.name) ?? "",
    address: asString(record.address),
    category: asString(record.type) ?? asString(record.category),
    lat: coords?.lat ?? null,
    lon: coords?.lon ?? null,
  };
}

export async function getSerpApiReviews(
  fields: Record<string, unknown>,
  page: number,
  nextPageToken: string | null,
  appConfig: AppConfig,
): Promise<SerpApiReviewsResult> {
  if (!appConfig.serpapi.apiKey) {
    throw new SourceError("not_configured", "SerpApi is not configured on this server");
  }
  const dataId = asString(fields.data_id);
  const placeId = asString(fields.place_id);
  if (!dataId && !placeId) {
    throw new SourceError("missing_identifier", "This record has no SerpApi identifier for reviews.");
  }
  const params = new URLSearchParams({ engine: "google_maps_reviews", hl: appConfig.serpapi.hl });
  if (dataId) params.set("data_id", dataId);
  else if (placeId) params.set("place_id", placeId);
  if (nextPageToken) params.set("next_page_token", nextPageToken);
  const url = new URL(appConfig.serpapi.baseUrl);
  for (const [key, value] of params.entries()) url.searchParams.set(key, value);
  url.searchParams.set("api_key", appConfig.serpapi.apiKey);
  const response = await requestJson(url.toString(), {
    headers: { Accept: "application/json", "User-Agent": "PlacesDiscovery/1.0" },
    timeoutMs: appConfig.serpapi.timeoutMs,
    // Each dispatch may be billable; callers reserve only one credit.
    retries: 0,
  });
  const data = asRecord(response.data);
  if (!data) throw new SourceError("invalid_response", "SerpApi returned an unexpected response");
  if (typeof data.error === "string") {
    throw new SourceError("serpapi_error", `SerpApi error: ${data.error.slice(0, 300)}`);
  }
  const rawReviews = Array.isArray(data.reviews)
    ? data.reviews.filter((review): review is JsonRecord => asRecord(review) !== null)
    : [];
  const reviews: ParsedReview[] = rawReviews.map((review, index) => {
    const user = asRecord(review.user);
    const authorName = asString(user?.name);
    const dateText = asString(review.date);
    const snippet = asString(review.snippet ?? review.extracted_snippet);
    const rating = asNumber(review.rating);
    const likes = asNumber(review.likes);
    const originalId = asString(review.review_id);
    const reviewKey =
      originalId ??
      createHash("sha256")
        .update(`${authorName ?? ""}|${dateText ?? ""}|${snippet ?? ""}|${index}`)
        .digest("hex")
        .slice(0, 32);
    return { reviewKey, authorName, rating, dateText, snippet, likes };
  });
  const pagination = asRecord(data.serpapi_pagination);
  return {
    reviews,
    hasNext: Boolean(pagination?.next) || Boolean(pagination?.next_page_token),
    nextPageToken: asString(pagination?.next_page_token),
    sanitizedParams: {
      engine: "google_maps_reviews",
      page,
      hasDataId: Boolean(dataId),
      hasPlaceId: Boolean(placeId),
    },
  };
}

import { getCategory } from "../../shared/categories.js";
import type { Bounds, SearchCriteria } from "../../shared/types.js";
import type { AppConfig } from "../config.js";
import { SourceError } from "../errors.js";
import { requestJson } from "./http.js";
import type { OsmSearchResult, ParseRejections, ParsedPlace } from "./types.js";

interface OsmElement {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OsmElement[];
  remark?: string;
  osm3s?: { timestamp_osm_base?: string };
}

function overpassString(value: string): string {
  return [...value].slice(0, 100).map((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? " " : character)
    .join("")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
}

function areaFilter(criteria: SearchCriteria): string {
  if (criteria.mode === "boundary") {
    const relationId = criteria.boundary?.osmRelationId;
    if (relationId) return `(area.searchBoundary)`;
    if (criteria.bounds) {
      const b = criteria.bounds;
      return `(${b.south},${b.west},${b.north},${b.east})`;
    }
    if (criteria.center) {
      return `(around:${Math.round(criteria.radiusMeters)},${criteria.center.lat},${criteria.center.lon})`;
    }
    throw new SourceError("invalid_area", "OpenStreetMap boundary search needs a resolved boundary or center");
  }
  if (criteria.mode === "area" && criteria.bounds) {
    const b: Bounds = criteria.bounds;
    return `(${b.south},${b.west},${b.north},${b.east})`;
  }
  if (!criteria.center) throw new SourceError("invalid_area", "OpenStreetMap search requires a center point");
  return `(around:${Math.round(criteria.radiusMeters)},${criteria.center.lat},${criteria.center.lon})`;
}

export function buildOverpassQuery(criteria: SearchCriteria, maxResults: number): string {
  const area = areaFilter(criteria);
  const category = getCategory(criteria.category);
  const keyword = criteria.keyword.trim();
  const parts: string[] = [];

  if (category) {
    for (const tag of category.osm) {
      if (keyword) {
        parts.push(`nwr["${tag.key}"="${tag.value}"]["name"~"${overpassString(keyword)}",i]${area};`);
        parts.push(`nwr["${tag.key}"="${tag.value}"]["brand"~"${overpassString(keyword)}",i]${area};`);
      } else {
        parts.push(`nwr["${tag.key}"="${tag.value}"]${area};`);
      }
    }
  } else if (keyword) {
    parts.push(`nwr["name"~"${overpassString(keyword)}",i]${area};`);
    parts.push(`nwr["brand"~"${overpassString(keyword)}",i]${area};`);
  } else {
    throw new SourceError("invalid_query", "Add a keyword or category for OpenStreetMap");
  }

  const relationId = criteria.mode === "boundary" ? criteria.boundary?.osmRelationId : null;
  const boundarySetup = relationId
    ? `rel(${relationId});map_to_area->.searchBoundary;\n(.searchBoundary;);out ids;\n`
    : "";
  const timeout = criteria.mode === "boundary" ? 45 : 25;
  return `[out:json][timeout:${timeout}][maxsize:536870912];\n${boundarySetup}(\n  ${parts.join("\n  ")}\n);\nout center tags ${Math.max(10, Math.min(maxResults, 2000))};`;
}

function humanize(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function deriveCategory(tags: Record<string, string>): string | null {
  const ordered = ["amenity", "shop", "tourism", "leisure", "office", "healthcare"];
  for (const key of ordered) {
    const value = tags[key];
    if (value) return humanize(value);
  }
  if (tags.religion) return `${humanize(tags.religion)} place of worship`;
  return null;
}

function buildAddress(tags: Record<string, string>): string | null {
  const pieces = [
    [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" "),
    tags["addr:neighbourhood"],
    tags["addr:suburb"],
    tags["addr:city"] ?? tags["addr:town"] ?? tags["addr:village"],
    tags["addr:district"],
    tags["addr:postcode"],
  ].filter((piece) => typeof piece === "string" && piece.trim().length > 0);
  if (pieces.length === 0) return null;
  return pieces.join(", ");
}

function firstTag(tags: Record<string, string>, keys: string[]): string | null {
  for (const key of keys) {
    const value = tags[key];
    if (value && value.trim()) return value.trim();
  }
  return null;
}

function asOsmElement(value: unknown): OsmElement | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as OsmElement : null;
}

function osmRejection(element: OsmElement): keyof ParseRejections | null {
  const tags = element.tags;
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) return "missingName";
  const name = tags.name ?? tags.brand ?? tags.operator ?? "";
  if (typeof name !== "string" || !name.trim()) return "missingName";
  const center = element.center && typeof element.center === "object" ? element.center : null;
  const lat = center?.lat ?? element.lat;
  const lon = center?.lon ?? element.lon;
  if (typeof lat !== "number" || typeof lon !== "number" ||
    !Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return "unusableCoordinates";
  }
  if (element.type !== undefined && !["node", "way", "relation"].includes(element.type)) return "other";
  if (typeof element.id !== "number" || !Number.isFinite(element.id)) return "missingIdentifier";
  return null;
}

function validHttpUrl(value: string | null): string | null {
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function parseOsmElement(element: OsmElement, retrievedAt: string): ParsedPlace | null {
  if (osmRejection(element)) return null;
  const tags = element.tags ?? {};
  const name = (tags.name ?? tags.brand ?? tags.operator ?? "").trim();
  if (!name) return null;
  const lat = element.center?.lat ?? element.lat;
  const lon = element.center?.lon ?? element.lon;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const type = element.type ?? "node";
  if (!["node", "way", "relation"].includes(type)) return null;
  if (typeof element.id !== "number") return null;

  const website = validHttpUrl(firstTag(tags, ["website", "contact:website", "url"]));
  const phone = firstTag(tags, ["phone", "contact:phone", "contact:mobile"]);
  const hours = firstTag(tags, ["opening_hours"]);
  const description = firstTag(tags, ["description", "note"]);
  const wheelchair = firstTag(tags, ["wheelchair"]);
  const category = deriveCategory(tags);
  const address = buildAddress(tags);
  const provenance = {
    name: { source: "osm" as const, retrievedAt },
    ...(address ? { address: { source: "osm" as const, retrievedAt } } : {}),
    ...(category ? { category: { source: "osm" as const, retrievedAt } } : {}),
    lat: { source: "osm" as const, retrievedAt },
    lon: { source: "osm" as const, retrievedAt },
    ...(website ? { website: { source: "osm" as const, retrievedAt } } : {}),
    ...(phone ? { phone: { source: "osm" as const, retrievedAt } } : {}),
    ...(hours ? { hours: { source: "osm" as const, retrievedAt } } : {}),
  };

  return {
    source: "osm",
    sourceType: `osm_${type}`,
    sourceId: String(element.id),
    sourceUrl: `https://www.openstreetmap.org/${type}/${element.id}`,
    name,
    address,
    category,
    lat,
    lon,
    detailsStatus: "fetched",
    fields: {
      tags,
      website,
      phone,
      hours,
      description,
      cuisine: firstTag(tags, ["cuisine"]),
      brand: firstTag(tags, ["brand"]),
      operator: firstTag(tags, ["operator"]),
      wheelchair,
      services: {
        takeaway: tags.takeaway ?? null,
        delivery: tags.delivery ?? null,
        outdoor_seating: tags.outdoor_seating ?? null,
        reservations: tags.reservation ?? null,
      },
      accessibility: {
        wheelchair: wheelchair ?? null,
        toilets_wheelchair: tags["toilets:wheelchair"] ?? null,
      },
      osmTimestamp: null,
    },
    provenance,
  };
}

export async function searchOsm(criteria: SearchCriteria, appConfig: AppConfig): Promise<OsmSearchResult> {
  const query = buildOverpassQuery(criteria, appConfig.osm.maxResults);
  const body = `data=${encodeURIComponent(query)}`;
  const response = await requestJson(appConfig.osm.overpassUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": appConfig.osm.userAgent,
    },
    body,
    timeoutMs: criteria.mode === "boundary" ? Math.max(appConfig.osm.timeoutMs, 55_000) : appConfig.osm.timeoutMs,
    retries: 1,
  });
  const data = response.data as OverpassResponse;
  if (!data || typeof data !== "object" || !Array.isArray(data.elements)) {
    throw new SourceError("invalid_response", "OpenStreetMap returned an unexpected response");
  }
  if (data.remark && /error|timeout|memory/i.test(data.remark)) {
    throw new SourceError("overpass_error", `OpenStreetMap query was incomplete: ${data.remark.slice(0, 240)}`);
  }
  const areaId = criteria.mode === "boundary" && criteria.boundary?.osmRelationId
    ? 3_600_000_000 + criteria.boundary.osmRelationId
    : null;
  if (areaId !== null && !data.elements.some((element) => element?.type === "area" && element.id === areaId)) {
    throw new SourceError("osm_area_unavailable", "OpenStreetMap has not generated an area for this relation; retry as a map rectangle or use SerpApi's approximate search.");
  }
  const returnedElements = data.elements.filter((element) => areaId === null || element?.type !== "area" || element.id !== areaId);
  const retrievedAt = new Date().toISOString();
  const osmTimestamp = data.osm3s?.timestamp_osm_base ?? null;
  const parseRejections: ParseRejections = {
    unusableCoordinates: 0,
    missingName: 0,
    missingIdentifier: 0,
    other: 0,
  };
  const places: ParsedPlace[] = [];
  for (const value of returnedElements) {
    const element = asOsmElement(value);
    if (!element) {
      parseRejections.other++;
      continue;
    }
    const reason = osmRejection(element);
    if (reason) {
      parseRejections[reason]++;
      continue;
    }
    const place = parseOsmElement(element, retrievedAt);
    if (place) places.push(place);
    else parseRejections.other++;
  }
  for (const place of places) {
    place.fields.osmTimestamp = osmTimestamp;
  }
  return {
    places,
    returned: returnedElements.length,
    parseRejections,
    capped: returnedElements.length >= Math.max(10, Math.min(appConfig.osm.maxResults, 2000)),
    sanitizedParams: {
      engine: "overpass",
      query,
      area: criteria.mode,
      radiusMeters: criteria.radiusMeters,
      maxResults: appConfig.osm.maxResults,
    },
    osmTimestamp,
  };
}

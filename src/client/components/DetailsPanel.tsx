import { useEffect, useRef, useState } from "react";
import type { Collection, Place, PlaceReviewPage, SavedPlace } from "../../shared/types.js";
import { api, ApiError } from "../api.js";
import { formatDateTime, formatDistance } from "../format.js";
import { Badge, Spinner } from "./Feedback.js";

interface DetailsPanelProps {
  placeId: string;
  savedPlaces: SavedPlace[];
  collections: Collection[];
  reviewsEnabled: boolean;
  onClose: () => void;
  onChanged: () => void;
  onNotify: (kind: "info" | "success" | "error", message: string) => void;
  onOpenDuplicates: () => void;
  onSearchHere: (place: Place) => void;
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
type Weekday = (typeof WEEKDAYS)[number];

function weekdayName(value: string): Weekday | null {
  const key = value.trim().toLowerCase();
  const match = WEEKDAYS.find((day) => day.toLowerCase() === key || day.slice(0, 3).toLowerCase() === key);
  return match ?? null;
}

function hoursEntries(value: unknown): Array<{ day: Weekday; value: unknown }> {
  let entries: Array<{ day: string; value: unknown }> = [];
  if (Array.isArray(value)) {
    entries = value.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      if (typeof record.day === "string") return [{ day: record.day, value: record.hours }];
      return Object.entries(record).map(([day, hours]) => ({ day, value: hours }));
    });
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.days)) {
      entries = record.days.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const day = (item as Record<string, unknown>).day;
        if (typeof day !== "string") return [];
        return [{ day, value: (item as Record<string, unknown>).hours }];
      });
    } else {
      entries = Object.entries(record).map(([day, hours]) => ({ day, value: hours }));
    }
  }
  return entries
    .flatMap(({ day, value: hours }) => {
      const normalized = weekdayName(day);
      return normalized ? [{ day: normalized, value: hours }] : [];
    })
    .sort((a, b) => WEEKDAYS.indexOf(a.day) - WEEKDAYS.indexOf(b.day));
}

function durationPercent(value: unknown): number | null {
  const text = scalar(value)?.toLowerCase();
  if (!text) return null;
  if (/closed|not open|休業/.test(text)) return 0;
  if (/24\s*(?:hours|\/\s*7)|open\s+24|全天/.test(text)) return 100;
  const ranges = [
    ...text.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/gi),
  ];
  if (ranges.length !== 1) return null;
  const range = ranges[0]!;
  const toMinutes = (hourText: string, minuteText: string | undefined, period: string | undefined) => {
    let hour = Number(hourText);
    const minute = Number(minuteText ?? 0);
    if (minute > 59 || hour > 24 || (period && (hour < 1 || hour > 12))) return null;
    if (period?.toLowerCase() === "am") hour = hour === 12 ? 0 : hour;
    if (period?.toLowerCase() === "pm") hour = hour === 12 ? 12 : hour + 12;
    if (!period && hour === 24 && minute === 0) return 1440;
    return hour < 24 ? hour * 60 + minute : null;
  };
  const start = toMinutes(range[1]!, range[2], range[3]);
  const end = toMinutes(range[4]!, range[5], range[6]);
  if (start === null || end === null) return null;
  const duration = end >= start ? end - start : 1440 - start + end;
  return Math.max(0, Math.min(100, (duration / 1440) * 100));
}

function scalar(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).filter(Boolean);
    return parts.length ? parts.join(", ") : null;
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
  return null;
}

function dataEntries(value: unknown): Array<[string, string]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .map(([key, entry]): [string, string] => [key.replaceAll("_", " "), typeof entry === "boolean" ? (entry ? "Yes" : "No") : scalar(entry) ?? "Unknown"])
    .filter(([, entry]) => entry !== "Unknown");
}

function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function DetailsPanel({
  placeId,
  savedPlaces,
  collections,
  reviewsEnabled,
  onClose,
  onChanged,
  onNotify,
  onOpenDuplicates,
  onSearchHere,
}: DetailsPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const reviewAbortRef = useRef<AbortController | null>(null);
  const reviewStopRef = useRef(false);
  const reviewBatchRef = useRef(0);
  const [reviewProgress, setReviewProgress] = useState<string | null>(null);
  const [reviewPageState, setReviewPageState] = useState<PlaceReviewPage | null>(null);
  const [place, setPlace] = useState<Place | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewsError, setReviewsError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [reviews, setReviews] = useState<PlaceReviewPage | null>(null);
  const [collectionsOpen, setCollectionsOpen] = useState(false);
  const [selectedCollection, setSelectedCollection] = useState("");

  const saved = savedPlaces.find((item) => item.place.id === placeId || item.place.sourceId === place?.sourceId);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPlace(null);
    setError(null);
    reviewStopRef.current = true;
    reviewBatchRef.current += 1;
    reviewAbortRef.current?.abort();
    setReviewProgress(null);
    setReviewsError(null);
    setReviews(null);
    setReviewPageState(null);
    setCollectionsOpen(false);
    api
      .place(placeId)
      .then((result) => {
        if (cancelled) return;
        setPlace(result);
        setNote(saved?.note ?? "");
        if (result.source === "serpapi" && result.reviews.available && result.reviews.fetched > 0) {
          return api.reviews(placeId).then((page) => {
            if (!cancelled) setReviews(page);
          }).catch((caught) => {
            if (!cancelled) setReviewsError(caught instanceof ApiError ? caught.message : "Could not load stored reviews.");
          });
        }
        return undefined;
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof ApiError ? caught.message : "Could not load this place.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      reviewStopRef.current = true;
      reviewBatchRef.current += 1;
      reviewAbortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeId]);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => previousFocus?.focus?.();
  }, [placeId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target;
      if (target instanceof Element && target.closest('[role="combobox"][aria-expanded="true"]')) return;
      if (document.querySelector(".modal-backdrop")) return;
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (saved) setNote(saved.note ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved?.id, saved?.note]);

  const runAction = async (name: string, action: () => Promise<void>) => {
    if (name === "reviews") setReviewsError(null);
    setBusyAction(name);
    try {
      await action();
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : "The action failed.";
      if (name === "reviews") setReviewsError(message);
      else onNotify("error", message);
    } finally {
      setBusyAction(null);
    }
  };

  const savePlace = () =>
    runAction("save", async () => {
      if (!place) return;
      await api.savePlace(place.id, note.trim() ? note.trim() : null);
      onChanged();
      onNotify("success", `${place.name} saved.`);
    });

  const removeSaved = () =>
    runAction("save", async () => {
      if (!saved) return;
      await api.deleteSavedPlace(saved.id);
      onChanged();
      onNotify("info", "Removed from saved places.");
    });

  const saveNote = () =>
    runAction("note", async () => {
      if (!saved) return;
      await api.updateSavedPlaceNote(saved.id, note.trim() ? note.trim() : null);
      onChanged();
      onNotify("success", "Note saved.");
    });

  const fetchDetails = () =>
    runAction("details", async () => {
      if (!place) return;
      const result = await api.fetchDetails(place.id);
      setPlace(result.place);
      onChanged();
      onNotify("success", "SerpApi details fetched (1 request).");
    });

  const loadReviews = (next: boolean) =>
    runAction("reviews", async () => {
      if (!place) return;
      const page = next ? (reviewPageState?.page ?? 1) + 1 : 1;
      const token = next ? (reviewPageState?.nextPageToken ?? null) : null;
      const result = await api.fetchReviews(place.id, page, token);
      setReviews(result);
      setReviewPageState(result);
      onNotify("success", `Loaded ${result.reviews.length} stored review${result.reviews.length === 1 ? "" : "s"} (1 request).`);
    });

  // A bounded batch follows available provider pages; the reported total may not be retrievable.
  const loadAvailableReviews = () => {
    if (!place || busyAction !== null) return;
    const id = place.id;
    const firstPage = reviewPageState?.nextPageToken && reviewPageState.page < 20 ? reviewPageState.page + 1 : 1;
    const firstToken = firstPage > 1 ? reviewPageState?.nextPageToken ?? null : null;
    const controller = new AbortController();
    reviewAbortRef.current = controller;
    reviewStopRef.current = false;
    const batch = ++reviewBatchRef.current;
    setBusyAction("reviews-all");
    setReviewsError(null);
    setReviewProgress(null);
    void (async () => {
      let page = firstPage;
      let token = firstToken;
      let calls = 0;
      const seen = new Set<string>();
      try {
        while (!reviewStopRef.current && batch === reviewBatchRef.current && calls < 5 && page <= 20) {
          if (token && seen.has(token)) {
            setReviewProgress("Stopped: the source repeated a page token. Stored reviews are preserved.");
            return;
          }
          if (token) seen.add(token);
          setReviewProgress(`Loading page ${page} · ${calls + 1} of at most 5 requests in this batch…`);
          const result = await api.fetchReviews(id, page, token, controller.signal);
          calls += 1;
          if (batch !== reviewBatchRef.current) return;
          setReviews(result);
          setReviewPageState(result);
          if (reviewStopRef.current) {
            setReviewProgress(`Stopped after ${calls} request${calls === 1 ? "" : "s"}; ${result.reviews.length} reviews stored.`);
            return;
          }
          if (!result.hasNext || !result.nextPageToken || page === 20 || result.nextPageToken === token) {
            setReviewProgress(`Stopped after ${calls} request${calls === 1 ? "" : "s"}; ${result.reviews.length} reviews stored. The source may not provide every review.`);
            return;
          }
          page += 1;
          token = result.nextPageToken;
        }
        if (!reviewStopRef.current && batch === reviewBatchRef.current) {
          setReviewProgress(`Stopped at the 5-request batch limit. Use “Load available pages” again to continue if a next page remains.`);
        }
      } catch (caught) {
        if (!reviewStopRef.current && batch === reviewBatchRef.current) {
          setReviewsError(caught instanceof ApiError ? caught.message : "Review loading stopped. Previously stored reviews are preserved.");
          setReviewProgress(`Stopped after ${calls} successful request${calls === 1 ? "" : "s"}.`);
        }
      } finally {
        if (batch === reviewBatchRef.current) {
          reviewAbortRef.current = null;
          setBusyAction(null);
        }
      }
    })();
  };

  const stopReviewLoading = () => {
    reviewStopRef.current = true;
    setReviewProgress("Stopping after the current request. A request already sent may still count against your SerpApi budget.");
  };

  const addToCollection = () =>
    runAction("collection", async () => {
      if (!saved || !selectedCollection) return;
      await api.addCollectionItems(selectedCollection, [saved.id]);
      onChanged();
      setSelectedCollection("");
      setCollectionsOpen(false);
      onNotify("success", "Added to collection.");
    });

  const osmLink = place
    ? `https://www.openstreetmap.org/?mlat=${place.lat}&mlon=${place.lon}#map=18/${place.lat}/${place.lon}`
    : null;
  const sourceUrl = safeExternalUrl(place?.sourceUrl);
  const website = safeExternalUrl(place?.fields.website);
  const phone = scalar(place?.fields.phone);
  const hoursValue = place?.fields.hours;
  const weeklyHours = hoursEntries(hoursValue);
  const hours = scalar(hoursValue);
  const hoursLastUpdated = scalar(place?.fields.hours_last_updated);
  const popularTimes = place?.fields.popular_times;
  const locationSummary = scalar(place?.fields.location_summary);
  const atThisPlace = place?.fields.at_this_place;
  const description = scalar(place?.fields.description);
  const rating = place?.fields.rating;
  const reviewCount = place?.fields.reviews;
  const sourceReviewCount = typeof reviewCount === "number" && Number.isFinite(reviewCount) ? reviewCount : null;
  const price = scalar(place?.fields.price);
  const openState = scalar(place?.fields.open_state);
  const types = Array.isArray(place?.fields.types) ? (place.fields.types as unknown[]) : [];
  const cuisine = scalar(place?.fields.cuisine);
  const brand = scalar(place?.fields.brand);
  const serviceOptions = place?.fields.service_options ?? place?.fields.services;
  const accessibility = place?.fields.accessibility;

  return (
    <aside
      ref={panelRef}
      className="details-panel"
      aria-labelledby="details-title"
      tabIndex={-1}
    >
      <header className="details-panel__header">
        <div>
          <p className="details-panel__eyebrow">Place details</p>
          <h2 id="details-title">{place?.name ?? "Loading place…"}</h2>
          {place ? (
            <div className="details-panel__badges">
              <Badge tone={place.source}>{place.source === "osm" ? "OpenStreetMap" : "SerpApi Google Maps"}</Badge>
              {place.possibleDuplicate ? (
                <button
                  type="button"
                  className="badge badge--warn badge--button"
                  onClick={onOpenDuplicates}
                  title="Review possible duplicates"
                  aria-label="Review possible duplicates"
                >
                  Possible duplicate
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close place details">
          ✕
        </button>
      </header>

      <div className="details-panel__body">
        {loading ? (
          <div className="details-panel__loading" role="status">
            <Spinner label="Loading place" /> Loading…
          </div>
        ) : error ? (
          <div className="callout callout--error" role="alert">
            {error}
          </div>
        ) : place ? (
          <>
            <dl className="detail-list">
              <div>
                <dt>Address</dt>
                <dd>{place.address ?? "Not provided by this source"}</dd>
              </div>
              <div>
                <dt>Category</dt>
                <dd>{place.category ?? "Uncategorised"}</dd>
              </div>
              <div>
                <dt>Distance</dt>
                <dd>{place.distanceMeters === null ? "—" : formatDistance(place.distanceMeters)}</dd>
              </div>
              <div>
                <dt>Coordinates</dt>
                <dd>
                  {place.lat.toFixed(6)}, {place.lon.toFixed(6)}
                </dd>
              </div>
              {rating !== undefined ? (
                <div>
                  <dt>Rating</dt>
                  <dd>
                    ★ {scalar(rating)} out of 5
                    {sourceReviewCount !== null ? ` · ${sourceReviewCount.toLocaleString()} source reviews` : ""}
                  </dd>
                </div>
              ) : null}
              {rating === undefined && sourceReviewCount !== null ? (
                <div><dt>Source review count</dt><dd>{sourceReviewCount.toLocaleString()} reviews reported</dd></div>
              ) : null}
              {openState ? (
                <div>
                  <dt>Open state</dt>
                  <dd>{openState}</dd>
                </div>
              ) : null}
              {price ? (
                <div>
                  <dt>Price</dt>
                  <dd>{price}</dd>
                </div>
              ) : null}
              {hours && weeklyHours.length === 0 ? (
                <div>
                  <dt>Hours</dt>
                  <dd className="detail-list__pre">{hours}</dd>
                </div>
              ) : null}
              {hoursLastUpdated ? (
                <div>
                  <dt>Hours last updated</dt>
                  <dd>{hoursLastUpdated}</dd>
                </div>
              ) : null}
              {popularTimes !== undefined && popularTimes !== null ? (
                <div>
                  <dt>Popular times</dt>
                  <dd className="detail-list__pre">{scalar(popularTimes)}</dd>
                </div>
              ) : null}
              {locationSummary ? (
                <div>
                  <dt>Location summary</dt>
                  <dd className="detail-list__pre">{locationSummary}</dd>
                </div>
              ) : null}
              {atThisPlace !== undefined && atThisPlace !== null ? (
                <div>
                  <dt>At this place</dt>
                  <dd className="detail-list__pre">{scalar(atThisPlace)}</dd>
                </div>
              ) : null}
              {phone ? (
                <div>
                  <dt>Phone</dt>
                  <dd>
                    <a href={`tel:${phone.replace(/[^\d+]/g, "")}`}>{phone}</a>
                  </dd>
                </div>
              ) : null}
              {website ? (
                <div>
                  <dt>Website</dt>
                  <dd>
                    <a href={website} target="_blank" rel="noreferrer noopener">
                      {website.replace(/^https?:\/\//, "").slice(0, 60)}
                    </a>
                  </dd>
                </div>
              ) : null}
              {description ? (
                <div>
                  <dt>Description</dt>
                  <dd>{description}</dd>
                </div>
              ) : null}
              {cuisine ? <div><dt>Cuisine</dt><dd>{cuisine}</dd></div> : null}
              {brand ? <div><dt>Brand</dt><dd>{brand}</dd></div> : null}
              {dataEntries(serviceOptions).length > 0 ? (
                <div><dt>Services</dt><dd>{dataEntries(serviceOptions).map(([key, value]) => `${key}: ${value}`).join(" · ")}</dd></div>
              ) : null}
              {dataEntries(accessibility).length > 0 ? (
                <div><dt>Accessibility</dt><dd>{dataEntries(accessibility).map(([key, value]) => `${key}: ${value}`).join(" · ")}</dd></div>
              ) : null}
              {types.length > 0 ? (
                <div>
                  <dt>Source types</dt>
                  <dd>{types.map((item) => scalar(item)).filter(Boolean).join(", ")}</dd>
                </div>
              ) : null}
              <div>
                <dt>Details status</dt>
                <dd>
                  {place.detailsStatus.replaceAll("_", " ")}
                  {place.detailsFetchedAt ? ` · ${formatDateTime(place.detailsFetchedAt)}` : ""}
                </dd>
              </div>
              <div>
                <dt>Retrieved</dt>
                <dd>{formatDateTime(place.retrievedAt)}</dd>
              </div>
            </dl>

            {weeklyHours.length > 0 ? (
              <section className="hours-chart" aria-labelledby="hours-chart-heading">
                <div className="hours-chart__head">
                  <h3 id="hours-chart-heading">Opening hours</h3>
                  <span className="field__hint">Weekly schedule as reported by the source</span>
                </div>
                <ul className="hours-chart__rows">
                  {weeklyHours.map((entry) => {
                    const label = scalar(entry.value) ?? "Unknown";
                    const percent = durationPercent(entry.value);
                    const today = WEEKDAYS[(new Date().getDay() + 6) % 7];
                    return (
                      <li
                        key={entry.day}
                        className={`hours-chart__row${entry.day === today ? " hours-chart__row--today" : ""}`}
                      >
                        <span className="hours-chart__day">
                          {entry.day}
                          {entry.day === today ? <span className="hours-chart__today">Today</span> : null}
                        </span>
                        <span
                          className="hours-chart__track"
                          role="img"
                          aria-label={`${entry.day}: ${label}`}
                        >
                          {percent === null ? (
                            <span className="hours-chart__unknown" />
                          ) : (
                            <span
                              className={`hours-chart__bar${percent === 0 ? " hours-chart__bar--closed" : ""}`}
                              style={{ width: `${percent === 0 ? 0 : Math.max(percent, 6)}%` }}
                            />
                          )}
                        </span>
                        <span className="hours-chart__value">{label}</span>
                      </li>
                    );
                  })}
                </ul>
                <p className="field__hint">
                  Bars use a 0–24 hour scale and show the length of each reported opening window. Split schedules and values
                  without a recognizable time range keep the source text without an estimated bar.
                </p>
              </section>
            ) : null}

            <div className="detail-links">
              {sourceUrl ? (
                <a className="button button--ghost button--small" href={sourceUrl} target="_blank" rel="noreferrer noopener">
                  {place.source === "osm" ? "Open OSM source ↗" : "Open Google Maps source ↗"}
                </a>
              ) : null}
              {osmLink ? (
                <a className="button button--ghost button--small" href={osmLink} target="_blank" rel="noreferrer noopener">
                  View location on OSM ↗
                </a>
              ) : null}
              <button
                type="button"
                className="button button--secondary button--small"
                onClick={() => onSearchHere(place)}
              >
                Search around this place
              </button>
            </div>

            {place.source === "serpapi" ? (
              <section className="detail-section" aria-labelledby="enrich-heading">
                <h3 id="enrich-heading">On-demand details</h3>
                <p className="field__hint">
                  Each request costs one SerpApi search and is charged to the shared budget. Nothing is fetched
                  automatically per marker.
                </p>
                <button
                  type="button"
                  className="button button--secondary button--small"
                  onClick={fetchDetails}
                  disabled={busyAction !== null}
                >
                  {busyAction === "details"
                    ? "Fetching…"
                    : place.detailsStatus === "fetched"
                      ? "Refresh details (1 request)"
                      : "Fetch details (1 request)"}
                </button>
              </section>
            ) : null}

            <section className="detail-section" aria-labelledby="reviews-heading">
              <h3 id="reviews-heading">Reviews</h3>
              {place.source !== "serpapi" ? (
                <p className="field__hint">Reviews are only available for SerpApi records.</p>
              ) : !reviewsEnabled ? (
                <p className="field__hint">Reviews are disabled by the server data policy.</p>
              ) : (
                <>
                  <p className="field__hint">{reviews?.reviews.length ?? place.reviews.fetched} stored here; {sourceReviewCount === null ? "source total unknown" : `${sourceReviewCount.toLocaleString()} reported by source`}. The provider may expose fewer reviews than its reported total.</p>
                  {reviewProgress ? <p className="field__hint" role="status" aria-live="polite">{reviewProgress}</p> : null}
                  {reviewsError ? <p className="form-error" role="alert">{reviewsError}</p> : null}
                  {reviews && reviews.reviews.length > 0 ? (
                    <ul className="review-list">
                      {reviews.reviews.map((review) => (
                        <li key={review.id} className="review">
                          <div className="review__head">
                            <strong>{review.authorName ?? "Anonymous"}</strong>
                            {review.rating !== null ? <span>★ {review.rating}</span> : null}
                            <span className="review__date">{review.dateText ?? ""}</span>
                          </div>
                          {review.snippet ? <p>{review.snippet}</p> : null}
                          {review.likes !== null ? <span className="review__likes">{review.likes} likes</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="field__hint">
                      No reviews are stored yet. Loaded reviews are included in exports when the reviews field is selected.
                    </p>
                  )}
                  {reviews?.fetchedAt ? (
                    <p className="field__hint">Fetched {formatDateTime(reviews.fetchedAt)}.</p>
                  ) : null}
                  <div className="button-row">
                    <button
                      type="button"
                      className="button button--secondary button--small"
                      onClick={() => loadReviews(false)}
                      disabled={busyAction !== null}
                    >
                      {busyAction === "reviews"
                        ? "Loading…"
                        : reviews?.reviews.length
                          ? "Refresh first page (1 request)"
                          : "Load reviews (1 request)"}
                    </button>
                    {reviewPageState?.hasNext && reviewPageState.nextPageToken && reviewPageState.page < 20 ? (
                      <button
                        type="button"
                        className="button button--ghost button--small"
                        onClick={() => loadReviews(true)}
                        disabled={busyAction !== null}
                      >
                        Load next page (1 request)
                      </button>
                    ) : null}
                    {busyAction === "reviews-all" ? (
                      <button type="button" className="button button--ghost button--small" onClick={stopReviewLoading}>Stop loading</button>
                    ) : (!reviewPageState || (reviewPageState.hasNext && reviewPageState.nextPageToken && reviewPageState.page < 20)) ? (
                      <button type="button" className="button button--secondary button--small" onClick={loadAvailableReviews} disabled={busyAction !== null}>
                        Load available pages (up to 5 requests)
                      </button>
                    ) : null}
                  </div>
                  <p className="field__hint">Each page uses one budgeted SerpApi request. A batch stops after 5 requests or page 20, whichever comes first; Stop waits for the current request. This cannot guarantee every review.</p>
                </>
              )}
            </section>

            <section className="detail-section" aria-labelledby="save-heading">
              <h3 id="save-heading">Save and annotate</h3>
              {saved ? (
                <>
                  <label className="field">
                    <span>Note</span>
                    <textarea
                      value={note}
                      maxLength={2000}
                      rows={3}
                      placeholder="Why is this place useful? Include a next step."
                      onChange={(event) => setNote(event.target.value)}
                    />
                  </label>
                  <div className="button-row">
                    <button
                      type="button"
                      className="button button--secondary button--small"
                      onClick={saveNote}
                      disabled={busyAction !== null}
                    >
                      {busyAction === "note" ? "Saving…" : "Save note"}
                    </button>
                    <button
                      type="button"
                      className="button button--ghost button--small"
                      onClick={removeSaved}
                      disabled={busyAction !== null}
                    >
                      Unsave
                    </button>
                    <button
                      type="button"
                      className="button button--ghost button--small"
                      onClick={() => setCollectionsOpen((open) => !open)}
                      aria-expanded={collectionsOpen}
                    >
                      Add to collection
                    </button>
                  </div>
                  {collectionsOpen ? (
                    collections.length === 0 ? (
                      <p className="field__hint">Create a collection in the saved library first.</p>
                    ) : (
                      <div className="inline-control">
                        <label className="field">
                          <span>Collection</span>
                          <select
                            value={selectedCollection}
                            onChange={(event) => setSelectedCollection(event.target.value)}
                          >
                            <option value="">Choose a collection…</option>
                            {collections.map((collection) => (
                              <option key={collection.id} value={collection.id}>
                                {collection.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          type="button"
                          className="button button--primary button--small"
                          onClick={addToCollection}
                          disabled={!selectedCollection || busyAction !== null}
                        >
                          Add
                        </button>
                      </div>
                    )
                  ) : null}
                </>
              ) : (
                <>
                  <p className="field__hint">Saving keeps a snapshot of the source record, even if retention later removes it.</p>
                  <button
                    type="button"
                    className="button button--primary button--small"
                    onClick={savePlace}
                    disabled={busyAction !== null}
                  >
                    {busyAction === "save" ? "Saving…" : "Save place"}
                  </button>
                </>
              )}
            </section>

            <details className="provenance">
              <summary>Field provenance and source data</summary>
              <ul className="provenance__list">
                {Object.entries(place.provenance).map(([field, info]) => (
                  <li key={field}>
                    <strong>{field}</strong>
                    <span>
                      {info.source === "osm" ? "OSM" : "SerpApi"} · {formatDateTime(info.retrievedAt)}
                      {info.note ? ` · ${info.note}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
              {place.source === "osm" && place.fields.tags ? (
                <details className="provenance__tags">
                  <summary>Raw OSM tags</summary>
                  <dl>
                    {Object.entries(place.fields.tags as Record<string, unknown>).map(([key, value]) => (
                      <div key={key}>
                        <dt>{key}</dt>
                        <dd>{scalar(value)}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              ) : null}
              <p className="field__hint">
                Timestamps show when this app retrieved a field, not when the source last verified the place.
              </p>
            </details>
          </>
        ) : null}
      </div>
    </aside>
  );
}

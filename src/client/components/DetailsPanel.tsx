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

function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

type IconName =
  | "pin"
  | "phone"
  | "globe"
  | "route"
  | "clock"
  | "search"
  | "check"
  | "x"
  | "info"
  | "food"
  | "tree"
  | "bed"
  | "bag"
  | "health"
  | "book"
  | "bank"
  | "heart";

const ICON_PATHS: Record<IconName, string[]> = {
  pin: [
    "M12 21s-6.4-5.7-6.4-10.2a6.4 6.4 0 1 1 12.8 0C18.4 15.3 12 21 12 21Z",
    "M12 13.1a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
  ],
  phone: [
    "M6.4 3.5h2.8l1.5 3.8-1.9 1.4a12.4 12.4 0 0 0 6.5 6.5l1.4-1.9 3.8 1.5v2.8A2.9 2.9 0 0 1 17.6 20C10.5 20 4 13.5 4 6.4a2.9 2.9 0 0 1 2.4-2.9Z",
  ],
  globe: [
    "M3.2 12h17.6",
    "M12 3.2c3 3.4 3 14.2 0 17.6",
    "M12 3.2c-3 3.4-3 14.2 0 17.6",
    "M12 3.2a8.8 8.8 0 1 0 0 17.6 8.8 8.8 0 0 0 0-17.6Z",
  ],
  route: [
    "M6.5 19.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
    "M17.5 9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
    "M8.8 14.7h5.7a3 3 0 0 0 3-3V9.4",
  ],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 7.5V12l3 1.8"],
  search: ["M11 18.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15Z", "m16.4 16.4 4.1 4.1"],
  check: ["m4.5 12.5 4.7 4.7L19.8 6.6"],
  x: ["M6.4 6.4l11.2 11.2", "M17.6 6.4 6.4 17.6"],
  info: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 11v5.5", "M12 7.6v.4"],
  food: [
    "M7 3.5v6.2a2 2 0 0 0 2 2h.4V3.5",
    "M8.2 11.7V20.5",
    "M16.8 3.5c-1.4 2.1-2 4.1-2 6.1v3.2h4V9.6c0-2-.6-4-2-6.1Z",
    "M16.8 12.8v7.7",
  ],
  tree: ["M12 3.5 5.3 13h3.9l-2 3.8h9.6l-2-3.8h3.9L12 3.5Z", "M12 16.8v3.7"],
  bed: [
    "M3.5 18.5v-6.3h17v6.3",
    "M3.5 12.2V6.4",
    "M3.5 18.5v1.8",
    "M20.5 18.5v1.8",
    "M7 12.2V9.4h4.8v2.8",
  ],
  bag: ["M6.2 8.3h11.6l1 11.2H5.2l1-11.2Z", "M9 8.3V6.4a3 3 0 0 1 6 0v1.9"],
  health: ["M12 4.2v15.6", "M4.2 12h15.6"],
  book: [
    "M5 4.2h8.6a3 3 0 0 1 3 3v12.6H8a3 3 0 0 1-3-3V4.2Z",
    "M16.6 4.2h2.4v15.6h-2.4",
  ],
  bank: [
    "M3.5 9.2h17L12 4 3.5 9.2Z",
    "M5.5 9.2v7.4",
    "M9.8 9.2v7.4",
    "M14.2 9.2v7.4",
    "M18.5 9.2v7.4",
    "M3.5 20h17",
  ],
  heart: [
    "M12 20.2s-7.6-4.6-7.6-9.6a4.2 4.2 0 0 1 7.6-2.5 4.2 4.2 0 0 1 7.6 2.5c0 5-7.6 9.6-7.6 9.6Z",
  ],
};

function Glyph({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className ? `glyph ${className}` : "glyph"}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICON_PATHS[name].map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}

function Stars({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(5, value));
  return (
    <span className="stars" aria-hidden="true">
      <span className="stars__track">★★★★★</span>
      <span className="stars__fill" style={{ width: `${(clamped / 5) * 100}%` }}>
        ★★★★★
      </span>
    </span>
  );
}

function ratingValue(value: unknown): number | null {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.min(5, numeric);
}

interface OpenInfo {
  label: string;
  detail: string | null;
  tone: "open" | "closed";
  raw: string;
}

function parseOpenState(...values: unknown[]): OpenInfo | null {
  const text = values.map((value) => scalar(value)).find((value): value is string => Boolean(value));
  if (!text) return null;
  const normalized = text.replace(/\s*[·⋅•|]\s*/g, " · ").trim();
  const parts = normalized.split(" · ");
  const head = parts[0] ?? "";
  const detail = parts.slice(1).join(" · ").trim() || null;
  const lowered = head.toLowerCase();
  if (/temporarily closed|permanently closed/.test(lowered)) {
    return { label: head, detail, tone: "closed", raw: text };
  }
  if (lowered.startsWith("closed")) {
    return { label: "Closed now", detail, tone: "closed", raw: text };
  }
  if (lowered.startsWith("open")) {
    return { label: /24/.test(lowered) ? "Open 24 hours" : "Open now", detail, tone: "open", raw: text };
  }
  return null;
}

function priceDisplay(value: string | null): { level: string | null; note: string | null } {
  if (!value) return { level: null, note: null };
  const text = value.trim();
  if (/^\$+$/.test(text) || /^(inexpensive|moderate|pricey|expensive|very expensive|\d+)$/i.test(text)) {
    return { level: text, note: null };
  }
  return { level: null, note: text };
}

function humanize(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (character) => character.toUpperCase());
}

interface AttributeItem {
  key: string;
  label: string;
  state: "yes" | "no" | "text";
  text: string | null;
}

function attributeItems(value: unknown): AttributeItem[] {
  const items: AttributeItem[] = [];
  if (value === null || value === undefined) return items;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = scalar(entry);
      if (text) items.push({ key: text, label: humanize(text), state: "yes", text: null });
    }
    return items;
  }
  if (typeof value !== "object") {
    const text = scalar(value);
    if (text) items.push({ key: text, label: text, state: "text", text });
    return items;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const label = humanize(key);
    if (typeof entry === "boolean") {
      items.push({ key, label, state: entry ? "yes" : "no", text: null });
      continue;
    }
    const text = scalar(entry);
    if (!text) continue;
    if (/^(yes|true)$/i.test(text)) items.push({ key, label, state: "yes", text: null });
    else if (/^(no|false)$/i.test(text)) items.push({ key, label, state: "no", text: null });
    else items.push({ key, label, state: "text", text });
  }
  return items;
}

interface SubPlace {
  title: string;
  type: string | null;
  rating: number | null;
  address: string | null;
  openState: string | null;
}

function subPlaces(value: unknown): SubPlace[] {
  const record =
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const list = record && Array.isArray(record.places) ? record.places : Array.isArray(value) ? value : [];
  return list.flatMap((item) => {
    if (typeof item === "string") {
      const title = item.trim();
      return title ? [{ title, type: null, rating: null, address: null, openState: null }] : [];
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const entry = item as Record<string, unknown>;
    const title = scalar(entry.title ?? entry.name);
    if (!title) return [];
    return [
      {
        title,
        type: scalar(entry.type) ?? null,
        rating: ratingValue(entry.rating),
        address: scalar(entry.address) ?? null,
        openState: scalar(entry.open_state) ?? null,
      },
    ];
  });
}

function summaryText(value: unknown): string | null {
  if (typeof value === "string") return scalar(value);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return scalar(record.text ?? record.summary ?? record.snippet ?? record.description);
  }
  return null;
}

function numberFrom(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const match = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const numeric = Number(match[0]);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function hourLabel(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  const numeric = numberFrom(value);
  if (numeric === null) return null;
  const hour = ((Math.round(numeric) % 24) + 24) % 24;
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display} ${hour < 12 ? "AM" : "PM"}`;
}

interface PopularPoint {
  label: string;
  value: number;
}

function normalizePopular(points: PopularPoint[]): PopularPoint[] {
  const max = Math.max(...points.map((point) => point.value));
  if (!Number.isFinite(max) || max <= 0) return points;
  if (max <= 1.5) return points.map((point) => ({ ...point, value: clampPercent(point.value * 100) }));
  if (max > 100) return points.map((point) => ({ ...point, value: (point.value / max) * 100 }));
  return points;
}

function popularPoints(value: unknown): PopularPoint[] | null {
  if (Array.isArray(value)) {
    const points: PopularPoint[] = [];
    for (const item of value) {
      if (typeof item === "number" || typeof item === "string") {
        const numeric = numberFrom(item);
        if (numeric !== null) points.push({ label: "", value: clampPercent(numeric) });
        continue;
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      const numeric = numberFrom(
        record.popularity ?? record.busyness ?? record.percentage ?? record.value ?? record.percent,
      );
      if (numeric === null) continue;
      points.push({ label: hourLabel(record.hour ?? record.time ?? record.label) ?? "", value: clampPercent(numeric) });
    }
    return points.length >= 2 ? normalizePopular(points) : null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const graph = record.graph_results ?? record.days ?? record.hours;
  if (graph && typeof graph === "object") {
    if (Array.isArray(graph)) return popularPoints(graph);
    const byDay = graph as Record<string, unknown>;
    const todayName = WEEKDAYS[(new Date().getDay() + 6) % 7];
    const key =
      Object.keys(byDay).find((candidate) => weekdayName(candidate) === todayName) ?? Object.keys(byDay)[0];
    if (key) {
      const points = popularPoints(byDay[key]);
      if (points) return points;
    }
  }
  const dayKeys = Object.keys(record).filter((key) => weekdayName(key) !== null);
  if (dayKeys.length > 0) {
    const todayName = WEEKDAYS[(new Date().getDay() + 6) % 7];
    const key = dayKeys.find((candidate) => weekdayName(candidate) === todayName) ?? dayKeys[0];
    if (key) {
      const points = popularPoints(record[key]);
      if (points) return points;
    }
  }
  const points: PopularPoint[] = [];
  for (const [key, entry] of Object.entries(record)) {
    const numeric = numberFrom(entry);
    if (numeric === null) continue;
    points.push({ label: hourLabel(key) ?? key, value: clampPercent(numeric) });
  }
  return points.length >= 2 ? normalizePopular(points) : null;
}

function categoryIcon(value: string | null): IconName {
  const text = (value ?? "").toLowerCase();
  if (/(hotel|motel|lodging|rv park|resort|guest|mobile home)/.test(text)) return "bed";
  if (/(restaurant|food|cafe|coffee|bakery|bar|meal|pizza|diner|bistro|tea)/.test(text)) return "food";
  if (/(park|garden|nature|trail|beach|forest)/.test(text)) return "tree";
  if (/(hospital|clinic|pharmacy|doctor|dentist|medical|health)/.test(text)) return "health";
  if (/(school|university|college|library|education)/.test(text)) return "book";
  if (/(bank|atm|finance|insurance|government|city hall|courthouse)/.test(text)) return "bank";
  if (/(store|shop|market|mall|retail|supermarket|grocery)/.test(text)) return "bag";
  return "pin";
}

function initialOf(value: string): string {
  return value.trim().charAt(0).toUpperCase() || "?";
}

function detailsStatusLabel(status: Place["detailsStatus"]): string {
  switch (status) {
    case "fetched":
      return "Details fetched";
    case "failed":
      return "Fetch failed";
    case "not_available":
      return "Not available from source";
    default:
      return "Not fetched yet";
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
  const locationSummary = summaryText(place?.fields.location_summary);
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

  const ratingNumber = ratingValue(rating);
  const openInfo = parseOpenState(openState, hours);
  const priceInfo = priceDisplay(price);
  const primaryCategory = place?.category ?? (types.length > 0 ? scalar(types[0]) : null) ?? "Uncategorised";
  const flatHours = weeklyHours.length === 0 ? hours : null;
  const popularSeries = popularPoints(popularTimes);
  const popularText = typeof popularTimes === "string" ? scalar(popularTimes) : null;
  const offerings = Array.isArray(atThisPlace)
    ? atThisPlace.map((item) => scalar(item)).filter((item): item is string => Boolean(item))
    : [];
  const subPlaceItems =
    atThisPlace &&
    typeof atThisPlace === "object" &&
    !Array.isArray(atThisPlace) &&
    Array.isArray((atThisPlace as Record<string, unknown>).places)
      ? subPlaces(atThisPlace)
      : [];
  const offeringItems: AttributeItem[] = offerings.map((text) => ({
    key: text,
    label: humanize(text),
    state: "yes" as const,
    text: null,
  }));
  const atThisPlaceAttributes =
    offeringItems.length === 0 && subPlaceItems.length === 0 ? attributeItems(atThisPlace) : [];
  const serviceItems = attributeItems(serviceOptions);
  const accessibilityItems = attributeItems(accessibility);
  const extraTypes = types
    .map((item) => scalar(item))
    .filter((item): item is string => Boolean(item) && item !== primaryCategory);
  const typeItems: AttributeItem[] = extraTypes.map((text) => ({
    key: text,
    label: text,
    state: "yes" as const,
    text: null,
  }));
  const goodToKnow: AttributeItem[] = [];
  if (brand) goodToKnow.push({ key: "brand", label: "Brand", state: "text", text: brand });
  if (cuisine) goodToKnow.push({ key: "cuisine", label: "Cuisine", state: "text", text: cuisine });
  if (priceInfo.note) goodToKnow.push({ key: "price-note", label: "Source note", state: "text", text: priceInfo.note });
  const highlightGroups: Array<{ label: string; items: AttributeItem[] }> = [];
  if (goodToKnow.length > 0) highlightGroups.push({ label: "Good to know", items: goodToKnow });
  if (offeringItems.length > 0) highlightGroups.push({ label: "At this place", items: offeringItems });
  if (atThisPlaceAttributes.length > 0) highlightGroups.push({ label: "At this place", items: atThisPlaceAttributes });
  if (serviceItems.length > 0) highlightGroups.push({ label: "Services", items: serviceItems });
  if (accessibilityItems.length > 0) highlightGroups.push({ label: "Accessibility", items: accessibilityItems });
  if (typeItems.length > 0) highlightGroups.push({ label: "Categories", items: typeItems });
  const storedReviews = reviews?.reviews ?? [];
  const reviewRatings = storedReviews.map((review) => review.rating).filter((value): value is number => value !== null);
  const averageStoredRating =
    reviewRatings.length > 0 ? reviewRatings.reduce((sum, value) => sum + value, 0) / reviewRatings.length : null;
  const reviewDistribution = [5, 4, 3, 2, 1].map((star) => ({
    star,
    count: reviewRatings.filter((value) => Math.round(value) === star).length,
  }));
  const maxDistribution = Math.max(1, ...reviewDistribution.map((entry) => entry.count));
  const detailsLabel = place ? detailsStatusLabel(place.detailsStatus) : "";
  const websiteLabel = website ? website.replace(/^https?:\/\//, "").replace(/\/$/, "") : null;

  return (
    <aside
      ref={panelRef}
      className="details-panel"
      aria-labelledby="details-title"
      tabIndex={-1}
    >
      <header className="details-panel__header">
        <div className="details-panel__heading">
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
            <section className={`detail-hero detail-hero--${place.source}`} aria-label="Place summary">
              <div className="detail-hero__top">
                <span className="detail-hero__glyph" aria-hidden="true">
                  <Glyph name={categoryIcon(primaryCategory)} />
                </span>
                <div className="detail-hero__identity">
                  <p className="detail-hero__category">{primaryCategory}</p>
                  <p className="detail-hero__address">
                    <Glyph name="pin" className="detail-hero__inline-icon" />
                    <span>{place.address ?? "No address in the source record."}</span>
                  </p>
                </div>
              </div>

              {ratingNumber !== null ||
              sourceReviewCount !== null ||
              openInfo !== null ||
              priceInfo.level !== null ||
              place.distanceMeters !== null ? (
                <div className="detail-hero__facts">
                  {ratingNumber !== null ? (
                    <div
                      className="detail-score"
                      aria-label={`Rated ${ratingNumber.toFixed(1)} out of 5${
                        sourceReviewCount !== null ? ` from ${sourceReviewCount} source reviews` : ""
                      }`}
                    >
                      <span className="detail-score__value">{ratingNumber.toFixed(1)}</span>
                      <span className="detail-score__body">
                        <Stars value={ratingNumber} />
                        <span className="detail-score__caption">
                          {sourceReviewCount !== null
                            ? `${sourceReviewCount.toLocaleString()} source reviews`
                            : "out of 5"}
                        </span>
                      </span>
                    </div>
                  ) : sourceReviewCount !== null ? (
                    <div className="detail-score detail-score--plain">
                      <span className="detail-score__value">{sourceReviewCount.toLocaleString()}</span>
                      <span className="detail-score__caption">source reviews</span>
                    </div>
                  ) : null}

                  <div className="detail-pills">
                    {openInfo ? (
                      <span className={`detail-pill detail-pill--${openInfo.tone}`} title={openInfo.raw}>
                        <Glyph name="clock" />
                        <span>{openInfo.label}</span>
                        {openInfo.detail ? <em>{openInfo.detail}</em> : null}
                      </span>
                    ) : null}
                    {priceInfo.level ? (
                      <span className="detail-pill detail-pill--neutral">
                        <span aria-hidden="true">{priceInfo.level}</span>
                        <span className="visually-hidden">Price level {priceInfo.level}</span>
                      </span>
                    ) : null}
                    {place.distanceMeters !== null ? (
                      <span className="detail-pill detail-pill--neutral">
                        <Glyph name="route" />
                        <span>{formatDistance(place.distanceMeters)}</span>
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </section>

            <div className="detail-actions" aria-label="Place actions">
              {phone ? (
                <a className="detail-action" href={`tel:${phone.replace(/[^\d+]/g, "")}`}>
                  <span className="detail-action__icon">
                    <Glyph name="phone" />
                  </span>
                  <span className="detail-action__text">
                    <strong>Call</strong>
                    <small>{phone}</small>
                  </span>
                </a>
              ) : null}
              {website ? (
                <a className="detail-action" href={website} target="_blank" rel="noreferrer noopener">
                  <span className="detail-action__icon">
                    <Glyph name="globe" />
                  </span>
                  <span className="detail-action__text">
                    <strong>Website</strong>
                    <small>{websiteLabel}</small>
                  </span>
                </a>
              ) : null}
              {sourceUrl ? (
                <a className="detail-action" href={sourceUrl} target="_blank" rel="noreferrer noopener">
                  <span className="detail-action__icon">
                    <Glyph name="pin" />
                  </span>
                  <span className="detail-action__text">
                    <strong>{place.source === "osm" ? "OSM record" : "Google Maps"}</strong>
                    <small>Open source ↗</small>
                  </span>
                </a>
              ) : null}
              {osmLink && place.source !== "osm" ? (
                <a className="detail-action" href={osmLink} target="_blank" rel="noreferrer noopener">
                  <span className="detail-action__icon">
                    <Glyph name="route" />
                  </span>
                  <span className="detail-action__text">
                    <strong>OSM map</strong>
                    <small>View location ↗</small>
                  </span>
                </a>
              ) : null}
              <button type="button" className="detail-action" onClick={() => onSearchHere(place)}>
                <span className="detail-action__icon">
                  <Glyph name="search" />
                </span>
                <span className="detail-action__text">
                  <strong>Search nearby</strong>
                  <small>Around this point</small>
                </span>
              </button>
            </div>

            {description || locationSummary ? (
              <section className="detail-section detail-section--card" aria-labelledby="about-heading">
                <h3 id="about-heading">About</h3>
                {description ? <p className="detail-about">{description}</p> : null}
                {locationSummary ? (
                  <p className="detail-about detail-about--muted">
                    <Glyph name="pin" />
                    <span>{locationSummary}</span>
                  </p>
                ) : null}
              </section>
            ) : null}

            {highlightGroups.length > 0 ? (
              <section className="detail-section detail-section--card" aria-labelledby="highlights-heading">
                <h3 id="highlights-heading">Highlights</h3>
                <div className="detail-chip-groups">
                  {highlightGroups.map((group) => (
                    <div className="detail-chip-group" key={group.label}>
                      <p className="detail-chip-group__label">{group.label}</p>
                      <ul className="detail-chip-row">
                        {group.items.map((item) => (
                          <li
                            key={`${group.label}-${item.key}`}
                            className={`detail-chip${item.state === "no" ? " detail-chip--off" : ""}${
                              item.state === "text" ? " detail-chip--text" : ""
                            }`}
                            title={
                              item.state === "text" && item.text
                                ? `${item.label}: ${item.text}`
                                : `${item.label}: ${item.state === "no" ? "No" : "Yes"}`
                            }
                          >
                            <Glyph
                              name={item.state === "no" ? "x" : item.state === "text" ? "info" : "check"}
                            />
                            <span>
                              {item.label}
                              {item.state === "text" && item.text ? `: ${item.text}` : ""}
                              <span className="visually-hidden">
                                {item.state === "no" ? ": no" : item.state === "yes" ? ": yes" : ""}
                              </span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {flatHours ? (
              <section className="detail-section detail-section--card" aria-labelledby="hours-flat-heading">
                <h3 id="hours-flat-heading">Hours</h3>
                <p className="detail-hours-flat">
                  <Glyph name="clock" />
                  <span>{flatHours}</span>
                </p>
                {hoursLastUpdated ? <p className="field__hint">Source update: {hoursLastUpdated}</p> : null}
              </section>
            ) : null}

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
                  Bars use a 0–24 hour scale and show the length of each reported opening window. Today is
                  highlighted. Split schedules and values without a recognizable time range keep the source text
                  without an estimated bar.
                </p>
              </section>
            ) : null}

            {popularSeries ? (
              <section className="detail-section detail-section--card" aria-labelledby="popular-heading">
                <div className="detail-section__head">
                  <h3 id="popular-heading">Popular times</h3>
                  <span className="field__hint">Busyness by hour from the source</span>
                </div>
                <div
                  className="popular-chart"
                  role="img"
                  aria-label={`Popular times: ${popularSeries
                    .map((point) => `${point.label || "hour"} ${Math.round(point.value)} percent`)
                    .join(", ")}`}
                >
                  {popularSeries.map((point, index) => (
                    <span className="popular-chart__col" key={`popular-${point.label}-${index}`}>
                      <span
                        className="popular-chart__bar"
                        style={{ height: `${Math.max(point.value, 3)}%` }}
                        title={`${point.label || `Hour ${index + 1}`}: ${Math.round(point.value)}%`}
                      />
                      <span className="popular-chart__label">{index % 3 === 0 ? point.label : ""}</span>
                    </span>
                  ))}
                </div>
              </section>
            ) : popularText || (popularTimes && typeof popularTimes === "object") ? (
              <section className="detail-section detail-section--card" aria-labelledby="popular-heading">
                <h3 id="popular-heading">Popular times</h3>
                {popularText ? (
                  <p className="detail-hours-flat">
                    <Glyph name="clock" />
                    <span>{popularText}</span>
                  </p>
                ) : (
                  <p className="field__hint">
                    The source returned a busyness graph that this view cannot chart. The original values remain in
                    the source record and in exports.
                  </p>
                )}
              </section>
            ) : null}

            {subPlaceItems.length > 0 ? (
              <section className="detail-section detail-section--card" aria-labelledby="subplaces-heading">
                <div className="detail-section__head">
                  <h3 id="subplaces-heading">Also at this location</h3>
                  <span className="field__hint">
                    {subPlaceItems.length} place{subPlaceItems.length === 1 ? "" : "s"}
                  </span>
                </div>
                <ul className="detail-subplaces">
                  {subPlaceItems.map((item, index) => (
                    <li className="detail-subplace" key={`${item.title}-${index}`}>
                      <div className="detail-subplace__head">
                        <strong>{item.title}</strong>
                        {item.rating !== null ? (
                          <span className="detail-subplace__rating">
                            <Stars value={item.rating} /> {item.rating.toFixed(1)}
                          </span>
                        ) : null}
                      </div>
                      {item.type || item.openState ? (
                        <p className="detail-subplace__meta">
                          {[item.type, item.openState].filter(Boolean).join(" · ")}
                        </p>
                      ) : null}
                      {item.address ? <p className="detail-subplace__address">{item.address}</p> : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {place.source === "serpapi" ? (
              <section className="detail-callout" aria-labelledby="enrich-heading">
                <span className="detail-callout__icon" aria-hidden="true">
                  <Glyph name="info" />
                </span>
                <div className="detail-callout__body">
                  <h3 id="enrich-heading">On-demand details</h3>
                  <p>
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
                </div>
              </section>
            ) : null}

            <section className="detail-section detail-section--card" aria-labelledby="save-heading">
              <div className="detail-section__head">
                <h3 id="save-heading">Save and annotate</h3>
                {saved ? <Badge tone="ok">Saved</Badge> : null}
              </div>
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

            <section className="detail-section detail-section--card" aria-labelledby="reviews-heading">
              <div className="detail-section__head">
                <h3 id="reviews-heading">Reviews</h3>
                {storedReviews.length > 0 ? (
                  <span className="field__hint">
                    {storedReviews.length} stored
                  </span>
                ) : null}
              </div>
              {place.source !== "serpapi" ? (
                <p className="field__hint">Reviews are only available for SerpApi records.</p>
              ) : !reviewsEnabled ? (
                <p className="field__hint">Reviews are disabled by the server data policy.</p>
              ) : (
                <>
                  <p className="field__hint">
                    {reviews?.reviews.length ?? place.reviews.fetched} stored here;{" "}
                    {sourceReviewCount === null
                      ? "source total unknown"
                      : `${sourceReviewCount.toLocaleString()} reported by source`}
                    . The provider may expose fewer reviews than its reported total.
                  </p>
                  {averageStoredRating !== null ? (
                    <div className="review-summary">
                      <div className="review-summary__score">
                        <strong>{averageStoredRating.toFixed(1)}</strong>
                        <Stars value={averageStoredRating} />
                        <span>{reviewRatings.length} rated</span>
                      </div>
                      <ul className="review-summary__dist" aria-hidden="true">
                        {reviewDistribution.map((entry) => (
                          <li key={entry.star}>
                            <span>{entry.star}</span>
                            <span className="review-summary__track">
                              <span
                                className="review-summary__fill"
                                style={{ width: `${Math.round((entry.count / maxDistribution) * 100)}%` }}
                              />
                            </span>
                            <span>{entry.count}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {reviewProgress ? (
                    <p className="field__hint" role="status" aria-live="polite">
                      {reviewProgress}
                    </p>
                  ) : null}
                  {reviewsError ? (
                    <p className="form-error" role="alert">
                      {reviewsError}
                    </p>
                  ) : null}
                  {storedReviews.length > 0 ? (
                    <ul className="review-list">
                      {storedReviews.map((review) => (
                        <li key={review.id} className="review">
                          <span className="review__avatar" aria-hidden="true">
                            {initialOf(review.authorName ?? "Anonymous")}
                          </span>
                          <div className="review__body">
                            <div className="review__head">
                              <strong>{review.authorName ?? "Anonymous"}</strong>
                              {review.rating !== null ? (
                                <span className="review__rating">
                                  <Stars value={review.rating} />
                                  <span>{review.rating.toFixed(1)}</span>
                                </span>
                              ) : null}
                              <span className="review__date">{review.dateText ?? ""}</span>
                            </div>
                            {review.snippet ? <p>{review.snippet}</p> : null}
                            {review.likes !== null ? (
                              <span className="review__likes">
                                <Glyph name="heart" /> {review.likes} likes
                              </span>
                            ) : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="field__hint">
                      No reviews are stored yet. Loaded reviews are included in exports when the reviews field is
                      selected.
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
                      <button type="button" className="button button--ghost button--small" onClick={stopReviewLoading}>
                        Stop loading
                      </button>
                    ) : !reviewPageState ||
                      (reviewPageState.hasNext && reviewPageState.nextPageToken && reviewPageState.page < 20) ? (
                      <button
                        type="button"
                        className="button button--secondary button--small"
                        onClick={loadAvailableReviews}
                        disabled={busyAction !== null}
                      >
                        Load available pages (up to 5 requests)
                      </button>
                    ) : null}
                  </div>
                  <p className="field__hint">
                    Each page uses one budgeted SerpApi request. A batch stops after 5 requests or page 20, whichever
                    comes first; Stop waits for the current request. This cannot guarantee every review.
                  </p>
                </>
              )}
            </section>

            <details className="detail-meta">
              <summary>
                <Glyph name="info" /> Record details
              </summary>
              <dl className="detail-list detail-list--compact">
                <div>
                  <dt>Coordinates</dt>
                  <dd>
                    {place.lat.toFixed(6)}, {place.lon.toFixed(6)}
                  </dd>
                </div>
                <div>
                  <dt>Details</dt>
                  <dd>
                    {detailsLabel}
                    {place.detailsFetchedAt ? ` · ${formatDateTime(place.detailsFetchedAt)}` : ""}
                  </dd>
                </div>
                <div>
                  <dt>Retrieved</dt>
                  <dd>{formatDateTime(place.retrievedAt)}</dd>
                </div>
                {hoursLastUpdated ? (
                  <div>
                    <dt>Hours updated</dt>
                    <dd>{hoursLastUpdated}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Source record</dt>
                  <dd>{place.source === "serpapi" ? "SerpApi place" : humanize(place.sourceType)}</dd>
                </div>
              </dl>
            </details>

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

export interface ExportField {
  id: string;
  label: string;
  description: string;
}

export const EXPORT_FIELDS: ExportField[] = [
  { id: "name", label: "Name", description: "Place name as returned by the source" },
  { id: "category", label: "Category", description: "Source category or derived OSM category" },
  { id: "address", label: "Address", description: "Formatted address when returned" },
  { id: "lat", label: "Latitude", description: "WGS84 latitude" },
  { id: "lon", label: "Longitude", description: "WGS84 longitude" },
  { id: "source", label: "Source", description: "osm or serpapi" },
  { id: "source_id", label: "Source ID", description: "Stable identifier from the source" },
  { id: "source_url", label: "Source URL", description: "Public source page or attribution link" },
  { id: "distance_m", label: "Distance (m)", description: "Distance from the search center" },
  { id: "rating", label: "Rating", description: "Source-provided rating" },
  { id: "review_count", label: "Review count", description: "Source-provided review count, not review text" },
  { id: "website", label: "Website", description: "Website when returned" },
  { id: "phone", label: "Phone", description: "Phone number when returned" },
  { id: "hours", label: "Hours", description: "Opening hours when returned" },
  {
    id: "hours_last_updated",
    label: "Hours last updated",
    description: "When the source last verified the opening hours",
  },
  {
    id: "popular_times",
    label: "Popular times (JSON)",
    description: "Hourly busyness graph from SerpApi, preserved as structured JSON",
  },
  {
    id: "location_summary",
    label: "Location summary (JSON)",
    description: "Source-provided summary of the place's location or setting",
  },
  {
    id: "at_this_place",
    label: "At this place (JSON)",
    description: "In-place offerings such as dine-in or takeout, as returned",
  },
  { id: "price", label: "Price", description: "Price level when returned" },
  { id: "description", label: "Description", description: "Source-provided description" },
  { id: "types", label: "Types (JSON)", description: "Source-provided place types or categories, as returned" },
  {
    id: "service_options",
    label: "Service options (JSON)",
    description: "Source-provided service options such as dine-in or takeout",
  },
  {
    id: "accessibility",
    label: "Accessibility (JSON)",
    description: "Source-provided accessibility details",
  },
  {
    id: "place_topics",
    label: "Place topics (JSON)",
    description: "Source-provided topic tags for the place",
  },
  { id: "details_status", label: "Details status", description: "Whether source details were fetched" },
  { id: "retrieved_at", label: "Retrieved at", description: "Timestamp of the latest source retrieval" },
  { id: "provenance", label: "Provenance (JSON)", description: "Field-level source provenance" },
  { id: "osm_tags", label: "OSM tags (JSON)", description: "Original OSM tags for OSM records" },
  {
    id: "reviews",
    label: "Stored reviews",
    description: "Stored SerpApi reviews as a separate reviews.csv and reviews.json file",
  },
];

export const DEFAULT_EXPORT_FIELDS = [
  "name",
  "category",
  "address",
  "lat",
  "lon",
  "source",
  "source_id",
  "source_url",
  "distance_m",
  "rating",
  "review_count",
  "website",
  "phone",
  "hours",
  "price",
  "retrieved_at",
  "reviews",
] as const;

export const RESTRICTED_EXPORT_FIELDS = [
  "review_images",
  "photo_url",
  "photos",
  "images",
  "thumbnail",
  "thumbnails",
] as const;

/**
 * Keys that must never leave the workspace in an export, whatever their depth.
 *
 * `RESTRICTED_EXPORT_FIELDS` only forbids whole field IDs. Structured fields
 * such as `popular_times`, `location_summary`, and `at_this_place` are kept
 * verbatim from the provider, so a nested photo URL would otherwise ride along
 * inside an allowed field and defeat the "no image URLs in exports" policy.
 * Serializers apply this recursively before any value reaches a file.
 */
export const RESTRICTED_EXPORT_KEYS: ReadonlySet<string> = new Set(
  RESTRICTED_EXPORT_FIELDS.flatMap((field) => [field, field.replaceAll("_", "")]),
);

/** True when a key names a restricted/photo field at any depth or casing. */
export function isRestrictedExportKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!normalized) return false;
  return (
    RESTRICTED_EXPORT_KEYS.has(key.toLowerCase()) ||
    RESTRICTED_EXPORT_KEYS.has(normalized) ||
    normalized.includes("photourl") ||
    normalized.includes("imageurl") ||
    normalized.includes("imageurls") ||
    normalized.includes("thumbnailurl")
  );
}

function isHttpsUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * True when a string is a concrete image reference that must never be
 * exported. Plain facts — names, addresses, opening hours, text — are left
 * alone so only image-shaped values are removed.
 */
function isIndividualImage(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text) return false;
  if (/^data:image\//i.test(text)) return true;
  if (/^https?:\/\/(?:[^/]+\.)?(?:googleusercontent\.com|ggpht\.com)\//i.test(text)) return true;
  if (!isHttpsUrl(text) && !text.startsWith("/")) return false;
  if (/(?:^|[?&#=/])(?:image|img|photo|picture|thumbnail)(?:[?&#=/]|$)/i.test(text)) return true;
  if (/\.(?:jpe?g|png|gif|webp|bmp|tiff?|heic|avif|svg)(?:[?#]|$)/i.test(text)) return true;
  if (/(?:=w\d{2,5}(?:-h\d{2,5})?(?:-[a-z]{2,4})?$)|[?&](?:w|h|width|height)=\d{2,5}(?:&|$)/i.test(text)) {
    return true;
  }
  return false;
}

/** Public predicate used by the CSV/XLSX/JSON serializers. */
export function looksLikeImageReference(value: string): boolean {
  return isIndividualImage(value);
}

/**
 * Recursively drop restricted keys and image-reference values from a value
 * before export. Non-plain values (Date, Buffer, class instances) are returned
 * untouched so serializers keep their own encoders.
 */
export function sanitizeExportValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return null;
  if (typeof value === "string") return isIndividualImage(value) ? null : value;
  if (Array.isArray(value)) {
    return value
      .filter((entry) => !isIndividualImage(entry))
      .map((entry) => sanitizeExportValue(entry, depth + 1))
      .filter((entry) => entry !== null && entry !== undefined);
  }
  if (isPlainRecord(value)) {
    const cleaned: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (isRestrictedExportKey(key) || isIndividualImage(entry)) continue;
      const sanitized = sanitizeExportValue(entry, depth + 1);
      if (sanitized === null || sanitized === undefined) continue;
      cleaned[key] = sanitized;
    }
    return cleaned;
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isExportField(id: string): boolean {
  return EXPORT_FIELDS.some((field) => field.id === id);
}

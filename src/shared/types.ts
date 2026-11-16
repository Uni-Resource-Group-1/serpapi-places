export type Source = "osm" | "serpapi";

export type SearchMode = "radius" | "area" | "boundary";

/** How a run obtains candidates. Tiled and import plans are explicit opt-ins. */
export type SearchPlan = "standard" | "tiled" | "import";

export type BoundaryLevel = "region" | "county" | "city";

export interface Coordinates {
  lat: number;
  lon: number;
}

export interface Bounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Multipolygon → polygons → rings → points; the first ring is the shell, the rest are holes. */
export type BoundaryPolygon = Coordinates[][][];

export interface BoundaryResolution {
  relationId: number | null;
  name: string | null;
  adminLevel: number | null;
  precision: "polygon" | "bbox" | "radius";
  boundsSource?: "osm" | "geonames" | "map" | "none";
  selectedBoundsSource?: "map" | null;
  reason: string | null;
  geometryHash: string | null;
  ringCount: number | null;
  vertexCount: number | null;
  osmTimestamp: string | null;
}

export interface BoundaryRef {
  level: BoundaryLevel;
  name: string;
  countryCode: string;
  center?: Coordinates | null;
  bounds?: Bounds | null;
  osmRelationId?: number | null;
  osmAdminLevel?: number | null;
}

export interface TilingConfig {
  /** Requested grid shape; the server re-validates it against hard limits. */
  columns: number;
  rows: number;
  tileCount: number;
  /** SerpApi page requests allowed per tile (1-3). */
  maxPagesPerTile: number;
}

export type PlaceRefKind = "place_id" | "data_id" | "data_cid";

export interface ImportedPlaceRef {
  kind: PlaceRefKind;
  value: string;
}

export interface SearchCriteria {
  keyword: string;
  category: string;
  sources: Source[];
  mode: SearchMode;
  center: Coordinates | null;
  radiusMeters: number;
  bounds: Bounds | null;
  country: string;
  region: string;
  county?: string;
  city: string;
  area: string;
  countryCode?: string;
  regionCode?: string;
  countyCode?: string;
  cityId?: number | null;
  boundary?: BoundaryRef | null;
  /** Run-time resolution metadata; never includes full polygon coordinates. */
  boundaryResolution?: BoundaryResolution | null;
  /** Opt-in plan. Absent means a standard single-query search. */
  plan?: SearchPlan;
  /** Present only when plan = "tiled". */
  tiling?: TilingConfig | null;
  /** Present only when plan = "import"; known Google Maps references resolved through SerpApi. */
  importRefs?: ImportedPlaceRef[] | null;
}

export type SearchRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled";

export type CoverageStatus = "within_limits" | "capped" | "partial" | "failed";

export interface SourceError {
  source: Source | "system";
  code: string;
  message: string;
  retryable?: boolean;
}

export interface TileBoundsInfo {
  index: number;
  row: number;
  column: number;
  bounds: Bounds;
  center: Coordinates;
  areaKm2: number;
}

export interface SourceSummary {
  source: Source;
  status: "ok" | "capped" | "error" | "disabled" | "skipped";
  requests: number;
  pages: number;
  results: number;
  kept: number;
  filteredOut: number;
  duplicates: number;
  /** Present for tiled runs: how many grid cells produced a completed sample. */
  tiles?: { total: number; attempted: number; completed: number; sampled: number };
  /** Per-source rejection reasons when recorded by this run; absent for older runs. */
  exclusions?: { missingCoordinates: number; invalidRecord: number; outsideArea: number; outsidePolygon: number };
  /** Resolved polygon, approximate box, approximate radius, or non-boundary search. */
  boundaryPrecision?: "polygon" | "bbox" | "radius" | "not_applicable";
  /** Why pagination ended; absent on older runs. */
  stopReason?: "exhausted" | "page_limit" | "result_limit" | "repeated_page" | "budget_limit" | "source_error";
  creditsEstimated: number;
  creditsActual: number;
  error?: string;
}

export interface SearchRunCounts {
  total: number;
  osm: number;
  serpapi: number;
  filteredOut: number;
  duplicates: number;
}

export interface SearchRun {
  id: string;
  status: SearchRunStatus;
  coverage: CoverageStatus | null;
  plan?: SearchPlan;
  criteria: SearchCriteria;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  counts: SearchRunCounts;
  sources: SourceSummary[];
  pagesProcessed: { osm: number; serpapi: number };
  requests: { osm: number; serpapi: number };
  credits: { estimated: number; actual: number };
  truncated: boolean;
  errors: SourceError[];
  caveats: string[];
  savedSearchId: string | null;
}

export interface FieldProvenance {
  source: Source;
  retrievedAt: string;
  note?: string;
}

export interface PlaceReview {
  id: string;
  authorName: string | null;
  rating: number | null;
  dateText: string | null;
  snippet: string | null;
  likes: number | null;
  fetchedAt: string;
}

export interface PlaceReviewPage {
  reviews: PlaceReview[];
  fetchedAt: string;
  page: number;
  hasNext: boolean;
  nextPageToken: string | null;
  reviewsEnabled: boolean;
}

export type AreaCheckKind = "radius" | "bounds" | "polygon";

export interface Place {
  id: string;
  source: Source;
  sourceType: string;
  sourceId: string;
  sourceUrl: string | null;
  name: string;
  address: string | null;
  category: string | null;
  lat: number;
  lon: number;
  distanceMeters: number | null;
  /**
   * Whether the run classified this record as inside the selected area.
   * `null` means the run had no usable geometry (or predates containment
   * classification), so it must not be treated as "outside".
   */
  insideArea: boolean | null;
  areaCheck: AreaCheckKind | null;
  fields: Record<string, unknown>;
  provenance: Record<string, FieldProvenance>;
  detailsStatus: "not_fetched" | "fetched" | "failed" | "not_available";
  detailsFetchedAt: string | null;
  retrievedAt: string;
  saved: boolean;
  possibleDuplicate: boolean;
  reviews: {
    available: boolean;
    fetched: number;
    lastFetchedAt: string | null;
  };
}

export interface SavedPlace {
  id: string;
  place: Place;
  note: string | null;
  createdAt: string;
  expiresAt: string | null;
  collections: Array<{ id: string; name: string }>;
}

/** Compact saved-place row used by pickers such as the export builder. */
export interface SavedPlaceSummary {
  id: string;
  name: string;
  source: Source;
  category: string | null;
  address: string | null;
  note: string | null;
  savedAt: string;
  hasHours: boolean;
  hasPopularTimes: boolean;
}

export interface Collection {
  id: string;
  name: string;
  description: string | null;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SavedSearch {
  id: string;
  name: string;
  criteria: SearchCriteria;
  refreshIntervalMinutes: number;
  lastRunAt: string | null;
  lastRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ExportFormat = "csv" | "geojson" | "json" | "xlsx";

export interface ExportJob {
  id: string;
  scope: "run" | "collection" | "saved";
  scopeId: string | null;
  selectionCount: number | null;
  format: ExportFormat;
  fields: string[];
  sources: Source[];
  insideOnly: boolean;
  status: "queued" | "running" | "completed" | "failed" | "expired";
  rowCount: number | null;
  omittedSources: string[];
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
  fileName: string | null;
  downloadCount: number;
  lastDownloadedAt: string | null;
  downloadUrl: string | null;
  manifest: ExportManifest | null;
}

export interface ExportManifest {
  schemaVersion: string;
  exportedAt: string;
  exportScope: string;
  scopeId: string;
  exportSelectionCount?: number | null;
  /** Selected saved places that could not be exported (source not requested or policy-disabled). */
  omittedSelectionCount?: number;
  format: ExportFormat;
  rowCount: number;
  reviewRowCount?: number;
  reviewFile?: string | null;
  coordinateSystem: "EPSG:4326 (WGS84)";
  criteria: SearchCriteria | null;
  filters: Record<string, unknown>;
  fields: string[];
  omittedFields: string[];
  restrictedSources: string[];
  sources: string[];
  retrievalRange: { earliest: string | null; latest: string | null };
  attribution: string[];
  coverageCaveats: string[];
  dataPolicy: string;
  csvSafe: boolean;
  geometryValidated: boolean;
}

export interface SourceStatus {
  osm: { configured: boolean; label: string; attribution: string };
  serpapi: {
    configured: boolean;
    reviewsEnabled: boolean;
    exportEnabled: boolean;
    label: string;
    attribution: string;
  };
  tiles: { url: string; attribution: string };
}

export interface DiscoveryEstimate {
  plan: SearchPlan;
  mode: SearchMode;
  tileCount: number;
  tiles: TileBoundsInfo[];
  serpapiRequests: number;
  estimatedCostUsd: number | null;
  remainingDay: number;
  remainingMonth: number;
  withinBudget: boolean;
  warnings: string[];
}

export interface UsageSummary {
  month: {
    used: number;
    limit: number;
    period: string;
    remaining: number;
  };
  day: {
    used: number;
    limit: number;
    period: string;
    remaining: number;
  };
  estimatedCostUsd: number;
  pricePerSearchUsd: number;
  hardLimits: {
    monthly: number;
    daily: number;
    maxPages: number;
    maxResults: number;
    maxRadiusMeters: number;
    maxAreaKm2: number;
    maxTiledAreaKm2: number;
    maxTilesPerRun: number;
    maxPagesPerTile: number;
    maxImportPlaces: number;
  };
}

export interface AppSettings {
  serpapiMonthlyLimit: number;
  serpapiDailyLimit: number;
  serpapiMaxPages: number;
  serpapiMaxResults: number;
  serpapiPriceUsd: number;
}

export type SerpApiCredentialSource = "settings" | "environment" | "none";

export type SerpApiCredentialStatus = "valid" | "invalid" | "unverified" | "unreadable" | "not_configured";

/**
 * Non-secret view of the active SerpApi credential. The key itself is never
 * serialized to the browser; only the last four characters are exposed.
 */
export interface SerpApiCredentialState {
  configured: boolean;
  source: SerpApiCredentialSource;
  last4: string | null;
  status: SerpApiCredentialStatus;
  plan: string | null;
  searchesLeft: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
  checkedAt: string | null;
}

export interface DuplicateCandidate {
  id: string;
  state: "candidate" | "approved" | "rejected";
  score: number;
  signals: Record<string, unknown>;
  createdAt: string;
  reviewedAt: string | null;
  a: {
    id: string;
    name: string;
    address: string | null;
    source: Source;
    category: string | null;
    lat: number;
    lon: number;
  };
  b: {
    id: string;
    name: string;
    address: string | null;
    source: Source;
    category: string | null;
    lat: number;
    lon: number;
  };
}

export interface SessionUser {
  displayName: string;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
}

export interface SearchRunCreateResponse {
  runId: string;
  reused: boolean;
}

export const TERMINAL_RUN_STATUSES: SearchRunStatus[] = [
  "completed",
  "partial",
  "failed",
  "cancelled",
];

export function isTerminalRun(status: SearchRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

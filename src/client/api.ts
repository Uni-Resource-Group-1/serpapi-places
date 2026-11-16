import type {
  AppSettings,
  Collection,
  DiscoveryEstimate,
  DuplicateCandidate,
  ExportFormat,
  ExportJob,
  ImportedPlaceRef,
  Place,
  PlaceReviewPage,
  SavedPlace,
  SavedPlaceSummary,
  SavedSearch,
  SearchCriteria,
  SearchRun,
  SerpApiCredentialState,
  SourceStatus,
  TileBoundsInfo,
  UsageSummary,
} from "../shared/types.js";

export interface AppStatus {
  appName: string;
  version: string;
  env: string;
  sources: SourceStatus;
  tiles: { url: string; attribution: string; maxZoom: number };
  usage: UsageSummary;
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

export interface SettingsPayload {
  settings: AppSettings & { updatedAt: string; updatedBy: string | null };
  usage: UsageSummary;
  serpapiCredential: SerpApiCredentialState;
  hardLimits: {
    monthly: number;
    daily: number;
    maxPages: number;
    maxResults: number;
    maxRadiusMeters: number;
    maxAreaKm2: number;
    exportRows: number;
    maxTiledAreaKm2: number;
    maxTilesPerRun: number;
    maxPagesPerTile: number;
    maxImportPlaces: number;
  };
  policy: {
    reviewsEnabled: boolean;
    serpapiExportEnabled: boolean;
    serpapiStorageDays: number;
    reviewRetentionDays: number;
    cacheTtlSeconds: number;
  };
}

export interface AuthSessionInfo {
  id: string;
  displayName: string;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
}

export interface PublicStatus {
  appName: string;
  version: string;
  accessRequired: boolean;
  env: string;
  serpapiConfigured: boolean;
  reviewsEnabled: boolean;
  serpapiExportEnabled: boolean;
  tiles: { url: string; attribution: string; maxZoom: number };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  raw?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (csrfToken && options.method && options.method !== "GET") {
    headers["x-csrf-token"] = csrfToken;
  }
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "same-origin",
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, "network_error", "Could not reach the server. Check your connection.");
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/api/auth/login")) {
      window.dispatchEvent(new CustomEvent("pd:unauthorized"));
    }
    const record = (payload ?? {}) as { error?: { code?: string; message?: string; details?: unknown } };
    throw new ApiError(
      response.status,
      record.error?.code ?? "request_failed",
      record.error?.message ?? `Request failed (${response.status}).`,
      record.error?.details,
    );
  }
  return payload as T;
}

export interface GeoCountry {
  code: string;
  name: string;
  center: { lat: number; lon: number } | null;
}

export interface GeoRegion {
  code: string;
  name: string;
  countryCode: string;
  center: { lat: number; lon: number } | null;
}

export interface GeoCounty {
  code: string;
  name: string;
  regionCode: string;
  countryCode: string;
  center: { lat: number; lon: number } | null;
}

export interface GeoCity {
  id: number;
  name: string;
  countyCode: string | null;
  regionCode: string;
  center: { lat: number; lon: number };
  population: number;
}

export const api = {
  login(accessKey: string, displayName: string): Promise<AuthSessionInfo> {
    return request("/api/auth/login", { method: "POST", body: { accessKey, displayName } });
  },
  me(): Promise<AuthSessionInfo> {
    return request("/api/auth/me");
  },
  logout(): Promise<void> {
    return request("/api/auth/logout", { method: "POST" });
  },
  publicStatus(): Promise<PublicStatus> {
    return request("/api/public/status");
  },
  status(): Promise<AppStatus> {
    return request("/api/status");
  },
  geoCountries(): Promise<{ countries: GeoCountry[]; attribution: string }> {
    return request("/api/geo/countries");
  },
  geoRegions(country: string): Promise<{ regions: GeoRegion[]; attribution: string }> {
    return request(`/api/geo/regions?country=${encodeURIComponent(country)}`);
  },
  geoCounties(region: string): Promise<{ counties: GeoCounty[]; attribution: string }> {
    return request(`/api/geo/counties?region=${encodeURIComponent(region)}`);
  },
  geoCities(params: { county?: string; region?: string }): Promise<{ cities: GeoCity[]; attribution: string }> {
    const query = params.county
      ? `county=${encodeURIComponent(params.county)}`
      : `region=${encodeURIComponent(params.region ?? "")}`;
    return request(`/api/geo/cities?${query}`);
  },
  getSettings(): Promise<SettingsPayload> {
    return request("/api/settings");
  },
  updateSettings(input: AppSettings): Promise<{ settings: AppSettings; usage: UsageSummary }> {
    return request("/api/settings", { method: "PUT", body: input });
  },
  saveSerpApiKey(apiKey: string): Promise<{ credential: SerpApiCredentialState; verification: { ok: boolean; plan: string | null; searchesLeft: number | null; message: string } }> {
    return request("/api/settings/serpapi-key", { method: "PUT", body: { apiKey } });
  },
  clearSerpApiKey(): Promise<{ credential: SerpApiCredentialState }> {
    return request("/api/settings/serpapi-key", { method: "DELETE" });
  },
  testSerpApiKey(apiKey?: string): Promise<{ verification: { ok: boolean; plan: string | null; searchesLeft: number | null; message: string } }> {
    return request("/api/settings/serpapi-key/test", { method: "POST", body: apiKey ? { apiKey } : {} });
  },
  createRun(criteria: SearchCriteria, savedSearchId: string | null = null): Promise<{ runId: string; reused: boolean }> {
    return request("/api/search-runs", {
      method: "POST",
      body: {
        criteria,
        savedSearchId,
        idempotencyKey: `manual:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
      },
    });
  },
  estimateRun(
    criteria: SearchCriteria,
    signal?: AbortSignal,
  ): Promise<DiscoveryEstimate> {
    return request("/api/search-runs/estimate", { method: "POST", body: { criteria }, signal });
  },
  queueTiles(
    criteria: SearchCriteria,
    savedSearchId: string | null = null,
  ): Promise<{ runs: Array<{ runId: string; reused: boolean; tile: TileBoundsInfo }>; estimate: DiscoveryEstimate }> {
    return request("/api/search-runs/queue-tiles", {
      method: "POST",
      body: {
        criteria,
        savedSearchId,
        idempotencyKey: `tiles:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
      },
    });
  },
  parsePlaceImports(input: string): Promise<{ refs: ImportedPlaceRef[]; rejected: Array<{ input: string; reason: string }> }> {
    return request("/api/place-imports", { method: "POST", body: { input } });
  },
  runs(limit = 12): Promise<{ runs: SearchRun[] }> {
    return request(`/api/search-runs?limit=${limit}`);
  },
  run(id: string): Promise<SearchRun> {
    return request(`/api/search-runs/${id}`);
  },
  runPlaces(id: string, offset = 0, limit = 100): Promise<{ places: Place[]; total: number; limit: number; offset: number }> {
    return request(`/api/search-runs/${id}/places?offset=${offset}&limit=${limit}`);
  },
  place(id: string): Promise<Place> {
    return request(`/api/places/${id}`);
  },
  fetchDetails(id: string): Promise<{ fetched: boolean; credits: number; place: Place }> {
    return request(`/api/places/${id}/details`, { method: "POST", body: {} });
  },
  reviews(id: string): Promise<PlaceReviewPage> {
    return request(`/api/places/${id}/reviews`);
  },
  fetchReviews(id: string, page: number, nextPageToken: string | null, signal?: AbortSignal): Promise<PlaceReviewPage> {
    return request(`/api/places/${id}/reviews`, {
      method: "POST",
      body: { page, nextPageToken },
      signal,
    });
  },
  savedSearches(): Promise<{ searches: SavedSearch[] }> {
    return request("/api/saved-searches");
  },
  saveSearch(name: string, criteria: SearchCriteria, refreshIntervalMinutes: number): Promise<SavedSearch> {
    return request("/api/saved-searches", {
      method: "POST",
      body: { name, criteria, refreshIntervalMinutes },
    });
  },
  updateSavedSearch(
    id: string,
    input: { name?: string; criteria?: SearchCriteria; refreshIntervalMinutes?: number },
  ): Promise<SavedSearch> {
    return request(`/api/saved-searches/${id}`, { method: "PATCH", body: input });
  },
  deleteSavedSearch(id: string): Promise<void> {
    return request(`/api/saved-searches/${id}`, { method: "DELETE" });
  },
  runSavedSearch(id: string): Promise<{ runId: string; reused: boolean }> {
    return request(`/api/saved-searches/${id}/run`, { method: "POST", body: {} });
  },
  savedPlaces(): Promise<{ places: SavedPlace[]; collections: Collection[] }> {
    return request("/api/saved-places");
  },
  savePlace(sourceRecordId: string, note: string | null = null, collectionId: string | null = null): Promise<SavedPlace> {
    return request("/api/saved-places", {
      method: "POST",
      body: { sourceRecordId, note, collectionId },
    });
  },
  updateSavedPlaceNote(id: string, note: string | null): Promise<{ id: string; note: string | null }> {
    return request(`/api/saved-places/${id}`, { method: "PATCH", body: { note } });
  },
  deleteSavedPlace(id: string, options: { destroySource?: boolean } = {}): Promise<void> {
    const query = options.destroySource ? "?destroySource=true" : "";
    return request(`/api/saved-places/${id}${query}`, { method: "DELETE" });
  },
  bulkDeleteSavedPlaces(ids: string[], options: { destroySource?: boolean } = {}): Promise<{ deleted: number; destroyed: number }> {
    return request("/api/saved-places/bulk-delete", {
      method: "POST",
      body: { ids, destroySource: options.destroySource === true },
    });
  },
  collections(): Promise<{ collections: Collection[] }> {
    return request("/api/collections");
  },
  createCollection(name: string, description: string | null = null): Promise<Collection> {
    return request("/api/collections", { method: "POST", body: { name, description } });
  },
  updateCollection(id: string, input: { name?: string; description?: string | null }): Promise<{ id: string }> {
    return request(`/api/collections/${id}`, { method: "PATCH", body: input });
  },
  deleteCollection(id: string): Promise<void> {
    return request(`/api/collections/${id}`, { method: "DELETE" });
  },
  addCollectionItems(id: string, savedPlaceIds: string[]): Promise<{ added: number }> {
    return request(`/api/collections/${id}/items`, { method: "POST", body: { savedPlaceIds } });
  },
  removeCollectionItem(id: string, savedPlaceId: string): Promise<{ deleted: number }> {
    return request(`/api/collections/${id}/items/${savedPlaceId}`, { method: "DELETE" });
  },
  /** Omit `savedPlaceIds` to empty the collection; saved places are kept. */
  removeCollectionItems(id: string, savedPlaceIds?: string[]): Promise<{ deleted: number }> {
    return request(`/api/collections/${id}/items/remove`, {
      method: "POST",
      body: savedPlaceIds ? { savedPlaceIds } : {},
    });
  },
  duplicates(state?: string): Promise<{ duplicates: DuplicateCandidate[] }> {
    return request(`/api/duplicates${state ? `?state=${encodeURIComponent(state)}` : ""}`);
  },
  decideDuplicate(id: string, decision: "approved" | "rejected" | "candidate"): Promise<{ id: string; state: string }> {
    return request(`/api/duplicates/${id}/decision`, { method: "POST", body: { decision } });
  },
  exportJobs(): Promise<{ jobs: ExportJob[] }> {
    return request("/api/export-jobs");
  },
  savedPlaceSummaries(): Promise<{ places: SavedPlaceSummary[] }> {
    return request("/api/saved-places/summaries");
  },
  deleteExportJob(id: string): Promise<{ id: string; deleted: boolean; fileDeleted: boolean; fileCleanupFailed: boolean }> {
    return request(`/api/export-jobs/${id}`, { method: "DELETE" });
  },
  createExport(input: {
    scope: "run" | "collection" | "saved";
    scopeId?: string;
    savedPlaceIds?: string[];
    format: ExportFormat;
    fields: string[];
    sources: string[];
    insideOnly?: boolean;
  }): Promise<ExportJob> {
    return request("/api/export-jobs", { method: "POST", body: input });
  },
  exportJob(id: string): Promise<ExportJob> {
    return request(`/api/export-jobs/${id}`);
  },
};

function filenameFromDisposition(value: string): string | null {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1].replaceAll('"', ""));
    } catch {
      return encoded[1].replaceAll('"', "");
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(value);
  return plain?.[1] ?? null;
}

/**
 * Download an export through fetch so failures surface as messages instead of
 * a silent navigation, and so the browser receives the server's exact file
 * name. A detached anchor without `download` can be retried by the browser or
 * ignored when the response is an error, which looked like "nothing happened".
 */
export async function downloadExport(jobId: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api/export-jobs/${jobId}/download`, {
      credentials: "same-origin",
      headers: { Accept: "application/zip" },
    });
  } catch {
    throw new ApiError(0, "network_error", "Could not reach the server. Check your connection.");
  }
  if (!response.ok) {
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent("pd:unauthorized"));
    }
    let message = `Download failed (${response.status}).`;
    let code = "download_failed";
    try {
      const payload = (await response.json()) as { error?: { code?: string; message?: string } };
      if (payload.error?.message) message = payload.error.message;
      if (payload.error?.code) code = payload.error.code;
    } catch {
      // The body was not JSON; keep the status-based message.
    }
    throw new ApiError(response.status, code, message);
  }
  const fileName =
    filenameFromDisposition(response.headers.get("content-disposition") ?? "") ??
    `places-export-${jobId.slice(0, 8)}.zip`;
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

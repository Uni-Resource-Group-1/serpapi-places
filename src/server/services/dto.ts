import type {
  Collection,
  DuplicateCandidate,
  Place,
  SavedPlace,
  SavedPlaceSummary,
  SavedSearch,
  SearchRun,
  Source,
  SourceError,
  SourceSummary,
} from "../../shared/types.js";
import { many, one } from "../db.js";

export interface PlaceRow {
  id: string;
  source: Source;
  source_type: string;
  source_id: string;
  source_url: string | null;
  name: string;
  address: string | null;
  category: string | null;
  lat: number;
  lon: number;
  distance_m: number | null;
  fields: Record<string, unknown>;
  field_provenance: Record<string, { source: Source; retrievedAt: string; note?: string }>;
  details_status: Place["detailsStatus"];
  details_fetched_at: Date | null;
  last_fetched_at: Date;
  possible_duplicate: boolean;
  saved_id: string | null;
  review_count: string | number | null;
  review_fetched_at: Date | null;
}

export function rowToPlace(row: PlaceRow, reviewsEnabled: boolean): Place {
  const reviewCount = Number(row.review_count ?? 0);
  return {
    id: row.id,
    source: row.source,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceUrl: row.source_url,
    name: row.name,
    address: row.address,
    category: row.category,
    lat: row.lat,
    lon: row.lon,
    distanceMeters: row.distance_m,
    fields: row.fields ?? {},
    provenance: row.field_provenance ?? {},
    detailsStatus: row.details_status,
    detailsFetchedAt: row.details_fetched_at?.toISOString() ?? null,
    retrievedAt: row.last_fetched_at.toISOString(),
    saved: Boolean(row.saved_id),
    possibleDuplicate: Boolean(row.possible_duplicate),
    reviews: {
      available: row.source === "serpapi" && reviewsEnabled,
      fetched: reviewCount,
      lastFetchedAt: row.review_fetched_at?.toISOString() ?? null,
    },
  };
}

const placeColumns = `
  s.id, s.source, s.source_type, s.source_id, s.source_url, s.name, s.address, s.category,
  s.lat, s.lon, s.fields, s.field_provenance, s.details_status, s.details_fetched_at,
  s.last_fetched_at,
  EXISTS (
    SELECT 1 FROM place_matches m
    WHERE (m.a_source_record_id = s.id OR m.b_source_record_id = s.id)
      AND m.state IN ('candidate', 'approved')
  ) AS possible_duplicate,
  sp.id AS saved_id,
  (SELECT count(*) FROM place_reviews pr WHERE pr.source_record_id = s.id AND (pr.expires_at IS NULL OR pr.expires_at > now())) AS review_count,
  (SELECT max(pr.fetched_at) FROM place_reviews pr WHERE pr.source_record_id = s.id AND (pr.expires_at IS NULL OR pr.expires_at > now())) AS review_fetched_at
`;

export async function fetchRunPlaces(runId: string, reviewsEnabled: boolean): Promise<Place[]> {
  const rows = await many<PlaceRow>(
    `SELECT ${placeColumns}, rp.distance_m
     FROM run_places rp
     JOIN source_place_records s ON s.id = rp.source_record_id
     LEFT JOIN saved_places sp ON sp.source_record_id = s.id
     WHERE rp.run_id = $1 AND s.source IN ('osm', 'serpapi') AND (s.expires_at IS NULL OR s.expires_at > now())
     ORDER BY rp.distance_m ASC NULLS LAST, s.name ASC`,
    [runId],
  );
  return rows.map((row) => rowToPlace(row, reviewsEnabled));
}

export async function fetchPlace(id: string, reviewsEnabled: boolean): Promise<Place | null> {
  const row = await one<PlaceRow>(
    `SELECT ${placeColumns}, NULL::double precision AS distance_m
     FROM source_place_records s
     LEFT JOIN saved_places sp ON sp.source_record_id = s.id
     WHERE s.id = $1 AND s.source IN ('osm', 'serpapi') AND (s.expires_at IS NULL OR s.expires_at > now())`,
    [id],
  );
  return row ? rowToPlace(row, reviewsEnabled) : null;
}

interface SearchRunRow {
  id: string;
  status: SearchRun["status"];
  coverage: SearchRun["coverage"];
  plan: SearchRun["plan"];
  criteria: SearchRun["criteria"];
  sources: Source[];
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  result_count: number;
  filtered_out: number;
  duplicate_count: number;
  source_summaries: SourceSummary[];
  pages_osm: number;
  pages_serpapi: number;
  osm_requests: number;
  serpapi_requests: number;
  credits_estimated: number;
  credits_actual: number;
  truncated: boolean;
  errors: SourceError[];
  caveats: string[];
  saved_search_id: string | null;
}

export async function fetchSearchRun(runId: string): Promise<SearchRun | null> {
  const row = await one<SearchRunRow>("SELECT * FROM search_runs WHERE id = $1", [runId]);
  if (!row) return null;
  const summaries = row.source_summaries ?? [];
  const osm = summaries.find((summary) => summary.source === "osm");
  const serpapi = summaries.find((summary) => summary.source === "serpapi");
  return {
    id: row.id,
    status: row.status,
    coverage: row.coverage,
    plan: row.plan ?? row.criteria.plan ?? "standard",
    criteria: row.criteria,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    counts: {
      total: row.result_count,
      osm: osm?.kept ?? 0,
      serpapi: serpapi?.kept ?? 0,
      filteredOut: row.filtered_out,
      duplicates: row.duplicate_count,
    },
    sources: summaries,
    pagesProcessed: { osm: row.pages_osm, serpapi: row.pages_serpapi },
    requests: { osm: row.osm_requests, serpapi: row.serpapi_requests },
    credits: { estimated: row.credits_estimated, actual: row.credits_actual },
    truncated: row.truncated,
    errors: row.errors ?? [],
    caveats: row.caveats ?? [],
    savedSearchId: row.saved_search_id,
  };
}

interface SavedPlaceRow extends PlaceRow {
  saved_place_id: string;
  note: string | null;
  saved_at: Date;
  saved_expires_at: Date | null;
  snapshot: Record<string, unknown>;
  source_record_id: string | null;
}

export async function fetchSavedPlaces(reviewsEnabled: boolean): Promise<SavedPlace[]> {
  const rows = await many<SavedPlaceRow>(
    `SELECT ${placeColumns},
            sp.id AS saved_place_id, sp.note, sp.created_at AS saved_at, sp.expires_at AS saved_expires_at,
            sp.snapshot, sp.source_record_id
     FROM saved_places sp
     LEFT JOIN source_place_records s ON s.id = sp.source_record_id
       AND (s.expires_at IS NULL OR s.expires_at > now())
     WHERE (sp.expires_at IS NULL OR sp.expires_at > now())
       AND sp.snapshot->>'source' IN ('osm', 'serpapi')
       AND (sp.snapshot->>'source' IS DISTINCT FROM 'serpapi'
         OR (s.id IS NOT NULL AND (s.expires_at IS NULL OR s.expires_at > now())))
     ORDER BY sp.created_at DESC`,
    [],
  );
  const items = await many<{ saved_place_id: string; collection_id: string; name: string }>(
    `SELECT ci.saved_place_id, c.id AS collection_id, c.name
     FROM collection_items ci JOIN collections c ON c.id = ci.collection_id`,
  );
  const collectionsBySaved = new Map<string, Array<{ id: string; name: string }>>();
  for (const item of items) {
    const list = collectionsBySaved.get(item.saved_place_id) ?? [];
    list.push({ id: item.collection_id, name: item.name });
    collectionsBySaved.set(item.saved_place_id, list);
  }
  return rows.map((row) => {
    const place = row.id
      ? rowToPlace({ ...row, saved_id: row.saved_place_id }, reviewsEnabled)
      : snapshotToPlace(row.snapshot, row.saved_place_id, row.saved_expires_at);
    return {
      id: row.saved_place_id,
      place,
      note: row.note,
      createdAt: row.saved_at.toISOString(),
      expiresAt: row.saved_expires_at?.toISOString() ?? null,
      collections: collectionsBySaved.get(row.saved_place_id) ?? [],
    };
  });
}

function snapshotToPlace(snapshot: Record<string, unknown>, savedId: string, _expiresAt: Date | null): Place {
  const source = snapshot.source === "serpapi" ? "serpapi" : "osm";
  return {
    id: `snapshot:${savedId}`,
    source,
    sourceType: String(snapshot.sourceType ?? "snapshot"),
    sourceId: String(snapshot.sourceId ?? ""),
    sourceUrl: typeof snapshot.sourceUrl === "string" ? snapshot.sourceUrl : null,
    name: String(snapshot.name ?? "Saved place"),
    address: typeof snapshot.address === "string" ? snapshot.address : null,
    category: typeof snapshot.category === "string" ? snapshot.category : null,
    lat: Number(snapshot.lat ?? 0),
    lon: Number(snapshot.lon ?? 0),
    distanceMeters: null,
    fields: (snapshot.fields as Record<string, unknown> | undefined) ?? {},
    provenance: (snapshot.provenance as Place["provenance"] | undefined) ?? {},
    detailsStatus: "fetched",
    detailsFetchedAt: null,
    retrievedAt: String(snapshot.retrievedAt ?? new Date(0).toISOString()),
    saved: true,
    possibleDuplicate: false,
    reviews: { available: false, fetched: 0, lastFetchedAt: null },
  };
}

export async function fetchSavedPlaceSummaries(): Promise<SavedPlaceSummary[]> {
  const rows = await many<{
    id: string;
    name: string;
    source: string;
    category: string | null;
    address: string | null;
    note: string | null;
    saved_at: Date;
    has_hours: boolean;
    has_popular_times: boolean;
  }>(
    `SELECT sp.id,
            sp.snapshot->>'name' AS name,
            sp.snapshot->>'source' AS source,
            sp.snapshot->>'category' AS category,
            sp.snapshot->>'address' AS address,
            sp.note,
            sp.created_at AS saved_at,
            (sp.snapshot->'fields' ? 'hours') AS has_hours,
            (sp.snapshot->'fields' ? 'popular_times') AS has_popular_times
     FROM saved_places sp
     WHERE (sp.expires_at IS NULL OR sp.expires_at > now())
       AND sp.snapshot->>'source' IN ('osm', 'serpapi')
     ORDER BY sp.created_at DESC`,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name || "Saved place",
    source: row.source === "serpapi" ? "serpapi" : "osm",
    category: row.category,
    address: row.address,
    note: row.note,
    savedAt: row.saved_at.toISOString(),
    hasHours: row.has_hours === true,
    hasPopularTimes: row.has_popular_times === true,
  }));
}

export async function fetchCollections(): Promise<Collection[]> {
  const rows = await many<{
    id: string;
    name: string;
    description: string | null;
    item_count: string;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT c.id, c.name, c.description, count(ci.saved_place_id)::text AS item_count,
            c.created_at, c.updated_at
     FROM collections c
     LEFT JOIN collection_items ci ON ci.collection_id = c.id
     GROUP BY c.id
     ORDER BY c.updated_at DESC`,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    itemCount: Number(row.item_count),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
}

export interface SavedSearchRow {
  id: string;
  name: string;
  criteria: SavedSearch["criteria"];
  refresh_interval_minutes: number;
  last_run_at: Date | null;
  last_run_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export function savedSearchDto(row: SavedSearchRow): SavedSearch {
  return {
    id: row.id,
    name: row.name,
    criteria: row.criteria,
    refreshIntervalMinutes: row.refresh_interval_minutes,
    lastRunAt: row.last_run_at?.toISOString() ?? null,
    lastRunId: row.last_run_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function fetchSavedSearches(): Promise<SavedSearch[]> {
  const rows = await many<SavedSearchRow>("SELECT * FROM saved_searches ORDER BY updated_at DESC");
  return rows.map(savedSearchDto);
}

export async function fetchDuplicates(state?: string): Promise<DuplicateCandidate[]> {
  const rows = await many<{
    id: string;
    state: DuplicateCandidate["state"];
    score: string;
    signals: Record<string, unknown>;
    created_at: Date;
    reviewed_at: Date | null;
    a_id: string;
    a_name: string;
    a_address: string | null;
    a_source: Source;
    a_category: string | null;
    a_lat: number;
    a_lon: number;
    b_id: string;
    b_name: string;
    b_address: string | null;
    b_source: Source;
    b_category: string | null;
    b_lat: number;
    b_lon: number;
  }>(
    `SELECT m.id, m.state, m.score, m.signals, m.created_at, m.reviewed_at,
       a.id AS a_id, a.name AS a_name, a.address AS a_address, a.source AS a_source,
       a.category AS a_category, a.lat AS a_lat, a.lon AS a_lon,
       b.id AS b_id, b.name AS b_name, b.address AS b_address, b.source AS b_source,
       b.category AS b_category, b.lat AS b_lat, b.lon AS b_lon
     FROM place_matches m
     JOIN source_place_records a ON a.id = m.a_source_record_id
     JOIN source_place_records b ON b.id = m.b_source_record_id
     WHERE ($1::text IS NULL OR m.state = $1)
     ORDER BY m.created_at DESC
     LIMIT 500`,
    [state ?? null],
  );
  return rows.map((row) => ({
    id: row.id,
    state: row.state,
    score: Number(row.score),
    signals: row.signals,
    createdAt: row.created_at.toISOString(),
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
    a: { id: row.a_id, name: row.a_name, address: row.a_address, source: row.a_source, category: row.a_category, lat: row.a_lat, lon: row.a_lon },
    b: { id: row.b_id, name: row.b_name, address: row.b_address, source: row.b_source, category: row.b_category, lat: row.b_lat, lon: row.b_lon },
  }));
}

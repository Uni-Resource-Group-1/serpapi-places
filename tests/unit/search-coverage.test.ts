// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoundaryPolygon, SearchCriteria, SourceSummary } from "../../src/shared/types.js";
import type { ParsedPlace } from "../../src/server/sources/types.js";
import { SourceError } from "../../src/server/errors.js";
import { loadConfig } from "../../src/server/config.js";

// The runner imports DB and auditing at module load; never let a unit test open a connection.
const db = vi.hoisted(() => ({ one: vi.fn(), many: vi.fn(), query: vi.fn() }));
const audit = vi.hoisted(() => vi.fn());
vi.mock("../../src/server/db.js", () => db);
vi.mock("../../src/server/services/audit.js", () => ({ audit }));

import { executeSearchRun } from "../../src/server/services/search-runner.js";

const point = (lat: number, lon: number) => ({ lat, lon });
const bounds = { south: 0, west: 0, north: 10, east: 10 };
const shell = [point(0, 0), point(0, 10), point(10, 10), point(10, 7), point(3, 7), point(3, 3), point(10, 3), point(10, 0), point(0, 0)];
const hole = [point(1, 1), point(1, 2), point(2, 2), point(2, 1), point(1, 1)];
const island = [point(12, 12), point(12, 14), point(14, 14), point(14, 12), point(12, 12)];
const polygon: BoundaryPolygon = [[shell, hole], [island]];

const base: SearchCriteria = {
  keyword: "", category: "restaurant", sources: ["osm"], mode: "boundary",
  center: point(1, 1), radiusMeters: 500, bounds,
  country: "Testland", region: "Test region", city: "Test city", area: "Test area",
};

describe("executeSearchRun result retention (offline)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("retains valid returned records beyond the radius, rectangle, and resolved polygon", async () => {
    const config = loadConfig({ APP_ACCESS_KEY: "test-key", NODE_ENV: "test", MAX_AREA_KM2: "3000000" });
    const resolvedBounds = { south: 0, west: 0, north: 14, east: 14 };
    const criteria = { ...base, bounds: resolvedBounds, boundary: { level: "city" as const, name: "Test city", countryCode: "XX" } };
    const returnedPlaces = [place("shell", 5, 2), place("island", 13, 13), place("hole", 1.5, 1.5), place("gap", 11, 11), place("outside", 15, 5)];
    expect(new Set(returnedPlaces.map((item) => item.sourceId)).size).toBe(5);
    const recordedRequests: unknown[][] = [];
    let finalParams: unknown[] | undefined;

    db.one.mockImplementation(async (sql: string) => {
      if (sql === "SELECT * FROM search_runs WHERE id = $1") return {
        id: "run-1", status: "queued", criteria, sources: ["osm"], requested_max_pages: 1,
        requested_max_results: 20, saved_search_id: null, created_by: "test",
      };
      if (sql.includes("status = 'running'") || sql.includes("status = 'capped'")) return null;
      if (sql.includes("SELECT id FROM source_requests") || sql.includes("SELECT id, source FROM source_requests")) return null;
      if (sql.includes("INSERT INTO source_requests")) return { id: "request-1" };
      if (sql.includes("AS total")) return {
        total: "5", osm: "5", serpapi: "0", filtered: "1", duplicates: "0", credits: "0", serpapi_credits: "0",
        osm_requests: "1", serpapi_requests: "0", osm_pages: "1", serpapi_pages: "0",
      };
      throw new Error(`Unexpected DB one: ${sql}`);
    });
    db.many.mockResolvedValue([]);
    db.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("UPDATE source_requests SET")) recordedRequests.push(params);
      if (sql.includes("UPDATE search_runs SET") && sql.includes("status=$2")) finalParams = params;
      return { rows: [], rowCount: 1 };
    });

    const resolveBoundary = vi.fn().mockResolvedValue({
      center: criteria.center, bounds: resolvedBounds, geometry: polygon, relationId: 123, adminLevel: 8,
    });
    const searchOsm = vi.fn().mockResolvedValue({
      places: returnedPlaces, returned: 6, capped: false, sanitizedParams: {}, osmTimestamp: null,
      parseRejections: { unusableCoordinates: 1, missingName: 0, missingIdentifier: 0, other: 0 },
    });
    const saveSourcePlace = vi.fn(async (record: ParsedPlace) => ({ id: record.sourceId }));
    const addRunPlace = vi.fn().mockResolvedValue(true);
    const findAndRecordMatch = vi.fn().mockResolvedValue(undefined);
    await executeSearchRun("run-1", config, { resolveBoundary, searchOsm, saveSourcePlace, addRunPlace, findAndRecordMatch });
    expect(findAndRecordMatch).toHaveBeenCalledTimes(5);

    expect(saveSourcePlace.mock.calls.map(([record]) => record.sourceId)).toEqual(["shell", "island", "hole", "gap", "outside"]);
    expect(addRunPlace).toHaveBeenCalledTimes(5);
    expect(recordedRequests[0]?.slice(1, 7)).toEqual(["success", 200, 6, 5, 1, 0]);
    expect(recordedRequests[0]?.[12]).toBe(JSON.stringify({ missingCoordinates: 1, invalidRecord: 0, outsideArea: 0, outsidePolygon: 0 }));
    expect(finalParams?.slice(1, 7)).toEqual(["completed", "within_limits", 5, 1, 0, false]);
    const summaries = (JSON.parse(finalParams?.[14] as string) as { sources: SourceSummary[] }).sources;
    expect(summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "osm", results: 6, kept: 5, filteredOut: 1, exclusions: { missingCoordinates: 1, invalidRecord: 0, outsideArea: 0, outsidePolygon: 0 } }),
    ]));
    expect(JSON.parse(finalParams?.[15] as string).join(" ")).toContain("1 missing/invalid coordinates");
    expect(JSON.parse(finalParams?.[15] as string).join(" ")).not.toContain("were filtered");
  });
});

function place(sourceId: string, lat: number, lon: number): ParsedPlace {
  return {
    source: "osm", sourceType: "osm_node", sourceId, sourceUrl: null, name: sourceId,
    address: null, category: null, lat, lon, fields: {}, provenance: {}, detailsStatus: "not_fetched",
  };
}

describe("executeSearchRun polygon accounting (offline)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects a resolved boundary over the configured area limit before dispatching any provider search", async () => {
    const config = loadConfig({ APP_ACCESS_KEY: "test-key", NODE_ENV: "test" });
    const criteria = { ...base, boundary: { level: "city" as const, name: "Test city", countryCode: "XX" } };
    db.one.mockResolvedValueOnce({ id: "run-large", status: "queued", criteria, sources: ["osm", "serpapi"], requested_max_pages: 6,
      requested_max_results: 100, saved_search_id: null, created_by: "test" }).mockResolvedValueOnce(null);
    const resolveBoundary = vi.fn().mockResolvedValue({ center: point(1, 1), bounds: { south: 0, west: 0, north: 10, east: 10 },
      geometry: polygon, relationId: 42, adminLevel: 8, name: "Test city" });
    const searchOsm = vi.fn();
    const searchSerpApiPage = vi.fn();
    await executeSearchRun("run-large", config, { resolveBoundary, searchOsm, searchSerpApiPage });
    expect(searchOsm).not.toHaveBeenCalled();
    expect(searchSerpApiPage).not.toHaveBeenCalled();
    expect(db.query.mock.calls).toContainEqual([expect.stringContaining("status = 'failed'"),
      expect.arrayContaining(["run-large", expect.stringContaining("boundary_too_large")])]);
  });

  it("does not fabricate a center when OSM boundary geometry and source location data are unavailable", async () => {
    const config = loadConfig({ APP_ACCESS_KEY: "test-key", NODE_ENV: "test" });
    const criteria: SearchCriteria = {
      ...base,
      center: null,
      bounds: null,
      boundary: { level: "city", name: "Centerless City", countryCode: "XX", center: null, bounds: null },
    };
    db.one.mockImplementation(async (sql: string) => {
      if (sql === "SELECT * FROM search_runs WHERE id = $1") return {
        id: "run-centerless", status: "queued", criteria, sources: ["osm"], requested_max_pages: 1,
        requested_max_results: 20, saved_search_id: null, created_by: "test",
      };
      if (sql.includes("status = 'running'") || sql.includes("status = 'capped'")) return null;
      if (sql.includes("SELECT id FROM source_requests") || sql.includes("SELECT id, source FROM source_requests")) return null;
      if (sql.includes("INSERT INTO source_requests")) return { id: "request-centerless" };
      if (sql.includes("AS total") && sql.includes("serpapi_pages")) return {
        total: "0", osm: "0", serpapi: "0", filtered: "0", duplicates: "0", credits: "0", serpapi_credits: "0",
        osm_requests: "1", serpapi_requests: "0", osm_pages: "1", serpapi_pages: "0",
      };
      throw new Error(`Unexpected DB one: ${sql}`);
    });
    db.many.mockResolvedValue([]);
    db.query.mockImplementation(async () => ({ rows: [], rowCount: 1 }));
    const resolveBoundary = vi.fn().mockResolvedValue(null);
    const searchOsm = vi.fn().mockRejectedValue(new SourceError("invalid_area", "no center or bounds"));
    await executeSearchRun("run-centerless", config, { resolveBoundary, searchOsm });
    expect(resolveBoundary).toHaveBeenCalledOnce();
    expect(searchOsm).not.toHaveBeenCalled();
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes("status = 'failed'"))).toBe(true);
    expect(db.query.mock.calls.some(([sql, params]) => String(sql).includes("boundary_unavailable") || JSON.stringify(params).includes("No location-based search could be performed"))).toBe(true);
  });

  it("preserves the selected center when OSM resolves bounds but no center", async () => {
    const config = loadConfig({ APP_ACCESS_KEY: "test-key", NODE_ENV: "test", MAX_AREA_KM2: "10000000" });
    const selectedCenter = point(5, 5);
    const criteria = {
      ...base,
      center: selectedCenter,
      bounds: null,
      boundary: { level: "city" as const, name: "Centerless City", countryCode: "XX", center: selectedCenter },
    };
    db.many.mockResolvedValue([]);
    db.query.mockImplementation(async () => ({ rows: [], rowCount: 1 }));
    db.one.mockImplementation(async (sql: string) => {
      if (sql === "SELECT * FROM search_runs WHERE id = $1") return {
        id: "run-preserve-center", status: "queued", criteria, sources: ["osm"], requested_max_pages: 1,
        requested_max_results: 20, saved_search_id: null, created_by: "test",
      };
      if (sql.includes("status = 'running'") || sql.includes("status = 'capped'")) return null;
      if (sql.includes("SELECT id FROM source_requests") || sql.includes("SELECT id, source FROM source_requests")) return null;
      if (sql.includes("INSERT INTO source_requests")) return { id: "request-preserve-center" };
      if (sql.includes("AS total") && sql.includes("serpapi_pages")) return {
        total: "0", osm: "0", serpapi: "0", filtered: "0", duplicates: "0", credits: "0", serpapi_credits: "0",
        osm_requests: "1", serpapi_requests: "0", osm_pages: "1", serpapi_pages: "0",
      };
      throw new Error(`Unexpected DB one: ${sql}`);
    });
    const resolveBoundary = vi.fn().mockResolvedValue({
      relationId: 42, areaId: 3_600_000_042, adminLevel: 8, name: "Centerless City", center: null,
      bounds: { south: 0, west: 0, north: 10, east: 10 }, geometry: null,
    });
    const searchOsm = vi.fn().mockResolvedValue({ places: [], returned: 0, capped: false, sanitizedParams: {}, osmTimestamp: null });
    await executeSearchRun("run-preserve-center", config, { resolveBoundary, searchOsm });
    expect(searchOsm).toHaveBeenCalledWith(expect.objectContaining({ center: selectedCenter, bounds: { south: 0, west: 0, north: 10, east: 10 } }), expect.anything());
  });

  it("reports GeoNames bounds as approximate, while preserving an explicit map rectangle source", async () => {
    const config = loadConfig({ APP_ACCESS_KEY: "test-key", NODE_ENV: "test", MAX_AREA_KM2: "10000000" });
    for (const [source, expectText] of [["map", "explicitly selected map rectangle"]] as const) {
      vi.resetAllMocks();
      const criteria = {
        ...base,
        bounds,
        boundary: { level: "city" as const, name: "Test city", countryCode: "XX", bounds },
        boundaryResolution: source === "map" ? {
          relationId: null, name: null, adminLevel: null, precision: "bbox" as const,
          boundsSource: "map" as const, reason: "Explicit rectangle", geometryHash: null, ringCount: null,
          vertexCount: null, osmTimestamp: null,
        } : null,
      };
      db.one.mockImplementation(async (sql: string) => {
        if (sql === "SELECT * FROM search_runs WHERE id = $1") return {
          id: `run-${source}`, status: "queued", criteria, sources: ["osm"], requested_max_pages: 1,
          requested_max_results: 20, saved_search_id: null, created_by: "test",
        };
        if (sql.includes("status = 'running'") || sql.includes("status = 'capped'")) return null;
        if (sql.includes("SELECT id FROM source_requests") || sql.includes("SELECT id, source FROM source_requests")) return null;
        if (sql.includes("INSERT INTO source_requests")) return { id: "request-fallback" };
        if (sql.includes("AS total") && sql.includes("serpapi_pages")) return {
          total: "0", osm: "0", serpapi: "0", filtered: "0", duplicates: "0", credits: "0", serpapi_credits: "0",
          osm_requests: "1", serpapi_requests: "0", osm_pages: "1", serpapi_pages: "0",
        };
        throw new Error(`Unexpected DB one: ${sql}`);
      });
      db.many.mockResolvedValue([]);
      let finalParams: unknown[] | undefined;
      db.query.mockImplementation(async (sql: string, params: unknown[]) => {
        if (sql.includes("UPDATE search_runs SET")) finalParams = params;
        return { rows: [], rowCount: 1 };
      });
      const resolveBoundary = vi.fn().mockResolvedValue(null);
      const searchOsm = vi.fn().mockResolvedValue({ places: [], returned: 0, capped: false, sanitizedParams: {}, osmTimestamp: null });
      db.one.mockImplementation(async (sql: string) => {
        if (sql === "SELECT * FROM search_runs WHERE id = $1") return {
          id: `run-${source}`, status: "queued", criteria, sources: ["osm"], requested_max_pages: 1,
          requested_max_results: 20, saved_search_id: null, created_by: "test",
        };
        if (sql.includes("status = 'running'") || sql.includes("status = 'capped'")) return null;
        if (sql.includes("SELECT id FROM source_requests") || sql.includes("SELECT id, source FROM source_requests")) return null;
        if (sql.includes("INSERT INTO source_requests")) return { id: "request-fallback" };
        if (sql.includes("AS total") && sql.includes("serpapi_pages")) return {
          total: "0", osm: "0", serpapi: "0", filtered: "0", duplicates: "0", credits: "0", serpapi_credits: "0",
          osm_requests: "1", serpapi_requests: "0", osm_pages: "1", serpapi_pages: "0",
        };
        throw new Error(`Unexpected DB one: ${sql}`);
      });
      await executeSearchRun(`run-${source}`, config, { resolveBoundary, searchOsm });
      expect(JSON.parse(finalParams?.[15] as string).join(" ")).toContain(expectText);
      const stored = JSON.parse(finalParams?.[14] as string);
      expect(stored.boundaryResolution.boundsSource).toBe(source);
    }
  });

  it("keeps map-bound provenance separate when OSM polygon succeeds and retains every valid returned point", async () => {
    const config = loadConfig({ APP_ACCESS_KEY: "test-key", NODE_ENV: "test", MAX_AREA_KM2: "3000000" });
    const selectedBounds = { south: 0, west: 0, north: 10, east: 10 };
    const criteria = {
      ...base,
      bounds: selectedBounds,
      boundary: { level: "city" as const, name: "Test city", countryCode: "XX", bounds: selectedBounds },
      boundaryResolution: {
        relationId: null, name: null, adminLevel: null, precision: "bbox" as const,
        boundsSource: "map" as const, reason: "Explicit rectangle", geometryHash: null, ringCount: null,
        vertexCount: null, osmTimestamp: null,
      },
    };
    let finalParams: unknown[] | undefined;
    db.one.mockImplementation(async (sql: string) => {
      if (sql === "SELECT * FROM search_runs WHERE id = $1") return {
        id: "run-map-polygon", status: "queued", criteria, sources: ["osm"], requested_max_pages: 1,
        requested_max_results: 20, saved_search_id: null, created_by: "test",
      };
      if (sql.includes("status = 'running'") || sql.includes("status = 'capped'")) return null;
      if (sql.includes("SELECT id FROM source_requests") || sql.includes("SELECT id, source FROM source_requests")) return null;
      if (sql.includes("INSERT INTO source_requests")) return { id: "request-map-polygon" };
      if (sql.includes("AS total") && sql.includes("serpapi_pages")) return {
        total: "1", osm: "1", serpapi: "0", filtered: "1", duplicates: "0", credits: "0", serpapi_credits: "0",
        osm_requests: "1", serpapi_requests: "0", osm_pages: "1", serpapi_pages: "0",
      };
      throw new Error(`Unexpected DB one: ${sql}`);
    });
    db.many.mockResolvedValue([]);
    db.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("UPDATE search_runs SET") && sql.includes("status=$2")) finalParams = params;
      return { rows: [], rowCount: 1 };
    });
    const resolveBoundary = vi.fn().mockResolvedValue({
      center: point(5, 5), bounds: selectedBounds, geometry: polygon, relationId: 123, adminLevel: 8, name: "Test city",
    });
    const searchOsm = vi.fn().mockResolvedValue({
      places: [place("inside", 5, 2), place("bbox-only", 5, 5)], returned: 2, capped: false, sanitizedParams: {}, osmTimestamp: null,
    });
    const saveSourcePlace = vi.fn(async (record: ParsedPlace) => ({ id: record.sourceId }));
    const addRunPlace = vi.fn().mockResolvedValue(true);
    const findAndRecordMatch = vi.fn().mockResolvedValue(undefined);
    await executeSearchRun("run-map-polygon", config, { resolveBoundary, searchOsm, saveSourcePlace, addRunPlace, findAndRecordMatch });

    expect(saveSourcePlace.mock.calls.map(([record]) => record.sourceId)).toEqual(["inside", "bbox-only"]);
    expect(JSON.parse(finalParams?.[14] as string).boundaryResolution).toMatchObject({
      precision: "polygon", boundsSource: "osm", selectedBoundsSource: "map",
    });
    const summaries = (JSON.parse(finalParams?.[14] as string) as { sources: SourceSummary[] }).sources;
    expect(summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "osm", kept: 2, boundaryPrecision: "polygon", exclusions: expect.objectContaining({ outsidePolygon: 0 }) }),
    ]));
    const caveats = JSON.parse(finalParams?.[15] as string).join(" ");
    expect(caveats).not.toContain("map rectangle was used");
    expect(caveats).toContain("resolved OpenStreetMap administrative polygon");
  });

  it("persists parse exclusions while retaining all valid places regardless of search area", async () => {
    const config = loadConfig({ APP_ACCESS_KEY: "test-key", NODE_ENV: "test", MAX_AREA_KM2: "3000000" });
    const resolvedBounds = { south: 0, west: 0, north: 14, east: 14 };
    const criteria = { ...base, bounds: resolvedBounds, boundary: { level: "city" as const, name: "Test city", countryCode: "XX" } };
    const returnedPlaces = [place("shell", 5, 2), place("island", 13, 13), place("hole", 1.5, 1.5), place("gap", 11, 11), place("outside", 15, 5)];
    const recordedRequests: unknown[][] = [];
    let finalSql: string | undefined;
    let finalParams: unknown[] | undefined;

    db.one.mockImplementation(async (sql: string) => {
      if (sql === "SELECT * FROM search_runs WHERE id = $1") return {
        id: "run-1", status: "queued", criteria, sources: ["osm"], requested_max_pages: 1,
        requested_max_results: 20, saved_search_id: null, created_by: "test",
      };
      if (sql.includes("status = 'running'") || sql.includes("status = 'capped'")) return null;
      if (sql.includes("SELECT id FROM source_requests") || sql.includes("SELECT id, source FROM source_requests")) return null;
      if (sql.includes("INSERT INTO source_requests")) return { id: "request-1" };
      if (sql.includes("SELECT\n") && sql.includes("AS total")) return {
        total: "2", osm: "2", serpapi: "0", filtered: "4", duplicates: "0", credits: "0", serpapi_credits: "0",
        osm_requests: "1", serpapi_requests: "0", osm_pages: "1", serpapi_pages: "0",
      };
      throw new Error(`Unexpected DB one: ${sql}`);
    });
    db.many.mockResolvedValue([{
      source: "osm", kept: "2", filtered: "4", duplicates: "0", results: "6",
      exclusions: { missingCoordinates: 1, invalidRecord: 0, outsideArea: 0, outsidePolygon: 3 },
      requests: "1", pages: "1", credits: "0",
    }]);
    db.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("UPDATE source_requests SET")) recordedRequests.push(params);
      if (sql.includes("UPDATE search_runs SET") && sql.includes("status=$2")) {
        finalSql = sql;
        finalParams = params;
      }
      return { rows: [], rowCount: 1 };
    });

    const resolveBoundary = vi.fn().mockResolvedValue({
      center: criteria.center, bounds: resolvedBounds, geometry: polygon, relationId: 123, adminLevel: 8,
    });
    const searchOsm = vi.fn().mockResolvedValue({
      places: returnedPlaces, returned: 6, capped: false, sanitizedParams: {}, osmTimestamp: null,
      parseRejections: { unusableCoordinates: 1, missingName: 0, missingIdentifier: 0, other: 0 },
    });
    const saveSourcePlace = vi.fn(async (record: ParsedPlace) => ({ id: record.sourceId }));
    const addRunPlace = vi.fn().mockResolvedValue(true);
    const findAndRecordMatch = vi.fn().mockResolvedValue(undefined);
    await executeSearchRun("run-1", config, { resolveBoundary, searchOsm, saveSourcePlace, addRunPlace, findAndRecordMatch });

    expect(resolveBoundary).toHaveBeenCalledOnce();
    expect(searchOsm).toHaveBeenCalledOnce();
    expect(saveSourcePlace.mock.calls.map(([record]) => record.sourceId)).toEqual(["shell", "island", "hole", "gap", "outside"]);
    expect(addRunPlace).toHaveBeenCalledTimes(5);
    expect(findAndRecordMatch).toHaveBeenCalledTimes(5);
    expect(recordedRequests).toHaveLength(1);
    expect(recordedRequests[0]?.slice(1, 7)).toEqual(["success", 200, 6, 5, 1, 0]);
    expect(JSON.parse(recordedRequests[0]?.[12] as string)).toEqual({
      missingCoordinates: 1, invalidRecord: 0, outsideArea: 0, outsidePolygon: 0,
    });
    expect(finalParams?.slice(1, 7)).toEqual(["completed", "within_limits", 5, 1, 0, false]);
    expect(finalSql).toContain("credits_estimated = $8::integer");
    expect(finalSql).toContain("source_summaries=$21::jsonb");
    expect(finalSql).not.toMatch(/\$\d+\s*\*\s*\$\d+/);
    expect(finalParams).toHaveLength(21);
    expect(JSON.parse(finalParams?.[14] as string)).toMatchObject({
      boundaryResolution: { relationId: 123, adminLevel: 8, precision: "polygon", ringCount: 3, vertexCount: 19 },
    });
    expect(JSON.parse(finalParams?.[14] as string)).not.toHaveProperty("geometry");
    expect(finalParams?.slice(16, 19)).toEqual([criteria.center?.lat, criteria.center?.lon, JSON.stringify(resolvedBounds)]);
    const summaries = (JSON.parse(finalParams?.[14] as string) as { sources: SourceSummary[] }).sources;
    expect(JSON.parse(finalParams?.[20] as string)).toEqual(summaries);
    expect(summaries.find((summary) => summary.source === "osm")).toMatchObject({
      status: "ok", results: 6, kept: 5, filteredOut: 1, boundaryPrecision: "polygon",
      exclusions: { missingCoordinates: 1, invalidRecord: 0, outsideArea: 0, outsidePolygon: 0 },
    });
    expect(summaries).toHaveLength(1);
    expect(JSON.parse(finalParams?.[15] as string)).toContain("Excluded returned records: 1 missing/invalid coordinates. Duplicates are counted separately.");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "search_run.finished", metadata: expect.objectContaining({ results: 5 }) }));
  });
});

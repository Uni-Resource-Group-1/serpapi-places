// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchCriteria } from "../../src/shared/types.js";
import type { ParsedPlace } from "../../src/server/sources/types.js";
import { loadConfig } from "../../src/server/config.js";

// The runner imports DB and auditing at module load; never let a unit test open a connection.
const db = vi.hoisted(() => ({ one: vi.fn(), many: vi.fn(), query: vi.fn() }));
const audit = vi.hoisted(() => vi.fn());
vi.mock("../../src/server/db.js", () => db);
vi.mock("../../src/server/services/audit.js", () => ({ audit }));
vi.mock("../../src/server/services/usage.js", () => ({
  reserveSerpApiCalls: vi.fn().mockResolvedValue({ allowed: true, monthUsed: 1, dayUsed: 1, monthLimit: 100, dayLimit: 50 }),
}));

import { executeSearchRun } from "../../src/server/services/search-runner.js";

const config = loadConfig({ APP_ACCESS_KEY: "test-key", NODE_ENV: "test" });

function mockRunDb(criteria: SearchCriteria, sources: SearchCriteria["sources"], counts: Record<string, string>) {
  db.one.mockImplementation(async (sql: string) => {
    if (sql === "SELECT * FROM search_runs WHERE id = $1") {
      return {
        id: "run-1",
        status: "queued",
        criteria,
        sources,
        requested_max_pages: 1,
        requested_max_results: 20,
        saved_search_id: null,
        created_by: "test",
      };
    }
    if (sql.includes("status = 'running'") || sql.includes("status = 'capped'")) return null;
    if (sql.includes("SELECT id FROM source_requests") || sql.includes("SELECT id, source FROM source_requests")) return null;
    if (sql.includes("INSERT INTO source_requests")) return { id: "request-1" };
    if (sql.includes("AS total")) return counts;
    throw new Error(`Unexpected DB one: ${sql}`);
  });
  db.many.mockResolvedValue([]);
  db.query.mockImplementation(async () => ({ rows: [], rowCount: 1 }));
}

function place(sourceId: string, lat: number, lon: number): ParsedPlace {
  return {
    source: "osm",
    sourceType: "osm_node",
    sourceId,
    sourceUrl: null,
    name: sourceId,
    address: null,
    category: null,
    lat,
    lon,
    fields: {},
    provenance: {},
    detailsStatus: "not_fetched",
  };
}

describe("executeSearchRun containment labelling (offline)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("labels every retained record inside or outside the selected radius without discarding any", async () => {
    const criteria: SearchCriteria = {
      keyword: "",
      category: "restaurant",
      sources: ["osm"],
      mode: "radius",
      center: { lat: 0, lon: 0 },
      radiusMeters: 500,
      bounds: null,
      country: "Testland",
      region: "Test region",
      city: "Test city",
      area: "Test area",
    };
    mockRunDb(criteria, ["osm"], {
      total: "2",
      osm: "2",
      serpapi: "0",
      filtered: "0",
      duplicates: "0",
      credits: "0",
      serpapi_credits: "0",
      osm_requests: "1",
      serpapi_requests: "0",
      osm_pages: "1",
      serpapi_pages: "0",
    });

    const searchOsm = vi.fn().mockResolvedValue({
      places: [place("inside", 0, 0), place("outside", 0.01, 0)],
      returned: 2,
      capped: false,
      sanitizedParams: {},
      osmTimestamp: null,
    });
    const saveSourcePlace = vi.fn(async (record: ParsedPlace) => ({ id: record.sourceId }));
    const addRunPlace = vi.fn().mockResolvedValue(true);
    const findAndRecordMatch = vi.fn().mockResolvedValue(undefined);
    const searchSerpApiPage = vi.fn();

    await executeSearchRun("run-1", config, {
      resolveBoundary: vi.fn(),
      searchOsm,
      searchSerpApiPage,
      getSerpApiDetails: vi.fn(),
      saveSourcePlace,
      addRunPlace,
      findAndRecordMatch,
    });

    expect(searchSerpApiPage).not.toHaveBeenCalled();
    expect(saveSourcePlace).toHaveBeenCalledTimes(2);
    expect(addRunPlace).toHaveBeenCalledTimes(2);
    expect(addRunPlace.mock.calls.map((call) => call[4])).toEqual([
      { insideArea: true, areaCheck: "radius" },
      { insideArea: false, areaCheck: "radius" },
    ]);
  });
});

describe("executeSearchRun known-place import (offline)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves the supplied place id through SerpApi details and never runs a ranked search", async () => {
    const criteria: SearchCriteria = {
      keyword: "",
      category: "restaurant",
      sources: ["serpapi"],
      mode: "radius",
      center: null,
      radiusMeters: 0,
      bounds: null,
      country: "Bangladesh",
      countryCode: "BD",
      region: "Dhaka Division",
      city: "Dhaka",
      area: "Dhanmondi",
      plan: "import",
      importRefs: [{ kind: "place_id", value: "ChIJknownPlaceId123" }],
    };
    mockRunDb(criteria, ["serpapi"], {
      total: "1",
      osm: "0",
      serpapi: "1",
      filtered: "0",
      duplicates: "0",
      credits: "1",
      serpapi_credits: "1",
      osm_requests: "0",
      serpapi_requests: "1",
      osm_pages: "0",
      serpapi_pages: "1",
    });

    const getSerpApiDetails = vi.fn().mockResolvedValue({
      fields: { title: "Imported Cafe", place_id: "ChIJknownPlaceId123" },
      provenance: { title: { source: "serpapi", retrievedAt: "2026-01-01T00:00:00.000Z" } },
      name: "Imported Cafe",
      address: "1 Example Road",
      category: "Cafe",
      lat: 23.78,
      lon: 90.41,
    });
    const saveSourcePlace = vi.fn(async (record: ParsedPlace) => ({ id: record.sourceId }));
    const addRunPlace = vi.fn().mockResolvedValue(true);
    const findAndRecordMatch = vi.fn().mockResolvedValue(undefined);
    const searchSerpApiPage = vi.fn();

    await executeSearchRun("run-1", config, {
      resolveBoundary: vi.fn(),
      searchOsm: vi.fn(),
      searchSerpApiPage,
      getSerpApiDetails,
      saveSourcePlace,
      addRunPlace,
      findAndRecordMatch,
    });

    expect(searchSerpApiPage).not.toHaveBeenCalled();
    expect(getSerpApiDetails).toHaveBeenCalledTimes(1);
    expect(getSerpApiDetails).toHaveBeenCalledWith({ place_id: "ChIJknownPlaceId123" }, expect.anything());
    expect(saveSourcePlace).toHaveBeenCalledTimes(1);
    expect(saveSourcePlace.mock.calls[0]?.[0]).toMatchObject({
      source: "serpapi",
      sourceId: "place_id:ChIJknownPlaceId123",
      name: "Imported Cafe",
      detailsStatus: "fetched",
    });
    expect(addRunPlace).toHaveBeenCalledTimes(1);
    // Imported records have no selected area to compare against, so containment stays unknown.
    expect(addRunPlace.mock.calls[0]?.[4]).toBeNull();
  });
});

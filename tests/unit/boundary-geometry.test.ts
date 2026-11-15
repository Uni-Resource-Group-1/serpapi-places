// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { pointInPolygon } from "../../src/shared/geo.js";
import { buildBoundaryLookupQuery, clearBoundaryCache, extractBoundaryGeometry, resolveBoundary } from "../../src/server/geo/boundary.js";
import type { AppConfig } from "../../src/server/config.js";

const point = (lat: number, lon: number) => ({ lat, lon });
const way = (ref: number, role: string, geometry: ReturnType<typeof point>[]) => ({ type: "way", ref, role, geometry });
const shell = [point(0, 0), point(0, 10), point(10, 10), point(10, 0), point(0, 0)];
const hole = [point(3, 3), point(3, 7), point(7, 7), point(7, 3), point(3, 3)];
const relation = (members: unknown[]) => ({ type: "relation", id: 42, members });

function geometry(members: unknown[]) {
  return extractBoundaryGeometry(relation(members));
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearBoundaryCache();
});

describe("OSM relation geometry", () => {
  it("rejects nested relation geometry even when remaining outer ways form a closed ring", () => {
    expect(geometry([way(1, "outer", shell), { type: "relation", role: "subarea", ref: 100 }])).toBeNull();
  });

  it("rejects invalid coordinate bounds from a lookup candidate", async () => {
    const response = (elements: unknown[]) => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ elements }) });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([
      { type: "relation", id: 42, tags: { admin_level: "8", name: "Town" }, bounds: { minlat: 10, minlon: 0, maxlat: 0, maxlon: 10 } },
    ])));
    const config = { osm: { overpassUrl: "https://example.invalid/overpass", userAgent: "test", timeoutMs: 100 } } as AppConfig;
    expect(await resolveBoundary({ level: "city", name: "Town", countryCode: "XX" }, config)).toBeNull();
  });

  it("constrains centered matches to the selected country and escapes names for Overpass regex", () => {
    const query = buildBoundaryLookupQuery({ level: "city", name: 'A (B)."', countryCode: "BD", center: point(1, 1) });
    expect(query).toContain('area["ISO3166-1"="BD"]->.c;');
    expect(query).toContain('rel(area.c)');
    expect(query).toContain('A \\\\(B\\\\)\\\\.\\"');
  });
  it("stitches reversed ways, assigns holes to their shell, and includes detached shells", () => {
    const result = geometry([
      way(1, "outer", shell.slice(0, 3)),
      way(2, "outer", shell.slice(2).reverse()),
      way(3, "inner", hole.slice(0, 3).reverse()),
      way(4, "inner", hole.slice(2).reverse()),
      way(5, "outer", [point(20, 20), point(20, 22), point(22, 22), point(22, 20), point(20, 20)]),
      { type: "node", role: "label", ref: 8 },
    ]);
    expect(result).toHaveLength(2);
    expect(result?.[0]).toHaveLength(2);
    expect(pointInPolygon(point(2, 2), result!)).toBe(true);
    expect(pointInPolygon(point(5, 5), result!)).toBe(false);
    expect(pointInPolygon(point(21, 21), result!)).toBe(true);
    expect(pointInPolygon(point(15, 15), result!)).toBe(false);
  });

  it("rejects dangling, ambiguous, malformed and oversized topology instead of returning a partial polygon", () => {
    expect(geometry([way(1, "outer", shell.slice(0, 3))])).toBeNull();
    expect(geometry([way(1, "outer", shell), way(2, "outer", shell.slice(0, 3))])).toBeNull();
    expect(geometry([way(1, "outer", shell), way(2, "inner", [point(20, 20), point(20, 21), point(21, 20), point(20, 20)])])).toBeNull();
    expect(geometry([way(1, "outer", shell), way(2, "inner", hole.slice(0, 3))])).toBeNull();
    expect(geometry([way(1, "outer", shell), way(2, "outer", [point(2, 2), point(2, 4), point(4, 4), point(4, 2), point(2, 2)])])).toBeNull();
    expect(geometry([way(1, "outer", [point(0, 0), point(10, 10), point(0, 10), point(10, 0), point(0, 0)])])).toBeNull();
    expect(geometry([way(1, "", shell)])).toBeNull();
    expect(geometry([way(1, "outer", shell), { type: "relation", role: "outer", ref: 3 }])).toBeNull();
    expect(geometry([way(1, "outer", [...shell.slice(0, 2), point(NaN, 10), ...shell.slice(3)])])).toBeNull();
    expect(geometry([way(1, "outer", Array.from({ length: 50_001 }, (_, i) => point(i % 2, i % 2)))])).toBeNull();
  });

  it("retries transient geometry failures instead of caching their approximate fallback", async () => {
    const response = (elements: unknown[], remark?: string) => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ elements, remark }) });
    const lookup = () => response([{ type: "relation", id: 42, tags: { admin_level: "8", name: "Town" }, bounds: { minlat: 0, minlon: 0, maxlat: 10, maxlon: 10 } }]);
    const fetchMock = vi.fn().mockResolvedValueOnce(lookup()).mockResolvedValueOnce(response([], "runtime error: timeout"))
      .mockResolvedValueOnce(lookup()).mockResolvedValueOnce(response([relation([way(1, "outer", shell)])]));
    vi.stubGlobal("fetch", fetchMock);
    const config = { osm: { overpassUrl: "https://example.invalid/overpass", userAgent: "test", timeoutMs: 100 } } as AppConfig;
    const ref = { level: "city" as const, name: "Town", countryCode: "XX", center: point(5, 5) };
    expect((await resolveBoundary(ref, config))?.geometry).toBeNull();
    expect((await resolveBoundary(ref, config))?.geometry).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("rejects ambiguous same-name candidates without a selected center", async () => {
    const response = (elements: unknown[]) => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ elements }) });
    const fetchMock = vi.fn().mockResolvedValue(response([
      { type: "relation", id: 42, tags: { admin_level: "8", name: "Town" }, bounds: { minlat: 0, minlon: 0, maxlat: 10, maxlon: 10 } },
      { type: "relation", id: 43, tags: { admin_level: "8", name: "Town" }, bounds: { minlat: 20, minlon: 20, maxlat: 30, maxlon: 30 } },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const config = { osm: { overpassUrl: "https://example.invalid/overpass", userAgent: "test", timeoutMs: 100 } } as AppConfig;
    expect(await resolveBoundary({ level: "city", name: "Town", countryCode: "XX" }, config)).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects multiple plausible same-name candidates at different admin levels without a center", async () => {
    const response = (elements: unknown[]) => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ elements }) });
    const fetchMock = vi.fn().mockResolvedValue(response([
      { type: "relation", id: 42, tags: { admin_level: "8", name: "Town" }, bounds: { minlat: 0, minlon: 0, maxlat: 10, maxlon: 10 } },
      { type: "relation", id: 43, tags: { admin_level: "6", name: "Town" }, bounds: { minlat: 1, minlon: 1, maxlat: 9, maxlon: 9 } },
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const config = { osm: { overpassUrl: "https://example.invalid/overpass", userAgent: "test", timeoutMs: 100 } } as AppConfig;
    expect(await resolveBoundary({ level: "city", name: "Town", countryCode: "XX" }, config)).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("preserves absent Overpass and GeoNames centers instead of fabricating a bounding-box center", async () => {
    const response = (elements: unknown[]) => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ elements }) });
    const fetchMock = vi.fn().mockResolvedValueOnce(response([
      { type: "relation", id: 42, tags: { admin_level: "8", name: "Town" }, bounds: { minlat: 0, minlon: 0, maxlat: 10, maxlon: 10 } },
    ])).mockResolvedValueOnce(response([relation([way(1, "outer", shell)])]));
    vi.stubGlobal("fetch", fetchMock);
    const config = { osm: { overpassUrl: "https://example.invalid/overpass", userAgent: "test", timeoutMs: 100 } } as AppConfig;
    const result = await resolveBoundary({ level: "city", name: "Town", countryCode: "XX" }, config);
    expect(result).toMatchObject({ center: null, bounds: { south: 0, west: 0, north: 10, east: 10 } });
  });

  it("does not cache an incomplete boundary lookup remark", async () => {
    const response = (elements: unknown[], remark?: string) => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ elements, remark }) });
    const fetchMock = vi.fn().mockResolvedValueOnce(response([], "runtime error: timeout"))
      .mockResolvedValueOnce(response([{ type: "relation", id: 42, tags: { admin_level: "8", name: "Town" }, bounds: { minlat: 0, minlon: 0, maxlat: 10, maxlon: 10 } }]))
      .mockResolvedValueOnce(response([relation([way(1, "outer", shell)])]));
    vi.stubGlobal("fetch", fetchMock);
    const config = { osm: { overpassUrl: "https://example.invalid/overpass", userAgent: "test", timeoutMs: 100 } } as AppConfig;
    const ref = { level: "city" as const, name: "Town", countryCode: "XX", center: point(5, 5) };
    expect(await resolveBoundary(ref, config)).toBeNull();
    expect((await resolveBoundary(ref, config))?.geometry).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fetches only selected relation geometry and caches a null geometry fallback", async () => {
    const response = (elements: unknown[]) => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ elements }) });
    const fetchMock = vi.fn().mockResolvedValueOnce(response([
      { type: "relation", id: 42, tags: { admin_level: "8", name: "Town" }, bounds: { minlat: 0, minlon: 0, maxlat: 10, maxlon: 10 } },
    ])).mockResolvedValueOnce(response([relation([way(1, "outer", shell)])]));
    vi.stubGlobal("fetch", fetchMock);
    const config = { osm: { overpassUrl: "https://example.invalid/overpass", userAgent: "test", timeoutMs: 100 } } as AppConfig;
    const ref = { level: "city" as const, name: "Town", countryCode: "XX", center: point(5, 5) };
    const result = await resolveBoundary(ref, config);
    expect(result?.geometry).toHaveLength(1);
    expect(decodeURIComponent(fetchMock.mock.calls[1]![1].body)).toContain("relation(42);out body geom;");
    await resolveBoundary(ref, config);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    clearBoundaryCache();
    fetchMock.mockResolvedValueOnce(response([
      { type: "relation", id: 42, tags: { admin_level: "8" }, bounds: { minlat: 0, minlon: 0, maxlat: 10, maxlon: 10 } },
    ])).mockRejectedValueOnce(new Error("offline"));
    const fallback = await resolveBoundary(ref, config);
    expect(fallback?.relationId).toBe(42);
    expect(fallback?.geometry).toBeNull();
  });
});

// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/server/sources/http.js", () => ({ requestJson: vi.fn() }));

import { requestJson } from "../../src/server/sources/http.js";
import { loadConfig } from "../../src/server/config.js";
import { buildOverpassQuery, parseOsmElement, searchOsm } from "../../src/server/sources/osm.js";
import type { SearchCriteria } from "../../src/shared/types.js";

const base: SearchCriteria = {
  keyword: "",
  category: "restaurant",
  sources: ["osm"],
  mode: "radius",
  center: { lat: 23.8103, lon: 90.4125 },
  radiusMeters: 1500,
  bounds: null,
  country: "Bangladesh",
  region: "Dhaka Division",
  city: "Dhaka",
  area: "Gulshan",
};

describe("buildOverpassQuery", () => {
  it("treats search keywords as literal text in Overpass regex", () => {
    const query = buildOverpassQuery({ ...base, keyword: "c++ (coffee)." }, 100);
    expect(query).toContain('["name"~"c\\\\+\\\\+ \\\\(coffee\\\\)\\\\.",i]');
  });

  it("uses an around filter for radius searches", () => {
    const query = buildOverpassQuery(base, 100);
    expect(query).toContain("(around:1500,23.8103,90.4125)");
    expect(query).toContain('nwr["amenity"="restaurant"]');
    expect(query).toContain("out center tags");
  });

  it("uses a bounding box for area searches", () => {
    const query = buildOverpassQuery(
      {
        ...base,
        mode: "area",
        bounds: { south: 23.79, west: 90.4, north: 23.81, east: 90.42 },
      },
      100,
    );
    expect(query).toContain("(23.79,90.4,23.81,90.42)");
  });

  it("queries a resolved administrative polygon rather than its bounding rectangle", () => {
    const query = buildOverpassQuery({
      ...base,
      mode: "boundary",
      bounds: { south: 23.5, west: 90, north: 24, east: 90.5 },
      boundary: { level: "county", name: "Dhaka", countryCode: "BD", osmRelationId: 4773565 },
    }, 100);
    expect(query).toContain("rel(4773565);map_to_area->.searchBoundary;");
    expect(query).toContain("(.searchBoundary;);out ids;");
    expect(query).toContain('(area.searchBoundary)');
    expect(query).not.toContain("(23.5,90,24,90.5)");
  });

  it("uses a radius when boundary resolution has no bbox", () => {
    const query = buildOverpassQuery({
      ...base,
      mode: "boundary",
      boundary: { level: "city", name: "Dhaka", countryCode: "BD" },
    }, 100);
    expect(query).toContain("(around:1500,23.8103,90.4125)");
  });

  it("filters by name and brand when a keyword is present", () => {
    const query = buildOverpassQuery({ ...base, keyword: "Sultan" }, 100);
    expect(query).toContain('["name"~"Sultan",i]');
    expect(query).toContain('["brand"~"Sultan",i]');
  });

  it("escapes quotes and backslashes in keyword text", () => {
    const query = buildOverpassQuery({ ...base, keyword: 'a"b\\c' }, 100);
    expect(query).toContain('a\\"b\\\\\\\\c');
    expect(query).not.toContain('"a"b');
  });

  it("caps the requested element count", () => {
    expect(buildOverpassQuery(base, 10_000)).toContain("out center tags 2000;");
    expect(buildOverpassQuery(base, 5)).toContain("out center tags 10;");
  });

  it("throws for a keyword-less any-category search", () => {
    expect(() => buildOverpassQuery({ ...base, category: "any" }, 100)).toThrow(/keyword or category/i);
  });

  it("throws when a radius search has no center", () => {
    expect(() => buildOverpassQuery({ ...base, center: null }, 100)).toThrow(/center point/i);
  });
});

describe("searchOsm", () => {
  it("requires the generated area and excludes its guard element from place counts", async () => {
    const boundary = { ...base, mode: "boundary" as const, boundary: { level: "city" as const, name: "Town", countryCode: "BD", osmRelationId: 42 } };
    const config = loadConfig({ APP_ACCESS_KEY: "test-access-key-not-for-production-0001", NODE_ENV: "test" });
    vi.mocked(requestJson).mockResolvedValueOnce({ status: 200, headers: new Headers(), data: { elements: [
      { type: "area", id: 3_600_000_042 },
      { type: "node", id: 1, lat: 23, lon: 90, tags: { name: "Valid" } },
    ] } });
    const result = await searchOsm(boundary, config);
    expect(result.returned).toBe(1);
    expect(result.places).toHaveLength(1);
    expect(result.parseRejections).toEqual({ unusableCoordinates: 0, missingName: 0, missingIdentifier: 0, other: 0 });

    vi.mocked(requestJson).mockResolvedValueOnce({ status: 200, headers: new Headers(), data: { elements: [] } });
    await expect(searchOsm(boundary, config)).rejects.toMatchObject({ code: "osm_area_unavailable" });
  });

  it("does not treat an unrelated area as proof of the selected relation area", async () => {
    const config = loadConfig({ APP_ACCESS_KEY: "test-access-key-not-for-production-0001", NODE_ENV: "test" });
    vi.mocked(requestJson).mockResolvedValueOnce({ status: 200, headers: new Headers(), data: { elements: [{ type: "area", id: 3_600_000_043 }] } });
    await expect(searchOsm({ ...base, mode: "boundary", boundary: { level: "city", name: "Town", countryCode: "BD", osmRelationId: 42 } }, config))
      .rejects.toMatchObject({ code: "osm_area_unavailable" });
  });
  it("classifies malformed elements and parse failures without losing returned elements", async () => {
    vi.mocked(requestJson).mockResolvedValueOnce({
      status: 200,
      headers: new Headers(),
      data: {
        elements: [
          null,
          42,
          { type: "node", id: 1, lat: 23, lon: 90, tags: { name: "Valid" } },
          { type: "node", id: 2, lat: 23, lon: 90, tags: { name: "" } },
          { type: "node", id: 3, lat: 91, lon: 90, tags: { name: "Invalid position" } },
          { type: "node", lat: 23, lon: 90, tags: { name: "No id" } },
          { type: "area", id: 4, lat: 23, lon: 90, tags: { name: "Unsupported" } },
          { type: "way", id: 5, center: { lat: 0, lon: 0 }, tags: { brand: "Valid way" } },
        ],
      },
    });
    const config = loadConfig({ APP_ACCESS_KEY: "test-access-key-not-for-production-0001", NODE_ENV: "test" });
    const result = await searchOsm(base, config);
    expect(result.returned).toBe(8);
    expect(result.places).toHaveLength(2);
    expect(result.parseRejections).toEqual({
      unusableCoordinates: 1, missingName: 1, missingIdentifier: 1, other: 3,
    });
    expect(result.returned).toBe(result.places.length + Object.values(result.parseRejections ?? {}).reduce((a, b) => a + b, 0));
  });
});

describe("parseOsmElement", () => {
  const retrievedAt = "2026-01-01T00:00:00.000Z";

  it("parses a named node with address and contact fields", () => {
    const place = parseOsmElement(
      {
        type: "node",
        id: 123,
        lat: 23.8103,
        lon: 90.4125,
        tags: {
          name: "Sultan's Dine",
          amenity: "restaurant",
          "addr:housenumber": "12",
          "addr:street": "Road 11",
          "addr:suburb": "Banani",
          "addr:city": "Dhaka",
          website: "https://example.com",
          phone: "+880 1700 000000",
          opening_hours: "Mo-Su 11:00-23:00",
          cuisine: "biryani",
        },
      },
      retrievedAt,
    );
    expect(place).not.toBeNull();
    expect(place?.sourceId).toBe("123");
    expect(place?.sourceUrl).toBe("https://www.openstreetmap.org/node/123");
    expect(place?.name).toBe("Sultan's Dine");
    expect(place?.address).toBe("12 Road 11, Banani, Dhaka");
    expect(place?.category).toBe("Restaurant");
    expect(place?.fields.website).toBe("https://example.com/");
    expect(place?.fields.phone).toBe("+880 1700 000000");
    expect(place?.provenance.name?.source).toBe("osm");
    expect(place?.detailsStatus).toBe("fetched");
  });

  it("parses a way using its center", () => {
    const place = parseOsmElement(
      {
        type: "way",
        id: 456,
        center: { lat: 23.8, lon: 90.4 },
        tags: { name: "Gulshan Lake Park", leisure: "park" },
      },
      retrievedAt,
    );
    expect(place?.sourceType).toBe("osm_way");
    expect(place?.lat).toBe(23.8);
    expect(place?.category).toBe("Park");
  });

  it("returns null without a name", () => {
    expect(
      parseOsmElement({ type: "node", id: 1, lat: 23.8, lon: 90.4, tags: { amenity: "cafe" } }, retrievedAt),
    ).toBeNull();
  });

  it("returns null for missing or invalid coordinates", () => {
    expect(parseOsmElement({ type: "node", id: 1, tags: { name: "X" } }, retrievedAt)).toBeNull();
    expect(
      parseOsmElement({ type: "node", id: 1, lat: Number.NaN, lon: 90.4, tags: { name: "X" } }, retrievedAt),
    ).toBeNull();
  });

  it("returns null for unsupported element types or missing ids", () => {
    expect(
      parseOsmElement({ type: "area", id: 1, lat: 23.8, lon: 90.4, tags: { name: "X" } }, retrievedAt),
    ).toBeNull();
    expect(parseOsmElement({ type: "node", lat: 23.8, lon: 90.4, tags: { name: "X" } }, retrievedAt)).toBeNull();
  });

  it("drops unsafe website schemes", () => {
    const place = parseOsmElement(
      {
        type: "node",
        id: 1,
        lat: 23.8,
        lon: 90.4,
        tags: { name: "X", website: "javascript:alert(1)" },
      },
      retrievedAt,
    );
    expect(place?.fields.website).toBeNull();
  });

  it("falls back to brand or operator for the name", () => {
    const place = parseOsmElement(
      { type: "node", id: 2, lat: 23.8, lon: 90.4, tags: { brand: "Fresh", shop: "supermarket" } },
      retrievedAt,
    );
    expect(place?.name).toBe("Fresh");
  });
});

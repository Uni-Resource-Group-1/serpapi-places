// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.js";
import { validateCriteria } from "../../src/server/validation.js";
import type { SearchCriteria } from "../../src/shared/types.js";

const config = loadConfig({
  APP_ACCESS_KEY: "test-access-key-not-for-production-0001",
  NODE_ENV: "test",
});

function radiusCriteria(overrides: Partial<SearchCriteria> = {}): SearchCriteria {
  return {
    keyword: "",
    category: "restaurant",
    sources: ["osm", "serpapi"],
    mode: "radius",
    center: { lat: 23.8103, lon: 90.4125 },
    radiusMeters: 2000,
    bounds: null,
    countryCode: "BD",
    country: "Bangladesh",
    region: "Dhaka Division",
    city: "Dhaka",
    area: "Gulshan",
    ...overrides,
  };
}

describe("validateCriteria", () => {
  it("accepts a radius search with an explicit country and clears bounds", () => {
    const result = validateCriteria(radiusCriteria({ countryCode: "BD" }), config);
    expect(result.mode).toBe("radius");
    expect(result.bounds).toBeNull();
    expect(result.countryCode).toBe("BD");
    expect(result.sources).toEqual(["osm", "serpapi"]);
  });

  it("requires an explicit country when SerpApi is selected", () => {
    expect(() => validateCriteria(radiusCriteria({ countryCode: "" }), config))
      .toThrow(/select a country before using SerpApi/i);
  });

  it("allows searches without a country when SerpApi is not selected", () => {
    const result = validateCriteria(radiusCriteria({ sources: ["osm"], countryCode: "" }), config);
    expect(result.countryCode).toBe("");
  });

  it("requires a keyword or a non-any category", () => {
    expect(() => validateCriteria(radiusCriteria({ keyword: "", category: "any" }), config)).toThrow(
      /keyword or choose a category/i,
    );
  });

  it("accepts a keyword with the any category", () => {
    const result = validateCriteria(radiusCriteria({ keyword: "biryani", category: "any" }), config);
    expect(result.keyword).toBe("biryani");
  });

  it("rejects unknown categories", () => {
    expect(() => validateCriteria(radiusCriteria({ category: "not-a-category" }), config)).toThrow();
  });

  it("rejects duplicate sources", () => {
    expect(() =>
      validateCriteria(radiusCriteria({ sources: ["osm", "osm"] }), config),
    ).toThrow(/Duplicate source/i);
  });

  it("rejects an empty source list", () => {
    expect(() => validateCriteria(radiusCriteria({ sources: [] }), config)).toThrow();
  });

  it("requires a center for radius mode", () => {
    expect(() => validateCriteria(radiusCriteria({ center: null }), config)).toThrow(/center point/i);
  });

  it("enforces the configured radius cap", () => {
    expect(() => validateCriteria(radiusCriteria({ radiusMeters: 50_000 }), config)).toThrow(/cannot exceed/i);
  });

  it("rejects radius mode without enough radius", () => {
    expect(() => validateCriteria(radiusCriteria({ radiusMeters: 10 }), config)).toThrow();
  });

  it("accepts a boundary search with a center but no pre-resolved box", () => {
    const result = validateCriteria(radiusCriteria({
      mode: "boundary",
      bounds: null,
      boundary: { level: "county", name: "Dhaka", countryCode: "BD" },
    }), config);
    expect(result.boundary?.level).toBe("county");
    expect(result.bounds).toBeNull();
  });

  it("allows a centerless boundary without bounds so the worker can attempt OSM resolution", () => {
    const result = validateCriteria(radiusCriteria({
      mode: "boundary", center: null, bounds: null,
      boundary: { level: "city", name: "Centerless City", countryCode: "BD", center: null, bounds: null },
    }), config);
    expect(result.boundary?.center).toBeNull();
    expect(result.boundaryResolution).toBeNull();
  });

  it("allows a centerless boundary with bounds as a usable location fallback", () => {
    const bounds = { south: 23, west: 90, north: 24, east: 91 };
    const result = validateCriteria(radiusCriteria({
      mode: "boundary", center: null, bounds: null,
      boundary: { level: "city", name: "Centerless City", countryCode: "BD", center: null, bounds },
    }), config);
    expect(result.center).toBeNull();
    expect(result.bounds).toEqual(bounds);
  });

  it("marks explicitly supplied map rectangles distinctly from GeoNames fallback bounds", () => {
    const result = validateCriteria(radiusCriteria({
      mode: "boundary", boundary: { level: "region", name: "Large Region", countryCode: "BD", bounds: { south: 0, west: 0, north: 20, east: 20 } },
      bounds: { south: 1, west: 1, north: 2, east: 2 },
    }), config);
    expect(result.boundaryResolution).toMatchObject({ precision: "bbox", boundsSource: "map", relationId: null });
  });

  it("accepts broad GeoNames bounds as a boundary lookup hint", () => {
    const result = validateCriteria(radiusCriteria({
      mode: "boundary", boundary: { level: "region", name: "Large Region", countryCode: "BD" },
      bounds: { south: 0, west: 0, north: 20, east: 20 },
    }), config);
    expect(result.mode).toBe("boundary");
    expect(result.boundary?.name).toBe("Large Region");
  });

  it("rejects a boundary search without a selected boundary", () => {
    expect(() => validateCriteria(radiusCriteria({ mode: "boundary" }), config)).toThrow(/select a region/i);
  });

  it("accepts an area search and derives center and radius", () => {
    const result = validateCriteria(
      radiusCriteria({
        mode: "area",
        bounds: { south: 23.79, west: 90.4, north: 23.81, east: 90.42 },
        center: null,
      }),
      config,
    );
    expect(result.mode).toBe("area");
    expect(result.bounds).toEqual({ south: 23.79, west: 90.4, north: 23.81, east: 90.42 });
    expect(result.center?.lat).toBeCloseTo(23.8, 5);
    expect(result.radiusMeters).toBeGreaterThan(0);
  });

  it("rejects an oversized map area", () => {
    expect(() =>
      validateCriteria(
        radiusCriteria({
          mode: "area",
          bounds: { south: 23, west: 90, north: 24, east: 91 },
          center: null,
        }),
        config,
      ),
    ).toThrow(/too large/i);
  });

  it("rejects an area search without bounds", () => {
    expect(() =>
      validateCriteria(radiusCriteria({ mode: "area", bounds: null, center: null }), config),
    ).toThrow(/map area/i);
  });

  it("rejects inverted bounds", () => {
    expect(() =>
      validateCriteria(
        radiusCriteria({
          mode: "area",
          bounds: { south: 23.9, west: 90.4, north: 23.8, east: 90.5 },
        }),
        config,
      ),
    ).toThrow();
  });
});

// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  boundsAreaKm2,
  boundsCenter,
  clamp,
  haversineMeters,
  isValidCoordinate,
  normalizeBounds,
  pointInBounds,
  toRadians,
  zoomForBounds,
  zoomForRadius,
} from "../../src/shared/geo.js";

const dhaka = { lat: 23.8103, lon: 90.4125 };

describe("haversineMeters", () => {
  it("returns zero for identical points", () => {
    expect(haversineMeters(dhaka, dhaka)).toBeCloseTo(0, 5);
  });

  it("computes a known short distance", () => {
    // 0.001 degrees of latitude is roughly 111.2 m.
    const nearby = { lat: dhaka.lat + 0.001, lon: dhaka.lon };
    const distance = haversineMeters(dhaka, nearby);
    expect(distance).toBeGreaterThan(110);
    expect(distance).toBeLessThan(112.5);
  });

  it("is symmetric", () => {
    const other = { lat: 22.3569, lon: 91.7832 };
    expect(haversineMeters(dhaka, other)).toBeCloseTo(haversineMeters(other, dhaka), 6);
  });
});

describe("pointInBounds", () => {
  const bounds = { south: 23.7, west: 90.3, north: 23.9, east: 90.5 };

  it("accepts interior and boundary points", () => {
    expect(pointInBounds(dhaka, bounds)).toBe(true);
    expect(pointInBounds({ lat: 23.7, lon: 90.5 }, bounds)).toBe(true);
  });

  it("rejects points outside the rectangle", () => {
    expect(pointInBounds({ lat: 23.95, lon: 90.4 }, bounds)).toBe(false);
    expect(pointInBounds({ lat: 23.8, lon: 90.6 }, bounds)).toBe(false);
  });
});

describe("bounds helpers", () => {
  it("computes the center", () => {
    expect(boundsCenter({ south: 1, west: 2, north: 3, east: 4 })).toEqual({ lat: 2, lon: 3 });
  });

  it("normalises swapped edges", () => {
    expect(normalizeBounds({ south: 3, west: 4, north: 1, east: 2 })).toEqual({
      south: 1,
      west: 2,
      north: 3,
      east: 4,
    });
  });

  it("computes an approximate area in square kilometres", () => {
    const area = boundsAreaKm2({ south: 23.8, west: 90.4, north: 23.81, east: 90.41 });
    expect(area).toBeGreaterThan(1);
    expect(area).toBeLessThan(1.2);
  });
});

describe("zoomForBounds", () => {
  it("zooms out for larger boundaries", () => {
    const city = zoomForBounds({ south: 23.7, west: 90.38, north: 23.72, east: 90.42 });
    const county = zoomForBounds({ south: 23.5, west: 90, north: 24, east: 90.5 });
    expect(city).toBeGreaterThan(county);
  });
});

describe("isValidCoordinate", () => {
  it("accepts real coordinates", () => {
    expect(isValidCoordinate(dhaka)).toBe(true);
  });

  it("rejects out-of-range and non-finite values", () => {
    expect(isValidCoordinate({ lat: 91, lon: 0 })).toBe(false);
    expect(isValidCoordinate({ lat: 0, lon: 181 })).toBe(false);
    expect(isValidCoordinate({ lat: Number.NaN, lon: 0 })).toBe(false);
    expect(isValidCoordinate(null)).toBe(false);
    expect(isValidCoordinate("23.8,90.4")).toBe(false);
  });
});

describe("small helpers", () => {
  it("converts degrees to radians", () => {
    expect(toRadians(180)).toBeCloseTo(Math.PI, 10);
  });

  it("maps radius to an approximate zoom", () => {
    expect(zoomForRadius(400)).toBe(16);
    expect(zoomForRadius(2_500)).toBe(14);
    expect(zoomForRadius(20_000)).toBe(11);
  });

  it("clamps values", () => {
    expect(clamp(5, 1, 3)).toBe(3);
    expect(clamp(-5, 1, 3)).toBe(1);
    expect(clamp(2, 1, 3)).toBe(2);
  });
});

// @vitest-environment node
import { describe, expect, it } from "vitest";
import { pointInPolygon } from "../../src/shared/geo.js";

const donut = [
  [
    [{ lat: 0, lon: 0 }, { lat: 0, lon: 10 }, { lat: 10, lon: 10 }, { lat: 10, lon: 0 }, { lat: 0, lon: 0 }],
    [{ lat: 3, lon: 3 }, { lat: 7, lon: 3 }, { lat: 7, lon: 7 }, { lat: 3, lon: 7 }, { lat: 3, lon: 3 }],
  ],
];

describe("pointInPolygon", () => {
  it("keeps points inside the outer ring but rejects holes and points in the bounding box outside the ring", () => {
    expect(pointInPolygon({ lat: 2, lon: 2 }, donut)).toBe(true);
    expect(pointInPolygon({ lat: 5, lon: 5 }, donut)).toBe(false);
    expect(pointInPolygon({ lat: 11, lon: 5 }, donut)).toBe(false);
    expect(pointInPolygon({ lat: 0, lon: 5 }, donut)).toBe(true);
    expect(pointInPolygon({ lat: 3, lon: 5 }, donut)).toBe(false);
  });

  it("includes disconnected islands and rejects a point between them", () => {
    const islands = [...donut, [[
      { lat: 20, lon: 20 }, { lat: 20, lon: 22 }, { lat: 22, lon: 22 }, { lat: 22, lon: 20 }, { lat: 20, lon: 20 },
    ]]];
    expect(pointInPolygon({ lat: 21, lon: 21 }, islands)).toBe(true);
    expect(pointInPolygon({ lat: 15, lon: 15 }, islands)).toBe(false);
  });
});

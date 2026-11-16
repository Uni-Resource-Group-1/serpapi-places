import { describe, expect, it } from "vitest";
import type { Place } from "../../src/shared/types.js";
import {
  containmentCounts,
  filterAndSortPlaces,
  mapVisiblePlaces,
  rankPlaces,
  type PlaceFilterState,
} from "../../src/client/place-filters.js";

function place(overrides: Partial<Place> = {}): Place {
  return {
    id: "p1",
    source: "osm",
    sourceType: "osm_node",
    sourceId: "1",
    sourceUrl: null,
    name: "Alpha Cafe",
    address: "Road 1",
    category: "Cafe",
    lat: 23.78,
    lon: 90.41,
    distanceMeters: 400,
    insideArea: true,
    areaCheck: "radius",
    fields: { rating: 4.2 },
    provenance: {},
    detailsStatus: "not_fetched",
    detailsFetchedAt: null,
    retrievedAt: "2026-01-01T00:00:00.000Z",
    saved: false,
    possibleDuplicate: false,
    reviews: { available: false, fetched: 0, lastFetchedAt: null },
    ...overrides,
  };
}

const defaults: PlaceFilterState = {
  source: "all",
  sort: "distance",
  text: "",
  showOutside: false,
};

describe("place presentation filters", () => {
  it("classifies containment without discarding unknown records", () => {
    const counts = containmentCounts([
      place({ id: "in", insideArea: true }),
      place({ id: "out", insideArea: false }),
      place({ id: "unknown", insideArea: null }),
    ]);
    expect(counts).toEqual({ inside: 1, outside: 1, unknown: 1, classified: true });
  });

  it("does not offer classification when every record is unknown", () => {
    expect(containmentCounts([place({ insideArea: null })])).toEqual({
      inside: 0,
      outside: 0,
      unknown: 1,
      classified: false,
    });
  });

  it("hides outside records by default and keeps them behind the toggle", () => {
    const places = [
      place({ id: "in", name: "Inside" }),
      place({ id: "out", name: "Outside", insideArea: false }),
      place({ id: "unknown", name: "Unknown", insideArea: null }),
    ];
    const containment = containmentCounts(places);
    expect(filterAndSortPlaces(places, defaults, containment).map((item) => item.name)).toEqual([
      "Inside",
      "Unknown",
    ]);
    expect(
      filterAndSortPlaces(places, { ...defaults, showOutside: true }, containment).map((item) => item.name),
    ).toEqual(["Inside", "Outside", "Unknown"]);
  });

  it("applies source, text, and sort filters to the visible list", () => {
    const places = [
      place({ id: "a", name: "Alpha Cafe", source: "osm", category: "Cafe", address: "Road 1", distanceMeters: 900, fields: { rating: 3.9 } }),
      place({ id: "b", name: "Beta Diner", source: "serpapi", category: "Diner", address: "Road 2", distanceMeters: 300, fields: { rating: 4.8 } }),
      place({ id: "c", name: "Cafe Gamma", source: "serpapi", category: "Cafe", address: "Road 3", distanceMeters: 600, fields: { rating: 4.1 } }),
    ];
    const containment = containmentCounts(places);

    expect(
      filterAndSortPlaces(places, { ...defaults, source: "serpapi" }, containment).map((item) => item.id),
    ).toEqual(["b", "c"]);
    expect(
      filterAndSortPlaces(places, { ...defaults, text: "cafe" }, containment).map((item) => item.id),
    ).toEqual(["c", "a"]);
    expect(
      filterAndSortPlaces(places, { ...defaults, sort: "rating" }, containment).map((item) => item.id),
    ).toEqual(["b", "c", "a"]);
    expect(
      filterAndSortPlaces(places, { ...defaults, sort: "name" }, containment).map((item) => item.id),
    ).toEqual(["a", "b", "c"]);
  });

  it("keeps the map free of outside records only while they are hidden", () => {
    const places = [
      place({ id: "in", insideArea: true }),
      place({ id: "out", insideArea: false }),
    ];
    const containment = containmentCounts(places);
    expect(mapVisiblePlaces(places, false, containment).map((item) => item.id)).toEqual(["in"]);
    expect(mapVisiblePlaces(places, true, containment).map((item) => item.id)).toEqual(["in", "out"]);

    const unknown = [place({ id: "u1", insideArea: null }), place({ id: "u2", insideArea: null })];
    expect(mapVisiblePlaces(unknown, false, containmentCounts(unknown))).toHaveLength(2);
  });

  it("numbers results from one shared ordered set", () => {
    const ranks = rankPlaces([place({ id: "a" }), place({ id: "b" }), place({ id: "c" })]);
    expect([...ranks.entries()]).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
  });
});

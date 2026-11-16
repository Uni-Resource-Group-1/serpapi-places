import type { Place, Source } from "../shared/types.js";

export type SourceFilter = "all" | Source;
export type SortKey = "distance" | "name" | "rating";

/**
 * Presentation-only filters. The run keeps every valid provider record; this
 * state only decides which rows and markers the operator sees right now.
 */
export interface PlaceFilterState {
  source: SourceFilter;
  sort: SortKey;
  text: string;
  showOutside: boolean;
}

/** Default presentation state used when a run is opened or switched. */
export const DEFAULT_PLACE_FILTERS: PlaceFilterState = {
  source: "all",
  sort: "distance",
  text: "",
  showOutside: false,
};

export interface ContainmentCounts {
  inside: number;
  outside: number;
  unknown: number;
  /** True when at least one loaded record carries a containment classification. */
  classified: boolean;
}

export function containmentCounts(places: Place[]): ContainmentCounts {
  let inside = 0;
  let outside = 0;
  let unknown = 0;
  for (const place of places) {
    if (place.insideArea === true) inside++;
    else if (place.insideArea === false) outside++;
    else unknown++;
  }
  // Only offer the outside toggle when the run actually classified records.
  return { inside, outside, unknown, classified: inside + outside > 0 };
}

function ratingOf(place: Place): number {
  const value = place.fields.rating;
  return typeof value === "number" ? value : -1;
}

/**
 * Apply the shared list/map filters and ordering. Callers pass the result to
 * both surfaces so a result's number always matches its marker.
 */
export function filterAndSortPlaces(
  places: Place[],
  filters: PlaceFilterState,
  containment: ContainmentCounts = containmentCounts(places),
): Place[] {
  const needle = filters.text.trim().toLowerCase();
  const list = places.filter((place) => {
    // Outside records are never deleted; they are hidden from presentation by
    // default and remain available behind the explicit toggle.
    if (containment.classified && !filters.showOutside && place.insideArea === false) return false;
    if (filters.source !== "all" && place.source !== filters.source) return false;
    if (!needle) return true;
    return `${place.name} ${place.address ?? ""} ${place.category ?? ""}`.toLowerCase().includes(needle);
  });
  return [...list].sort((a, b) => {
    if (filters.sort === "name") return a.name.localeCompare(b.name);
    if (filters.sort === "rating") return ratingOf(b) - ratingOf(a) || a.name.localeCompare(b.name);
    return (a.distanceMeters ?? Number.MAX_SAFE_INTEGER) - (b.distanceMeters ?? Number.MAX_SAFE_INTEGER);
  });
}

/**
 * Places the map may plot. Keeping this next to the list filter guarantees the
 * map never plots an out-of-area record the operator has chosen to hide.
 */
export function mapVisiblePlaces(
  places: Place[],
  showOutside: boolean,
  containment: ContainmentCounts = containmentCounts(places),
): Place[] {
  if (!containment.classified || showOutside) return places;
  return places.filter((place) => place.insideArea !== false);
}

/** Stable 1-based numbers shared by list rows and map markers. */
export function rankPlaces(places: Place[]): Map<string, number> {
  const ranks = new Map<string, number>();
  places.forEach((place, index) => ranks.set(place.id, index + 1));
  return ranks;
}

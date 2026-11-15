import type { BoundaryPolygon, Bounds, Coordinates } from "./types.js";

const EARTH_RADIUS_M = 6_371_008.8;

export function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function haversineMeters(a: Coordinates, b: Coordinates): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function pointInBounds(point: Coordinates, bounds: Bounds): boolean {
  return (
    point.lat >= bounds.south &&
    point.lat <= bounds.north &&
    point.lon >= bounds.west &&
    point.lon <= bounds.east
  );
}

function pointOnSegment(point: Coordinates, a: Coordinates, b: Coordinates): boolean {
  const cross = (point.lon - a.lon) * (b.lat - a.lat) - (point.lat - a.lat) * (b.lon - a.lon);
  const length = Math.hypot(b.lat - a.lat, b.lon - a.lon);
  if (length === 0 || Math.abs(cross) / length > 1e-10) return false;
  return point.lon >= Math.min(a.lon, b.lon) - 1e-10 && point.lon <= Math.max(a.lon, b.lon) + 1e-10 &&
    point.lat >= Math.min(a.lat, b.lat) - 1e-10 && point.lat <= Math.max(a.lat, b.lat) + 1e-10;
}

function ringPosition(point: Coordinates, ring: Coordinates[]): "inside" | "outside" | "edge" {
  if (ring.length < 4) return "outside";
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[j]!;
    const b = ring[i]!;
    if (pointOnSegment(point, a, b)) return "edge";
    if ((a.lat > point.lat) !== (b.lat > point.lat) &&
      point.lon < ((b.lon - a.lon) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lon) {
      inside = !inside;
    }
  }
  return inside ? "inside" : "outside";
}

/** Includes the outer edge; hole edges and interiors are excluded. */
export function pointInPolygon(point: Coordinates, polygons: BoundaryPolygon): boolean {
  for (const [shell, ...holes] of polygons) {
    if (!shell || ringPosition(point, shell) === "outside") continue;
    if (holes.every((hole) => ringPosition(point, hole) === "outside")) return true;
  }
  return false;
}

export function boundsCenter(bounds: Bounds): Coordinates {
  return {
    lat: (bounds.south + bounds.north) / 2,
    lon: (bounds.west + bounds.east) / 2,
  };
}

export function boundsAreaKm2(bounds: Bounds): number {
  const midLat = toRadians((bounds.south + bounds.north) / 2);
  const heightKm = Math.abs(bounds.north - bounds.south) * 111.32;
  const widthKm = Math.abs(bounds.east - bounds.west) * 111.32 * Math.cos(midLat);
  return Math.abs(heightKm * widthKm);
}

export function isValidCoordinate(value: unknown): value is Coordinates {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.lat === "number" &&
    Number.isFinite(candidate.lat) &&
    candidate.lat >= -90 &&
    candidate.lat <= 90 &&
    typeof candidate.lon === "number" &&
    Number.isFinite(candidate.lon) &&
    candidate.lon >= -180 &&
    candidate.lon <= 180
  );
}

export function normalizeBounds(input: Bounds): Bounds {
  return {
    south: Math.min(input.south, input.north),
    north: Math.max(input.south, input.north),
    west: Math.min(input.west, input.east),
    east: Math.max(input.west, input.east),
  };
}

export function zoomForRadius(radiusMeters: number): number {
  if (radiusMeters <= 500) return 16;
  if (radiusMeters <= 1_000) return 15;
  if (radiusMeters <= 2_500) return 14;
  if (radiusMeters <= 5_000) return 13;
  if (radiusMeters <= 10_000) return 12;
  return 11;
}

/** Approximate Google Maps zoom level that frames a bounding box. */
export function zoomForBounds(bounds: Bounds): number {
  const midLat = toRadians((bounds.south + bounds.north) / 2);
  const heightKm = Math.abs(bounds.north - bounds.south) * 111.32;
  const widthKm = Math.abs(bounds.east - bounds.west) * 111.32 * Math.cos(midLat);
  const spanKm = Math.max(heightKm, widthKm);
  if (spanKm <= 1) return 16;
  if (spanKm <= 2) return 15;
  if (spanKm <= 5) return 14;
  if (spanKm <= 10) return 13;
  if (spanKm <= 20) return 12;
  if (spanKm <= 40) return 11;
  if (spanKm <= 80) return 10;
  if (spanKm <= 160) return 9;
  if (spanKm <= 320) return 8;
  return 7;
}

export function formatDistance(meters: number | null): string {
  if (meters === null || !Number.isFinite(meters)) return "—";
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

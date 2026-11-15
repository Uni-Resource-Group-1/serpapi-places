import type { BoundaryPolygon, Bounds, Coordinates } from "../../shared/types.js";
import { boundsCenter, haversineMeters, isValidCoordinate, pointInPolygon } from "../../shared/geo.js";
import type { AppConfig } from "../config.js";
import { logger } from "../logger.js";
import { requestJson } from "../sources/http.js";

export interface BoundaryRef {
  level: "region" | "county" | "city";
  name: string;
  countryCode: string;
  center?: Coordinates | null;
  bounds?: Bounds | null;
  osmRelationId?: number | null;
  osmAdminLevel?: number | null;
}

export interface ResolvedBoundary {
  relationId: number;
  areaId: number;
  adminLevel: number;
  name: string;
  center: Coordinates | null;
  bounds: Bounds;
  /** Null means geometry was unavailable or unsafe to use; callers must use their normal fallback. */
  geometry?: BoundaryPolygon | null;
}

interface OverpassMember {
  type?: string;
  role?: string;
  ref?: number;
  geometry?: Array<{ lat?: number; lon?: number }>;
}

interface OverpassRelation {
  type?: string;
  id?: number;
  tags?: Record<string, string>;
  center?: { lat?: number; lon?: number };
  bounds?: { minlat?: number; minlon?: number; maxlat?: number; maxlon?: number };
  members?: OverpassMember[];
}

interface OverpassResponse {
  elements?: OverpassRelation[];
  remark?: string;
}

const cache = new Map<string, { value: ResolvedBoundary | null; expiresAt: number }>();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 64;

function cacheResult(key: string, value: ResolvedBoundary | null): void {
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

const EXPECTED_LEVEL: Record<BoundaryRef["level"], number> = { region: 4, county: 5, city: 8 };
const MAX_GEOMETRY_POINTS = 50_000;
const MAX_GEOMETRY_WAYS = 5_000;
// Bound quadratic topology checks to keep large or adversarial relations from blocking the worker.
const MAX_TOPOLOGY_WORK = 2_000_000;

type Ring = Coordinates[];

interface Segment {
  points: Ring;
  start: string;
  end: string;
}

function endpoint(point: Coordinates): string {
  return `${point.lat},${point.lon}`;
}

function validRing(ring: Ring): boolean {
  if (ring.length < 4 || endpoint(ring[0]!) !== endpoint(ring[ring.length - 1]!)) return false;
  const unique = new Set(ring.slice(0, -1).map(endpoint));
  if (unique.size < 3 || unique.size !== ring.length - 1) return false;
  let area = 0;
  for (let i = 1; i < ring.length; i += 1) {
    area += ring[i - 1]!.lon * ring[i]!.lat - ring[i]!.lon * ring[i - 1]!.lat;
  }
  if (Math.abs(area) <= 1e-12) return false;
  // Checking every pair is bounded by the extraction work budget below.
  for (let i = 1; i < ring.length; i += 1) {
    for (let j = i + 2; j < ring.length; j += 1) {
      if (i === 1 && j === ring.length - 1) continue; // adjacent closing edges
      if (segmentsIntersect(ring[i - 1]!, ring[i]!, ring[j - 1]!, ring[j]!)) return false;
    }
  }
  return true;
}

/** Overpass `out geom` supplies coordinates but not endpoint node IDs. Exact endpoint coordinates
 * are used as the only safe join key; no proximity snapping is allowed. */
function stitchRings(segments: Segment[]): Ring[] | null {
  const adjacency = new Map<string, number[]>();
  const add = (key: string, index: number): void => {
    const matches = adjacency.get(key) ?? [];
    matches.push(index);
    adjacency.set(key, matches);
  };
  for (const [index, segment] of segments.entries()) {
    add(segment.start, index);
    add(segment.end, index);
  }
  if ([...adjacency.values()].some((indices) => indices.length !== 2)) return null;

  const unused = new Set(segments.map((_, index) => index));
  const rings: Ring[] = [];
  while (unused.size) {
    const first = unused.values().next().value as number;
    unused.delete(first);
    const segment = segments[first]!;
    const ring = [...segment.points];
    let tail = segment.end;
    while (tail !== segment.start) {
      const next = adjacency.get(tail)?.find((index) => unused.has(index));
      if (next === undefined) return null;
      unused.delete(next);
      const match = segments[next]!;
      const points = match.start === tail ? match.points : [...match.points].reverse();
      ring.push(...points.slice(1));
      tail = match.start === tail ? match.end : match.start;
    }
    if (!validRing(ring)) return null;
    rings.push(ring);
  }
  return rings;
}

function orientation(a: Coordinates, b: Coordinates, c: Coordinates): number {
  return (b.lon - a.lon) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lon - a.lon);
}

function onSegment(a: Coordinates, b: Coordinates, c: Coordinates): boolean {
  return c.lon >= Math.min(a.lon, b.lon) && c.lon <= Math.max(a.lon, b.lon) &&
    c.lat >= Math.min(a.lat, b.lat) && c.lat <= Math.max(a.lat, b.lat);
}

function segmentsIntersect(a: Coordinates, b: Coordinates, c: Coordinates, d: Coordinates): boolean {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  return (abC === 0 && onSegment(a, b, c)) || (abD === 0 && onSegment(a, b, d)) ||
    (cdA === 0 && onSegment(c, d, a)) || (cdB === 0 && onSegment(c, d, b)) ||
    ((abC > 0) !== (abD > 0) && (cdA > 0) !== (cdB > 0));
}

function ringsIntersect(a: Ring, b: Ring): boolean {
  for (let i = 1; i < a.length; i += 1) {
    for (let j = 1; j < b.length; j += 1) {
      if (segmentsIntersect(a[i - 1]!, a[i]!, b[j - 1]!, b[j]!)) return true;
    }
  }
  return false;
}

function ringContainsRing(shell: Ring, ring: Ring): boolean {
  return !ringsIntersect(shell, ring) && ring.slice(0, -1).every((point) => pointInPolygon(point, [[shell]]));
}

function signedArea(ring: Ring): number {
  let area = 0;
  for (let i = 1; i < ring.length; i += 1) {
    area += ring[i - 1]!.lon * ring[i]!.lat - ring[i]!.lon * ring[i - 1]!.lat;
  }
  return Math.abs(area);
}

/** All-or-nothing: partial boundaries must never be used for filtering places. */
export function extractBoundaryGeometry(relation: OverpassRelation): BoundaryPolygon | null {
  if (relation.type !== "relation" || !Array.isArray(relation.members) ||
      relation.members.length === 0 || relation.members.length > MAX_GEOMETRY_WAYS) return null;
  const outer: Segment[] = [];
  const inner: Segment[] = [];
  let pointCount = 0;
  for (const member of relation.members) {
    if (member.type !== "way") {
      // Nested relations or unsupported geometry roles could hide missing boundary edges.
      if (member.type !== "node" || (member.role !== "admin_centre" && member.role !== "label")) return null;
      continue;
    }
    if (member.role !== "outer" && member.role !== "inner" ||
        !Number.isSafeInteger(member.ref) || !Array.isArray(member.geometry) || member.geometry.length < 2) return null;
    pointCount += member.geometry.length;
    if (pointCount > MAX_GEOMETRY_POINTS) return null;
    const points = member.geometry;
    if (!points.every(isValidCoordinate)) return null;
    const coordinates = points as Coordinates[];
    const segment = {
      points: coordinates,
      start: endpoint(coordinates[0]!),
      end: endpoint(coordinates[coordinates.length - 1]!),
    };
    (member.role === "outer" ? outer : inner).push(segment);
  }
  if (!outer.length) return null;
  const shells = stitchRings(outer);
  const holes = stitchRings(inner);
  if (!shells?.length || holes === null) return null;
  if (shells.length + holes.length > 1_000) return null;
  const rings = [...shells, ...holes];
  let topologyWork = 0;
  for (const [index, ring] of rings.entries()) {
    const edges = ring.length - 1;
    topologyWork += edges * edges;
    for (let other = index + 1; other < rings.length; other += 1) {
      topologyWork += edges * (rings[other]!.length - 1);
    }
    if (topologyWork > MAX_TOPOLOGY_WORK) return null;
  }
  const polygons: BoundaryPolygon = shells.map((shell) => [shell]);
  for (let i = 0; i < shells.length; i += 1) {
    for (let j = i + 1; j < shells.length; j += 1) {
      if (ringsIntersect(shells[i]!, shells[j]!) || ringContainsRing(shells[i]!, shells[j]!) || ringContainsRing(shells[j]!, shells[i]!)) return null;
    }
  }
  for (const hole of holes) {
    const matches = shells.map((shell, index) => ({ shell, index }))
      .filter(({ shell }) => signedArea(shell) > signedArea(hole) && ringContainsRing(shell, hole))
      .sort((a, b) => signedArea(a.shell) - signedArea(b.shell));
    if (!matches.length || holes.some((other) => other !== hole && ringsIntersect(hole, other))) return null;
    polygons[matches[0]!.index]!.push(hole);
  }
  return polygons;
}

function escapeRegex(value: string): string {
  return value.slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeOverpassString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function overpassString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').slice(0, 120);
}

function cacheKey(ref: BoundaryRef): string {
  const location = ref.center ? `${ref.center.lat.toFixed(2)},${ref.center.lon.toFixed(2)}` : "unknown";
  return `${ref.countryCode.toUpperCase()}|${ref.level}|${ref.name.toLowerCase()}|${location}`;
}

function levelPenalty(level: BoundaryRef["level"], adminLevel: number): number {
  if (level === "city") return adminLevel >= 6 ? 0 : 40_000;
  if (level === "county") return adminLevel >= 4 && adminLevel <= 7 ? 0 : 40_000;
  return adminLevel <= 5 ? 0 : 40_000;
}

function pickCandidate(
  ref: BoundaryRef,
  candidates: ResolvedBoundary[],
): ResolvedBoundary | null {
  // Without a selected center or relation ID, scoring by admin level is only a
  // preference, not enough evidence to distinguish same-name boundaries.
  if (!ref.center && ref.osmRelationId == null && candidates.length > 1) return null;

  const identified = ref.osmRelationId == null
    ? candidates
    : candidates.filter((candidate) => candidate.relationId === ref.osmRelationId);
  if (ref.osmRelationId != null && identified.length !== 1) return null;
  candidates = identified;

  const expected = EXPECTED_LEVEL[ref.level];
  let best: { score: number; candidate: ResolvedBoundary } | null = null;
  for (const candidate of candidates) {
    const distance = ref.center && candidate.center ? haversineMeters(ref.center, candidate.center) : 0;
    const score = distance * 0.1 + levelPenalty(ref.level, candidate.adminLevel) + Math.abs(candidate.adminLevel - expected) * 25_000;
    if (!best || score < best.score) best = { score, candidate };
  }
  if (!best) return null;
  const tied = candidates.filter((candidate) => {
    const distance = ref.center && candidate.center ? haversineMeters(ref.center, candidate.center) : 0;
    const score = distance * 0.1 + levelPenalty(ref.level, candidate.adminLevel) + Math.abs(candidate.adminLevel - expected) * 25_000;
    return score === best!.score;
  });
  return tied.length === 1 ? best.candidate : null;
}

function pointWithinBounds(point: Coordinates, bounds: Bounds): boolean {
  return point.lat >= bounds.south && point.lat <= bounds.north &&
    point.lon >= bounds.west && point.lon <= bounds.east;
}

function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west;
}

function toBounds(value: OverpassRelation["bounds"]): Bounds | null {
  if (!value) return null;
  const { minlat, minlon, maxlat, maxlon } = value;
  if ([minlat, minlon, maxlat, maxlon].some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    return null;
  }
  if (minlat! < -90 || maxlat! > 90 || minlon! < -180 || maxlon! > 180 || minlat! >= maxlat! || minlon! >= maxlon!) {
    return null;
  }
  return { south: minlat as number, west: minlon as number, north: maxlat as number, east: maxlon as number };
}

export function buildBoundaryLookupQuery(ref: BoundaryRef): string {
  const name = escapeRegex(ref.name.trim());
  const country = overpassString(ref.countryCode.toUpperCase());
  // Delimiters belong to the regex too; escape the complete expression for Overpass strings.
  const pattern = escapeOverpassString(`^${name}([ ]|$)`);
  const lat = ref.center?.lat;
  const lon = ref.center?.lon;
  if (lat !== undefined && lon !== undefined) {
    const south = Math.max(-90, lat - 0.7);
    const north = Math.min(90, lat + 0.7);
    const west = Math.max(-180, lon - 0.7);
    const east = Math.min(180, lon + 0.7);
    return `[out:json][timeout:45];
area["ISO3166-1"="${country}"]->.c;
(
  rel(area.c)["boundary"="administrative"]["admin_level"~"^(3|4|5|6|7|8)$"]["name:en"~"${pattern}",i](${south},${west},${north},${east});
  rel(area.c)["boundary"="administrative"]["admin_level"~"^(3|4|5|6|7|8)$"]["name"~"${pattern}",i](${south},${west},${north},${east});
);
out body center bb;`;
  }
  return `[out:json][timeout:45];
area["ISO3166-1"="${country}"]->.c;
(
  rel(area.c)["boundary"="administrative"]["admin_level"~"^(3|4|5|6|7|8)$"]["name:en"~"${pattern}",i];
  rel(area.c)["boundary"="administrative"]["admin_level"~"^(3|4|5|6|7|8)$"]["name"~"${pattern}",i];
);
out body center bb;`;
}

/**
 * Resolves a selected region/county/city to an OpenStreetMap administrative
 * boundary. Returns null when no closed boundary matches, so callers can fall
 * back to a bounding box or radius instead of failing the whole run.
 */
export async function resolveBoundary(ref: BoundaryRef, appConfig: AppConfig): Promise<ResolvedBoundary | null> {
  if (!ref.name.trim()) return null;
  const key = cacheKey(ref);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  cache.delete(key);

  const query = buildBoundaryLookupQuery(ref);
  try {
    const response = await requestJson(appConfig.osm.overpassUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": appConfig.osm.userAgent,
      },
      body: `data=${encodeURIComponent(query)}`,
      timeoutMs: Math.max(appConfig.osm.timeoutMs, 55_000),
      retries: 0,
    });
    const data = response.data as OverpassResponse;
    if (data?.remark || !Array.isArray(data?.elements)) throw new Error("OpenStreetMap boundary lookup incomplete");
    const elements = data.elements;
    const candidates: ResolvedBoundary[] = [];
    for (const element of elements) {
      if (element.type !== "relation" || typeof element.id !== "number") continue;
      const adminLevel = Number(element.tags?.admin_level);
      const bounds = toBounds(element.bounds);
      if (!bounds || !Number.isFinite(adminLevel) || !Number.isSafeInteger(element.id) || element.id <= 0) continue;
      const center = element.center?.lat !== undefined && element.center?.lon !== undefined &&
        isValidCoordinate({ lat: element.center.lat, lon: element.center.lon })
        ? { lat: element.center.lat, lon: element.center.lon }
        : null;
      candidates.push({
        relationId: element.id,
        areaId: 3_600_000_000 + element.id,
        adminLevel,
        name: element.tags?.["name:en"] ?? element.tags?.name ?? ref.name,
        center,
        bounds,
      });
    }
    const plausible = candidates.filter((candidate) => {
      if (ref.center && !pointWithinBounds(ref.center, candidate.bounds)) return false;
      if (!ref.center) {
        return !ref.bounds || boundsOverlap(ref.bounds, candidate.bounds);
      }
      return haversineMeters(ref.center, boundsCenter(candidate.bounds)) < 300_000;
    });
    const chosen = pickCandidate(ref, plausible);
    let geometryRequestFailed = false;
    if (chosen) {
      // Fetch only the selected relation's members; lookup response has no way geometry.
      // A failed or incomplete geometry fetch preserves the resolved bounds for fallback.
      chosen.geometry = null;
      try {
        const geometryQuery = `[out:json][timeout:45];relation(${chosen.relationId});out body geom;`;
        const geometryResponse = await requestJson(appConfig.osm.overpassUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            "User-Agent": appConfig.osm.userAgent,
          },
          body: `data=${encodeURIComponent(geometryQuery)}`,
          timeoutMs: Math.max(appConfig.osm.timeoutMs, 55_000),
          retries: 0,
        });
        const geometryData = geometryResponse.data as OverpassResponse;
        if (geometryData?.remark || !Array.isArray(geometryData?.elements)) throw new Error("OpenStreetMap boundary geometry incomplete");
        const relation = geometryData.elements.find((item) => item.type === "relation" && item.id === chosen.relationId);
        chosen.geometry = relation ? extractBoundaryGeometry(relation) : null;
      } catch (error) {
        geometryRequestFailed = true;
        logger.warn({ err: error, relationId: chosen.relationId }, "OpenStreetMap boundary geometry unavailable; using bounds fallback");
      }
    }
    // Transient geometry failures must not permanently downgrade later runs.
    if (!geometryRequestFailed) cacheResult(key, chosen);
    logger.info(
      { level: ref.level, name: ref.name, country: ref.countryCode, candidates: candidates.length, matched: chosen?.relationId ?? null },
      "OpenStreetMap boundary lookup",
    );
    return chosen;
  } catch (error) {
    logger.warn({ err: error, level: ref.level, name: ref.name }, "OpenStreetMap boundary lookup failed");
    return null;
  }
}

export function clearBoundaryCache(): void {
  cache.clear();
}

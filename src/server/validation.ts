import { CATEGORIES, CATEGORY_ANY } from "../shared/categories.js";
import type { Bounds, SearchCriteria, Source } from "../shared/types.js";
import { boundsAreaKm2, boundsCenter, isValidCoordinate, normalizeBounds } from "../shared/geo.js";
import { buildTilePlan } from "../shared/tiling.js";
import { z } from "zod";
import type { AppConfig } from "./config.js";

const categoryIds = new Set([CATEGORY_ANY, ...CATEGORIES.map((category) => category.id)]);

const sourceSchema = z.enum(["osm", "serpapi"]);

const importedPlaceRefSchema = z.object({
  kind: z.enum(["place_id", "data_id", "data_cid"]),
  value: z
    .string()
    .trim()
    .min(4)
    .max(300)
    .regex(/^[A-Za-z0-9_:-]+$/, "Place references may only contain letters, digits, _ : and -"),
});

const tilingSchema = z.object({
  columns: z.number().int().min(1).max(20),
  rows: z.number().int().min(1).max(20),
  tileCount: z.number().int().min(1).max(100).default(1),
  maxPagesPerTile: z.number().int().min(1).max(5).default(1),
});

export const coordinatesSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180),
});

export const boundsSchema = z
  .object({
    south: z.number().finite().min(-90).max(90),
    west: z.number().finite().min(-180).max(180),
    north: z.number().finite().min(-90).max(90),
    east: z.number().finite().min(-180).max(180),
  })
  .refine((value) => value.south < value.north, "Bounds must have north greater than south")
  .refine((value) => value.west < value.east, "Bounds must have east greater than west");

export const boundaryRefSchema = z.object({
  level: z.enum(["region", "county", "city"]),
  name: z.string().trim().min(1).max(120),
  countryCode: z.string().trim().length(2).transform((value) => value.toUpperCase()),
  center: coordinatesSchema.nullable().optional(),
  bounds: boundsSchema.nullable().optional(),
  osmRelationId: z.number().int().positive().nullable().optional(),
  osmAdminLevel: z.number().int().min(1).max(12).nullable().optional(),
});

export const criteriaSchema = z.object({
  keyword: z.string().trim().max(120).default(""),
  category: z.string().trim().max(60).default(CATEGORY_ANY),
  sources: z.array(sourceSchema).min(1).max(3),
  mode: z.enum(["radius", "area", "boundary"]),
  plan: z.enum(["standard", "tiled", "import"]).optional().default("standard"),
  tiling: tilingSchema.nullable().optional().default(null),
  importRefs: z.array(importedPlaceRefSchema).max(500).nullable().optional().default(null),
  center: coordinatesSchema.nullable(),
  radiusMeters: z.number().finite().min(100).max(100_000),
  bounds: boundsSchema.nullable(),
  country: z.string().trim().max(80).default(""),
  region: z.string().trim().max(80).default(""),
  county: z.string().trim().max(80).default(""),
  city: z.string().trim().max(80).default(""),
  area: z.string().trim().max(80).default(""),
  countryCode: z.string().trim().max(2).default(""),
  regionCode: z.string().trim().max(20).default(""),
  countyCode: z.string().trim().max(30).default(""),
  cityId: z.number().int().positive().nullable().optional().default(null),
  boundary: boundaryRefSchema.nullable().optional().default(null),
}).strict();

export interface NormalizedCriteria extends Omit<SearchCriteria, "sources"> {
  sources: Source[];
}

export function validateCriteria(input: unknown, appConfig: AppConfig): NormalizedCriteria {
  const parsed = criteriaSchema.parse(input);
  const category = parsed.category || CATEGORY_ANY;
  if (!categoryIds.has(category)) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["category"],
        message: "Unknown category",
        input: parsed.category,
      },
    ]);
  }
  if (parsed.plan !== "import" && !parsed.keyword && category === CATEGORY_ANY) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["keyword"],
        message: "Enter a keyword or choose a category",
        input: parsed.keyword,
      },
    ]);
  }
  if (parsed.sources.includes("osm") && !parsed.keyword && category === CATEGORY_ANY) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["keyword"],
        message: "OpenStreetMap searches need a keyword or category",
        input: parsed.keyword,
      },
    ]);
  }
  if (parsed.sources.includes("serpapi") && !parsed.countryCode) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["countryCode"],
        message: "Select a country before using SerpApi discovery. This sets the Google Maps search locale and prevents results from the wrong country.",
        input: parsed.countryCode,
      },
    ]);
  }
  if (new Set(parsed.sources).size !== parsed.sources.length) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["sources"],
        message: "Duplicate source selection",
        input: parsed.sources,
      },
    ]);
  }

  if (parsed.plan === "import") {
    if (parsed.sources.length !== 1 || parsed.sources[0] !== "serpapi") {
      throw new z.ZodError([
        {
          code: "custom",
          path: ["sources"],
          message: "Known-place imports use SerpApi only.",
          input: parsed.sources,
        },
      ]);
    }
    const refs = parsed.importRefs ?? [];
    if (refs.length === 0) {
      throw new z.ZodError([
        {
          code: "custom",
          path: ["importRefs"],
          message: "Paste at least one Google Maps place ID or URL to import.",
          input: refs,
        },
      ]);
    }
    if (refs.length > appConfig.limits.maxImportPlaces) {
      throw new z.ZodError([
        {
          code: "custom",
          path: ["importRefs"],
          message: `Import at most ${appConfig.limits.maxImportPlaces} places per run.`,
          input: refs.length,
        },
      ]);
    }
    const unique = new Set(refs.map((ref) => `${ref.kind}:${ref.value}`));
    if (unique.size !== refs.length) {
      throw new z.ZodError([
        {
          code: "custom",
          path: ["importRefs"],
          message: "Remove duplicate place references before importing.",
          input: refs.length,
        },
      ]);
    }
    return {
      ...parsed,
      category,
      sources: parsed.sources as Source[],
      mode: "radius",
      center: null,
      bounds: null,
      radiusMeters: Math.max(100, Math.min(parsed.radiusMeters, appConfig.limits.maxRadiusMeters)),
      boundary: null,
      plan: "import",
      tiling: null,
      importRefs: refs,
    };
  }

  if (parsed.plan === "tiled") {
    if (parsed.mode !== "area" || !parsed.bounds) {
      throw new z.ZodError([
        {
          code: "custom",
          path: ["bounds"],
          message: "Tiled discovery needs a map rectangle. Select an area first.",
          input: parsed.bounds,
        },
      ]);
    }
    if (!parsed.sources.includes("serpapi")) {
      throw new z.ZodError([
        {
          code: "custom",
          path: ["sources"],
          message: "Tiled discovery requires SerpApi. Enable it, or run OSM on the whole rectangle.",
          input: parsed.sources,
        },
      ]);
    }

    if (!parsed.tiling) {
      throw new z.ZodError([
        {
          code: "custom",
          path: ["tiling"],
          message: "Choose a tile grid before running tiled discovery.",
          input: parsed.tiling,
        },
      ]);
    }
    if (parsed.tiling.maxPagesPerTile > appConfig.limits.maxPagesPerTile) {
      throw new z.ZodError([
        {
          code: "custom",
          path: ["tiling", "maxPagesPerTile"],
          message: `At most ${appConfig.limits.maxPagesPerTile} SerpApi pages per tile are allowed.`,
          input: parsed.tiling.maxPagesPerTile,
        },
      ]);
    }
    const bounds = normalizeBounds(parsed.bounds);
    const plan = buildTilePlan(bounds, {
      maxTileAreaKm2: appConfig.limits.maxAreaKm2,
      maxTiledAreaKm2: appConfig.limits.maxTiledAreaKm2,
      maxTiles: appConfig.limits.maxTilesPerRun,
      columns: parsed.tiling.columns,
      rows: parsed.tiling.rows,
    });
    if (!plan.ok) {
      throw new z.ZodError([
        {
          code: "custom",
          path: ["bounds"],
          message: plan.message,
          input: parsed.bounds,
        },
      ]);
    }
    const center = boundsCenter(bounds);
    return {
      ...parsed,
      category,
      sources: parsed.sources as Source[],
      mode: "area",
      center,
      bounds,
      boundary: null,
      radiusMeters: derivedRadius(center, bounds, appConfig),
      plan: "tiled",
      tiling: {
        columns: plan.plan.columns,
        rows: plan.plan.rows,
        tileCount: plan.plan.tiles.length,
        maxPagesPerTile: parsed.tiling.maxPagesPerTile,
      },
      importRefs: null,
    };
  }

  if (parsed.mode === "boundary") {
    if (!parsed.boundary) {
      throw new z.ZodError([
        {
          code: "custom",
          path: ["boundary"],
          message: "Select a region, county, or city before running a boundary search",
          input: parsed.boundary,
        },
      ]);
    }
    const center = parsed.center ?? parsed.boundary.center ?? null;
    const bounds = parsed.bounds ?? parsed.boundary.bounds ?? null;
    const hasMapRectangle = parsed.mode === "boundary" && parsed.bounds !== null;
    // GeoNames selections often carry a broad admin-region bounding box. The
    // authoritative OSM geometry/bounds are resolved by the worker and checked
    // there; pre-reject only an explicit search-area box, not this hint. A
    // centerless selection without bounds is still valid when OSM can resolve it.
    if (!center && !bounds && parsed.boundary.osmRelationId) {
      throw new z.ZodError([
        {
          code: "custom",
          path: ["boundary"],
          message: "The selected boundary has no known center. Pick a map point or use a radius search.",
          input: parsed.boundary,
        },
      ]);
    }
    return {
      ...parsed,
      category,
      sources: parsed.sources as Source[],
      center,
      bounds,
      boundary: { ...parsed.boundary, center, bounds },
      boundaryResolution: hasMapRectangle ? {
        relationId: null,
        name: null,
        adminLevel: null,
        precision: "bbox",
        boundsSource: "map",
        reason: "Explicitly selected map rectangle; administrative boundary has not been resolved",
        geometryHash: null,
        ringCount: null,
        vertexCount: null,
        osmTimestamp: null,
      } : null,
      radiusMeters: Math.min(Math.max(parsed.radiusMeters, 100), appConfig.limits.maxRadiusMeters),
      plan: "standard",
      tiling: null,
      importRefs: null,
    };
  }

  if (parsed.mode === "radius") {
    if (!parsed.center) {
      throw new z.ZodError([
        {
          code: "custom",
          path: ["center"],
          message: "A center point is required for a radius search",
          input: parsed.center,
        },
      ]);
    }
    if (parsed.radiusMeters < 100) {
      throw new z.ZodError([
        {
          code: "custom",
          path: ["radiusMeters"],
          message: "Radius must be at least 100 metres",
          input: parsed.radiusMeters,
        },
      ]);
    }
    if (parsed.radiusMeters > appConfig.limits.maxRadiusMeters) {
      throw new z.ZodError([
        {
          code: "custom",
          path: ["radiusMeters"],
          message: `Radius cannot exceed ${appConfig.limits.maxRadiusMeters} metres`,
          input: parsed.radiusMeters,
        },
      ]);
    }
    return {
      ...parsed,
      category,
      sources: parsed.sources as Source[],
      bounds: null,
      plan: "standard",
      tiling: null,
      importRefs: null,
    };
  }

  if (!parsed.bounds) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["bounds"],
        message: "Draw or select a map area before running an area search",
        input: parsed.bounds,
      },
    ]);
  }
  const normalizedBounds = normalizeBounds(parsed.bounds);
  const area = boundsAreaKm2(normalizedBounds);
  if (area > appConfig.limits.maxAreaKm2) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["bounds"],
        message: `Selected area is too large (${area.toFixed(0)} km²). Limit is ${appConfig.limits.maxAreaKm2} km².`,
        input: parsed.bounds,
      },
    ]);
  }
  const center = boundsCenter(normalizedBounds);
  return {
    ...parsed,
    category,
    sources: parsed.sources as Source[],
    bounds: normalizedBounds,
    center,
    radiusMeters: derivedRadius(center, normalizedBounds, appConfig),
    plan: "standard",
    tiling: null,
    importRefs: null,
  };
}

function derivedRadius(center: { lat: number; lon: number }, bounds: Bounds, appConfig: AppConfig): number {
  const northWest = { lat: bounds.north, lon: bounds.west };
  const southEast = { lat: bounds.south, lon: bounds.east };
  const radiusMeters = Math.max(
    100,
    Math.ceil(Math.max(haversineApprox(center, northWest), haversineApprox(center, southEast))),
  );
  return Math.min(radiusMeters, appConfig.limits.maxRadiusMeters);
}

function haversineApprox(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const latMeters = (a.lat - b.lat) * 111_320;
  const lonMeters = (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.sqrt(latMeters * latMeters + lonMeters * lonMeters);
}

export function coerceCriteriaFromStorage(input: unknown, appConfig: AppConfig): NormalizedCriteria {
  return validateCriteria(input, appConfig);
}

export function safeBounds(input: unknown): Bounds | null {
  const parsed = boundsSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function assertCoordinate(point: unknown): asserts point is { lat: number; lon: number } {
  if (!isValidCoordinate(point)) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["coordinates"],
        message: "Invalid coordinates",
        input: point,
      },
    ]);
  }
}

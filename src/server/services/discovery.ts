import type { AppConfig } from "../config.js";
import type {
  DiscoveryEstimate,
  SearchCriteria,
  TileBoundsInfo,
} from "../../shared/types.js";
import { boundsCenter, haversineMeters } from "../../shared/geo.js";
import { buildTilePlan, tileRequestEstimate } from "../../shared/tiling.js";
import { AppError } from "../errors.js";
import { getSettings, getUsage } from "./usage.js";

/** Plan tiles for a validated tiled criteria object. */
export function tilesForCriteria(criteria: SearchCriteria, appConfig: AppConfig): TileBoundsInfo[] {
  if (!criteria.bounds || !criteria.tiling) {
    throw new AppError(400, "invalid_tiling", "Tiled discovery needs a rectangle and a grid.");
  }
  const plan = buildTilePlan(criteria.bounds, {
    maxTileAreaKm2: appConfig.limits.maxAreaKm2,
    maxTiledAreaKm2: appConfig.limits.maxTiledAreaKm2,
    maxTiles: appConfig.limits.maxTilesPerRun,
    columns: criteria.tiling.columns,
    rows: criteria.tiling.rows,
  });
  if (!plan.ok) throw new AppError(400, "invalid_tiling", plan.message);
  return plan.plan.tiles;
}

/** Turn a parent tiled criteria into a standalone area criteria for one tile. */
export function tileCriteria(parent: SearchCriteria, tile: TileBoundsInfo): SearchCriteria {
  const corners = [
    { lat: tile.bounds.north, lon: tile.bounds.west },
    { lat: tile.bounds.north, lon: tile.bounds.east },
    { lat: tile.bounds.south, lon: tile.bounds.west },
    { lat: tile.bounds.south, lon: tile.bounds.east },
  ];
  const radiusMeters = Math.max(
    100,
    Math.ceil(Math.max(...corners.map((corner) => haversineMeters(tile.center, corner)))),
  );
  return {
    ...parent,
    mode: "area",
    center: tile.center ?? boundsCenter(tile.bounds),
    bounds: tile.bounds,
    radiusMeters,
    boundary: null,
    boundaryResolution: null,
    plan: "standard",
    tiling: null,
    importRefs: null,
  };
}

export async function buildDiscoveryEstimate(
  criteria: SearchCriteria,
  appConfig: AppConfig,
): Promise<DiscoveryEstimate> {
  const [settings, usage] = await Promise.all([getSettings(appConfig), getUsage(appConfig)]);
  const plan = criteria.plan ?? "standard";
  const serializedSerp = (criteria.sources ?? []).includes("serpapi");
  const warnings: string[] = [];
  let tiles: TileBoundsInfo[] = [];
  let serpapiRequests = 0;

  if (plan === "tiled") {
    tiles = tilesForCriteria(criteria, appConfig);
    const pagesPerTile = Math.max(1, criteria.tiling?.maxPagesPerTile ?? 1);
    serpapiRequests = serializedSerp ? tileRequestEstimate(tiles.length, pagesPerTile) : 0;
    warnings.push(
      `Tiled runs sample ${tiles.length} grid cell${tiles.length === 1 ? "" : "s"} with up to ${pagesPerTile} SerpApi page${pagesPerTile === 1 ? "" : "s"} each. Coverage remains sampled, not exhaustive.`,
    );
  } else if (plan === "import") {
    serpapiRequests = serializedSerp ? (criteria.importRefs ?? []).length : 0;
    warnings.push("Each imported place reference costs one SerpApi details request. Places without usable coordinates are skipped.");
  } else if (serializedSerp) {
    serpapiRequests = Math.min(Math.max(1, settings.serpapiMaxPages), appConfig.limits.maxPagesHard, 6);
  }

  if (criteria.mode === "boundary" && serializedSerp) {
    warnings.push("SerpApi cannot query a polygon directly. Boundary runs are approximate samples of the selected area.");
  }

  const estimatedCostUsd = Number((serpapiRequests * settings.serpapiPriceUsd).toFixed(4));
  const remainingDay = usage.day.remaining;
  const remainingMonth = usage.month.remaining;
  const withinBudget = !serializedSerp || (serpapiRequests <= remainingDay && serpapiRequests <= remainingMonth);

  if (serializedSerp && (serpapiRequests > remainingDay || serpapiRequests > remainingMonth)) {
    warnings.push(
      `This plan needs ${serpapiRequests} SerpApi request${serpapiRequests === 1 ? "" : "s"} but only ${Math.min(remainingDay, remainingMonth)} remain in the current daily/monthly budget.`,
    );
  }

  return {
    plan,
    mode: criteria.mode,
    tileCount: tiles.length,
    tiles,
    serpapiRequests,
    estimatedCostUsd,
    remainingDay,
    remainingMonth,
    withinBudget,
    warnings,
  };
}

import type { Bounds, Coordinates, TileBoundsInfo } from "./types.js";
import { boundsAreaKm2, boundsCenter, normalizeBounds } from "./geo.js";

export interface TilePlanOptions {
  /** Maximum area of a single tile in km². */
  maxTileAreaKm2: number;
  /** Maximum area of the whole tiled parent in km². */
  maxTiledAreaKm2: number;
  /** Hard cap on the number of grid cells. */
  maxTiles: number;
  /** Optional explicit grid; when omitted the helper chooses a shape. */
  columns?: number | null;
  rows?: number | null;
  maxColumns?: number;
  maxRows?: number;
}

export interface TilePlan {
  columns: number;
  rows: number;
  tiles: TileBoundsInfo[];
  tileAreaKm2: number;
  totalAreaKm2: number;
}

export type TilePlanCode =
  | "invalid_bounds"
  | "area_too_large"
  | "area_too_small"
  | "too_many_tiles"
  | "tile_area_too_large";

export type TilePlanResult =
  | { ok: true; plan: TilePlan }
  | { ok: false; code: TilePlanCode; message: string };

export const DEFAULT_MAX_TILE_COLUMNS = 20;
export const DEFAULT_MAX_TILE_ROWS = 20;

function validBounds(bounds: Bounds): boolean {
  return (
    Number.isFinite(bounds.south) &&
    Number.isFinite(bounds.west) &&
    Number.isFinite(bounds.north) &&
    Number.isFinite(bounds.east) &&
    bounds.south < bounds.north &&
    bounds.west < bounds.east
  );
}

function spanKm(bounds: Bounds): { widthKm: number; heightKm: number; midLat: number } {
  const midLat = ((bounds.south + bounds.north) / 2) * (Math.PI / 180);
  return {
    widthKm: Math.abs(bounds.east - bounds.west) * 111.32 * Math.max(0.02, Math.cos(midLat)),
    heightKm: Math.abs(bounds.north - bounds.south) * 111.32,
    midLat,
  };
}

/** Divide a bounds rectangle into an explicit rows × columns grid. */
export function splitBounds(boundsInput: Bounds, columns: number, rows: number): TileBoundsInfo[] {
  const bounds = normalizeBounds(boundsInput);
  const tiles: TileBoundsInfo[] = [];
  const latStep = (bounds.north - bounds.south) / rows;
  const lonStep = (bounds.east - bounds.west) / columns;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const tileBounds: Bounds = {
        south: roundCoord(bounds.south + row * latStep),
        north: roundCoord(bounds.south + (row + 1) * latStep),
        west: roundCoord(bounds.west + column * lonStep),
        east: roundCoord(bounds.west + (column + 1) * lonStep),
      };
      const center = boundsCenter(tileBounds);
      tiles.push({
        index: row * columns + column,
        row,
        column,
        bounds: tileBounds,
        center,
        areaKm2: boundsAreaKm2(tileBounds),
      });
    }
  }
  return tiles;
}

function roundCoord(value: number): number {
  return Math.round(value * 1e7) / 1e7;
}

function candidateScore(widthKm: number, heightKm: number, columns: number, rows: number): number {
  const tileWidth = widthKm / columns;
  const tileHeight = heightKm / rows;
  const aspectPenalty = Math.abs(Math.log(tileWidth / Math.max(1e-6, tileHeight)));
  return aspectPenalty + 0.02 * (columns * rows);
}

/**
 * Build a bounded tile grid for a large area.
 *
 * The helper never silently enlarges the request: if the parent area or a
 * single cell exceeds the configured limits it returns a typed failure. This is
 * the shared source of truth for validation, estimation, and the client UI.
 */
export function buildTilePlan(boundsInput: Bounds, options: TilePlanOptions): TilePlanResult {
  if (!validBounds(boundsInput)) {
    return { ok: false, code: "invalid_bounds", message: "Tiling needs a valid south/west/north/east rectangle." };
  }
  const bounds = normalizeBounds(boundsInput);
  const { widthKm, heightKm } = spanKm(bounds);
  const totalAreaKm2 = boundsAreaKm2(bounds);
  if (!Number.isFinite(totalAreaKm2) || totalAreaKm2 <= 0) {
    return { ok: false, code: "invalid_bounds", message: "The selected rectangle has no usable area." };
  }
  const maxTiles = Math.max(1, Math.floor(options.maxTiles));
  if (totalAreaKm2 > options.maxTiledAreaKm2) {
    return {
      ok: false,
      code: "area_too_large",
      message: `The tiled area is ${totalAreaKm2.toFixed(0)} km²; the limit is ${options.maxTiledAreaKm2.toFixed(0)} km². Narrow the rectangle or use separate tile runs.`,
    };
  }
  if (totalAreaKm2 < 0.05) {
    return { ok: false, code: "area_too_small", message: "The selected rectangle is too small to tile." };
  }

  const maxColumns = Math.max(1, Math.min(options.maxColumns ?? DEFAULT_MAX_TILE_COLUMNS, maxTiles));
  const maxRows = Math.max(1, Math.min(options.maxRows ?? DEFAULT_MAX_TILE_ROWS, maxTiles));
  const requestedColumns = options.columns ?? null;
  const requestedRows = options.rows ?? null;

  let selected: { columns: number; rows: number; tiles: TileBoundsInfo[] } | null = null;
  if (requestedColumns != null || requestedRows != null) {
    if (requestedColumns == null || requestedRows == null) {
      return { ok: false, code: "invalid_bounds", message: "Choose both a column count and a row count for tiling." };
    }
    const columns = Math.floor(requestedColumns);
    const rows = Math.floor(requestedRows);
    if (columns < 1 || rows < 1 || columns > maxColumns || rows > maxRows || columns * rows > maxTiles) {
      return {
        ok: false,
        code: "too_many_tiles",
        message: `That grid has ${columns * rows} cells; the per-run limit is ${maxTiles}.`,
      };
    }
    selected = { columns, rows, tiles: splitBounds(bounds, columns, rows) };
  } else {
    const target = Math.max(1, Math.ceil(totalAreaKm2 / Math.max(0.01, options.maxTileAreaKm2)));
    if (target > maxTiles) {
      return {
        ok: false,
        code: "too_many_tiles",
        message: `This area needs at least ${target} tiles at ${options.maxTileAreaKm2.toFixed(0)} km² each; the per-run limit is ${maxTiles}. Narrow the area or queue separate tile runs.`,
      };
    }
    let bestScore = Number.POSITIVE_INFINITY;
    for (let columns = 1; columns <= maxColumns; columns += 1) {
      for (let rows = 1; rows <= maxRows; rows += 1) {
        if (columns * rows < target || columns * rows > maxTiles) continue;
        const score = candidateScore(widthKm, heightKm, columns, rows);
        if (score >= bestScore) continue;
        const tiles = splitBounds(bounds, columns, rows);
        if (tiles.some((tile) => tile.areaKm2 > options.maxTileAreaKm2 + 1e-6)) continue;
        bestScore = score;
        selected = { columns, rows, tiles };
      }
    }
  }

  if (!selected) {
    return {
      ok: false,
      code: "tile_area_too_large",
      message: `Could not fit this rectangle into cells of ${options.maxTileAreaKm2.toFixed(0)} km² or less with at most ${maxTiles} tiles.`,
    };
  }
  const oversized = selected.tiles.find((tile) => tile.areaKm2 > options.maxTileAreaKm2 + 1e-6);
  if (oversized) {
    return {
      ok: false,
      code: "tile_area_too_large",
      message: `Tile ${oversized.index + 1} would be ${oversized.areaKm2.toFixed(0)} km²; the limit is ${options.maxTileAreaKm2.toFixed(0)} km².`,
    };
  }

  return {
    ok: true,
    plan: {
      columns: selected.columns,
      rows: selected.rows,
      tiles: selected.tiles,
      tileAreaKm2: Math.max(...selected.tiles.map((tile) => tile.areaKm2)),
      totalAreaKm2,
    },
  };
}

export function tileRequestEstimate(tileCount: number, maxPagesPerTile: number): number {
  return Math.max(0, Math.floor(tileCount)) * Math.max(1, Math.floor(maxPagesPerTile));
}

export function tilePlanCenter(tiles: TileBoundsInfo[], fallback: Coordinates | null): Coordinates | null {
  if (tiles.length === 0) return fallback;
  const total = tiles.reduce(
    (accumulator, tile) => ({
      lat: accumulator.lat + tile.center.lat,
      lon: accumulator.lon + tile.center.lon,
    }),
    { lat: 0, lon: 0 },
  );
  return { lat: total.lat / tiles.length, lon: total.lon / tiles.length };
}

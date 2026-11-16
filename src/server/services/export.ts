import { createWriteStream } from "node:fs";
import { mkdir, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { ZipArchive } from "archiver";
import type { AppConfig } from "../config.js";
import { many, one, query } from "../db.js";
import { AppError, errorMessage } from "../errors.js";
import type {
  ExportFormat,
  ExportManifest,
  Place,
  SearchCriteria,
  Source,
} from "../../shared/types.js";
import {
  DEFAULT_EXPORT_FIELDS,
  EXPORT_FIELDS,
  RESTRICTED_EXPORT_FIELDS,
  sanitizeExportValue,
  isRestrictedExportKey,
  looksLikeImageReference,
} from "../../shared/export-fields.js";
import { fetchRunPlaces, fetchSavedPlaces } from "./dto.js";
import { fetchStoredReviewsForRecords } from "./details.js";
import { audit } from "./audit.js";
import { logger } from "../logger.js";
import { buildXlsx } from "./xlsx.js";

interface ExportJobRow {
  id: string;
  scope: "run" | "collection" | "saved";
  scope_id: string | null;
  selection: string[] | null;
  format: ExportFormat;
  fields: string[];
  sources: Source[];
  inside_only: boolean;
  status: string;
  created_by: string;
}

interface RunScopeRow {
  criteria: SearchCriteria;
  caveats: string[];
}

const FIELD_IDS = new Set(EXPORT_FIELDS.map((field) => field.id));

export function validateExportFields(fields: unknown): string[] {
  if (fields === undefined || fields === null) return [...DEFAULT_EXPORT_FIELDS];
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new AppError(400, "invalid_fields", "Choose at least one export field.");
  }
  const cleaned = [...new Set(fields.map(String))];
  for (const field of cleaned) {
    if (!FIELD_IDS.has(field)) throw new AppError(400, "invalid_field", `Unknown export field: ${field}`);
    if ((RESTRICTED_EXPORT_FIELDS as readonly string[]).includes(field)) {
      throw new AppError(403, "restricted_field", `Field ${field} is not approved for export.`);
    }
  }
  return cleaned;
}

export function sanitizeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "string" ? value : JSON.stringify(value);
  text = text.replaceAll("\u0000", "");
  if (/^\s*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function buildCsv(fields: string[], rows: Array<Record<string, unknown>>): string {
  const header = fields.map((field) => sanitizeCsvCell(field)).join(",");
  const lines = rows.map((row) => fields.map((field) => sanitizeCsvCell(row[field])).join(","));
  return `\uFEFF${header}\r\n${lines.join("\r\n")}\r\n`;
}

function valueForField(place: Place, field: string): unknown {
  switch (field) {
    case "name":
      return place.name;
    case "category":
      return place.category;
    case "address":
      return place.address;
    case "lat":
      return place.lat;
    case "lon":
      return place.lon;
    case "source":
      return place.source;
    case "source_id":
      return place.sourceId;
    case "source_url":
      return place.sourceUrl;
    case "distance_m":
      return place.distanceMeters === null ? null : Math.round(place.distanceMeters);
    case "rating":
      return place.fields.rating ?? null;
    case "review_count":
      return place.fields.reviews ?? null;
    case "website":
      return place.fields.website ?? null;
    case "phone":
      return place.fields.phone ?? null;
    case "hours":
      return place.fields.hours ?? null;
    case "hours_last_updated":
      return place.fields.hours_last_updated ?? null;
    case "popular_times":
      return place.fields.popular_times ?? null;
    case "location_summary":
      return place.fields.location_summary ?? null;
    case "at_this_place":
      return place.fields.at_this_place ?? null;
    case "price":
      return place.fields.price ?? null;
    case "description":
      return place.fields.description ?? null;
    case "types":
      return place.fields.types ?? null;
    case "service_options":
      return place.fields.service_options ?? null;
    case "accessibility":
      return place.fields.accessibility ?? null;
    case "place_topics":
      return place.fields.place_topics ?? null;
    case "details_status":
      return place.detailsStatus;
    case "retrieved_at":
      return place.retrievedAt;
    case "provenance":
      return place.provenance;
    case "osm_tags":
      return place.source === "osm" ? place.fields.tags ?? null : null;
    case "reviews":
      return place.reviews.fetched;
    default:
      return null;
  }
}

function rowForPlace(place: Place, fields: string[]): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const field of fields) row[field] = sanitizeExportValue(valueForField(place, field));
  return row;
}

const REVIEW_EXPORT_FIELDS = [
  "place_source_id",
  "place_name",
  "author_name",
  "rating",
  "date_text",
  "review_text",
  "likes",
  "fetched_at",
] as const;

function reviewRow(review: Awaited<ReturnType<typeof fetchStoredReviewsForRecords>>[number]): Record<string, unknown> {
  return sanitizeExportValue({
    place_source_id: review.placeSourceId,
    place_name: review.placeName,
    author_name: review.authorName,
    rating: review.rating,
    date_text: review.dateText,
    review_text: review.snippet,
    likes: review.likes,
    fetched_at: review.fetchedAt,
  }) as Record<string, unknown>;
}

function attributionFor(sources: Source[]): string[] {
  const attribution: string[] = [];
  if (sources.includes("osm")) {
    attribution.push(
      "OpenStreetMap data © OpenStreetMap contributors, licensed under the Open Database License (ODbL) 1.0. https://www.openstreetmap.org/copyright",
    );
  }
  if (sources.includes("serpapi")) {
    attribution.push(
      "SerpApi Google Maps results. Underlying place and review data remains subject to applicable provider and content rights. Retain this attribution in any downstream use and do not republish or resell the data without the necessary rights.",
    );
  }
  return attribution;
}

function jsonManifest(manifest: ExportManifest): string {
  return JSON.stringify(manifest, null, 2);
}

/**
 * Belt-and-braces guard for serializers that build their own JSON string,
 * so a restricted nested key can never reach a file even if an object is
 * assembled outside `rowForPlace`.
 */
export function safeJson(value: unknown, indent = 2): string {
  return JSON.stringify(value, (key, entry) => {
    if (key && isRestrictedExportKey(key)) return undefined;
    if (typeof entry === "string" && looksLikeImageReference(entry)) return undefined;
    return entry;
  }, indent);
}

function attributionText(manifest: ExportManifest): string {
  return [
    "Places Discovery export",
    "",
    ...manifest.attribution,
    "",
    "Coordinate system: EPSG:4326 (WGS84)",
    `Rows: ${manifest.rowCount}`,
    `Exported: ${manifest.exportedAt}`,
    "",
    "Coverage caveats:",
    ...manifest.coverageCaveats.map((caveat) => `- ${caveat}`),
    "",
    "This archive includes manifest.json with the full export record.",
  ].join("\n");
}

async function rowsForJob(
  job: ExportJobRow,
  appConfig: AppConfig,
  sources: Source[],
): Promise<{ places: Place[]; criteria: SearchCriteria | null; caveats: string[]; omittedSelectionCount: number }> {
  let places: Place[];
  let criteria: SearchCriteria | null = null;
  let caveats: string[] = [];
  let omittedSelectionCount = 0;
  if (job.scope === "run") {
    if (!job.scope_id) throw new AppError(500, "invalid_export_scope", "Search-run export is missing its scope ID.");
    const run = await one<RunScopeRow>("SELECT criteria, caveats FROM search_runs WHERE id = $1", [job.scope_id]);
    if (!run) throw new AppError(404, "run_not_found", "Search run not found");
    criteria = run.criteria;
    caveats = run.caveats ?? [];
    places = await fetchRunPlaces(job.scope_id, appConfig.serpapi.reviewsEnabled);
  } else if (job.scope === "collection") {
    if (!job.scope_id) throw new AppError(500, "invalid_export_scope", "Collection export is missing its scope ID.");
    const collection = await one<{ id: string; name: string }>("SELECT id, name FROM collections WHERE id = $1", [
      job.scope_id,
    ]);
    if (!collection) throw new AppError(404, "collection_not_found", "Collection not found");
    const ids = await many<{ saved_place_id: string }>(
      "SELECT saved_place_id FROM collection_items WHERE collection_id = $1",
      [job.scope_id],
    );
    const idSet = new Set(ids.map((row) => row.saved_place_id));
    const saved = await fetchSavedPlaces(appConfig.serpapi.reviewsEnabled);
    places = saved.filter((item) => idSet.has(item.id)).map((item) => item.place);
  } else {
    const saved = await fetchSavedPlaces(appConfig.serpapi.reviewsEnabled);
    const selectedIds = job.selection ? new Set(job.selection) : null;
    const selectedPlaces = saved.filter((item) => !selectedIds || selectedIds.has(item.id));
    if (selectedIds && selectedPlaces.length !== selectedIds.size) {
      throw new AppError(404, "saved_place_not_found", "One or more selected saved places no longer exist.");
    }
    places = selectedPlaces.map((item) => item.place);
    const includedSources = new Set(sources);
    omittedSelectionCount = selectedPlaces.filter((item) => !includedSources.has(item.place.source)).length;
    if (omittedSelectionCount > 0) {
      caveats.push(
        `${omittedSelectionCount} selected saved place(s) were omitted because their source was not requested or export is disabled.`,
      );
    }
  }
  places = places.filter((place) => sources.includes(place.source));
  if (job.scope === "run" && job.inside_only) {
    const before = places.length;
    places = places.filter((place) => place.insideArea !== false);
    const removed = before - places.length;
    if (removed > 0) {
      caveats.push(
        `${removed} record(s) outside the selected area were omitted because this export requested inside-area rows only.`,
      );
    }
  }
  places.sort((a, b) => (a.distanceMeters ?? Number.MAX_SAFE_INTEGER) - (b.distanceMeters ?? Number.MAX_SAFE_INTEGER));
  return { places, criteria, caveats, omittedSelectionCount };
}

export async function processExportJob(jobId: string, appConfig: AppConfig): Promise<void> {
  const job = await one<ExportJobRow>("SELECT * FROM export_jobs WHERE id = $1", [jobId]);
  if (!job) throw new Error("Export job not found");
  if (job.status !== "running") {
    throw new AppError(409, "export_job_not_running", "Export job must be claimed before it can be processed.");
  }

  const requestedSources = job.sources.filter(
    (source) => source === "osm" || source === "serpapi",
  );
  const omitted: string[] = job.sources
    .filter((source) => source !== "osm" && source !== "serpapi")
    .map((source) => `${source}: retired source`);
  const allowedSources: Source[] = [];
  for (const source of requestedSources) {
    if (source === "serpapi" && !appConfig.serpapi.exportEnabled) {
      omitted.push("serpapi: export disabled by data policy (SERPAPI_EXPORT_ENABLED=false)");
      continue;
    }
    allowedSources.push(source);
  }
  const fields = validateExportFields(job.fields);
  const { places, criteria, caveats, omittedSelectionCount } = await rowsForJob(job, appConfig, allowedSources);
  if (places.length > appConfig.limits.maxExportRows) {
    throw new AppError(413, "export_row_limit", `Export exceeds the ${appConfig.limits.maxExportRows} row limit. Narrow the selection.`);
  }
  if (job.format === "xlsx" && places.length > 5_000) {
    throw new AppError(413, "xlsx_row_limit", "Excel exports are limited to 5,000 rows. Narrow the selection or choose CSV/JSON.");
  }
  const rows = places.map((place) => rowForPlace(place, fields));
  const includeReviews = fields.includes("reviews");
  const storedReviews = includeReviews
    ? await fetchStoredReviewsForRecords(places.map((place) => place.id))
    : [];
  const reviewRows = storedReviews.map(reviewRow);
  const actualSources = [...new Set(places.map((place) => place.source))];
  const exportedAt = new Date().toISOString();
  const retrievalDates = places.map((place) => place.retrievedAt).sort();
  const selectedCount = job.selection?.length ?? null;
  const manifest: ExportManifest = {
    schemaVersion: "1.0",
    exportedAt,
    exportScope: job.scope === "run" ? "completed search run" : job.scope === "collection" ? "saved collection" : "saved places",
    scopeId: job.scope_id ?? "",
    exportSelectionCount: selectedCount,
    omittedSelectionCount,
    format: job.format,
    rowCount: places.length,
    reviewRowCount: reviewRows.length,
    reviewFile: includeReviews ? (job.format === "json" || job.format === "geojson" ? "reviews.json" : "reviews.csv") : null,
    coordinateSystem: "EPSG:4326 (WGS84)",
    criteria,
    filters: {
      sources: allowedSources,
      requestedSources: requestedSources,
      fields,
      omittedSources: omitted,
      insideOnly: job.inside_only,
    },
    fields,
    omittedFields: [
      ...RESTRICTED_EXPORT_FIELDS,
      ...(appConfig.serpapi.exportEnabled ? [] : ["serpapi_records"]),
    ],
    restrictedSources: omitted,
    sources: actualSources,
    retrievalRange: {
      earliest: retrievalDates[0] ?? null,
      latest: retrievalDates.at(-1) ?? null,
    },
    attribution: attributionFor(actualSources),
    coverageCaveats: [
      ...caveats,
      ...(omitted.length > 0 ? ["Some requested sources were omitted for policy reasons."] : []),
      "Exports reflect the data stored at export time. Source values can change after retrieval.",
      "Review text and reviewer names are stored and exportable for this workspace's own use. Do not republish, resell, or redistribute them without confirming the necessary rights.",
      "Lists, ratings, opening hours, and any busyness or location summaries are structured facts. They are third-party content under the provider's terms; use them for internal research and do not republish the structured payloads.",
    ],
    dataPolicy:
      "OSM data is exported under ODbL attribution. SerpApi-derived place and review records are exportable for this workspace's own use while SERPAPI_EXPORT_ENABLED is true. Image fields and image URLs are stripped at any depth when structured provider payloads are written to an export file. Downstream publication, resale, or redistribution is the operator's responsibility and requires the necessary rights.",
    csvSafe: true,
    geometryValidated: true,
  };

  let dataFile: { name: string; content: string | Buffer };
  if (job.format === "csv") {
    dataFile = { name: "places.csv", content: buildCsv(fields, rows) };
  } else if (job.format === "xlsx") {
    const workbook = buildXlsx(fields, rows);
    if (workbook.byteLength > 20_000_000) {
      throw new AppError(413, "xlsx_size_limit", "Excel workbook exceeds 20 MB. Narrow the fields or choose CSV/JSON.");
    }
    dataFile = { name: "places.xlsx", content: workbook };
  } else if (job.format === "geojson") {
    const features = places.map((place, index) => {
      if (
        !Number.isFinite(place.lat) ||
        !Number.isFinite(place.lon) ||
        Math.abs(place.lat) > 90 ||
        Math.abs(place.lon) > 180
      ) {
        throw new AppError(500, "invalid_geometry", `Invalid geometry in export row ${index + 1}`);
      }
      return sanitizeExportValue({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [place.lon, place.lat] },
        properties: rows[index],
      });
    });
    dataFile = {
      name: "places.geojson",
      content: safeJson({
        type: "FeatureCollection",
        features,
        manifest,
      }),
    };
  } else if (job.format === "json") {
    dataFile = {
      name: "places.json",
      content: safeJson({
        manifest,
        records: places.map((place, index) => ({
          ...rows[index],
          ...(fields.includes("provenance")
            ? { provenance: sanitizeExportValue(place.provenance) }
            : {}),
        })),
      }),
    };
  } else {
    throw new AppError(400, "invalid_format", "Unsupported export format.");
  }

  await mkdir(appConfig.exportsDir, { recursive: true });
  const safeName = `places-${job.scope}-${job.id.slice(0, 8)}-${exportedAt.slice(0, 10)}.zip`;
  const fullPath = path.join(appConfig.exportsDir, safeName);
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(fullPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    archive.append(dataFile.content, { name: dataFile.name });
    if (includeReviews) {
      if (job.format === "json" || job.format === "geojson") {
        archive.append(safeJson({ rowCount: reviewRows.length, reviews: reviewRows }), {
          name: "reviews.json",
        });
      } else {
        archive.append(buildCsv([...REVIEW_EXPORT_FIELDS], reviewRows), { name: "reviews.csv" });
      }
    }
    archive.append(jsonManifest(sanitizeExportValue(manifest) as ExportManifest), { name: "manifest.json" });
    archive.append(attributionText(manifest), { name: "ATTRIBUTION.txt" });
    void archive.finalize();
  });
  const fileStat = await stat(fullPath);
  const expiresAt = new Date(Date.now() + appConfig.limits.exportRetentionHours * 3_600_000);
  await query(
    `UPDATE export_jobs SET
       status = 'completed', row_count = $2, omitted_sources = $3::jsonb,
       manifest = $4::jsonb, file_name = $5, file_path = $6, finished_at = now(), expires_at = $7
     WHERE id = $1`,
    [
      jobId,
      places.length,
      JSON.stringify(omitted),
      JSON.stringify(manifest),
      safeName,
      fullPath,
      expiresAt,
    ],
  );
  await audit({
    actor: job.created_by,
    action: "export.completed",
    targetType: "export_job",
    targetId: jobId,
    metadata: {
      scope: job.scope,
      format: job.format,
      rows: places.length,
      bytes: fileStat.size,
      omitted,
      sources: actualSources,
    },
  });
  logger.info({ jobId, rows: places.length, bytes: fileStat.size, format: job.format }, "Export job completed");
}

/** Remove an export archive only when its resolved path is inside the configured export directory. */
export async function deleteExportFile(filePath: string | null, appConfig: AppConfig): Promise<boolean> {
  if (!filePath) return false;
  const exportsRoot = path.resolve(appConfig.exportsDir) + path.sep;
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(exportsRoot)) {
    throw new Error("Refusing to remove an export file outside the exports directory.");
  }
  try {
    const [realRoot, realFile] = await Promise.all([
      realpath(appConfig.exportsDir),
      realpath(resolved),
    ]);
    if (!realFile.startsWith(realRoot + path.sep)) {
      throw new Error("Refusing to remove an export file outside the exports directory.");
    }
    await unlink(resolved);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function cleanupExpiredExports(appConfig: AppConfig): Promise<number> {
  const rows = await many<{ id: string; file_path: string | null }>(
    `SELECT id, file_path FROM export_jobs
     WHERE status = 'completed' AND expires_at IS NOT NULL AND expires_at < now()`,
  );
  let removed = 0;
  for (const row of rows) {
    if (row.file_path) {
      const resolved = path.resolve(row.file_path);
      const exportsRoot = path.resolve(appConfig.exportsDir) + path.sep;
      if (resolved.startsWith(exportsRoot)) {
        await unlink(resolved).catch(() => undefined);
      }
    }
    await query("UPDATE export_jobs SET status = 'expired', file_path = NULL WHERE id = $1", [row.id]);
    removed += 1;
  }
  await query("DELETE FROM serpapi_page_cache WHERE expires_at < now()");
  await query("DELETE FROM place_reviews WHERE expires_at IS NOT NULL AND expires_at < now()");
  await query("DELETE FROM saved_places WHERE expires_at IS NOT NULL AND expires_at < now()");
  await query("DELETE FROM source_place_records WHERE source = 'serpapi' AND expires_at IS NOT NULL AND expires_at < now()");
  return removed;
}

export async function failExportJob(jobId: string, error: unknown): Promise<void> {
  const message = errorMessage(error);
  await query("UPDATE export_jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [
    jobId,
    message.slice(0, 1000),
  ]);
}

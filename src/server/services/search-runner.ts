import { createHash } from "node:crypto";
import type { BoundaryPolygon, ImportedPlaceRef, SearchCriteria, Source, SourceError, SourceSummary, CoverageStatus } from "../../shared/types.js";
import { boundsAreaKm2, haversineMeters } from "../../shared/geo.js";
import { buildTilePlan, tileRequestEstimate } from "../../shared/tiling.js";
import type { AppConfig } from "../config.js";
import { one, query } from "../db.js";
import { SourceError as SourceFailure, errorMessage } from "../errors.js";
import { audit } from "./audit.js";
import { findAndRecordMatch } from "./matching.js";
import { reserveSerpApiCalls } from "./usage.js";
import { addRunPlace, saveSourcePlace } from "./repository.js";
import { buildOverpassQuery, searchOsm } from "../sources/osm.js";
import { buildSerpApiSearchParams, searchSerpApiPage } from "../sources/serpapi.js";
import { resolveBoundary } from "../geo/boundary.js";
import type { ParsedPlace, OsmSearchResult, SourceSearchPage, ParseRejections } from "../sources/types.js";
import { logger } from "../logger.js";

interface RunRow {
  id: string; status: string; criteria: SearchCriteria; sources: Source[]; requested_max_pages: number;
  requested_max_results: number; saved_search_id: string | null; created_by: string;
}
interface SourceRequestRow { id: string; }
export interface SearchRunnerDeps {
  searchOsm: typeof searchOsm;
  searchSerpApiPage: typeof searchSerpApiPage;
  saveSourcePlace: typeof saveSourcePlace;
  addRunPlace: typeof addRunPlace;
  findAndRecordMatch: typeof findAndRecordMatch;
  resolveBoundary: typeof resolveBoundary;
}
const defaultDeps: SearchRunnerDeps = { searchOsm, searchSerpApiPage, saveSourcePlace, addRunPlace, findAndRecordMatch, resolveBoundary };
function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function sourceLabel(source: Source): string { return source === "osm" ? "OpenStreetMap" : "SerpApi Google Maps"; }
function emptyExclusions(): NonNullable<SourceSummary["exclusions"]> { return { missingCoordinates: 0, invalidRecord: 0, outsideArea: 0, outsidePolygon: 0 }; }
function parseExclusions(result: { returned: number; places: ParsedPlace[]; parseRejections?: ParseRejections }): NonNullable<SourceSummary["exclusions"]> {
  const d = result.parseRejections;
  return { ...emptyExclusions(), missingCoordinates: d?.unusableCoordinates ?? 0, invalidRecord: d ? d.missingName + d.missingIdentifier + d.other : Math.max(0, result.returned - result.places.length) };
}
function addExclusions(a: NonNullable<SourceSummary["exclusions"]>, b: NonNullable<SourceSummary["exclusions"]>): NonNullable<SourceSummary["exclusions"]> {
  return { missingCoordinates: a.missingCoordinates + b.missingCoordinates, invalidRecord: a.invalidRecord + b.invalidRecord, outsideArea: a.outsideArea + b.outsideArea, outsidePolygon: a.outsidePolygon + b.outsidePolygon };
}
async function startRequest(runId: string, source: Source, page: number, fp: string, params: Record<string, unknown>, credits: number, appConfig?: AppConfig): Promise<string> {
  const r = await one<SourceRequestRow>(`INSERT INTO source_requests (run_id,source,page,fingerprint,params,credits_estimated) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [runId, source, page, fp, JSON.stringify(params), credits]);
  if (!r) {
    if (appConfig && source === "osm") throw new SourceFailure("boundary_too_large", "The resolved boundary exceeds the configured search area limit.");
    throw new Error("Could not create source request record");
  }
  return r.id;
}
async function finishRequest(requestId: string, input: { status: "success" | "error" | "skipped" | "capped"; httpStatus?: number | null; resultCount?: number; keptCount?: number; filteredCount?: number; duplicateCount?: number; creditsActual?: number; durationMs?: number; errorCode?: string; errorMessage?: string; cached?: boolean; exclusions?: NonNullable<SourceSummary["exclusions"]> }): Promise<void> {
  await query(`UPDATE source_requests SET status=$2,http_status=$3,result_count=$4,kept_count=$5,filtered_count=$6,duplicate_count=$7,credits_actual=$8,duration_ms=$9,error_code=$10,error_message=$11,cached=$12,params=CASE WHEN $13::jsonb IS NULL THEN params ELSE jsonb_set(params,'{exclusions}',$13::jsonb) END,finished_at=now() WHERE id=$1`, [requestId, input.status, input.httpStatus ?? null, input.resultCount ?? 0, input.keptCount ?? 0, input.filteredCount ?? 0, input.duplicateCount ?? 0, input.creditsActual ?? 0, input.durationMs ?? null, input.errorCode ?? null, input.errorMessage?.slice(0, 600) ?? null, input.cached ?? false, input.exclusions ? JSON.stringify(input.exclusions) : null]);
}
async function updateHeartbeat(runId: string, progress: Record<string, unknown>): Promise<void> { await query("UPDATE search_runs SET heartbeat_at=now(),progress=$2::jsonb WHERE id=$1", [runId, JSON.stringify(progress)]); }
function caveatsFor(criteria: SearchCriteria, errors: SourceError[], truncated: boolean, exclusions: NonNullable<SourceSummary["exclusions"]>, cappedSources: Source[], summaries: SourceSummary[], notices: string[] = []): string[] {
  const caveats = [...notices];
  if (criteria.mode === "boundary") {
    if (criteria.boundaryResolution?.boundsSource === "none") caveats.push("No OpenStreetMap administrative boundary, usable center, or bounds were available. No location-based search could be performed.");
    for (const summary of summaries.filter((item) => criteria.sources.includes(item.source))) {
      if (summary.status === "disabled" || (summary.status === "error" && summary.pages === 0)) continue;
      if (summary.boundaryPrecision === "polygon") caveats.push(`${sourceLabel(summary.source)} searched around the resolved OpenStreetMap administrative polygon. All valid returned records are retained, including records outside the polygon; this does not mean all places in it were found.`);
      else if (summary.boundaryPrecision === "bbox") {
        const boundsSource = criteria.boundaryResolution?.boundsSource;
        const detail = boundsSource === "map" ? "the explicitly selected map rectangle" : boundsSource === "geonames" ? "an approximate GeoNames bounding box because OpenStreetMap geometry was unavailable" : "an approximate OpenStreetMap bounding box because polygon geometry was unavailable";
        caveats.push(`${sourceLabel(summary.source)} used ${detail} to search, but all valid returned records are retained even when outside those bounds.`);
      } else if (summary.boundaryPrecision === "radius") caveats.push(`${sourceLabel(summary.source)} used an approximate ${criteria.radiusMeters / 1000} km center radius to search because no usable boundary box was available. All valid returned records are retained.`);
    }
    if (criteria.sources.includes("serpapi")) caveats.push("SerpApi cannot query a polygon directly: its map-center search samples the selected area. Returned records are not discarded by post-search area or polygon filters, but the provider may omit places.");
  }
  if (criteria.sources.includes("serpapi")) caveats.push("SerpApi returns ranked map results, not a complete inventory. A run can end within its configured limits and still omit places; narrowing the area may improve discovery, but extra requests require deliberate budget approval.");
  if (criteria.plan === "tiled") caveats.push(`This tiled run divided the rectangle into ${criteria.tiling?.tileCount ?? "multiple"} grid cells with up to ${criteria.tiling?.maxPagesPerTile ?? 1} SerpApi page${(criteria.tiling?.maxPagesPerTile ?? 1) === 1 ? "" : "s"} per cell. Each cell is sampled, not exhaustively enumerated, and the combined coverage remains capped.`);
  if (criteria.plan === "import") caveats.push("Imported places come from references you supplied. Each reference costs one SerpApi details request, and unresolved or coordinate-less references are omitted.");
  if (criteria.sources.includes("osm")) caveats.push("OpenStreetMap contains only features mapped by contributors with the requested tags. Missing or outdated businesses can be absent.");
  if (truncated || cappedSources.length > 0) {
    const reasons = summaries.filter((summary) => cappedSources.includes(summary.source)).map((summary) => {
      const reason = summary.stopReason === "page_limit" ? "page limit" : summary.stopReason === "result_limit" ? "result limit" : summary.stopReason === "repeated_page" ? "repeated provider page" : "source limit";
      return `${sourceLabel(summary.source)} (${reason}; ${summary.pages} page${summary.pages === 1 ? "" : "s"})`;
    });
    if (reasons.length > 0) caveats.push(`Discovery stopped at ${reasons.join(", ")}. Narrow the search area or deliberately adjust page/result limits in Settings; raising limits may incur more SerpApi requests.`);
  }
  const descriptions = [exclusions.missingCoordinates && `${exclusions.missingCoordinates} missing/invalid coordinates`, exclusions.invalidRecord && `${exclusions.invalidRecord} invalid or unidentified records`].filter(Boolean);
  if (descriptions.length > 0) caveats.push(`Excluded returned records: ${descriptions.join("; ")}. Duplicates are counted separately.`);
  if (errors.length > 0) caveats.push("One or more requested sources failed or were unavailable. Results from successful sources are partial; inspect source errors before retrying.");
  caveats.push("Run time describes this app's retrieval, not a provider's last verification. Place details may have been refreshed after this run.");
  return caveats;
}
function summary(source: Source, status: SourceSummary["status"] = "ok"): SourceSummary {
  return { source, status, requests: 0, pages: 0, results: 0, kept: 0, filteredOut: 0, duplicates: 0, exclusions: emptyExclusions(), creditsEstimated: 0, creditsActual: 0 };
}
function getBoundaryPrecision(criteria: SearchCriteria): SourceSummary["boundaryPrecision"] {
  if (criteria.mode !== "boundary") return "not_applicable";
  return criteria.boundaryResolution?.precision ?? (criteria.bounds ? "bbox" : "radius");
}

export async function executeSearchRun(runId: string, appConfig: AppConfig, deps: SearchRunnerDeps = defaultDeps): Promise<void> {
  const run = await one<RunRow>("SELECT * FROM search_runs WHERE id = $1", [runId]);
  if (!run || (run.status !== "queued" && run.status !== "running")) return;
   // Refuse legacy queued runs before provider dispatch; preserve their historical records.
   if (run.sources.some((source) => source !== "osm" && source !== "serpapi")) {
     await query("UPDATE search_runs SET status='failed', finished_at=now(), heartbeat_at=now(), errors=$2::jsonb WHERE id=$1", [runId, JSON.stringify([{ source: "system", code: "retired_source", message: "This run includes a retired source and was not dispatched." }])]);
     return;
   }
  const claimed = run.status === "queued" ? await query("UPDATE search_runs SET status='running',started_at=COALESCE(started_at,now()),heartbeat_at=now() WHERE id=$1 AND status='queued'", [runId]) : null;
  if (claimed && claimed.rowCount === 0) return;
  const criteria = run.criteria;
  const errors: SourceError[] = [];
  const summaries: SourceSummary[] = [];
  const cappedSources: Source[] = [];
  const globalExclusions = emptyExclusions();
  let truncated = false;
  let boundaryResolutionSnapshot: SearchCriteria["boundaryResolution"] = null;
  const maxResults = run.requested_max_results;
  const maxPages = run.requested_max_pages;
  let polygon: BoundaryPolygon | null = null;
  const notices: string[] = [];
  try {
    let boundaryUnavailable = false;
    let boundaryTooLarge = false;
    if (criteria.mode === "boundary" && criteria.boundary) {
      try {
        const boundary = await deps.resolveBoundary(criteria.boundary, appConfig);
        polygon = boundary?.geometry ?? null;
        if (boundary?.bounds) criteria.bounds = boundary.bounds;
        if (boundary?.bounds && boundsAreaKm2(boundary.bounds) > (criteria.plan === "tiled" ? appConfig.limits.maxTiledAreaKm2 : appConfig.limits.maxAreaKm2)) boundaryTooLarge = true;
        if (boundary) criteria.boundaryResolution = {
          relationId: boundary.relationId, name: boundary.name, adminLevel: boundary.adminLevel,
          precision: boundary.geometry ? "polygon" : "bbox", boundsSource: boundary.geometry ? "osm" : criteria.boundaryResolution?.boundsSource === "map" ? "map" : "osm", selectedBoundsSource: criteria.boundaryResolution?.selectedBoundsSource ?? (criteria.boundaryResolution?.boundsSource === "map" ? "map" : null),
          reason: boundary.geometry ? null : "Boundary geometry unavailable; using bounding box.", geometryHash: null, ringCount: boundary.geometry ? boundary.geometry.length + 1 : null, vertexCount: boundary.geometry?.reduce((n, rings) => n + rings.reduce((sum, ring) => sum + ring.length, 0), 0) ?? null, osmTimestamp: null,
        };
        boundaryResolutionSnapshot = criteria.boundaryResolution ?? null;
      } catch (error) { notices.push(`Boundary geometry could not be resolved: ${errorMessage(error)}`); }
      if (!criteria.bounds && !criteria.center && !polygon) {
        boundaryUnavailable = true;
        errors.push({ source: "system", code: "boundary_unavailable", message: "No location-based search could be performed." });
        notices.push("No location-based search could be performed.");
        criteria.boundaryResolution = { relationId: null, name: criteria.boundary?.name ?? null, adminLevel: null, precision: "radius", boundsSource: "none", selectedBoundsSource: criteria.boundaryResolution?.selectedBoundsSource ?? null, reason: "No boundary, usable center, or bounds were available.", geometryHash: null, ringCount: null, vertexCount: null, osmTimestamp: null };
        boundaryResolutionSnapshot = criteria.boundaryResolution;
      }
      if (boundaryUnavailable) {
        for (const source of run.sources) summaries.push({ ...summary(source, "error"), error: "No location-based search could be performed.", stopReason: "source_error" });
      }
    }
    for (const source of run.sources) {
      if (boundaryUnavailable) break;
      const current = summary(source, boundaryTooLarge ? "error" : "ok");
      current.boundaryPrecision = getBoundaryPrecision(criteria);
      summaries.push(current);
      if (boundaryTooLarge) {
        errors.push({ source, code: "boundary_too_large", message: "The resolved boundary exceeds the configured search area limit." });
        current.status = "error"; current.stopReason = "source_error"; current.error = "The resolved boundary exceeds the configured search area limit.";
        continue;
      }
      if (source === "osm") {
        let params: Record<string, unknown>;
        try { params = { query: buildOverpassQuery(criteria, maxResults) }; }
        catch (error) {
          const failure = error instanceof SourceFailure ? error : new SourceFailure("source_error", errorMessage(error));
          errors.push({ source, code: failure.code, message: failure.message, retryable: failure.retryable });
          current.status = "error"; current.error = failure.message; current.stopReason = "source_error";
          continue;
        }
        const requestId = await startRequest(runId, source, 1, fingerprint(params), { ...params, boundaryResolution: criteria.boundaryResolution ?? null }, 0, appConfig);
        const began = Date.now();
        try {
          const result: OsmSearchResult = await deps.searchOsm(criteria, appConfig);
          const exclusions = parseExclusions(result);
          current.requests = 1; current.pages = 1; current.results = result.returned;
          for (const place of result.places) {
            const distance = criteria.center ? haversineMeters(criteria.center, { lat: place.lat, lon: place.lon }) : null;
            const record = await deps.saveSourcePlace(place, appConfig);
            const inserted = await deps.addRunPlace(runId, record.id, distance, current.kept + 1);
            await deps.findAndRecordMatch(record.id);
            if (!inserted) current.duplicates++;
            else current.kept++;
          }
          current.filteredOut = exclusions.missingCoordinates + exclusions.invalidRecord;
          current.exclusions = exclusions;
          await finishRequest(requestId, { status: result.capped ? "capped" : "success", httpStatus: 200, resultCount: result.returned, keptCount: current.kept, filteredCount: current.filteredOut, creditsActual: 0, durationMs: Date.now() - began, exclusions });
          if (result.capped) { current.status = "capped"; current.stopReason = "result_limit"; cappedSources.push(source); truncated = true; }
        } catch (error) {
          const failure = error instanceof SourceFailure ? error : new SourceFailure("source_error", errorMessage(error));
          errors.push({ source, code: failure.code, message: failure.message, retryable: failure.retryable });
          current.status = "error"; current.error = failure.message; current.stopReason = "source_error";
          await finishRequest(requestId, { status: "error", httpStatus: 502, errorCode: failure.code, errorMessage: failure.message, durationMs: Date.now() - began });
        }
        continue;
      }

      let page = 1;
      const seen = new Set<string>();
      const tileResult = criteria.plan === "tiled" && criteria.bounds ? buildTilePlan(criteria.bounds, {
        maxTileAreaKm2: appConfig.limits.maxAreaKm2, maxTiledAreaKm2: appConfig.limits.maxTiledAreaKm2,
        maxTiles: appConfig.limits.maxTilesPerRun, columns: criteria.tiling?.columns, rows: criteria.tiling?.rows,
      }) : null;
      const tilePlan = tileResult?.ok ? tileResult.plan.tiles : [];
      if (tileResult && !tileResult.ok) throw new Error(tileResult.message);
      const queries = criteria.plan === "tiled" && tilePlan.length ? tilePlan.map((tile) => ({ criteria: { ...criteria, center: tile.center, bounds: tile.bounds, radiusMeters: 0 }, label: `tile-${tile.index}` })) : [{ criteria, label: "standard" }];
      const importRefs: ImportedPlaceRef[] = criteria.plan === "import" ? criteria.importRefs ?? [] : [];
      const estimatedCalls = criteria.plan === "import" ? importRefs.length : criteria.plan === "tiled" ? tileRequestEstimate(queries.length, criteria.tiling?.maxPagesPerTile ?? 1) : maxPages;
      const serpBudget = await reserveSerpApiCalls(estimatedCalls, appConfig);
      let callCount = 0;
      for (const item of queries) {
        let queryPage = 1;
        while (queryPage <= maxPages && current.results < maxResults) {
          if (callCount >= estimatedCalls) break;
          const params = buildSerpApiSearchParams(item.criteria, queryPage, appConfig);
          const sanitizedParams = Object.fromEntries(params.entries());
          const requestId = await startRequest(runId, source, page, fingerprint(sanitizedParams), { ...sanitizedParams, query: item.label }, 1);
          const began = Date.now();
          try {
            const result: SourceSearchPage = await deps.searchSerpApiPage(item.criteria, queryPage, appConfig);
            callCount++; current.requests++; current.pages++; current.results += result.returned; current.creditsEstimated++; current.creditsActual++;
            const exclusions = parseExclusions(result);
            for (const place of result.places) {
              const distance = item.criteria.center ? haversineMeters(item.criteria.center, { lat: place.lat, lon: place.lon }) : null;
              const record = await deps.saveSourcePlace(place, appConfig);
              const inserted = await deps.addRunPlace(runId, record.id, distance, current.kept + 1);
              const matched = await deps.findAndRecordMatch(record.id);
              if (matched) current.duplicates++;
              if (inserted) current.kept++;
            }
            current.filteredOut += exclusions.missingCoordinates + exclusions.invalidRecord;
            current.exclusions = addExclusions(current.exclusions ?? emptyExclusions(), exclusions);
            await finishRequest(requestId, { status: "success", resultCount: result.returned, keptCount: current.kept, filteredCount: current.filteredOut, duplicateCount: current.duplicates, creditsActual: 1, durationMs: Date.now() - began, exclusions });
            if (!result.hasNext) break;
            if (seen.has(result.pageFingerprint)) { current.status = "capped"; current.stopReason = "repeated_page"; cappedSources.push(source); truncated = true; break; }
            seen.add(result.pageFingerprint); queryPage++; page++;
          } catch (error) {
            const failure = error instanceof SourceFailure ? error : new SourceFailure("source_error", errorMessage(error));
            callCount++; current.requests++; current.creditsEstimated++; current.creditsActual++;
            errors.push({ source, code: failure.code, message: failure.message, retryable: failure.retryable });
            current.status = "error"; current.error = failure.message; current.stopReason = "source_error";
            await finishRequest(requestId, { status: "error", errorCode: failure.code, errorMessage: failure.message, creditsActual: 1, durationMs: Date.now() - began });
            break;
          }
        }
        if (current.results >= maxResults || current.pages >= maxPages) break;
      }
      if (!serpBudget.allowed) { current.status = current.requests ? "capped" : "error"; current.stopReason = "budget_limit"; }
      if (current.status === "capped") { cappedSources.push(source); truncated = true; }
    }
    await updateHeartbeat(runId, { sources: summaries.map((item) => ({ source: item.source, requests: item.requests, results: item.results })) });
    for (const item of summaries) Object.assign(globalExclusions, addExclusions(globalExclusions, item.exclusions ?? emptyExclusions()));
    if (boundaryUnavailable || boundaryTooLarge) {
      const failureMessage = boundaryUnavailable
        ? "No location-based search could be performed."
        : "The resolved boundary exceeds the configured search area limit.";
      const failureCode = boundaryUnavailable ? "boundary_unavailable" : "boundary_too_large";
      const failureErrors = errors.length ? errors : [{ source: "system" as const, code: failureCode, message: failureMessage }];
      const failureCaveats = caveatsFor(criteria, failureErrors, false, globalExclusions, cappedSources, summaries, notices);
      const failureSummary = { sources: summaries, errors: failureErrors, coverage: "failed", boundaryResolution: boundaryResolutionSnapshot ?? criteria.boundaryResolution ?? null };
      await query("UPDATE search_runs SET status = 'failed', coverage = 'failed', finished_at=now(), heartbeat_at=now(), progress=$2::jsonb, summary=$3::jsonb, errors=$4::jsonb, caveats=$5::jsonb, truncated=false, source_summaries=$6::jsonb, result_count=0, filtered_out=0, duplicate_count=0, center_lat=$7, center_lon=$8, bounds=$9::jsonb WHERE id=$1 AND status='running'", [runId, JSON.stringify({ sources: summaries }), JSON.stringify(failureSummary), JSON.stringify(failureErrors), JSON.stringify(failureCaveats), JSON.stringify(summaries), criteria.center?.lat ?? null, criteria.center?.lon ?? null, criteria.bounds ? JSON.stringify(criteria.bounds) : null]);
      return;
    }
    const totals = await one<{ total: string; osm: string; serpapi: string; filtered: string; duplicates: string; credits: string; serpapi_credits: string; osm_requests: string; serpapi_requests: string; osm_pages: string; serpapi_pages: string }>(`SELECT
      COALESCE(SUM(result_count),0)::text AS total,
      COALESCE(SUM(result_count) FILTER (WHERE source='osm'),0)::text AS osm,
      COALESCE(SUM(result_count) FILTER (WHERE source='serpapi'),0)::text AS serpapi,
      COALESCE(SUM(filtered_count),0)::text AS filtered,
      COALESCE(SUM(duplicate_count),0)::text AS duplicates,
      COALESCE(SUM(credits_actual),0)::text AS credits,
      COALESCE(SUM(credits_actual) FILTER (WHERE source='serpapi'),0)::text AS serpapi_credits,
      COUNT(*) FILTER (WHERE source='osm')::text AS osm_requests,
      COUNT(*) FILTER (WHERE source='serpapi')::text AS serpapi_requests,
      COUNT(*) FILTER (WHERE source='osm' AND status IN ('success','capped','error'))::text AS osm_pages,
      COUNT(*) FILTER (WHERE source='serpapi' AND status IN ('success','capped','error'))::text AS serpapi_pages
      FROM source_requests WHERE run_id=$1`, [runId]);
    for (const source of run.sources) {
      if (!summaries.some((item) => item.source === source)) summaries.push(summary(source, "skipped"));
    }
    if (totals) {
      for (const item of summaries) {
        const prefix = item.source;
        item.results = Math.max(item.results, Number(totals[prefix]));
        item.requests = Number(totals[`${prefix}_requests`]);
        item.pages = Number(totals[`${prefix}_pages`]);
        item.creditsActual = item.source === "serpapi" ? Number(totals.serpapi_credits) : 0;
        item.creditsEstimated = item.creditsActual;
      }
    }
    if (!totals) throw new Error("Could not aggregate search-run source requests");
    const status = errors.length === 0 ? (cappedSources.length ? "partial" : "completed") : summaries.some((item) => item.requests > 0) ? "partial" : "failed";
    const coverage: CoverageStatus = status === "failed" ? "failed" : errors.length ? "partial" : cappedSources.length ? "capped" : "within_limits";
    const caveats = caveatsFor(criteria, errors, truncated, globalExclusions, cappedSources, summaries, notices);
    const resultCount = summaries.reduce((n, item) => n + item.kept, 0);
    const filteredOut = globalExclusions.missingCoordinates + globalExclusions.invalidRecord;
    const duplicateCount = summaries.reduce((n, item) => n + item.duplicates, 0);
    const creditsEstimated = summaries.reduce((n, item) => n + item.creditsEstimated, 0);
    const creditsActual = summaries.reduce((n, item) => n + item.creditsActual, 0);
    const sourceSummaries = summaries;
    const runDetails = { sources: sourceSummaries, errors, coverage, caveats, boundaryResolution: boundaryResolutionSnapshot ?? criteria.boundaryResolution ?? null };
    const result = await query(`UPDATE search_runs SET
       status=$2, coverage=$3, result_count=$4, filtered_out=$5, duplicate_count=$6, truncated=$7,
       credits_estimated = $8::integer, credits_actual=$9::integer,
       osm_requests=$10::integer, serpapi_requests=$11::integer,
       pages_osm=$12::integer, pages_serpapi=$13::integer,
       progress=$14::jsonb, summary=$15::jsonb, caveats=$16::jsonb,
       center_lat=$17, center_lon=$18, bounds=$19::jsonb, errors=$20::jsonb,
       source_summaries=$21::jsonb, finished_at=now(), heartbeat_at=now()
     WHERE id=$1 AND status='running'`, [
       runId, status, coverage, resultCount, filteredOut, duplicateCount, truncated, creditsEstimated, creditsActual,
       summaries.find((item) => item.source === "osm")?.requests ?? 0,
       summaries.find((item) => item.source === "serpapi")?.requests ?? 0,
       summaries.find((item) => item.source === "osm")?.pages ?? 0,
       summaries.find((item) => item.source === "serpapi")?.pages ?? 0,
       JSON.stringify({ sources: summaries }),
       JSON.stringify({ ...runDetails, criteria, boundaryResolution: boundaryResolutionSnapshot ?? criteria.boundaryResolution ?? null }),
       JSON.stringify(caveats), criteria.center?.lat ?? null, criteria.center?.lon ?? null,
       criteria.bounds ? JSON.stringify(criteria.bounds) : null, JSON.stringify(errors), JSON.stringify(sourceSummaries),
     ]);
    if (result?.rowCount) {
      await audit({ actor: run.created_by, action: "search_run.finished", targetType: "search_run", targetId: runId, metadata: { status, coverage, results: resultCount, requests: summaries.reduce((n, item) => n + item.requests, 0) } });
    }
  } catch (error) {
    const message = errorMessage(error);
    logger.error({ runId, error: message }, "Search run failed unexpectedly");
    await query("UPDATE search_runs SET status='failed',finished_at=now(),heartbeat_at=now(),errors=$2::jsonb WHERE id=$1 AND status='running'", [runId, JSON.stringify([{ source: "system", code: "runner_error", message }])]);
  }
}

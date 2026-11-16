import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, checkOrigin, requireCsrf } from "../auth.js";
import { config } from "../config.js";
import { one, many, query } from "../db.js";
import { AppError } from "../errors.js";
import { hashIp } from "../auth-crypto.js";
import { audit } from "../services/audit.js";
import { deleteExportFile, validateExportFields } from "../services/export.js";
import type { ExportFormat, ExportJob, ExportManifest, Source } from "../../shared/types.js";

interface ExportRow {
  id: string;
  scope: ExportJob["scope"];
  scope_id: string | null;
  selection: string[] | null;
  format: ExportFormat;
  fields: string[];
  sources: Source[];
  inside_only: boolean;
  status: ExportJob["status"];
  row_count: number | null;
  omitted_sources: string[];
  manifest: ExportManifest | null;
  file_name: string | null;
  error: string | null;
  created_at: Date;
  finished_at: Date | null;
  expires_at: Date | null;
  download_count: number;
  last_downloaded_at: Date | null;
}

function exportDto(row: ExportRow): ExportJob {
  const active = row.status === "completed" && (!row.expires_at || row.expires_at > new Date());
  return {
    id: row.id,
    scope: row.scope,
    scopeId: row.scope_id,
    selectionCount: row.selection?.length ?? null,
    format: row.format,
    fields: row.fields,
    sources: row.sources,
    insideOnly: Boolean(row.inside_only),
    status: row.status,
    rowCount: row.row_count,
    omittedSources: row.omitted_sources ?? [],
    error: row.error,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    expiresAt: row.expires_at?.toISOString() ?? null,
    fileName: row.file_name,
    downloadCount: row.download_count ?? 0,
    lastDownloadedAt: row.last_downloaded_at?.toISOString() ?? null,
    downloadUrl: active ? `/api/export-jobs/${row.id}/download` : null,
    manifest: row.manifest,
  };
}

const createExportSchema = z.object({
  scope: z.enum(["run", "collection", "saved"]),
  scopeId: z.string().uuid().optional(),
  savedPlaceIds: z.array(z.string().uuid()).min(1).max(5000).optional(),
  format: z.enum(["csv", "geojson", "json", "xlsx"]),
  fields: z.unknown().optional(),
  sources: z.array(z.enum(["osm", "serpapi"])).min(1).max(2),
  insideOnly: z.boolean().optional().default(false),
}).superRefine((value, ctx) => {
  if (value.scope === "saved" && !value.savedPlaceIds?.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Select at least one saved place to export.", path: ["savedPlaceIds"] });
  }
  if (value.scope !== "saved" && !value.scopeId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Choose a run or collection to export.", path: ["scopeId"] });
  }
  if (value.scope !== "saved" && value.savedPlaceIds?.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Place selections are only valid for saved-place exports.", path: ["savedPlaceIds"] });
  }
});

export async function registerExportRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/export-jobs", { preHandler: authenticate }, async (request) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).safeParse(request.query);
    const limit = q.success ? q.data.limit : 20;
    const rows = await many<ExportRow>("SELECT * FROM export_jobs ORDER BY created_at DESC LIMIT $1", [limit]);
    return { jobs: rows.map(exportDto) };
  });

  app.post(
    "/api/export-jobs",
    { preHandler: [authenticate, requireCsrf], config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      checkOrigin(request);
      const parsed = createExportSchema.safeParse(request.body);
      if (!parsed.success) throw new AppError(400, "invalid_export", parsed.error.issues[0]?.message ?? "Invalid export request.");
      const fields = validateExportFields(parsed.data.fields);
      if (parsed.data.scope === "run") {
        const run = await one<{ status: string }>("SELECT status FROM search_runs WHERE id = $1", [
          parsed.data.scopeId,
        ]);
        if (!run) throw new AppError(404, "not_found", "Search run not found.");
        if (!["completed", "partial"].includes(run.status)) {
          throw new AppError(409, "run_not_finished", "Wait for the search run to finish before exporting it.");
        }
      } else if (parsed.data.scope === "collection") {
        const collection = await one<{ id: string }>("SELECT id FROM collections WHERE id = $1", [
          parsed.data.scopeId,
        ]);
        if (!collection) throw new AppError(404, "not_found", "Collection not found.");
      } else {
        const ids = parsed.data.savedPlaceIds ?? [];
        const found = await many<{ id: string }>(
          "SELECT id FROM saved_places WHERE id = ANY($1::uuid[])",
          [ids],
        );
        if (found.length !== new Set(ids).size) {
          throw new AppError(404, "not_found", "Some selected saved places no longer exist.");
        }
      }
      const selection = parsed.data.scope === "saved" ? [...new Set(parsed.data.savedPlaceIds ?? [])] : null;
      // Collapse repeat submissions: a double-click or a retry must not build a
      // second identical archive. Identical requests inside 60 seconds reuse
      // the existing job instead.
      const duplicate = await one<ExportRow>(
        `SELECT * FROM export_jobs
         WHERE scope = $1
           AND scope_id IS NOT DISTINCT FROM $2::uuid
           AND format = $3
           AND fields = $4::text[]
           AND sources = $5::text[]
           AND inside_only = $6
           AND selection IS NOT DISTINCT FROM $7::jsonb
           AND created_by = $8
           AND created_at > now() - interval '60 seconds'
           AND status IN ('queued', 'running', 'completed')
         ORDER BY created_at DESC
         LIMIT 1`,
        [
          parsed.data.scope,
          parsed.data.scope === "saved" ? null : parsed.data.scopeId,
          parsed.data.format,
          fields,
          parsed.data.sources,
          parsed.data.insideOnly,
          selection ? JSON.stringify(selection) : null,
          request.auth!.displayName,
        ],
      );
      if (duplicate) {
        return reply.code(200).send(exportDto(duplicate));
      }
      const row = await one<ExportRow>(
        `INSERT INTO export_jobs (scope, scope_id, selection, format, fields, sources, inside_only, created_by)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8) RETURNING *`,
        [
          parsed.data.scope,
          parsed.data.scope === "saved" ? null : parsed.data.scopeId,
          selection ? JSON.stringify(selection) : null,
          parsed.data.format,
          fields,
          parsed.data.sources,
          parsed.data.insideOnly,
          request.auth!.displayName,
        ],
      );
      if (!row) throw new Error("Could not create export job");
      await audit({
        actor: request.auth!.displayName,
        action: "export.queued",
        targetType: "export_job",
        targetId: row.id,
        ipHash: hashIp(request.ip),
        metadata: {
          scope: parsed.data.scope,
          scopeId: parsed.data.scope === "saved" ? null : parsed.data.scopeId,
          selectionCount: selection?.length ?? null,
          format: parsed.data.format,
          sources: parsed.data.sources,
          fields,
        },
      });
      return reply.code(202).send(exportDto(row));
    },
  );

  app.get("/api/export-jobs/:id", { preHandler: authenticate }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) throw new AppError(400, "invalid_id", "Invalid export job id.");
    const row = await one<ExportRow>("SELECT * FROM export_jobs WHERE id = $1", [params.data.id]);
    if (!row) throw new AppError(404, "not_found", "Export job not found.");
    return exportDto(row);
  });

  app.delete(
    "/api/export-jobs/:id",
    { preHandler: [authenticate, requireCsrf] },
    async (request) => {
      checkOrigin(request);
      const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
      if (!params.success) throw new AppError(400, "invalid_id", "Invalid export job id.");
      const row = await one<{ id: string; file_path: string | null; status: string }>(
        "SELECT id, file_path, status FROM export_jobs WHERE id = $1",
        [params.data.id],
      );
      if (!row) throw new AppError(404, "not_found", "Export job not found.");
      if (row.status === "queued" || row.status === "running") {
        throw new AppError(409, "export_in_progress", "Wait for this export to finish before deleting it.");
      }
      // Delete conditionally so a job that starts running between the read and
      // the delete cannot be removed out from under the worker.
      const deleted = await query<{ id: string }>(
        "DELETE FROM export_jobs WHERE id = $1 AND status NOT IN ('queued', 'running') RETURNING id",
        [row.id],
      );
      if (!deleted.rowCount) {
        throw new AppError(409, "export_in_progress", "This export started running. Try again once it finishes.");
      }
      let fileDeleted = false;
      let fileCleanupFailed = false;
      try {
        fileDeleted = await deleteExportFile(row.file_path, config);
      } catch (error) {
        fileCleanupFailed = true;
        request.log.error({ err: error, exportJobId: row.id }, "Could not remove export archive");
      }
      await audit({
        actor: request.auth!.displayName,
        action: "export.deleted",
        targetType: "export_job",
        targetId: row.id,
        ipHash: hashIp(request.ip),
        metadata: { fileDeleted, fileCleanupFailed },
      });
      return { id: row.id, deleted: true, fileDeleted, fileCleanupFailed };
    },
  );

  app.get("/api/export-jobs/:id/download", { preHandler: authenticate }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) throw new AppError(400, "invalid_id", "Invalid export job id.");
    const row = await one<ExportRow & { file_path: string | null }>(
      "SELECT * FROM export_jobs WHERE id = $1",
      [params.data.id],
    );
    if (!row) throw new AppError(404, "not_found", "Export job not found.");
    if (row.status !== "completed") throw new AppError(409, "not_ready", "Export is not ready yet.");
    if (row.expires_at && row.expires_at <= new Date()) {
      throw new AppError(410, "expired", "This export has expired. Create a new export.");
    }
    if (!row.file_path || !row.file_name) throw new AppError(410, "file_missing", "Export file is unavailable.");
    const exportsRoot = path.resolve(config.exportsDir) + path.sep;
    const resolved = path.resolve(row.file_path);
    if (!resolved.startsWith(exportsRoot)) throw new AppError(500, "invalid_path", "Invalid export path.");
    let fileSize: number;
    try {
      const fileStat = await stat(resolved);
      if (!fileStat.isFile()) throw new Error("not a file");
      fileSize = fileStat.size;
    } catch {
      throw new AppError(410, "file_missing", "Export file is no longer available.");
    }
    await query(
      "UPDATE export_jobs SET download_count = download_count + 1, last_downloaded_at = now() WHERE id = $1",
      [row.id],
    );
    await audit({
      actor: request.auth!.displayName,
      action: "export.downloaded",
      targetType: "export_job",
      targetId: row.id,
      ipHash: hashIp(request.ip),
    });
    const safeName = row.file_name.replaceAll('"', "");
    reply
      .header("Content-Type", "application/zip")
      .header(
        "Content-Disposition",
        `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
      )
      .header("Content-Length", String(fileSize))
      .header("Cache-Control", "no-store, private")
      .header("X-Content-Type-Options", "nosniff");
    return reply.send(createReadStream(resolved));
  });
}

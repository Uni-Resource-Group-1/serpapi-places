import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { closePool, many, one, query } from "./db.js";
import { logger } from "./logger.js";
import { executeSearchRun } from "./services/search-runner.js";
import { cleanupExpiredExports, failExportJob, processExportJob } from "./services/export.js";
import { createSearchRun } from "./services/search-runs.js";
import { validateCriteria } from "./validation.js";

let stopping = false;
let busy = false;
let lastAutoRefresh = 0;
let lastCleanup = 0;

async function claimSearchRun(): Promise<string | null> {
  const row = await one<{ id: string }>(
    `UPDATE search_runs SET status = 'running', started_at = COALESCE(started_at, now()), heartbeat_at = now()
     WHERE id = (
       SELECT id FROM search_runs WHERE status = 'queued'
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id`,
  );
  return row?.id ?? null;
}

async function claimExportJob(): Promise<string | null> {
  const row = await one<{ id: string }>(
    `UPDATE export_jobs SET status = 'running', started_at = now()
     WHERE id = (
       SELECT id FROM export_jobs WHERE status = 'queued'
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     AND status = 'queued'
     RETURNING id`,
  );
  return row?.id ?? null;
}

async function recoverStale(): Promise<void> {
  const recovered = await many<{ id: string }>(
    `UPDATE search_runs SET status = 'queued', started_at = NULL
     WHERE status = 'running' AND heartbeat_at < now() - interval '30 minutes'
       AND NOT EXISTS (
         SELECT 1 FROM source_requests sr WHERE sr.run_id = search_runs.id
           AND sr.status = 'running' AND sr.created_at > now() - interval '30 minutes'
       )
     RETURNING id`,
  );
  if (recovered.length > 0) {
    logger.warn({ count: recovered.length }, "Requeued stale search runs");
  }
  await query(
    `UPDATE export_jobs SET status = 'queued', started_at = NULL
     WHERE status = 'running' AND started_at < now() - interval '15 minutes'`,
  );
}

function isDatabaseNotReady(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "42P01" || code === "3D000" || code === "57P03" || code === "ECONNREFUSED";
}

async function waitForSchema(): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      await recoverStale();
      return;
    } catch (error) {
      if (!isDatabaseNotReady(error) || Date.now() >= deadline) throw error;
      logger.warn("Database schema is not ready yet; worker will retry");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

export async function scheduleSavedSearches(): Promise<void> {
  if (Date.now() - lastAutoRefresh < 60_000) return;
  lastAutoRefresh = Date.now();
  const due = await many<{
    id: string;
    criteria: unknown;
    refresh_interval_minutes: number;
  }>(
    `SELECT s.id, s.criteria, s.refresh_interval_minutes, s.auto_refresh_skipped_at
     FROM saved_searches s
     WHERE s.refresh_interval_minutes > 0
       AND (s.last_auto_run_at IS NULL OR s.last_auto_run_at < now() - (s.refresh_interval_minutes * interval '1 minute'))
       AND NOT EXISTS (
         SELECT 1 FROM search_runs r
         WHERE r.saved_search_id = s.id AND r.status IN ('queued', 'running')
       )
     ORDER BY s.last_auto_run_at ASC NULLS FIRST
     LIMIT 5`,
  );
  for (const saved of due) {
    try {
      const criteria = validateCriteria(saved.criteria, config);

      const intervalMs = Math.max(1, saved.refresh_interval_minutes) * 60_000;
      const bucket = Math.floor(Date.now() / intervalMs);
      const created = await createSearchRun(
        {
          criteria,
          savedSearchId: saved.id,
          actor: "auto-refresh",
          idempotencyKey: `auto:${saved.id}:${bucket}`,
        },
        config,
      );
      await query("UPDATE saved_searches SET last_auto_run_at = now(), auto_refresh_skipped_at = NULL, auto_refresh_skip_reason = NULL WHERE id = $1", [saved.id]);
      logger.info(
        { savedSearchId: saved.id, runId: created.runId, reused: created.reused, interval: saved.refresh_interval_minutes },
        "Auto-refresh search queued",
      );
    } catch (error) {
      logger.error({ err: error, savedSearchId: saved.id }, "Auto-refresh failed to queue");
    }
  }
}

async function heartbeatFile(): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(path.join(config.dataDir, "worker-heartbeat"), String(Date.now()), "utf8");
}

async function tick(): Promise<void> {
  if (busy || stopping) return;
  busy = true;
  try {
    await heartbeatFile();
    await recoverStale();
    await scheduleSavedSearches();
    for (let i = 0; i < 3; i += 1) {
      const runId = await claimSearchRun();
      if (!runId) break;
      try {
        await executeSearchRun(runId, config);
      } catch (error) {
        logger.error({ err: error, runId }, "Search run failed");
        await query(
          `UPDATE search_runs SET status = 'failed', coverage = 'failed', finished_at = now(),
             errors = errors || $2::jsonb WHERE id = $1`,
          [runId, JSON.stringify([{ source: "system", code: "worker_error", message: "Search worker failed" }])],
        );
      }
    }
    for (let i = 0; i < 2; i += 1) {
      const jobId = await claimExportJob();
      if (!jobId) break;
      try {
        await processExportJob(jobId, config);
      } catch (error) {
        logger.error({ err: error, jobId }, "Export job failed");
        await failExportJob(jobId, error);
      }
    }
    if (Date.now() - lastCleanup > 15 * 60_000) {
      lastCleanup = Date.now();
      const removed = await cleanupExpiredExports(config);
      if (removed > 0) logger.info({ removed }, "Expired export files cleaned up");
    }
  } catch (error) {
    logger.error({ err: error }, "Worker tick failed");
  } finally {
    busy = false;
  }
}

async function main(): Promise<void> {
  logger.info({ env: config.env, version: config.version }, "Places Discovery worker starting");
  await heartbeatFile();
  await waitForSchema();
  const timer = setInterval(() => void tick(), 1_500);
  void tick();

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "Worker shutting down");
    clearInterval(timer);
    const deadline = Date.now() + 20_000;
    while (busy && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
    await closePool();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.error({ err: error }, "Worker crashed");
  process.exit(1);
});

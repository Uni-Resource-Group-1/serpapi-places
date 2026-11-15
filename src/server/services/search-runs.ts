import { createHash } from "node:crypto";
import type { AppConfig } from "../config.js";
import { transaction } from "../db.js";
import type { SearchCriteria } from "../../shared/types.js";
import { audit } from "./audit.js";
import { getSettings } from "./usage.js";
import { AppError } from "../errors.js";
import { validateCriteria } from "../validation.js";

/** Trusted metadata persisted alongside the run, never part of public SearchCriteria. */
export interface CreateSearchRunInput {
  criteria: SearchCriteria;
  savedSearchId?: string | null;
  actor: string;
  ipHash?: string | null;
  idempotencyKey?: string | null;
}

interface ExistingRun {
  id: string;
  criteria: unknown;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function criteriaFingerprint(criteria: SearchCriteria): string {
  return createHash("sha256").update(canonical(criteria)).digest("hex");
}

export async function createSearchRun(
  input: CreateSearchRunInput,
  appConfig: AppConfig,
): Promise<{ runId: string; reused: boolean }> {
  const criteria = validateCriteria(input.criteria, appConfig);

  const settings = await getSettings(appConfig);
  const maxPages = criteria.plan === "tiled"
    ? Math.max(1, Math.min(criteria.tiling?.maxPagesPerTile ?? 1, appConfig.limits.maxPagesPerTile, 5))
    : Math.max(1, Math.min(settings.serpapiMaxPages, appConfig.limits.maxPagesHard, 6));
  const maxResults = Math.max(20, Math.min(settings.serpapiMaxResults, appConfig.limits.maxResultsPerSource));

  const result = await transaction(async (client) => {
    if (input.idempotencyKey) {
      // Serialize requests for the same key, including the first-insert race.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [input.idempotencyKey]);
      const existing = await client.query<ExistingRun>(
        "SELECT id, criteria FROM search_runs WHERE idempotency_key = $1 FOR UPDATE",
        [input.idempotencyKey],
      );
      const prior = existing.rows[0];
      if (prior) {
        const priorCriteria = validateCriteria(prior.criteria, appConfig);
        if (criteriaFingerprint(priorCriteria) !== criteriaFingerprint(criteria)) {
          throw new AppError(409, "idempotency_conflict", "This idempotency key was already used for a different search.");
        }
        return { id: prior.id, reused: true };
      }
    }

    if (input.savedSearchId) {
      const saved = await client.query<{ id: string }>("SELECT id FROM saved_searches WHERE id = $1", [input.savedSearchId]);
      if (saved.rowCount === 0) throw new Error("Saved search not found");
    }
    const persistedCriteria = criteria;
    const definition = await client.query<{ id: string }>(
      `INSERT INTO search_definitions (saved_search_id, criteria, created_by)
       VALUES ($1, $2::jsonb, $3) RETURNING id`,
      [input.savedSearchId ?? null, JSON.stringify(persistedCriteria), input.actor],
    );
    const created = await client.query<{ id: string }>(
      `INSERT INTO search_runs
         (definition_id, saved_search_id, criteria, sources, center_lat, center_lon, radius_m, bounds,
          keyword, category, requested_max_pages, requested_max_results, idempotency_key, created_by, plan)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`,
      [definition.rows[0]?.id ?? null, input.savedSearchId ?? null, JSON.stringify(persistedCriteria),
        criteria.sources, criteria.center?.lat ?? null, criteria.center?.lon ?? null, criteria.radiusMeters,
        criteria.bounds ? JSON.stringify(criteria.bounds) : null, criteria.keyword, criteria.category, maxPages,
        maxResults, input.idempotencyKey ?? null, input.actor, criteria.plan ?? "standard"],
    );
    const id = created.rows[0]?.id;
    if (!id) throw new Error("Could not create search run");
    return { id, reused: false };
  });

  if (!result.reused) {
    await audit({
      actor: input.actor, action: "search_run.created", targetType: "search_run", targetId: result.id,
      ipHash: input.ipHash ?? null,
      metadata: { sources: criteria.sources, mode: criteria.mode, category: criteria.category,
        keywordLength: criteria.keyword.length, radiusMeters: criteria.radiusMeters,
        savedSearchId: input.savedSearchId ?? null },
    });
  }
  return { runId: result.id, reused: result.reused };
}

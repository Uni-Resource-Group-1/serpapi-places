import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, checkOrigin, requireCsrf } from "../auth.js";
import { config } from "../config.js";
import { many, one, query } from "../db.js";
import { AppError } from "../errors.js";
import { validateCriteria } from "../validation.js";
import { createSearchRun } from "../services/search-runs.js";
import {
  fetchCollections,
  fetchDuplicates,
  fetchPlace,
  fetchSavedPlaces,
  fetchSavedPlaceSummaries,
  fetchSavedSearches,
  savedSearchDto,
  type SavedSearchRow,
} from "../services/dto.js";
import { audit } from "../services/audit.js";
import { hashIp } from "../auth-crypto.js";

const refreshIntervals = [0, 15, 60, 360, 1440] as const;

const savedSearchSchema = z.object({
  name: z.string().trim().min(1).max(120),
  criteria: z.unknown(),
  refreshIntervalMinutes: z.number().int().refine((value) => refreshIntervals.includes(value as 0), {
    message: "Refresh interval must be 0, 15, 60, 360, or 1440 minutes",
  }).default(0),
});

const collectionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
});

/**
 * Delete source records that nothing else depends on. Run placements, reviews,
 * match candidates, and canonical links all cascade from the source record, so
 * this only runs for an explicit "delete the place too" request and never for a
 * plain unsave.
 */
async function destroyOrphanedSourceRecords(sourceRecordIds: string[]): Promise<number> {
  if (sourceRecordIds.length === 0) return 0;
  const deleted = await query(
    `DELETE FROM source_place_records s
     WHERE s.id = ANY($1::uuid[])
       AND NOT EXISTS (SELECT 1 FROM saved_places sp WHERE sp.source_record_id = s.id)`,
    [sourceRecordIds],
  );
  return deleted.rowCount ?? 0;
}

function snapshotFor(place: Awaited<ReturnType<typeof fetchPlace>>): Record<string, unknown> {
  if (!place) throw new AppError(404, "not_found", "Place not found.");
  return {
    name: place.name,
    address: place.address,
    category: place.category,
    lat: place.lat,
    lon: place.lon,
    source: place.source,
    sourceType: place.sourceType,
    sourceId: place.sourceId,
    sourceUrl: place.sourceUrl,
    fields: place.fields,
    provenance: place.provenance,
    retrievedAt: place.retrievedAt,
  };
}

export async function registerLibraryRoutes(app: FastifyInstance): Promise<void> {
  // Saved searches
  app.get("/api/saved-searches", { preHandler: authenticate }, async () => {
    return { searches: await fetchSavedSearches() };
  });

  app.post(
    "/api/saved-searches",
    { preHandler: [authenticate, requireCsrf], config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      checkOrigin(request);
      const parsed = savedSearchSchema.safeParse(request.body);
      if (!parsed.success) throw new AppError(400, "invalid_saved_search", parsed.error.issues[0]?.message ?? "Invalid saved search.");
      let criteria;
      try {
        criteria = validateCriteria(parsed.data.criteria, config);
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new AppError(400, "invalid_search", error.issues[0]?.message ?? "Invalid criteria.");
        }
        throw error;
      }
      const count = await one<{ total: string }>("SELECT count(*)::text AS total FROM saved_searches");
      if (Number(count?.total ?? 0) >= config.limits.maxSavedSearches) {
        throw new AppError(409, "limit_reached", `Saved search limit is ${config.limits.maxSavedSearches}.`);
      }
      const row = await one<SavedSearchRow>(
        `INSERT INTO saved_searches (name, criteria, refresh_interval_minutes, created_by)
         VALUES ($1, $2::jsonb, $3, $4) RETURNING *`,
        [parsed.data.name, JSON.stringify(criteria), parsed.data.refreshIntervalMinutes, request.auth!.displayName],
      );
      if (!row) throw new Error("Could not save search");
      await audit({
        actor: request.auth!.displayName,
        action: "saved_search.created",
        targetType: "saved_search",
        targetId: row.id,
        ipHash: hashIp(request.ip),
        metadata: { name: parsed.data.name, refreshIntervalMinutes: parsed.data.refreshIntervalMinutes },
      });
      return reply.code(201).send(savedSearchDto(row));
    },
  );

  app.patch(
    "/api/saved-searches/:id",
    { preHandler: [authenticate, requireCsrf] },
    async (request) => {
      checkOrigin(request);
      const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
      if (!params.success) throw new AppError(400, "invalid_id", "Invalid saved search id.");
      const body = z
        .object({
          name: z.string().trim().min(1).max(120).optional(),
          criteria: z.unknown().optional(),
          refreshIntervalMinutes: z.number().int().optional(),
        })
        .safeParse(request.body);
      if (!body.success) throw new AppError(400, "invalid_saved_search", "Invalid saved search update.");
      const current = await one<SavedSearchRow>("SELECT * FROM saved_searches WHERE id = $1", [params.data.id]);
      if (!current) throw new AppError(404, "not_found", "Saved search not found.");
      let criteriaJson: string | null = null;
      if (body.data.criteria !== undefined) {
        try {
          criteriaJson = JSON.stringify(validateCriteria(body.data.criteria, config));
        } catch (error) {
          if (error instanceof z.ZodError) throw new AppError(400, "invalid_search", error.issues[0]?.message ?? "Invalid criteria.");
          throw error;
        }
      }
      const refresh = body.data.refreshIntervalMinutes;
      if (
        refresh !== undefined &&
        !refreshIntervals.includes(refresh as 0)
      ) {
        throw new AppError(400, "invalid_refresh", "Refresh interval must be 0, 15, 60, 360, or 1440 minutes.");
      }
      const row = await one<SavedSearchRow>(
        `UPDATE saved_searches SET
           name = COALESCE($2, name),
           criteria = COALESCE($3::jsonb, criteria),
           refresh_interval_minutes = COALESCE($4, refresh_interval_minutes),
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [params.data.id, body.data.name ?? null, criteriaJson, refresh ?? null],
      );
      if (!row) throw new AppError(404, "not_found", "Saved search not found.");
      await audit({
        actor: request.auth!.displayName,
        action: "saved_search.updated",
        targetType: "saved_search",
        targetId: row.id,
        ipHash: hashIp(request.ip),
      });
      return savedSearchDto(row);
    },
  );

  app.delete(
    "/api/saved-searches/:id",
    { preHandler: [authenticate, requireCsrf] },
    async (request, reply) => {
      checkOrigin(request);
      const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
      if (!params.success) throw new AppError(400, "invalid_id", "Invalid saved search id.");
      const deleted = await query("DELETE FROM saved_searches WHERE id = $1", [params.data.id]);
      if (deleted.rowCount === 0) throw new AppError(404, "not_found", "Saved search not found.");
      await audit({
        actor: request.auth!.displayName,
        action: "saved_search.deleted",
        targetType: "saved_search",
        targetId: params.data.id,
        ipHash: hashIp(request.ip),
      });
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/saved-searches/:id/run",
    { preHandler: [authenticate, requireCsrf], config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      checkOrigin(request);
      const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
      if (!params.success) throw new AppError(400, "invalid_id", "Invalid saved search id.");
      const saved = await one<SavedSearchRow>("SELECT * FROM saved_searches WHERE id = $1", [params.data.id]);
      if (!saved) throw new AppError(404, "not_found", "Saved search not found.");
      let criteria;
      try {
        criteria = validateCriteria(saved.criteria, config);
      } catch (error) {
        if (error instanceof z.ZodError) throw new AppError(400, "invalid_search", error.issues[0]?.message ?? "Saved criteria are no longer valid.");
        throw error;
      }
      const created = await createSearchRun(
        {
          criteria,
          savedSearchId: saved.id,
          actor: request.auth!.displayName,
          ipHash: hashIp(request.ip),
        },
        config,
      );
      return reply.code(202).send(created);
    },
  );

  // Saved places
  app.get("/api/saved-places", { preHandler: authenticate }, async () => {
    const [places, collections] = await Promise.all([
      fetchSavedPlaces(config.serpapi.reviewsEnabled),
      fetchCollections(),
    ]);
    return { places, collections };
  });

  // Lightweight list for the export builder's place picker. Reads only the
  // snapshot columns a chooser needs, so it stays fast even for large libraries.
  app.get("/api/saved-places/summaries", { preHandler: authenticate }, async () => ({
    places: await fetchSavedPlaceSummaries(),
  }));

  app.post(
    "/api/saved-places",
    { preHandler: [authenticate, requireCsrf] },
    async (request, reply) => {
      checkOrigin(request);
      const body = z
        .object({
          sourceRecordId: z.string().uuid(),
          note: z.string().max(2000).nullable().optional(),
          collectionId: z.string().uuid().nullable().optional(),
        })
        .safeParse(request.body);
      if (!body.success) throw new AppError(400, "invalid_saved_place", "Invalid saved place payload.");
      const place = await fetchPlace(body.data.sourceRecordId, config.serpapi.reviewsEnabled);
      if (!place) throw new AppError(404, "not_found", "Place not found.");
      const snapshot = snapshotFor(place);
      const row = await one<{ id: string }>(
        `INSERT INTO saved_places (source_record_id, canonical_place_id, snapshot, note, created_by, expires_at)
         SELECT $1, canonical_place_id, $2::jsonb, $3, $4,
           CASE WHEN source = 'serpapi' THEN expires_at ELSE NULL END
         FROM source_place_records WHERE id = $1 AND (expires_at IS NULL OR expires_at > now())
         ON CONFLICT (source_record_id) WHERE source_record_id IS NOT NULL
         DO UPDATE SET note = EXCLUDED.note, snapshot = EXCLUDED.snapshot, expires_at = EXCLUDED.expires_at
         RETURNING id`,
        [body.data.sourceRecordId, JSON.stringify(snapshot), body.data.note ?? null, request.auth!.displayName],
      );
      if (!row) throw new AppError(404, "not_found", "Place not found.");
      if (body.data.collectionId) {
        const collection = await one<{ id: string }>("SELECT id FROM collections WHERE id = $1", [
          body.data.collectionId,
        ]);
        if (!collection) throw new AppError(404, "collection_not_found", "Collection not found.");
        await query(
          "INSERT INTO collection_items (collection_id, saved_place_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [body.data.collectionId, row.id],
        );
        await query("UPDATE collections SET updated_at = now() WHERE id = $1", [body.data.collectionId]);
      }
      await audit({
        actor: request.auth!.displayName,
        action: "saved_place.created",
        targetType: "saved_place",
        targetId: row.id,
        ipHash: hashIp(request.ip),
        metadata: { source: place.source, sourceId: place.sourceId },
      });
      const places = await fetchSavedPlaces(config.serpapi.reviewsEnabled);
      return reply.code(201).send(places.find((item) => item.id === row.id) ?? { id: row.id });
    },
  );

  app.patch(
    "/api/saved-places/:id",
    { preHandler: [authenticate, requireCsrf] },
    async (request) => {
      checkOrigin(request);
      const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
      const body = z.object({ note: z.string().max(2000).nullable() }).safeParse(request.body);
      if (!params.success || !body.success) throw new AppError(400, "invalid_request", "Invalid note update.");
      const row = await one<{ id: string }>(
        "UPDATE saved_places SET note = $2 WHERE id = $1 RETURNING id",
        [params.data.id, body.data.note],
      );
      if (!row) throw new AppError(404, "not_found", "Saved place not found.");
      return { id: row.id, note: body.data.note };
    },
  );

  app.delete(
    "/api/saved-places/:id",
    { preHandler: [authenticate, requireCsrf] },
    async (request, reply) => {
      checkOrigin(request);
      const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
      const queryParams = z
        .object({ destroySource: z.enum(["true", "false"]).optional() })
        .safeParse(request.query);
      if (!params.success) throw new AppError(400, "invalid_id", "Invalid saved place id.");

      // `destroySource` opts in to also deleting the underlying source record so
      // the place disappears from every results list. Without it the source
      // record and its run placement are preserved and only the saved snapshot
      // goes away, which keeps "nothing valid is deleted" true by default.
      const destroySource = queryParams.success && queryParams.data.destroySource === "true";
      const rows = await many<{ source_record_id: string | null }>(
        `DELETE FROM saved_places WHERE id = $1 RETURNING source_record_id`,
        [params.data.id],
      );
      const row = rows[0];
      if (!row) throw new AppError(404, "not_found", "Saved place not found.");

      let destroyed = 0;
      if (destroySource && row.source_record_id) {
        destroyed = await destroyOrphanedSourceRecords([row.source_record_id]);
      }

      await audit({
        actor: request.auth!.displayName,
        action: "saved_place.deleted",
        targetType: "saved_place",
        targetId: params.data.id,
        metadata: { destroySource, destroyedSourceRecords: destroyed },
      });
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/saved-places/bulk-delete",
    { preHandler: [authenticate, requireCsrf] },
    async (request) => {
      checkOrigin(request);
      const body = z
        .object({
          ids: z.array(z.string().uuid()).min(1).max(500),
          destroySource: z.boolean().optional(),
        })
        .safeParse(request.body);
      if (!body.success) throw new AppError(400, "invalid_request", "Choose places to delete.");
      const rows = await many<{ source_record_id: string | null }>(
        `DELETE FROM saved_places WHERE id = ANY($1::uuid[]) RETURNING source_record_id`,
        [body.data.ids],
      );
      const records = rows
        .map((row) => row.source_record_id)
        .filter((id): id is string => typeof id === "string");
      const destroyed = body.data.destroySource === true && records.length > 0
        ? await destroyOrphanedSourceRecords(records)
        : 0;
      await audit({
        actor: request.auth!.displayName,
        action: "saved_place.bulk_deleted",
        targetType: "saved_place",
        metadata: { count: rows.length, destroySource: body.data.destroySource === true, destroyedSourceRecords: destroyed },
      });
      return { deleted: rows.length, destroyed };
    },
  );

  // Collections
  app.get("/api/collections", { preHandler: authenticate }, async () => ({ collections: await fetchCollections() }));

  app.post(
    "/api/collections",
    { preHandler: [authenticate, requireCsrf] },
    async (request, reply) => {
      checkOrigin(request);
      const parsed = collectionSchema.safeParse(request.body);
      if (!parsed.success) throw new AppError(400, "invalid_collection", parsed.error.issues[0]?.message ?? "Invalid collection.");
      const count = await one<{ total: string }>("SELECT count(*)::text AS total FROM collections");
      if (Number(count?.total ?? 0) >= config.limits.maxCollections) {
        throw new AppError(409, "limit_reached", `Collection limit is ${config.limits.maxCollections}.`);
      }
      const row = await one<{ id: string }>(
        `INSERT INTO collections (name, description, created_by) VALUES ($1, $2, $3) RETURNING id`,
        [parsed.data.name, parsed.data.description ?? null, request.auth!.displayName],
      );
      if (!row) throw new Error("Could not create collection");
      await audit({
        actor: request.auth!.displayName,
        action: "collection.created",
        targetType: "collection",
        targetId: row.id,
        metadata: { name: parsed.data.name },
      });
      const collections = await fetchCollections();
      return reply.code(201).send(collections.find((collection) => collection.id === row.id));
    },
  );

  app.patch(
    "/api/collections/:id",
    { preHandler: [authenticate, requireCsrf] },
    async (request) => {
      checkOrigin(request);
      const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
      const body = z
        .object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().max(1000).nullable().optional() })
        .safeParse(request.body);
      if (!params.success || !body.success) throw new AppError(400, "invalid_collection", "Invalid collection update.");
      const row = await one<{ id: string }>(
        `UPDATE collections SET name = COALESCE($2, name), description = COALESCE($3, description), updated_at = now()
         WHERE id = $1 RETURNING id`,
        [params.data.id, body.data.name ?? null, body.data.description ?? null],
      );
      if (!row) throw new AppError(404, "not_found", "Collection not found.");
      return { id: row.id };
    },
  );

  app.delete(
    "/api/collections/:id",
    { preHandler: [authenticate, requireCsrf] },
    async (request, reply) => {
      checkOrigin(request);
      const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
      if (!params.success) throw new AppError(400, "invalid_id", "Invalid collection id.");
      const deleted = await query("DELETE FROM collections WHERE id = $1", [params.data.id]);
      if (deleted.rowCount === 0) throw new AppError(404, "not_found", "Collection not found.");
      await audit({
        actor: request.auth!.displayName,
        action: "collection.deleted",
        targetType: "collection",
        targetId: params.data.id,
      });
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/collections/:id/items",
    { preHandler: [authenticate, requireCsrf] },
    async (request) => {
      checkOrigin(request);
      const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
      const body = z.object({ savedPlaceIds: z.array(z.string().uuid()).min(1).max(500) }).safeParse(request.body);
      if (!params.success || !body.success) throw new AppError(400, "invalid_request", "Choose saved places to add.");
      const collection = await one<{ id: string }>("SELECT id FROM collections WHERE id = $1", [params.data.id]);
      if (!collection) throw new AppError(404, "not_found", "Collection not found.");
      let added = 0;
      for (const savedPlaceId of body.data.savedPlaceIds) {
        const result = await query(
          "INSERT INTO collection_items (collection_id, saved_place_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [params.data.id, savedPlaceId],
        );
        added += result.rowCount ?? 0;
      }
      await query("UPDATE collections SET updated_at = now() WHERE id = $1", [params.data.id]);
      await audit({
        actor: request.auth!.displayName,
        action: "collection.items_added",
        targetType: "collection",
        targetId: params.data.id,
        metadata: { added },
      });
      return { added };
    },
  );

  app.delete(
    "/api/collections/:id/items/:savedPlaceId",
    { preHandler: [authenticate, requireCsrf] },
    async (request) => {
      checkOrigin(request);
      const params = z
        .object({ id: z.string().uuid(), savedPlaceId: z.string().uuid() })
        .safeParse(request.params);
      if (!params.success) throw new AppError(400, "invalid_id", "Invalid collection item id.");
      const deleted = await query(
        "DELETE FROM collection_items WHERE collection_id = $1 AND saved_place_id = $2",
        [params.data.id, params.data.savedPlaceId],
      );
      if (deleted.rowCount === 0) throw new AppError(404, "not_found", "Collection item not found.");
      await query("UPDATE collections SET updated_at = now() WHERE id = $1", [params.data.id]);
      return { deleted: 1 };
    },
  );

  // Remove saved places from a collection without deleting the saved places.
  // Omit `savedPlaceIds` to empty the collection.
  app.post(
    "/api/collections/:id/items/remove",
    { preHandler: [authenticate, requireCsrf] },
    async (request) => {
      checkOrigin(request);
      const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
      const body = z
        .object({ savedPlaceIds: z.array(z.string().uuid()).min(1).max(2000).optional() })
        .safeParse(request.body ?? {});
      if (!params.success || !body.success) throw new AppError(400, "invalid_request", "Invalid collection removal request.");
      const collection = await one<{ id: string }>("SELECT id FROM collections WHERE id = $1", [params.data.id]);
      if (!collection) throw new AppError(404, "not_found", "Collection not found.");

      const removed = body.data.savedPlaceIds
        ? await query(
            "DELETE FROM collection_items WHERE collection_id = $1 AND saved_place_id = ANY($2::uuid[])",
            [params.data.id, body.data.savedPlaceIds],
          )
        : await query("DELETE FROM collection_items WHERE collection_id = $1", [params.data.id]);

      await query("UPDATE collections SET updated_at = now() WHERE id = $1", [params.data.id]);
      await audit({
        actor: request.auth!.displayName,
        action: "collection.items_removed",
        targetType: "collection",
        targetId: params.data.id,
        metadata: { removed: removed.rowCount ?? 0, scope: body.data.savedPlaceIds ? "selected" : "all" },
      });
      return { deleted: removed.rowCount ?? 0 };
    },
  );

  // Duplicate review
  app.get("/api/duplicates", { preHandler: authenticate }, async (request) => {
    const queryParams = z
      .object({ state: z.enum(["candidate", "approved", "rejected"]).optional() })
      .safeParse(request.query);
    return { duplicates: await fetchDuplicates(queryParams.success ? queryParams.data.state : undefined) };
  });

  app.post(
    "/api/duplicates/:id/decision",
    { preHandler: [authenticate, requireCsrf] },
    async (request) => {
      checkOrigin(request);
      const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
      const body = z.object({ decision: z.enum(["approved", "rejected", "candidate"]) }).safeParse(request.body);
      if (!params.success || !body.success) throw new AppError(400, "invalid_decision", "Invalid duplicate decision.");
      const row = await one<{ id: string }>(
        `UPDATE place_matches SET state = $2, reviewed_by = $3, reviewed_at = now(), updated_at = now()
         WHERE id = $1 RETURNING id`,
        [params.data.id, body.data.decision, request.auth!.displayName],
      );
      if (!row) throw new AppError(404, "not_found", "Match candidate not found.");
      await audit({
        actor: request.auth!.displayName,
        action: "match.decision",
        targetType: "place_match",
        targetId: params.data.id,
        metadata: { decision: body.data.decision },
      });
      return { id: row.id, state: body.data.decision };
    },
  );
}

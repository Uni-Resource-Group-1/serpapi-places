import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, checkOrigin, requireCsrf } from "../auth.js";
import { config } from "../config.js";
import { one, many } from "../db.js";
import { AppError } from "../errors.js";
import { validateCriteria } from "../validation.js";
import { createSearchRun } from "../services/search-runs.js";
import { buildDiscoveryEstimate, tileCriteria, tilesForCriteria } from "../services/discovery.js";
import { parsePlaceInput } from "../services/place-imports.js";
import { fetchPlace, fetchRunPlaces, fetchSearchRun } from "../services/dto.js";
import { fetchReviews, loadReviews, refreshPlaceDetails } from "../services/details.js";
import { hashIp } from "../auth-crypto.js";
import { audit } from "../services/audit.js";

const createRunSchema = z.object({
  criteria: z.unknown(),
  savedSearchId: z.string().uuid().nullable().optional(),
  idempotencyKey: z.string().trim().min(8).max(120).nullable().optional(),
}).strict();

const reviewsSchema = z.object({
  page: z.number().int().min(1).max(20).default(1),
  nextPageToken: z.string().max(4000).nullable().optional(),
});

const placeImportSchema = z.object({
  input: z.string().trim().min(1).max(20_000),
});

function criteriaOrThrow(input: unknown) {
  try {
    return validateCriteria(input, config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new AppError(400, "invalid_search", error.issues[0]?.message ?? "Invalid search criteria.", {
        issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      });
    }
    throw error;
  }
}

export async function registerSearchRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/search-runs",
    {
      preHandler: [authenticate, requireCsrf],
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      checkOrigin(request);
      const parsed = createRunSchema.safeParse(request.body);
      if (!parsed.success) throw new AppError(400, "invalid_request", "Invalid search request.");
      let criteria;
      try {
        criteria = validateCriteria(parsed.data.criteria, config);
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new AppError(400, "invalid_search", error.issues[0]?.message ?? "Invalid search criteria.", {
            issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
          });
        }
        throw error;
      }
      const created = await createSearchRun(
        {
          criteria,
          savedSearchId: parsed.data.savedSearchId ?? null,
          actor: request.auth!.displayName,
          ipHash: hashIp(request.ip),
          idempotencyKey: parsed.data.idempotencyKey ?? null,
        },
        config,
      );
      return reply.code(202).send(created);
    },
  );

  app.post(
    "/api/search-runs/estimate",
    {
      preHandler: [authenticate, requireCsrf],
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request) => {
      checkOrigin(request);
      const parsed = createRunSchema.safeParse(request.body);
      if (!parsed.success) throw new AppError(400, "invalid_request", "Invalid estimate request.");
      const criteria = criteriaOrThrow(parsed.data.criteria);
      return buildDiscoveryEstimate(criteria, config);
    },
  );

  app.post(
    "/api/search-runs/queue-tiles",
    {
      preHandler: [authenticate, requireCsrf],
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      checkOrigin(request);
      const parsed = createRunSchema.safeParse(request.body);
      if (!parsed.success) throw new AppError(400, "invalid_request", "Invalid tiled run request.");
      const criteria = criteriaOrThrow(parsed.data.criteria);
      if (criteria.plan !== "tiled") {
        throw new AppError(400, "not_tiled", "Queue-tiles requires tiled criteria with a tile grid.");
      }
      if (!config.serpapi.apiKey) {
        throw new AppError(409, "not_configured", "SerpApi is not configured on this server, so tiled runs cannot start.");
      }
      const estimate = await buildDiscoveryEstimate(criteria, config);
      if (!estimate.withinBudget) {
        throw new AppError(
          409,
          "budget_limit",
          `This tiled plan needs ${estimate.serpapiRequests} SerpApi requests but only ${Math.min(estimate.remainingDay, estimate.remainingMonth)} remain in the current budget.`,
          { estimate },
        );
      }

      const tiles = estimate.tiles.length > 0 ? estimate.tiles : tilesForCriteria(criteria, config);
      const baseKey = parsed.data.idempotencyKey ?? null;
      const runs = [];
      for (const tile of tiles) {
        const created = await createSearchRun(
          {
            criteria: tileCriteria(criteria, tile),
            savedSearchId: parsed.data.savedSearchId ?? null,
            actor: request.auth!.displayName,
            ipHash: hashIp(request.ip),
            idempotencyKey: baseKey ? `${baseKey}:tile:${tile.index}` : null,
          },
          config,
        );
        runs.push({ ...created, tile });
      }
      await audit({
        actor: request.auth!.displayName,
        action: "search_run.tiles_queued",
        targetType: "search_run",
        targetId: runs[0]?.runId ?? "none",
        ipHash: hashIp(request.ip),
        metadata: {
          parentTileCount: tiles.length,
          serpapiRequests: estimate.serpapiRequests,
          keyword: criteria.keyword,
          category: criteria.category,
        },
      });
      return reply.code(202).send({ runs, estimate });
    },
  );

  app.post(
    "/api/place-imports",
    {
      preHandler: [authenticate, requireCsrf],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request) => {
      checkOrigin(request);
      const parsed = placeImportSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(400, "invalid_import", "Paste at least one Google Maps place link or identifier.");
      }
      const result = await parsePlaceInput(parsed.data.input, config.limits.maxImportPlaces);
      await audit({
        actor: request.auth!.displayName,
        action: "place_import.parsed",
        targetType: "place_import",
        targetId: "parse",
        ipHash: hashIp(request.ip),
        metadata: {
          accepted: result.refs.length,
          rejected: result.rejected.length,
          truncated: result.refs.length >= config.limits.maxImportPlaces,
        },
      });
      return result;
    },
  );

  app.get("/api/search-runs", { preHandler: authenticate }, async (request) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(50).default(12) }).safeParse(request.query);
    const limit = query.success ? query.data.limit : 12;
    const rows = await many<{ id: string }>(
      "SELECT id FROM search_runs ORDER BY created_at DESC LIMIT $1",
      [limit],
    );
    const runs = await Promise.all(rows.map((row) => fetchSearchRun(row.id)));
    return { runs: runs.filter((run) => run !== null) };
  });

  app.get("/api/search-runs/:id", { preHandler: authenticate }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) throw new AppError(400, "invalid_id", "Invalid search run id.");
    const run = await fetchSearchRun(params.data.id);
    if (!run) throw new AppError(404, "not_found", "Search run not found.");
    return run;
  });

  app.get("/api/search-runs/:id/places", { preHandler: authenticate }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) throw new AppError(400, "invalid_id", "Invalid search run id.");
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(1000).default(500),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .safeParse(request.query);
    const limit = query.success ? query.data.limit : 500;
    const offset = query.success ? query.data.offset : 0;
    const run = await one<{ result_count: number }>("SELECT result_count FROM search_runs WHERE id = $1", [
      params.data.id,
    ]);
    if (!run) throw new AppError(404, "not_found", "Search run not found.");
    const all = await fetchRunPlaces(params.data.id, config.serpapi.reviewsEnabled);
    return {
      places: all.slice(offset, offset + limit),
      total: all.length,
      limit,
      offset,
    };
  });

  app.get("/api/places/:id", { preHandler: authenticate }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) throw new AppError(400, "invalid_id", "Invalid place id.");
    const place = await fetchPlace(params.data.id, config.serpapi.reviewsEnabled);
    if (!place) throw new AppError(404, "not_found", "Place not found.");
    return place;
  });

  app.post(
    "/api/places/:id/details",
    {
      preHandler: [authenticate, requireCsrf],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request) => {
      checkOrigin(request);
      const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
      if (!params.success) throw new AppError(400, "invalid_id", "Invalid place id.");
      const result = await refreshPlaceDetails(params.data.id, request.auth!.displayName, config);
      const place = await fetchPlace(params.data.id, config.serpapi.reviewsEnabled);
      return { ...result, place };
    },
  );

  app.get("/api/places/:id/reviews", { preHandler: authenticate }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) throw new AppError(400, "invalid_id", "Invalid place id.");
    const record = await one<{ source: string }>("SELECT source FROM source_place_records WHERE id = $1 AND (expires_at IS NULL OR expires_at > now())", [
      params.data.id,
    ]);
    if (!record) throw new AppError(404, "not_found", "Place not found.");
    if (record.source !== "serpapi") {
      return {
        reviews: [],
        fetchedAt: null,
        page: 1,
        hasNext: false,
        nextPageToken: null,
        reviewsEnabled: false,
      };
    }
    if (!config.serpapi.reviewsEnabled) {
      return {
        reviews: [],
        fetchedAt: null,
        page: 1,
        hasNext: false,
        nextPageToken: null,
        reviewsEnabled: false,
      };
    }
    return loadReviews(params.data.id);
  });

  app.post(
    "/api/places/:id/reviews",
    {
      preHandler: [authenticate, requireCsrf],
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      checkOrigin(request);
      const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
      if (!params.success) throw new AppError(400, "invalid_id", "Invalid place id.");
      const parsed = reviewsSchema.safeParse(request.body ?? {});
      if (!parsed.success) throw new AppError(400, "invalid_request", "Invalid review page request.");
      const result = await fetchReviews(
        params.data.id,
        parsed.data.page,
        parsed.data.nextPageToken ?? null,
        request.auth!.displayName,
        config,
      );
      await audit({
        actor: request.auth!.displayName,
        action: "place.reviews_requested",
        targetType: "source_place",
        targetId: params.data.id,
        ipHash: hashIp(request.ip),
        metadata: { page: parsed.data.page },
      });
      return reply.code(200).send(result);
    },
  );
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, checkOrigin, requireCsrf } from "../auth.js";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { audit } from "../services/audit.js";
import { hashIp } from "../auth-crypto.js";
import { getSettings, getUsage, updateSettings } from "../services/usage.js";

const settingsSchema = z.object({
  serpapiMonthlyLimit: z.number().int().min(0).max(10_000),
  serpapiDailyLimit: z.number().int().min(0).max(10_000),
  serpapiMaxPages: z.number().int().min(1).max(20),
  serpapiMaxResults: z.number().int().min(20).max(2000),
  serpapiPriceUsd: z.number().min(0).max(100),
});

export async function registerSystemRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/status", { preHandler: authenticate }, async () => {
    const usage = await getUsage(config);
    return {
      appName: "Places Discovery",
      version: config.version,
      env: config.env,
      sources: {
        osm: {
          configured: true,
          label: "OpenStreetMap / Overpass",
          attribution: "© OpenStreetMap contributors · ODbL",
        },
        serpapi: {
          configured: Boolean(config.serpapi.apiKey),
          reviewsEnabled: config.serpapi.reviewsEnabled,
          exportEnabled: config.serpapi.exportEnabled,
          label: "SerpApi Google Maps",
          attribution: "SerpApi Google Maps results · not a complete inventory",
        },
      },
      tiles: config.tiles,
      usage,
      hardLimits: {
        monthly: config.limits.monthlyHardLimit,
        daily: config.limits.dailyHardLimit,
        maxPages: config.limits.maxPagesHard,
        maxResults: config.limits.maxResultsPerSource,
        maxRadiusMeters: config.limits.maxRadiusMeters,
        maxAreaKm2: config.limits.maxAreaKm2,
        maxTiledAreaKm2: config.limits.maxTiledAreaKm2,
        maxTilesPerRun: config.limits.maxTilesPerRun,
        maxPagesPerTile: config.limits.maxPagesPerTile,
        maxImportPlaces: config.limits.maxImportPlaces,
      },
    };
  });

  app.get("/api/usage", { preHandler: authenticate }, async () => getUsage(config));

  app.get("/api/settings", { preHandler: authenticate }, async () => {
    const [settings, usage] = await Promise.all([getSettings(config), getUsage(config)]);
    return {
      settings,
      usage,
      hardLimits: {
        monthly: config.limits.monthlyHardLimit,
        daily: config.limits.dailyHardLimit,
        maxPages: config.limits.maxPagesHard,
        maxResults: config.limits.maxResultsPerSource,
        maxRadiusMeters: config.limits.maxRadiusMeters,
        maxAreaKm2: config.limits.maxAreaKm2,
        exportRows: config.limits.maxExportRows,
        maxTiledAreaKm2: config.limits.maxTiledAreaKm2,
        maxTilesPerRun: config.limits.maxTilesPerRun,
        maxPagesPerTile: config.limits.maxPagesPerTile,
        maxImportPlaces: config.limits.maxImportPlaces,
      },
      policy: {
        reviewsEnabled: config.serpapi.reviewsEnabled,
        serpapiExportEnabled: config.serpapi.exportEnabled,
        serpapiStorageDays: config.serpapi.storageDays,
        reviewRetentionDays: config.serpapi.reviewRetentionDays,
        cacheTtlSeconds: config.serpapi.cacheTtlSeconds,
      },
    };
  });

  app.put(
    "/api/settings",
    { preHandler: [authenticate, requireCsrf], config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => {
      checkOrigin(request);
      const parsed = settingsSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(400, "invalid_settings", parsed.error.issues[0]?.message ?? "Invalid settings.");
      }
      try {
        const settings = await updateSettings(parsed.data, request.auth!.displayName, config);
        const usage = await getUsage(config);
        await audit({
          actor: request.auth!.displayName,
          action: "settings.updated",
          targetType: "settings",
          targetId: "1",
          ipHash: hashIp(request.ip),
          metadata: parsed.data,
        });
        return { settings, usage };
      } catch (error) {
        throw new AppError(400, "invalid_settings", error instanceof Error ? error.message : "Invalid settings.");
      }
    },
  );
}

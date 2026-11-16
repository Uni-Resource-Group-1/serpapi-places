import "dotenv/config";

export interface AppConfig {
  env: "development" | "test" | "production";
  port: number;
  host: string;
  appOrigin: string;
  databaseUrl: string;
  accessKey: string;
  /** Secret used to encrypt operator-managed credentials at rest. */
  secretsKey: string;
  cookieSecure: boolean;
  sessionDays: number;
  maxActiveSessions: number;
  dataDir: string;
  exportsDir: string;
  logLevel: string;
  trustProxy: boolean;
  ipHashSalt: string;
  limits: {
    maxRadiusMeters: number;
    maxAreaKm2: number;
    maxResultsPerSource: number;
    maxPagesHard: number;
    monthlyHardLimit: number;
    dailyHardLimit: number;
    maxSavedSearches: number;
    maxCollections: number;
    maxExportRows: number;
    exportRetentionHours: number;
    maxTiledAreaKm2: number;
    maxTilesPerRun: number;
    maxPagesPerTile: number;
    maxImportPlaces: number;
  };
  osm: {
    overpassUrl: string;
    userAgent: string;
    timeoutMs: number;
    maxResults: number;
    contact: string;
  };
  serpapi: {
    apiKey: string | null;
    baseUrl: string;
    timeoutMs: number;
    pricePerSearchUsd: number;
    defaultMonthlyLimit: number;
    defaultDailyLimit: number;
    defaultMaxPages: number;
    defaultMaxResults: number;
    cacheTtlSeconds: number;
    reviewsEnabled: boolean;
    exportEnabled: boolean;
    storageDays: number;
    reviewRetentionDays: number;
    hl: string;
  };
  tiles: {
    url: string;
    attribution: string;
    maxZoom: number;
  };
  version: string;
}

function int(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function float(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV === "production" ? "production" : env.NODE_ENV === "test" ? "test" : "development";
  const envValue = nodeEnv === "production" ? "production" : nodeEnv === "test" ? "test" : "development";
  const accessKey = env.APP_ACCESS_KEY?.trim() || "";
  if (!accessKey) {
    throw new Error("APP_ACCESS_KEY is required. Set a long random access key in the server environment.");
  }
  if (envValue === "production" && accessKey.length < 24) {
    throw new Error("APP_ACCESS_KEY must be at least 24 characters in production.");
  }
  if (["change-me", "changeme", "password", "dev-access-key"].includes(accessKey) && envValue === "production") {
    throw new Error("APP_ACCESS_KEY is a placeholder. Generate a random key before deploying.");
  }

  const port = int(env.PORT, 3001, "PORT");
  const dataDir = env.DATA_DIR?.trim() || "./data";
  const databaseUrl =
    env.DATABASE_URL?.trim() ||
    "postgres://places:places@localhost:5432/places_discovery";

  return {
    env: envValue,
    port,
    host: env.HOST?.trim() || "0.0.0.0",
    appOrigin: env.APP_ORIGIN?.trim() || "http://localhost:5173",
    databaseUrl,
    accessKey,
    secretsKey: env.SETTINGS_ENCRYPTION_KEY?.trim() || accessKey,
    cookieSecure: bool(env.COOKIE_SECURE, envValue === "production"),
    sessionDays: int(env.SESSION_DAYS, 30, "SESSION_DAYS"),
    maxActiveSessions: int(env.MAX_ACTIVE_SESSIONS, 5, "MAX_ACTIVE_SESSIONS"),
    dataDir,
    exportsDir: env.EXPORTS_DIR?.trim() || `${dataDir}/exports`,
    logLevel: env.LOG_LEVEL?.trim() || (envValue === "test" ? "silent" : "info"),
    trustProxy: bool(env.TRUST_PROXY, true),
    ipHashSalt: env.IP_HASH_SALT?.trim() || "dev-ip-salt-change-in-production",
    limits: {
      maxRadiusMeters: int(env.MAX_RADIUS_METERS, 20000, "MAX_RADIUS_METERS"),
      maxAreaKm2: float(env.MAX_AREA_KM2, 400, "MAX_AREA_KM2"),
      maxResultsPerSource: int(env.MAX_RESULTS_PER_SOURCE, 500, "MAX_RESULTS_PER_SOURCE"),
      maxPagesHard: int(env.SERPAPI_MAX_PAGES_HARD, 10, "SERPAPI_MAX_PAGES_HARD"),
      monthlyHardLimit: int(env.SERPAPI_MONTHLY_HARD_LIMIT, 1000, "SERPAPI_MONTHLY_HARD_LIMIT"),
      dailyHardLimit: int(env.SERPAPI_DAILY_HARD_LIMIT, 100, "SERPAPI_DAILY_HARD_LIMIT"),
      maxSavedSearches: int(env.MAX_SAVED_SEARCHES, 100, "MAX_SAVED_SEARCHES"),
      maxCollections: int(env.MAX_COLLECTIONS, 50, "MAX_COLLECTIONS"),
      maxExportRows: int(env.MAX_EXPORT_ROWS, 50000, "MAX_EXPORT_ROWS"),
      exportRetentionHours: int(env.EXPORT_RETENTION_HOURS, 24, "EXPORT_RETENTION_HOURS"),
      maxTiledAreaKm2: float(env.MAX_TILED_AREA_KM2, 10000, "MAX_TILED_AREA_KM2"),
      maxTilesPerRun: int(env.MAX_TILES_PER_RUN, 25, "MAX_TILES_PER_RUN"),
      maxPagesPerTile: int(env.MAX_PAGES_PER_TILE, 3, "MAX_PAGES_PER_TILE"),
      maxImportPlaces: int(env.MAX_IMPORT_PLACES, 25, "MAX_IMPORT_PLACES"),
    },
    osm: {
      overpassUrl: env.OVERPASS_URL?.trim() || "https://overpass-api.de/api/interpreter",
      userAgent:
        env.OSM_USER_AGENT?.trim() ||
        "PlacesDiscovery/1.0 (self-hosted place research; contact: admin@dhakafareast.tech)",
      timeoutMs: int(env.OVERPASS_TIMEOUT_MS, 30000, "OVERPASS_TIMEOUT_MS"),
      maxResults: int(env.OSM_MAX_RESULTS, 1200, "OSM_MAX_RESULTS"),
      contact: env.OSM_CONTACT?.trim() || "admin@dhakafareast.tech",
    },
    serpapi: {
      apiKey: env.SERPAPI_API_KEY?.trim() || null,
      baseUrl: env.SERPAPI_BASE_URL?.trim() || "https://serpapi.com/search.json",
      timeoutMs: int(env.SERPAPI_TIMEOUT_MS, 25000, "SERPAPI_TIMEOUT_MS"),
      pricePerSearchUsd: float(env.SERPAPI_PRICE_PER_SEARCH_USD, 0.015, "SERPAPI_PRICE_PER_SEARCH_USD"),
      defaultMonthlyLimit: int(env.SERPAPI_MONTHLY_LIMIT, 250, "SERPAPI_MONTHLY_LIMIT"),
      defaultDailyLimit: int(env.SERPAPI_DAILY_LIMIT, 50, "SERPAPI_DAILY_LIMIT"),
      defaultMaxPages: int(env.SERPAPI_MAX_PAGES, 6, "SERPAPI_MAX_PAGES"),
      defaultMaxResults: int(env.SERPAPI_MAX_RESULTS, 120, "SERPAPI_MAX_RESULTS"),
      cacheTtlSeconds: int(env.SERPAPI_CACHE_TTL_SECONDS, 0, "SERPAPI_CACHE_TTL_SECONDS"),
      reviewsEnabled: bool(env.SERPAPI_REVIEWS_ENABLED, true),
      exportEnabled: bool(env.SERPAPI_EXPORT_ENABLED, true),
      storageDays: int(env.SERPAPI_STORAGE_DAYS, 0, "SERPAPI_STORAGE_DAYS"),
      reviewRetentionDays: int(env.SERPAPI_REVIEW_RETENTION_DAYS, 0, "SERPAPI_REVIEW_RETENTION_DAYS"),
      hl: env.SERPAPI_HL?.trim() || "en",
    },
    tiles: {
      url: env.TILE_URL?.trim() || "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      attribution:
        env.TILE_ATTRIBUTION?.trim() ||
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: int(env.TILE_MAX_ZOOM, 19, "TILE_MAX_ZOOM"),
    },
    version: env.APP_VERSION?.trim() || "1.0.0",
  };
}

export const config = loadConfig();

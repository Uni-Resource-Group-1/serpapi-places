import type { AppConfig } from "../config.js";
import { many, one, query, transaction } from "../db.js";

export interface SettingsRow {
  serpapi_monthly_limit: number;
  serpapi_daily_limit: number;
  serpapi_max_pages: number;
  serpapi_max_results: number;
  serpapi_price_usd: string;
  updated_at: Date;
  updated_by: string | null;
}

export interface Settings {
  serpapiMonthlyLimit: number;
  serpapiDailyLimit: number;
  serpapiMaxPages: number;
  serpapiMaxResults: number;
  serpapiPriceUsd: number;
  updatedAt: string;
  updatedBy: string | null;
}

export function settingsDto(row: SettingsRow): Settings {
  return {
    serpapiMonthlyLimit: row.serpapi_monthly_limit,
    serpapiDailyLimit: row.serpapi_daily_limit,
    serpapiMaxPages: row.serpapi_max_pages,
    serpapiMaxResults: row.serpapi_max_results,
    serpapiPriceUsd: Number(row.serpapi_price_usd),
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
  };
}

export async function ensureSettingsRow(appConfig: AppConfig): Promise<void> {
  await query(
    `INSERT INTO app_settings
       (id, serpapi_monthly_limit, serpapi_daily_limit, serpapi_max_pages, serpapi_max_results, serpapi_price_usd)
     VALUES (1, $1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [
      Math.min(appConfig.serpapi.defaultMonthlyLimit, appConfig.limits.monthlyHardLimit),
      Math.min(appConfig.serpapi.defaultDailyLimit, appConfig.limits.dailyHardLimit),
      Math.min(appConfig.serpapi.defaultMaxPages, appConfig.limits.maxPagesHard),
      Math.min(appConfig.serpapi.defaultMaxResults, appConfig.limits.maxResultsPerSource),
      appConfig.serpapi.pricePerSearchUsd,
    ],
  );
}

export async function getSettings(appConfig: AppConfig): Promise<Settings> {
  await ensureSettingsRow(appConfig);
  const row = await one<SettingsRow>("SELECT * FROM app_settings WHERE id = 1");
  if (!row) throw new Error("Settings row could not be created");
  const settings = settingsDto(row);
  return {
    ...settings,
    serpapiMonthlyLimit: Math.min(settings.serpapiMonthlyLimit, appConfig.limits.monthlyHardLimit),
    serpapiDailyLimit: Math.min(settings.serpapiDailyLimit, appConfig.limits.dailyHardLimit),
    serpapiMaxPages: Math.min(settings.serpapiMaxPages, appConfig.limits.maxPagesHard),
    serpapiMaxResults: Math.min(settings.serpapiMaxResults, appConfig.limits.maxResultsPerSource),
  };
}

export async function updateSettings(
  input: {
    serpapiMonthlyLimit: number;
    serpapiDailyLimit: number;
    serpapiMaxPages: number;
    serpapiMaxResults: number;
    serpapiPriceUsd: number;
  },
  actor: string,
  appConfig: AppConfig,
): Promise<Settings> {
  if (input.serpapiMonthlyLimit > appConfig.limits.monthlyHardLimit) {
    throw new Error(`Monthly limit exceeds the server hard cap of ${appConfig.limits.monthlyHardLimit}`);
  }
  if (input.serpapiDailyLimit > appConfig.limits.dailyHardLimit) {
    throw new Error(`Daily limit exceeds the server hard cap of ${appConfig.limits.dailyHardLimit}`);
  }
  if (input.serpapiMaxPages > appConfig.limits.maxPagesHard) {
    throw new Error(`Page limit exceeds the server hard cap of ${appConfig.limits.maxPagesHard}`);
  }
  if (input.serpapiMaxResults > appConfig.limits.maxResultsPerSource) {
    throw new Error(`Result limit exceeds the server hard cap of ${appConfig.limits.maxResultsPerSource}`);
  }
  const row = await one<SettingsRow>(
    `UPDATE app_settings SET
       serpapi_monthly_limit = $1,
       serpapi_daily_limit = $2,
       serpapi_max_pages = $3,
       serpapi_max_results = $4,
       serpapi_price_usd = $5,
       updated_at = now(),
       updated_by = $6
     WHERE id = 1
     RETURNING *`,
    [
      input.serpapiMonthlyLimit,
      input.serpapiDailyLimit,
      input.serpapiMaxPages,
      input.serpapiMaxResults,
      input.serpapiPriceUsd,
      actor,
    ],
  );
  if (!row) throw new Error("Settings row is missing");
  return settingsDto(row);
}

export function periods(now = new Date()): { month: string; day: string } {
  return {
    month: now.toISOString().slice(0, 7),
    day: now.toISOString().slice(0, 10),
  };
}

export interface Usage {
  month: { used: number; limit: number; period: string; remaining: number };
  day: { used: number; limit: number; period: string; remaining: number };
  estimatedCostUsd: number;
  pricePerSearchUsd: number;
}

export async function getUsage(appConfig: AppConfig, now = new Date()): Promise<Usage> {
  const settings = await getSettings(appConfig);
  const { month, day } = periods(now);
  const rows = await many<{ scope: string; period: string; used: number }>(
    `SELECT scope, period, used FROM usage_counters
     WHERE (scope = 'serpapi_month' AND period = $1)
        OR (scope = 'serpapi_day' AND period = $2)`, 
    [month, day],
  );
  const monthUsed = rows.find((row) => row.scope === "serpapi_month")?.used ?? 0;
  const dayUsed = rows.find((row) => row.scope === "serpapi_day")?.used ?? 0;
  return {
    month: {
      used: monthUsed,
      limit: settings.serpapiMonthlyLimit,
      period: month,
      remaining: Math.max(0, settings.serpapiMonthlyLimit - monthUsed),
    },
    day: {
      used: dayUsed,
      limit: settings.serpapiDailyLimit,
      period: day,
      remaining: Math.max(0, settings.serpapiDailyLimit - dayUsed),
    },
    estimatedCostUsd: Number((monthUsed * settings.serpapiPriceUsd).toFixed(4)),
    pricePerSearchUsd: settings.serpapiPriceUsd,
  };
}

export interface ReservationResult {
  allowed: boolean;
  reason?: "monthly" | "daily";
  monthUsed: number;
  dayUsed: number;
  monthLimit: number;
  dayLimit: number;
}

/**
 * Atomically reserves SerpApi request credits before a billable call.
 * A reservation is deliberately not refunded if the upstream call fails after
 * dispatch, because the provider may still have counted it. This is the safe
 * direction for cost control.
 */
export async function reserveSerpApiCalls(
  count: number,
  appConfig: AppConfig,
  now = new Date(),
): Promise<ReservationResult> {
  const settings = await getSettings(appConfig);
  const { month, day } = periods(now);
  return transaction(async (client) => {
    await client.query(
      `INSERT INTO usage_counters (scope, period, used) VALUES
        ('serpapi_month', $1, 0), ('serpapi_day', $2, 0)
       ON CONFLICT (scope, period) DO NOTHING`,
      [month, day],
    );
    const counters = await client.query<{ scope: string; used: number }>(
      `SELECT scope, used FROM usage_counters
       WHERE (scope = 'serpapi_month' AND period = $1)
          OR (scope = 'serpapi_day' AND period = $2)
       FOR UPDATE`,
      [month, day],
    );
    const monthUsed = counters.rows.find((row) => row.scope === "serpapi_month")?.used ?? 0;
    const dayUsed = counters.rows.find((row) => row.scope === "serpapi_day")?.used ?? 0;
    if (monthUsed + count > settings.serpapiMonthlyLimit) {
      return {
        allowed: false,
        reason: "monthly",
        monthUsed,
        dayUsed,
        monthLimit: settings.serpapiMonthlyLimit,
        dayLimit: settings.serpapiDailyLimit,
      };
    }
    if (dayUsed + count > settings.serpapiDailyLimit) {
      return {
        allowed: false,
        reason: "daily",
        monthUsed,
        dayUsed,
        monthLimit: settings.serpapiMonthlyLimit,
        dayLimit: settings.serpapiDailyLimit,
      };
    }
    await client.query(
      `UPDATE usage_counters SET used = used + $3, updated_at = now()
       WHERE (scope = 'serpapi_month' AND period = $1)
          OR (scope = 'serpapi_day' AND period = $2)`,
      [month, day, count],
    );
    return {
      allowed: true,
      monthUsed: monthUsed + count,
      dayUsed: dayUsed + count,
      monthLimit: settings.serpapiMonthlyLimit,
      dayLimit: settings.serpapiDailyLimit,
    };
  });
}

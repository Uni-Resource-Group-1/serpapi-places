import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { SerpApiCredentialState } from "../../shared/types.js";
import { one, query } from "../db.js";
import { AppError, errorMessage } from "../errors.js";
import { logger } from "../logger.js";
import { requestJson } from "../sources/http.js";
import { ensureSettingsRow } from "./usage.js";

interface CredentialRow {
  serpapi_api_key_cipher: string | null;
  serpapi_api_key_last4: string | null;
  serpapi_api_key_status: string | null;
  serpapi_api_key_updated_at: Date | null;
  serpapi_api_key_updated_by: string | null;
  serpapi_api_key_checked_at: Date | null;
  serpapi_account_plan: string | null;
  serpapi_account_searches_left: number | null;
}

export interface SerpApiVerification {
  ok: boolean;
  plan: string | null;
  searchesLeft: number | null;
  message: string;
}

const CREDENTIAL_COLUMNS = `
  serpapi_api_key_cipher, serpapi_api_key_last4, serpapi_api_key_status,
  serpapi_api_key_updated_at, serpapi_api_key_updated_by, serpapi_api_key_checked_at,
  serpapi_account_plan, serpapi_account_searches_left
`;

// A fixed, non-secret salt keeps the derived key stable across restarts.
const KEY_SALT = "places-discovery:serpapi-credential:v1";
const CIPHER_VERSION = "v1";
// scrypt is deliberately slow, and provider calls resolve the key once per
// page. Cache the derived key per secret so a run does not pay that cost on
// every request. Rotating the secret produces a new cache entry.
const derivedKeyCache = new Map<string, Buffer>();

function derivedKey(appConfig: AppConfig): Buffer {
  const cached = derivedKeyCache.get(appConfig.secretsKey);
  if (cached) return cached;
  const key = scryptSync(appConfig.secretsKey, KEY_SALT, 32);
  derivedKeyCache.set(appConfig.secretsKey, key);
  return key;
}

export function encryptSecret(value: string, appConfig: AppConfig): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derivedKey(appConfig), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    CIPHER_VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

export function decryptSecret(payload: string, appConfig: AppConfig): string | null {
  const [version, ivText, tagText, dataText] = payload.split(".");
  if (version !== CIPHER_VERSION || !ivText || !tagText || !dataText) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", derivedKey(appConfig), Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(dataText, "base64url")), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
}

function last4(value: string): string {
  return value.slice(-4);
}

async function credentialRow(): Promise<CredentialRow | null> {
  return one<CredentialRow>(`SELECT ${CREDENTIAL_COLUMNS} FROM app_settings WHERE id = 1`);
}

/**
 * Return the key used for provider dispatch: an operator-managed key in the
 * database wins, otherwise the server environment value is used.
 *
 * There is deliberately no in-process cache: provider calls are infrequent and
 * a stale key must never survive an operator update in another container.
 */
export async function resolveSerpApiKey(appConfig: AppConfig): Promise<string | null> {
  let row: CredentialRow | null = null;
  try {
    row = await credentialRow();
  } catch (error) {
    logger.warn({ err: errorMessage(error) }, "Could not read stored SerpApi credentials; falling back to environment");
  }
  if (row?.serpapi_api_key_cipher) {
    const decrypted = decryptSecret(row.serpapi_api_key_cipher, appConfig);
    if (decrypted) return decrypted;
    logger.warn("Stored SerpApi key could not be decrypted with the active encryption secret; falling back to environment");
  }
  return appConfig.serpapi.apiKey;
}

export async function getSerpApiCredentialState(appConfig: AppConfig): Promise<SerpApiCredentialState> {
  const row = await credentialRow();
  const stored = Boolean(row?.serpapi_api_key_cipher);
  const decrypted = stored ? decryptSecret(row!.serpapi_api_key_cipher!, appConfig) : null;
  const configured = Boolean(decrypted ?? appConfig.serpapi.apiKey);
  const source = stored ? "settings" : appConfig.serpapi.apiKey ? "environment" : "none";
  const status: SerpApiCredentialState["status"] =
    stored && !decrypted
      ? "unreadable"
      : !configured
        ? "not_configured"
        : (row?.serpapi_api_key_status as SerpApiCredentialState["status"] | null) ?? "unverified";
  return {
    configured,
    source,
    last4: stored
      ? row?.serpapi_api_key_last4 ?? null
      : appConfig.serpapi.apiKey
        ? last4(appConfig.serpapi.apiKey)
        : null,
    status,
    plan: row?.serpapi_account_plan ?? null,
    searchesLeft: row?.serpapi_account_searches_left ?? null,
    updatedAt: row?.serpapi_api_key_updated_at?.toISOString() ?? null,
    updatedBy: row?.serpapi_api_key_updated_by ?? null,
    checkedAt: row?.serpapi_api_key_checked_at?.toISOString() ?? null,
  };
}

function accountUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = "/account";
  url.search = "";
  return url.toString();
}

/**
 * Confirm a key against SerpApi's account endpoint before saving it. This is a
 * free metadata call, not a billable search.
 */
export async function verifySerpApiKey(key: string, appConfig: AppConfig): Promise<SerpApiVerification> {
  const url = new URL(accountUrl(appConfig.serpapi.baseUrl));
  url.searchParams.set("api_key", key);
  try {
    const response = await requestJson(url.toString(), {
      headers: { Accept: "application/json", "User-Agent": "PlacesDiscovery/1.0" },
      timeoutMs: Math.min(appConfig.serpapi.timeoutMs, 15_000),
      retries: 0,
    });
    const data = (response.data ?? {}) as Record<string, unknown>;
    if (typeof data.error === "string" && data.error.trim()) {
      return { ok: false, plan: null, searchesLeft: null, message: data.error.slice(0, 300) };
    }
    const plan = typeof data.plan_name === "string" ? data.plan_name : typeof data.plan === "string" ? data.plan : null;
    const left = Number(data.total_searches_left ?? data.searches_left ?? Number.NaN);
    return {
      ok: true,
      plan,
      searchesLeft: Number.isFinite(left) ? left : null,
      message: plan ? `Key verified on the ${plan} plan.` : "Key verified.",
    };
  } catch (error) {
    return { ok: false, plan: null, searchesLeft: null, message: errorMessage(error) };
  }
}

export async function saveSerpApiKey(
  rawKey: string,
  actor: string,
  appConfig: AppConfig,
): Promise<{ state: SerpApiCredentialState; verification: SerpApiVerification }> {
  const key = rawKey.trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) {
    throw new AppError(400, "invalid_serpapi_key", "Enter a single SerpApi key without spaces or punctuation.");
  }
  const verification = await verifySerpApiKey(key, appConfig);
  if (!verification.ok) {
    throw new AppError(400, "invalid_serpapi_key", `SerpApi rejected this key: ${verification.message}`);
  }
  await ensureSettingsRow(appConfig);
  const cipher = encryptSecret(key, appConfig);
  await query(
    `UPDATE app_settings SET
       serpapi_api_key_cipher = $1,
       serpapi_api_key_last4 = $2,
       serpapi_api_key_status = 'valid',
       serpapi_api_key_updated_at = now(),
       serpapi_api_key_updated_by = $3,
       serpapi_api_key_checked_at = now(),
       serpapi_account_plan = $4,
       serpapi_account_searches_left = $5
     WHERE id = 1`,
    [cipher, last4(key), actor, verification.plan, verification.searchesLeft],
  );
  return { state: await getSerpApiCredentialState(appConfig), verification };
}

export async function clearSerpApiKey(
  actor: string,
  appConfig: AppConfig,
): Promise<SerpApiCredentialState> {
  await ensureSettingsRow(appConfig);
  await query(
    `UPDATE app_settings SET
       serpapi_api_key_cipher = NULL,
       serpapi_api_key_last4 = NULL,
       serpapi_api_key_status = NULL,
       serpapi_api_key_updated_at = now(),
       serpapi_api_key_updated_by = $1,
       serpapi_api_key_checked_at = NULL,
       serpapi_account_plan = NULL,
       serpapi_account_searches_left = NULL
     WHERE id = 1`,
    [actor],
  );
  return getSerpApiCredentialState(appConfig);
}

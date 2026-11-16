// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/server/config.js";

// Never let a unit test open a database or provider connection.
const db = vi.hoisted(() => ({ one: vi.fn(), query: vi.fn() }));
vi.mock("../../src/server/db.js", () => db);
vi.mock("../../src/server/services/usage.js", () => ({ ensureSettingsRow: vi.fn() }));
vi.mock("../../src/server/sources/http.js", () => ({ requestJson: vi.fn() }));

import {
  decryptSecret,
  encryptSecret,
  getSerpApiCredentialState,
  resolveSerpApiKey,
} from "../../src/server/services/serpapi-credentials.js";

const config = loadConfig({
  APP_ACCESS_KEY: "test-access-key-not-for-production-0001",
  SETTINGS_ENCRYPTION_KEY: "test-settings-encryption-key-0001",
  SERPAPI_API_KEY: "environment-key-1234",
  NODE_ENV: "test",
});

describe("SerpApi credential encryption", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("round-trips a key without storing it in clear text", () => {
    const cipher = encryptSecret("super-secret-serpapi-key-9876", config);
    expect(cipher).not.toContain("super-secret-serpapi-key-9876");
    expect(cipher.startsWith("v1.")).toBe(true);
    expect(decryptSecret(cipher, config)).toBe("super-secret-serpapi-key-9876");
  });

  it("produces a different ciphertext for the same plaintext", () => {
    const first = encryptSecret("same-key-1234567890", config);
    const second = encryptSecret("same-key-1234567890", config);
    expect(first).not.toBe(second);
  });

  it("returns null when the encryption secret changed", () => {
    const otherConfig = loadConfig({
      APP_ACCESS_KEY: "test-access-key-not-for-production-0001",
      SETTINGS_ENCRYPTION_KEY: "a-different-encryption-key-0002",
      NODE_ENV: "test",
    });
    const cipher = encryptSecret("key-that-cannot-be-read-1234", config);
    expect(decryptSecret(cipher, otherConfig)).toBeNull();
  });
});

describe("SerpApi key resolution precedence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("uses the operator-saved key ahead of the environment value", async () => {
    const cipher = encryptSecret("settings-key-abcdef1234", config);
    db.one.mockResolvedValue({
      serpapi_api_key_cipher: cipher,
      serpapi_api_key_last4: "1234",
      serpapi_api_key_status: "valid",
      serpapi_api_key_updated_at: new Date("2026-01-01T00:00:00.000Z"),
      serpapi_api_key_updated_by: "operator",
      serpapi_api_key_checked_at: new Date("2026-01-01T00:00:00.000Z"),
      serpapi_account_plan: "Free",
      serpapi_account_searches_left: 38,
    });
    await expect(resolveSerpApiKey(config)).resolves.toBe("settings-key-abcdef1234");
    const state = await getSerpApiCredentialState(config);
    expect(state).toMatchObject({
      configured: true,
      source: "settings",
      last4: "1234",
      status: "valid",
      plan: "Free",
      searchesLeft: 38,
    });
  });

  it("falls back to the environment key when no stored key exists", async () => {
    db.one.mockResolvedValue({
      serpapi_api_key_cipher: null,
      serpapi_api_key_last4: null,
      serpapi_api_key_status: null,
      serpapi_api_key_updated_at: null,
      serpapi_api_key_updated_by: null,
      serpapi_api_key_checked_at: null,
      serpapi_account_plan: null,
      serpapi_account_searches_left: null,
    });
    await expect(resolveSerpApiKey(config)).resolves.toBe("environment-key-1234");
    const state = await getSerpApiCredentialState(config);
    expect(state).toMatchObject({
      configured: true,
      source: "environment",
      last4: "1234",
    });
  });

  it("reports an unreadable stored key instead of silently using a broken value", async () => {
    const otherConfig = loadConfig({
      APP_ACCESS_KEY: "test-access-key-not-for-production-0001",
      SETTINGS_ENCRYPTION_KEY: "rotated-encryption-key-0003",
      NODE_ENV: "test",
    });
    db.one.mockResolvedValue({
      serpapi_api_key_cipher: encryptSecret("unreadable-key-5678", config),
      serpapi_api_key_last4: "5678",
      serpapi_api_key_status: "valid",
      serpapi_api_key_updated_at: null,
      serpapi_api_key_updated_by: null,
      serpapi_api_key_checked_at: null,
      serpapi_account_plan: null,
      serpapi_account_searches_left: null,
    });
    const state = await getSerpApiCredentialState(otherConfig);
    expect(state.source).toBe("settings");
    expect(state.status).toBe("unreadable");
    // No environment key on this config, so the credential is not usable.
    expect(state.configured).toBe(false);
    await expect(resolveSerpApiKey(otherConfig)).resolves.toBeNull();
  });
});

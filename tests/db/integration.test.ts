// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === "1" && Boolean(databaseUrl);

describe.skipIf(!enabled)("PostgreSQL schema integration", () => {
  let runMigrations: typeof import("../../src/server/migrate.js").runMigrations;
  let closePool: typeof import("../../src/server/db.js").closePool;
  let transaction: typeof import("../../src/server/db.js").transaction;
  let many: typeof import("../../src/server/db.js").many;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl as string;
    ({ runMigrations } = await import("../../src/server/migrate.js"));
    ({ closePool, transaction, many } = await import("../../src/server/db.js"));
    await runMigrations(undefined, "migrations");
  });

  afterAll(async () => {
    await closePool?.();
  });

  it("creates the core tables", async () => {
    const rows = await many<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const names = new Set(rows.map((row) => row.table_name));
    for (const table of [
      "sessions",
      "settings",
      "usage_counters",
      "google_request_reservations",
      "search_runs",
      "source_place_records",
      "run_places",
      "saved_places",
      "collections",
      "export_jobs",
    ]) {
      expect(names.has(table), `missing table ${table}`).toBe(true);
    }
  });

  it("rolls back failed transactions", async () => {
    await expect(
      transaction(async (client) => {
        await client.query("CREATE TEMP TABLE pd_rollback_probe (value int)");
        await client.query("INSERT INTO pd_rollback_probe (value) VALUES (1)");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    const rows = await many<{ count: string }>(
      "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_name = 'pd_rollback_probe'",
    );
    expect(rows[0]?.count).toBe("0");
  });
});

if (!enabled) {
  describe("PostgreSQL schema integration", () => {
    it.skip("set RUN_DB_TESTS=1 and TEST_DATABASE_URL to run database tests", () => undefined);
  });
}

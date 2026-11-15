import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { pool } from "./db.js";
import { logger } from "./logger.js";

const MIGRATION_LOCK_ID = 7_310_442;

export async function runMigrations(databasePool: Pool = pool, migrationsDir = "migrations"): Promise<string[]> {
  const client = await databasePool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const files = (await readdir(migrationsDir))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const existing = await client.query<{ filename: string }>("SELECT filename FROM schema_migrations");
    const done = new Set(existing.rows.map((row) => row.filename));

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
        logger.info({ migration: file }, "Applied database migration");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        });
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
  return applied;
}

const isDirectRun = process.argv[1]?.endsWith("migrate.js") || process.argv[1]?.endsWith("migrate.ts");
if (isDirectRun) {
  runMigrations()
    .then((applied) => {
      logger.info({ applied: applied.length }, "Database migrations complete");
      process.exit(0);
    })
    .catch((error) => {
      logger.error({ err: error }, "Database migration failed");
      process.exit(1);
    });
}

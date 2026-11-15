import { config } from "./config.js";
import { buildApp } from "./app.js";
import { runMigrations } from "./migrate.js";
import { closePool } from "./db.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  const app = await buildApp();
  try {
    await runMigrations();
    await app.listen({ port: config.port, host: config.host });
    logger.info(
      { port: config.port, env: config.env, version: config.version },
      "Places Discovery API listening",
    );
  } catch (error) {
    logger.error({ err: error }, "Failed to start server");
    await app.close().catch(() => undefined);
    await closePool().catch(() => undefined);
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down API");
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  logger.error({ err: error }, "API crashed");
  process.exit(1);
});

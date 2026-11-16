import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  authenticate,
  checkOrigin,
  createSession,
  destroySession,
  requireCsrf,
  verifyAccessKey,
} from "../auth.js";
import { config } from "../config.js";
import { audit } from "../services/audit.js";
import { resolveSerpApiKey } from "../services/serpapi-credentials.js";
import { hashIp } from "../auth-crypto.js";
import { AppError } from "../errors.js";
import { closePool } from "../db.js";

const loginSchema = z.object({
  accessKey: z.string().min(1).max(500),
  displayName: z.string().trim().min(1).max(80),
});

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/auth/login",
    {
      config: { rateLimit: { max: 10, timeWindow: "5 minutes" } },
    },
    async (request, reply) => {
      checkOrigin(request);
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(400, "invalid_login", "Enter your name and access key.");
      }
      if (!verifyAccessKey(parsed.data.accessKey)) {
        await audit({
          actor: parsed.data.displayName,
          action: "auth.login_failed",
          ipHash: hashIp(request.ip),
          metadata: { reason: "invalid_access_key" },
        });
        throw new AppError(401, "invalid_access", "That access key is not valid.");
      }
      const session = await createSession(parsed.data.displayName, request, reply);
      return reply.code(200).send(session);
    },
  );

  app.get("/api/auth/me", { preHandler: authenticate }, async (request) => {
    return request.auth;
  });

  app.post(
    "/api/auth/logout",
    { preHandler: [authenticate, requireCsrf] },
    async (request, reply) => {
      await destroySession(request, reply);
      return reply.code(204).send();
    },
  );

  app.get("/health/live", async () => ({ status: "ok", version: config.version }));

  app.get("/health/ready", async (_request, reply) => {
    try {
      const { one } = await import("../db.js");
      await one("SELECT 1");
      return { status: "ready", version: config.version };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  app.get("/api/public/status", async () => ({
    appName: "Places Discovery",
    version: config.version,
    accessRequired: true,
    env: config.env,
    serpapiConfigured: Boolean(await resolveSerpApiKey(config)),
    reviewsEnabled: config.serpapi.reviewsEnabled,
    serpapiExportEnabled: config.serpapi.exportEnabled,
    tiles: config.tiles,
  }));
}

export async function closeDatabase(): Promise<void> {
  await closePool();
}

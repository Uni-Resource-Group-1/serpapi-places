import { existsSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import compress from "@fastify/compress";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { AppError } from "./errors.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerLibraryRoutes } from "./routes/library.js";
import { registerExportRoutes } from "./routes/exports.js";
import { registerGeoRoutes } from "./routes/geo.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
    requestIdHeader: "x-request-id",
  });

  app.decorateRequest("auth", null);

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: config.env === "production" ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.env === "production" ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });
  await app.register(compress, { global: true, encodings: ["gzip", "deflate"] });
  await app.register(rateLimit, {
    global: false,
    max: 120,
    timeWindow: "1 minute",
    keyGenerator: (request) => request.ip,
  });

  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("X-Robots-Tag", "noindex, nofollow");
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details ?? undefined },
        requestId: request.id,
      });
    }
    if (error instanceof ZodError) {
      const first = error.issues[0];
      return reply.code(400).send({
        error: {
          code: "validation_error",
          message: first?.message ?? "Invalid request.",
          details: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
        },
        requestId: request.id,
      });
    }
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, "Unhandled request error");
    }
    return reply.code(statusCode).send({
      error: {
        code: statusCode >= 500 ? "internal_error" : "request_error",
        message:
          statusCode >= 500
            ? "Something went wrong. Try again."
            : error instanceof Error
              ? error.message
              : "Request failed.",
      },
      requestId: request.id,
    });
  });

  await app.register(registerAuthRoutes);
  await app.register(registerSystemRoutes);
  await app.register(registerGeoRoutes);
  await app.register(registerSearchRoutes);
  await app.register(registerLibraryRoutes);
  await app.register(registerExportRoutes);

  const clientDir = path.resolve("dist/client");
  if (existsSync(path.join(clientDir, "index.html"))) {
    await app.register(fastifyStatic, {
      root: clientDir,
      prefix: "/",
      wildcard: true,
      maxAge: config.env === "production" ? "1h" : 0,
    });
  }

  app.setNotFoundHandler((request, reply) => {
    if (
      request.url.startsWith("/api/") ||
      request.url.startsWith("/health/") ||
      !existsSync(path.join(clientDir, "index.html"))
    ) {
      return reply.code(404).send({ error: { code: "not_found", message: "Not found." } });
    }
    return reply.type("text/html").sendFile("index.html");
  });

  return app as unknown as FastifyInstance;
}

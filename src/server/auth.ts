import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { one, query, transaction } from "./db.js";
import { AppError } from "./errors.js";
import { accessKeyMatches, hashIp, randomToken, safeEqual, sha256 } from "./auth-crypto.js";
import { audit } from "./services/audit.js";

export const SESSION_COOKIE = "pd_session";

export interface AuthSession {
  id: string;
  displayName: string;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthSession | null;
  }
}

interface SessionRow {
  id: string;
  display_name: string;
  csrf_token: string;
  created_at: Date;
  expires_at: Date;
}

function requestIp(request: FastifyRequest): string {
  return request.ip;
}

export async function createSession(
  displayName: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthSession> {
  const rawToken = randomToken(32);
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + config.sessionDays * 86_400_000);
  const session = await transaction(async (client) => {
    await client.query("DELETE FROM sessions WHERE expires_at < now()");
    const inserted = await client.query<SessionRow>(
      `INSERT INTO sessions (token_hash, csrf_token, display_name, user_agent, ip_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, display_name, csrf_token, created_at, expires_at`,
      [
        sha256(rawToken),
        csrfToken,
        displayName.slice(0, 80),
        (request.headers["user-agent"] ?? "").slice(0, 300),
        hashIp(requestIp(request)),
        expiresAt,
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("Could not create session");
    const count = await client.query<{ total: string }>("SELECT count(*)::text AS total FROM sessions");
    const total = Number(count.rows[0]?.total ?? 0);
    if (total > config.maxActiveSessions) {
      await client.query(
        `DELETE FROM sessions WHERE id IN (
           SELECT id FROM sessions ORDER BY last_seen_at ASC LIMIT $1
         )`,
        [total - config.maxActiveSessions],
      );
    }
    return row;
  });

  reply.setCookie(SESSION_COOKIE, rawToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    path: "/",
    maxAge: config.sessionDays * 86_400,
  });

  await audit({
    actor: displayName,
    action: "auth.login",
    targetType: "session",
    targetId: session.id,
    ipHash: hashIp(requestIp(request)),
  });

  return {
    id: session.id,
    displayName: session.display_name,
    csrfToken: session.csrf_token,
    createdAt: session.created_at.toISOString(),
    expiresAt: session.expires_at.toISOString(),
  };
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) throw new AppError(401, "unauthenticated", "Sign in to continue.");
  const row = await one<SessionRow>(
    `SELECT id, display_name, csrf_token, created_at, expires_at
     FROM sessions WHERE token_hash = $1 AND expires_at > now()`,
    [sha256(raw)],
  );
  if (!row) {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    throw new AppError(401, "session_expired", "Your session has expired. Sign in again.");
  }
  request.auth = {
    id: row.id,
    displayName: row.display_name,
    csrfToken: row.csrf_token,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
  await query(
    "UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '60 seconds'",
    [row.id],
  );
}

export function checkOrigin(request: FastifyRequest): void {
  const origin = request.headers.origin;
  if (origin && origin !== config.appOrigin) {
    throw new AppError(403, "invalid_origin", "Request origin is not allowed.");
  }
}

export async function requireCsrf(request: FastifyRequest): Promise<void> {
  checkOrigin(request);
  const token = request.headers["x-csrf-token"];
  if (!request.auth || typeof token !== "string" || !safeEqual(token, request.auth.csrfToken)) {
    throw new AppError(403, "invalid_csrf", "Your session form token is missing or invalid. Refresh and try again.");
  }
}

export function verifyAccessKey(candidate: unknown): boolean {
  return typeof candidate === "string" && candidate.length > 0 && accessKeyMatches(candidate);
}

export async function destroySession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.auth) {
    await query("DELETE FROM sessions WHERE id = $1", [request.auth.id]);
    await audit({
      actor: request.auth.displayName,
      action: "auth.logout",
      targetType: "session",
      targetId: request.auth.id,
      ipHash: hashIp(requestIp(request)),
    });
  }
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
  request.auth = null;
}

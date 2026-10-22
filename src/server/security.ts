// Loopback-only browser security boundary. Session cookie is HttpOnly +
// SameSite=Strict; writes additionally require Origin to match the configured
// canonical origin and X-CSRF-Token to match the session's token. There is no
// CORS; cross-origin requests cannot reach this server because it binds to
// 127.0.0.1 by default.

import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ProofestraConfig } from "../shared/config.js";
import type { SessionRepo } from "../storage/repos.js";

export const SESSION_COOKIE = "proofestra_session";

interface SessionBindings {
  sessions: SessionRepo;
  config: ProofestraConfig;
}

export function registerSecurity(app: FastifyInstance, bindings: SessionBindings): void {
  const allowedOrigins = new Set<string>([bindings.config.origin, ...bindings.config.extraOrigins]);
  const allowedHosts = new Set<string>([
    `${bindings.config.host}:${bindings.config.port}`,
    `127.0.0.1:${bindings.config.port}`,
    `localhost:${bindings.config.port}`,
  ]);
  for (const extra of bindings.config.extraOrigins) {
    try {
      const url = new URL(extra);
      allowedHosts.add(url.host.toLowerCase());
    } catch {
      // config loader already validated this; swallow defensively.
    }
  }

  app.addHook("onRequest", async (request, reply) => {
    // Reject non-loopback Host headers (defense in depth against DNS rebinding).
    const host = request.headers.host ?? "";
    if (!allowedHosts.has(host.toLowerCase())) {
      reply
        .status(403)
        .headers(baseHeaders(request))
        .send({ error: errorBody("forbidden", "Host header is not allowed", request.id) });
      return reply;
    }
    return undefined;
  });

  app.addHook("onSend", async (request, reply, payload) => {
    // Cache-control: only set if the route didn't already set one. The
    // attachment preview/download routes need `private, no-store` with a
    // Content-Disposition, and some routes may legitimately mark a
    // response cacheable in the future.
    if (!reply.getHeader("cache-control")) {
      reply.header("cache-control", "no-store");
    }
    reply.header("x-request-id", String(request.id));
    reply.header("x-content-type-options", "nosniff");
    // Preserve a route-set X-Frame-Options (DENY is already the strictest,
    // so this is identity today, but keep the pattern consistent).
    if (!reply.getHeader("x-frame-options")) {
      reply.header("x-frame-options", "DENY");
    }
    reply.header("referrer-policy", "no-referrer");
    reply.header("cross-origin-opener-policy", "same-origin");
    reply.header("cross-origin-resource-policy", "same-origin");
    // CSP: a route may set a STRICTER CSP (e.g. the attachment preview
    // route uses `default-src 'none'; sandbox; ...` to make inline media
    // truly inert). Overwriting that with the broad app-wide policy would
    // relax the security boundary. Only set the default policy when the
    // route hasn't set one.
    if (!reply.getHeader("content-security-policy")) {
      reply.header(
        "content-security-policy",
        // Narrow default. The UI needs `img-src 'self' data:` for inline
        // thumbnails of pasted/dragged images (object-URL blobs resolve
        // under `blob:`, included here). Media/video previews served by
        // the attachment route use the stricter route-set CSP above.
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
    }
    return payload;
  });

  app.decorateRequest("session", null);

  app.addHook("preHandler", async (request, reply) => {
    const sessionCookie = parseCookie(request.headers.cookie ?? null, SESSION_COOKIE);
    const url = request.url ?? "";
    const isApi = url.startsWith("/api/");
    const isSessionBootstrap =
      request.method === "GET" &&
      (url === "/api/v1/session" || url.startsWith("/api/v1/session?"));
    const needsSession = isApi && !isSessionBootstrap;
    if (!needsSession) return undefined;
    if (!sessionCookie) {
      reply
        .status(401)
        .send({ error: errorBody("unauthorized", "no session; call GET /api/v1/session first", request.id) });
      return reply;
    }
    const existing = bindings.sessions.get(sessionCookie);
    if (!existing) {
      reply
        .status(401)
        .send({ error: errorBody("unauthorized", "session expired; call GET /api/v1/session", request.id) });
      return reply;
    }
    bindings.sessions.touch(existing.id);
    (request as { session?: { id: string; csrf: string } }).session = {
      id: existing.id,
      csrf: existing.csrf_token,
    };

    const method = request.method;
    const mutating = method === "POST" || method === "PUT" || method === "DELETE" || method === "PATCH";
    if (mutating) {
      const origin = request.headers.origin ?? null;
      if (origin == null || !allowedOrigins.has(origin)) {
        reply.status(403).send({
          error: errorBody("forbidden", "Origin header is not in the allowlist", request.id),
        });
        return reply;
      }
      const csrfHeader = request.headers["x-csrf-token"];
      const csrfValue = Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader;
      if (!csrfValue || !safeEqual(csrfValue, existing.csrf_token)) {
        reply.status(403).send({
          error: errorBody("forbidden", "missing or incorrect X-CSRF-Token", request.id),
        });
        return reply;
      }
    }
    return undefined;
  });
}

export function newSession(repo: SessionRepo): { id: string; csrfToken: string } {
  const id = randomBytes(24).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  repo.create(id, csrfToken);
  return { id, csrfToken };
}

export function sessionCookieHeader(id: string, config: ProofestraConfig): string {
  const parts = [
    `${SESSION_COOKIE}=${id}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=86400",
  ];
  if (config.origin.startsWith("https://")) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function errorBody(code: string, message: string, requestId: string | number): {
  code: string;
  message: string;
  request_id: string;
  details: never[];
} {
  return {
    code,
    message,
    request_id: String(requestId),
    details: [],
  };
}

/**
 * Extract one cookie value from a Cookie header. The first occurrence of the
 * name wins. A value is everything after the first `=` (so padding `=` stays
 * part of the value and never truncates it). Fail-closed: a malformed
 * percent-encoding (which makes decodeURIComponent throw) is treated as an
 * absent/invalid session instead of surfacing as a 500.
 */
export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    try {
      return decodeURIComponent(trimmed.slice(eq + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const buf = createHash("sha256").update(a).digest();
  const other = createHash("sha256").update(b).digest();
  if (buf.length !== other.length) return false;
  let diff = 0;
  for (let i = 0; i < buf.length; i++) diff |= buf[i]! ^ other[i]!;
  return diff === 0;
}

function baseHeaders(request: FastifyRequest): Record<string, string> {
  return {
    "cache-control": "no-store",
    "x-request-id": String(request.id),
    "content-type": "application/json; charset=utf-8",
  };
}

export function requireSession(request: FastifyRequest, reply: FastifyReply): { id: string; csrf: string } | null {
  const session = (request as { session?: { id: string; csrf: string } }).session;
  if (!session) {
    reply.status(401).send({ error: errorBody("unauthorized", "no session", request.id) });
    return null;
  }
  return session;
}

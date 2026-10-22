import type { FastifyInstance } from "fastify";
import type { RouteDeps } from "./index.js";
import { SESSION_COOKIE, newSession, parseCookie, sessionCookieHeader } from "../security.js";

export function registerSessionRoute(app: FastifyInstance, deps: RouteDeps): void {
  app.get("/api/v1/session", async (request, reply) => {
    // Idempotent: always issue a fresh session + CSRF token. The HttpOnly
    // SameSite=Strict cookie never leaves the loopback interface.
    const existing = parseCookie(request.headers.cookie ?? null, SESSION_COOKIE);
    if (existing) {
      const current = deps.sessions.get(existing);
      if (current) {
        deps.sessions.touch(existing);
        reply.header("set-cookie", sessionCookieHeader(existing, deps.config));
        return { csrf_token: current.csrf_token };
      }
    }
    const session = newSession(deps.sessions);
    reply.header("set-cookie", sessionCookieHeader(session.id, deps.config));
    return { csrf_token: session.csrfToken };
  });
}

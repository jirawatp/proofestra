// requireSession: the guard a handler uses to read the authenticated session
// that registerSecurity's preHandler attached.

import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type DbHandle } from "../../src/storage/db.js";
import { SessionRepo } from "../../src/storage/repos.js";
import { newSession, registerSecurity, requireSession, sessionCookieHeader } from "../../src/server/security.js";
import { makeConfig } from "../integration/_server_helpers.js";

let db: DbHandle | null = null;
afterEach(() => {
  db?.close();
  db = null;
});

describe("requireSession / newSession / sessionCookieHeader", () => {
  it("returns the session attached by the preHandler on an authenticated API route and answers 401 otherwise", async () => {
    db = openDatabase(":memory:");
    const sessions = new SessionRepo(db);
    const config = makeConfig("/unused");
    const app = Fastify();
    registerSecurity(app, { sessions, config });
    app.get("/api/v1/whoami", async (request, reply) => {
      const s = requireSession(request, reply);
      if (!s) return reply;
      return { id: s.id, csrf: s.csrf };
    });
    // A non-API path skips the session hook, so requireSession itself must refuse.
    app.get("/open", async (request, reply) => {
      const s = requireSession(request, reply);
      if (!s) return reply;
      return { unexpected: true };
    });
    const s = newSession(sessions);

    const ok = await app.inject({ method: "GET", url: "/api/v1/whoami", headers: { host: "127.0.0.1:3000", cookie: `proofestra_session=${s.id}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ id: s.id, csrf: s.csrfToken });

    const open = await app.inject({ method: "GET", url: "/open", headers: { host: "127.0.0.1:3000", cookie: `proofestra_session=${s.id}` } });
    expect(open.statusCode).toBe(401);
    expect((open.json() as { error: { code: string } }).error.code).toBe("unauthorized");
    await app.close();
  });

  it("newSession issues unguessable distinct ids and tokens that are persisted", () => {
    db = openDatabase(":memory:");
    const sessions = new SessionRepo(db);
    const a = newSession(sessions);
    const b = newSession(sessions);
    expect(a.id).not.toBe(b.id);
    expect(a.csrfToken).not.toBe(b.csrfToken);
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sessions.get(a.id)).toEqual({ id: a.id, csrf_token: a.csrfToken });
  });

  it("cookie attributes: Secure only on https origins; always HttpOnly, SameSite=Strict, Path=/, one-day Max-Age", () => {
    const http = sessionCookieHeader("abc", makeConfig("/x"));
    const https = sessionCookieHeader("abc", makeConfig("/x", { origin: "https://localhost:3000" }));
    expect(http).toBe("proofestra_session=abc; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400");
    expect(https).toBe(`${http}; Secure`);
  });
});

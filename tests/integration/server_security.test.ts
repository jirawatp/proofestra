// Browser-security boundary: session bootstrap, cookie handling (including
// hostile / malformed cookies), Host and Origin allow-lists, CSRF failure
// modes, security headers and the static/SPA/404 envelope. Everything runs
// through fastify.inject against a temp SQLite DB; no listener is bound.

import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeServer, type ServerCtx } from "./_server_helpers.js";
import { parseCookie, registerSecurity, SESSION_COOKIE } from "../../src/server/security.js";
import { SessionRepo } from "../../src/storage/repos.js";

let ctx: ServerCtx | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await ctx?.cleanup();
  ctx = null;
});

function setCookieOf(resp: { headers: Record<string, unknown> }): string {
  const raw = resp.headers["set-cookie"];
  return Array.isArray(raw) ? (raw[0] as string) : (raw as string);
}

describe("parseCookie", () => {
  it("returns the value of the named cookie and ignores other cookies", () => {
    expect(parseCookie("a=1; proofestra_session=abc; b=2", SESSION_COOKIE)).toBe("abc");
  });

  it("returns null for a missing header, missing cookie, or cookie without '='", () => {
    expect(parseCookie(null, SESSION_COOKIE)).toBeNull();
    expect(parseCookie("", SESSION_COOKIE)).toBeNull();
    expect(parseCookie("other=1", SESSION_COOKIE)).toBeNull();
    expect(parseCookie("proofestra_session", SESSION_COOKIE)).toBeNull();
  });

  it("fails closed (null) instead of throwing on malformed percent-encoding", () => {
    expect(parseCookie("proofestra_session=%", SESSION_COOKIE)).toBeNull();
    expect(parseCookie("proofestra_session=%E0%A4%A", SESSION_COOKIE)).toBeNull();
    expect(parseCookie("proofestra_session=%zz", SESSION_COOKIE)).toBeNull();
  });

  it("decodes well-formed percent-encoding and keeps '=' inside the value", () => {
    expect(parseCookie("proofestra_session=a%20b", SESSION_COOKIE)).toBe("a b");
    expect(parseCookie("proofestra_session=abc=def", SESSION_COOKIE)).toBe("abc=def");
  });

  it("uses the first occurrence when the name is duplicated", () => {
    expect(parseCookie("proofestra_session=first; proofestra_session=second", SESSION_COOKIE)).toBe(
      "first",
    );
  });

  it("returns an empty string for an empty value (callers treat it as absent)", () => {
    expect(parseCookie("proofestra_session=", SESSION_COOKIE)).toBe("");
  });
});

describe("session bootstrap", () => {
  it("issues an HttpOnly SameSite=Strict cookie without Secure on http origins", async () => {
    ctx = await makeServer({ bootstrap: false });
    const resp = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/session",
      headers: { host: ctx.hostHeader },
    });
    expect(resp.statusCode).toBe(200);
    const cookie = setCookieOf(resp);
    expect(cookie).toMatch(/^proofestra_session=[A-Za-z0-9_-]{20,};/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=86400");
    expect(cookie).not.toContain("Secure");
    expect((resp.json() as { csrf_token: string }).csrf_token.length).toBeGreaterThanOrEqual(32);
  });

  it("adds Secure when the canonical origin is https", async () => {
    ctx = await makeServer({
      bootstrap: false,
      config: { origin: "https://localhost:3000" },
    });
    const resp = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/session",
      headers: { host: ctx.hostHeader },
    });
    expect(setCookieOf(resp)).toContain("Secure");
  });

  it("reuses a valid existing session: same csrf token and the same cookie id", async () => {
    ctx = await makeServer();
    const resp = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/session",
      headers: { host: ctx.hostHeader, cookie: ctx.cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect((resp.json() as { csrf_token: string }).csrf_token).toBe(ctx.csrf);
    expect(setCookieOf(resp).split(";")[0]).toBe(ctx.cookie);
  });

  it("issues a fresh session for an unknown session id", async () => {
    ctx = await makeServer();
    const resp = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/session?x=1",
      headers: { host: ctx.hostHeader, cookie: "proofestra_session=does-not-exist" },
    });
    expect(resp.statusCode).toBe(200);
    expect((resp.json() as { csrf_token: string }).csrf_token).not.toBe(ctx.csrf);
    expect(setCookieOf(resp).split(";")[0]).not.toBe("proofestra_session=does-not-exist");
  });

  // Regression: decodeURIComponent threw inside parseCookie and surfaced as 500.
  it.each(["proofestra_session=%", "proofestra_session=%E0%A4%A", "proofestra_session=%zz"])(
    "malformed cookie %s on GET /session issues a FRESH session (200), not 500",
    async (cookie) => {
      ctx = await makeServer({ bootstrap: false });
      const resp = await ctx.app.inject({
        method: "GET",
        url: "/api/v1/session",
        headers: { host: ctx.hostHeader, cookie },
      });
      expect(resp.statusCode).toBe(200);
      const body = resp.json() as { csrf_token: string };
      expect(body.csrf_token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
      expect(setCookieOf(resp)).toMatch(/^proofestra_session=[A-Za-z0-9_-]+;/);
      // The fresh session is actually usable.
      const sid = setCookieOf(resp).split(";")[0]!;
      const ok = await ctx.app.inject({
        method: "GET",
        url: "/api/v1/conversations",
        headers: { host: ctx.hostHeader, cookie: sid },
      });
      expect(ok.statusCode).toBe(200);
    },
  );
});

describe("protected API access", () => {
  it("rejects a request with no cookie as 401 unauthorized", async () => {
    ctx = await makeServer({ bootstrap: false });
    const resp = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/conversations",
      headers: { host: ctx.hostHeader },
    });
    expect(resp.statusCode).toBe(401);
    const body = resp.json() as { error: { code: string; request_id: string } };
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.request_id).toBeTruthy();
  });

  // Regression: same 500 in the preHandler hook.
  it.each([
    "proofestra_session=%",
    "proofestra_session=%E0%A4%A",
    "proofestra_session",
    "proofestra_session=",
    "other=1",
  ])("treats cookie header %j as an absent session (401, not 500)", async (cookie) => {
    ctx = await makeServer({ bootstrap: false });
    const resp = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/conversations",
      headers: { host: ctx.hostHeader, cookie },
    });
    expect(resp.statusCode).toBe(401);
    expect((resp.json() as { error: { code: string } }).error.code).toBe("unauthorized");
  });

  it("rejects an unknown (e.g. purged or expired) session id with 401 and a re-bootstrap hint", async () => {
    ctx = await makeServer();
    ctx.bundle.db.prepare("DELETE FROM sessions").run();
    const resp = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/conversations",
      headers: { host: ctx.hostHeader, cookie: ctx.cookie },
    });
    expect(resp.statusCode).toBe(401);
    const err = (resp.json() as { error: { code: string; message: string } }).error;
    expect(err.code).toBe("unauthorized");
    expect(err.message).toContain("session");
  });

  it("does not treat a session id with trailing junk after '=' as that session", async () => {
    ctx = await makeServer();
    const resp = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/conversations",
      headers: { host: ctx.hostHeader, cookie: `${ctx.cookie}=junk` },
    });
    expect(resp.statusCode).toBe(401);
  });

  it("uses the first session cookie when the name is duplicated", async () => {
    ctx = await makeServer();
    const good = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/conversations",
      headers: { host: ctx.hostHeader, cookie: `${ctx.cookie}; proofestra_session=bogus` },
    });
    expect(good.statusCode).toBe(200);
    const bad = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/conversations",
      headers: { host: ctx.hostHeader, cookie: `proofestra_session=bogus; ${ctx.cookie}` },
    });
    expect(bad.statusCode).toBe(401);
  });

  it("touches last_used_at on every authenticated request", async () => {
    ctx = await makeServer();
    const id = ctx.cookie.split("=")[1]!;
    ctx.bundle.db.prepare("UPDATE sessions SET last_used_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", id);
    await ctx.app.inject({
      method: "GET",
      url: "/api/v1/conversations",
      headers: { host: ctx.hostHeader, cookie: ctx.cookie },
    });
    const row = ctx.bundle.db.prepare("SELECT last_used_at FROM sessions WHERE id = ?").get(id) as {
      last_used_at: string;
    };
    expect(row.last_used_at > "2000-01-01T00:00:00.000Z").toBe(true);
  });
});

describe("Host allow-list", () => {
  it("rejects disallowed Host headers on API and non-API paths with security headers", async () => {
    ctx = await makeServer();
    for (const url of ["/api/v1/conversations", "/anything", "/api/v1/session"]) {
      const resp = await ctx.app.inject({
        method: "GET",
        url,
        headers: { host: "evil.example:3000", cookie: ctx.cookie },
      });
      expect(resp.statusCode).toBe(403);
      expect((resp.json() as { error: { code: string } }).error.code).toBe("forbidden");
      expect(resp.headers["cache-control"]).toBe("no-store");
      expect(resp.headers["x-content-type-options"]).toBe("nosniff");
      expect(resp.headers["x-request-id"]).toBeTruthy();
    }
  });

  it("rejects a missing Host header", async () => {
    ctx = await makeServer();
    const resp = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/session",
      headers: { host: "" },
    });
    expect(resp.statusCode).toBe(403);
  });

  it("accepts 127.0.0.1, localhost and the configured host case-insensitively", async () => {
    ctx = await makeServer({ bootstrap: false });
    for (const host of ["127.0.0.1:3000", "localhost:3000", "LOCALHOST:3000"]) {
      const resp = await ctx.app.inject({ method: "GET", url: "/api/v1/session", headers: { host } });
      expect(resp.statusCode).toBe(200);
    }
    const wrongPort = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/session",
      headers: { host: "127.0.0.1:3001" },
    });
    expect(wrongPort.statusCode).toBe(403);
  });

  it("accepts extra origins for both Host and Origin, and still rejects unlisted ones", async () => {
    ctx = await makeServer({ config: { extraOrigins: ["http://localhost:5173"] } });
    const hostOk = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/conversations",
      headers: { host: "localhost:5173", cookie: ctx.cookie },
    });
    expect(hostOk.statusCode).toBe(200);

    const originOk = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/conversations",
      headers: ctx.headers({ host: "localhost:5173", origin: "http://localhost:5173" }),
      payload: {},
    });
    expect(originOk.statusCode).toBe(201);

    const originBad = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/conversations",
      headers: ctx.headers({ origin: "http://localhost:5174" }),
      payload: {},
    });
    expect(originBad.statusCode).toBe(403);
  });

  it("ignores an unparsable extra origin when building the Host allow-list", async () => {
    // loadConfig validates entries, but a hand-built config must not crash
    // the server or widen the allow-list.
    ctx = await makeServer({ bootstrap: false, config: { extraOrigins: ["not a url"] } });
    const resp = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/session",
      headers: { host: "not a url" },
    });
    expect(resp.statusCode).toBe(403);
  });
});

describe("CSRF and Origin on mutating requests", () => {
  const post = (c: ServerCtx, headers: Record<string, string | string[]>) =>
    c.app.inject({
      method: "POST",
      url: "/api/v1/conversations",
      headers: headers as Record<string, string>,
      payload: {},
    });

  it("accepts a correct Origin and token", async () => {
    ctx = await makeServer();
    expect((await post(ctx, ctx.headers())).statusCode).toBe(201);
  });

  it("rejects a missing Origin header", async () => {
    ctx = await makeServer();
    const h = ctx.headers();
    delete h.origin;
    const resp = await post(ctx, h);
    expect(resp.statusCode).toBe(403);
    expect((resp.json() as { error: { message: string } }).error.message).toContain("Origin");
  });

  it("rejects a foreign Origin even with a valid token", async () => {
    ctx = await makeServer();
    expect((await post(ctx, ctx.headers({ origin: "http://evil.example" }))).statusCode).toBe(403);
  });

  it("rejects a missing CSRF header", async () => {
    ctx = await makeServer();
    const h = ctx.headers();
    delete h["x-csrf-token"];
    const resp = await post(ctx, h);
    expect(resp.statusCode).toBe(403);
    expect((resp.json() as { error: { message: string } }).error.message).toContain("X-CSRF-Token");
  });

  it("rejects an empty CSRF header", async () => {
    ctx = await makeServer();
    expect((await post(ctx, ctx.headers({ "x-csrf-token": "" }))).statusCode).toBe(403);
  });

  it("rejects a wrong-length and a same-length-but-wrong CSRF token", async () => {
    ctx = await makeServer();
    expect((await post(ctx, ctx.headers({ "x-csrf-token": "short" }))).statusCode).toBe(403);
    const flipped = (ctx.csrf[0] === "A" ? "B" : "A") + ctx.csrf.slice(1);
    expect(flipped).toHaveLength(ctx.csrf.length);
    expect((await post(ctx, ctx.headers({ "x-csrf-token": flipped }))).statusCode).toBe(403);
  });

  it("rejects a duplicated CSRF header even when one of the values is correct", async () => {
    ctx = await makeServer();
    // Node joins repeated non-cookie headers into one "a, b" string, so the
    // combined value can never equal the real token.
    for (const value of [["wrong", ctx.csrf], [ctx.csrf, "wrong"]]) {
      const resp = await ctx.app.inject({
        method: "POST",
        url: "/api/v1/conversations",
        headers: { ...ctx.headers(), "x-csrf-token": value as unknown as string },
        payload: {},
      });
      expect(resp.statusCode).toBe(403);
    }
  });

  it.each([
    ["PUT", "/api/v1/runs/00000000-0000-4000-8000-000000000000/cancellation"],
    ["DELETE", "/api/v1/conversations/00000000-0000-4000-8000-000000000000"],
  ] as const)("enforces CSRF and Origin on %s as well", async (method, url) => {
    ctx = await makeServer();
    const noCsrf = ctx.headers();
    delete noCsrf["x-csrf-token"];
    delete noCsrf["content-type"];
    expect((await ctx.app.inject({ method, url, headers: noCsrf })).statusCode).toBe(403);
    const noOrigin = ctx.headers();
    delete noOrigin.origin;
    delete noOrigin["content-type"];
    expect((await ctx.app.inject({ method, url, headers: noOrigin })).statusCode).toBe(403);
  });

  it("does not require Origin/CSRF on GET", async () => {
    ctx = await makeServer();
    const resp = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/conversations",
      headers: { host: ctx.hostHeader, cookie: ctx.cookie },
    });
    expect(resp.statusCode).toBe(200);
  });
});

describe("security headers", () => {
  it("sets the full hardening header set on a JSON API response", async () => {
    ctx = await makeServer();
    const resp = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/conversations",
      headers: { host: ctx.hostHeader, cookie: ctx.cookie },
    });
    expect(resp.headers["cache-control"]).toBe("no-store");
    expect(resp.headers["x-content-type-options"]).toBe("nosniff");
    expect(resp.headers["x-frame-options"]).toBe("DENY");
    expect(resp.headers["referrer-policy"]).toBe("no-referrer");
    expect(resp.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(resp.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(String(resp.headers["content-security-policy"])).toContain("default-src 'self'");
    expect(String(resp.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
    expect(resp.headers["x-request-id"]).toBeTruthy();
  });

  it("preserves a route-set stricter CSP, cache-control and frame option (onSend does not relax them)", async () => {
    ctx = await makeServer({ bootstrap: false });
    const probe = Fastify();
    registerSecurity(probe, { sessions: new SessionRepo(ctx.bundle.db), config: ctx.config });
    probe.get("/strict", async (_req, reply) => {
      reply
        .header("content-security-policy", "default-src 'none'; sandbox")
        .header("cache-control", "private, no-store")
        .header("x-frame-options", "SAMEORIGIN");
      return "ok";
    });
    probe.get("/plain", async () => "ok");
    const strict = await probe.inject({ method: "GET", url: "/strict", headers: { host: ctx.hostHeader } });
    expect(strict.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(strict.headers["cache-control"]).toBe("private, no-store");
    expect(strict.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(strict.headers["x-content-type-options"]).toBe("nosniff");
    const plain = await probe.inject({ method: "GET", url: "/plain", headers: { host: ctx.hostHeader } });
    expect(String(plain.headers["content-security-policy"])).toContain("default-src 'self'");
    expect(plain.headers["cache-control"]).toBe("no-store");
    await probe.close();
  });
});

describe("static assets, SPA fallback and unknown API paths", () => {
  function tmpPublic(root: string, dir: string): void {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, "index.html"), "<!doctype html><title>spa</title>");
    fs.writeFileSync(path.join(root, dir, "app.js"), "console.log('x')");
  }

  it("serves static files, SPA-falls-back for unknown pages and 404s unknown /api paths (dist/public)", async () => {
    let cwdRoot = "";
    ctx = await makeServer({
      bootstrap: false,
      beforeBuild: ({ workDir }) => {
        cwdRoot = workDir;
        tmpPublic(workDir, "dist/public");
        vi.spyOn(process, "cwd").mockReturnValue(workDir);
      },
    });
    expect(cwdRoot).toBeTruthy();

    const asset = await ctx.app.inject({ method: "GET", url: "/app.js", headers: { host: ctx.hostHeader } });
    expect(asset.statusCode).toBe(200);
    expect(asset.payload).toContain("console.log");
    expect(asset.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(asset.headers["content-security-policy"])).toContain("default-src 'self'");

    const index = await ctx.app.inject({ method: "GET", url: "/", headers: { host: ctx.hostHeader } });
    expect(index.statusCode).toBe(200);
    expect(index.payload).toContain("<title>spa</title>");

    // Non-API paths bypass the session requirement entirely (no 401).
    const spa = await ctx.app.inject({ method: "GET", url: "/some/client/route", headers: { host: ctx.hostHeader } });
    expect(spa.statusCode).toBe(200);
    expect(spa.payload).toContain("<title>spa</title>");

    // An authenticated unknown API path gets the JSON 404 envelope + headers.
    const boot = await ctx.app.inject({ method: "GET", url: "/api/v1/session", headers: { host: ctx.hostHeader } });
    const cookie = setCookieOf(boot).split(";")[0]!;
    const unknown = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/nope",
      headers: { host: ctx.hostHeader, cookie },
    });
    expect(unknown.statusCode).toBe(404);
    const err = (unknown.json() as { error: { code: string; message: string; details: unknown[]; request_id: string } }).error;
    expect(err.code).toBe("not_found");
    expect(err.details).toEqual([]);
    expect(err.request_id).toBeTruthy();
    expect(unknown.headers["x-frame-options"]).toBe("DENY");

    // Without a session, unknown /api paths are 401 first (preHandler runs
    // before the not-found handler).
    const anon = await ctx.app.inject({ method: "GET", url: "/api/v1/nope", headers: { host: ctx.hostHeader } });
    expect([401, 404]).toContain(anon.statusCode);
  });

  it("falls back to <dataDir>/../public when dist/public does not exist", async () => {
    ctx = await makeServer({
      bootstrap: false,
      beforeBuild: ({ workDir }) => {
        tmpPublic(workDir, "public");
        // cwd without a dist/public directory.
        vi.spyOn(process, "cwd").mockReturnValue(path.join(workDir, "data"));
      },
    });
    const resp = await ctx.app.inject({ method: "GET", url: "/", headers: { host: ctx.hostHeader } });
    expect(resp.statusCode).toBe(200);
    expect(resp.payload).toContain("<title>spa</title>");
  });

  it("serves no static handler when no client build exists (plain 404 with security headers)", async () => {
    ctx = await makeServer({
      bootstrap: false,
      beforeBuild: ({ workDir }) => {
        vi.spyOn(process, "cwd").mockReturnValue(path.join(workDir, "data"));
      },
    });
    const resp = await ctx.app.inject({ method: "GET", url: "/", headers: { host: ctx.hostHeader } });
    expect(resp.statusCode).toBe(404);
    expect(resp.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(resp.headers["content-security-policy"])).toContain("default-src 'self'");
    // The body is the documented envelope, not Fastify's default 404 shape.
    expect((resp.json() as { error: { code: string; message: string } }).error).toMatchObject({ code: "not_found", message: "not found" });
  });

  it("an unbuilt checkout still answers an unknown API path with the documented envelope (not Fastify's default 404)", async () => {
    ctx = await makeServer({
      beforeBuild: ({ dataDir }) => {
        vi.spyOn(process, "cwd").mockReturnValue(dataDir);
      },
    });
    const resp = await ctx.app.inject({ method: "GET", url: "/api/v1/extensions", headers: ctx.bodyless() });
    expect(resp.statusCode).toBe(404);
    const body = resp.json() as { error: { code: string; message: string; details: unknown[]; request_id: string }; statusCode?: number };
    expect(body.statusCode).toBeUndefined();
    expect(body.error).toMatchObject({ code: "not_found", message: "unknown API path", details: [] });
    expect(body.error.request_id).toBeTruthy();
    expect(resp.headers["x-frame-options"]).toBe("DENY");
  });
});

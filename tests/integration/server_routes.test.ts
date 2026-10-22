// Conversation, provider, runtime-policy and run routes through fastify.inject
// (plus one real loopback listener on port 0 for the long-lived SSE tail).

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createConversation,
  makeServer,
  quickRunBody,
  teamRunBody,
  waitFor,
  waitTerminal,
  type ServerCtx,
} from "./_server_helpers.js";
import { RUNTIME_POLICY_VERSION } from "../../src/shared/config.js";
import type { RunSnapshot } from "../../src/shared/types.js";

let ctx: ServerCtx | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await ctx?.cleanup();
  ctx = null;
});

const SLOW_PROFILES = {
  mode: "append",
  profiles: [
    {
      profile_id: "mock-glacial",
      provider: "mock",
      label: "Mock glacial",
      model_id: "mock-glacial-v1",
      safe_input_tokens: 32_000,
      max_output_tokens: 2048,
      api_shape: "mock",
      execution_backend_id: "mock-provider-api",
      fixture: { extra_latency_ms: 30_000 },
    },
  ],
};

async function postRun(c: ServerCtx, convId: string, body: unknown, key = crypto.randomUUID(), extra: Record<string, string> = {}) {
  return c.app.inject({
    method: "POST",
    url: `/api/v1/conversations/${convId}/runs`,
    headers: c.headers({ "idempotency-key": key, ...extra }),
    payload: body as object,
  });
}

describe("conversations", () => {
  it("creates with a default and a custom title, returning 201 + Location", async () => {
    ctx = await makeServer();
    const a = await ctx.app.inject({ method: "POST", url: "/api/v1/conversations", headers: ctx.headers(), payload: {} });
    expect(a.statusCode).toBe(201);
    const body = a.json() as { id: string; title: string };
    expect(body.title).toBe("New conversation");
    expect(a.headers.location).toBe(`/api/v1/conversations/${body.id}`);
    const b = await ctx.app.inject({ method: "POST", url: "/api/v1/conversations", headers: ctx.headers(), payload: { title: "Hello ก" } });
    expect((b.json() as { title: string }).title).toBe("Hello ก");
  });

  it.each([{ title: "" }, { title: "x".repeat(201) }, { title: 5 }])("rejects invalid create body %j with 422", async (payload) => {
    ctx = await makeServer();
    const r = await ctx.app.inject({ method: "POST", url: "/api/v1/conversations", headers: ctx.headers(), payload });
    expect(r.statusCode).toBe(422);
    expect((r.json() as { error: { code: string } }).error.code).toBe("validation_failed");
  });

  it("creating with no body at all uses the default title", async () => {
    ctx = await makeServer();
    const r = await ctx.app.inject({ method: "POST", url: "/api/v1/conversations", headers: ctx.bodyless() });
    expect(r.statusCode).toBe(201);
    expect((r.json() as { title: string }).title).toBe("New conversation");
  });

  it("an unexpected repository failure while listing is a generic 500, not a leak", async () => {
    ctx = await makeServer();
    vi.spyOn(ctx.bundle.conversations, "list").mockImplementation(() => {
      throw new Error("disk I/O error at /var/db/secret.sqlite");
    });
    const r = await ctx.app.inject({ method: "GET", url: "/api/v1/conversations", headers: ctx.headers() });
    expect(r.statusCode).toBe(500);
    expect(r.payload).not.toContain("/var/db");
  });

  it("gets one conversation or 404s", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx, "T");
    const ok = await ctx.app.inject({ method: "GET", url: `/api/v1/conversations/${id}`, headers: ctx.headers() });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { title: string }).title).toBe("T");
    const miss = await ctx.app.inject({ method: "GET", url: "/api/v1/conversations/nope", headers: ctx.headers() });
    expect(miss.statusCode).toBe(404);
    expect((miss.json() as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("paginates with limit and an opaque cursor, newest first, with no repeats", async () => {
    ctx = await makeServer();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(await createConversation(ctx, `c${i}`));
      await new Promise((r) => setTimeout(r, 5));
    }
    const p1 = (await ctx.app.inject({ method: "GET", url: "/api/v1/conversations?limit=2", headers: ctx.headers() })).json() as {
      items: { id: string }[];
      next_cursor: string | null;
    };
    expect(p1.items.map((c) => c.id)).toEqual([ids[2], ids[1]]);
    expect(p1.next_cursor).toBeTruthy();
    const p2 = (
      await ctx.app.inject({ method: "GET", url: `/api/v1/conversations?limit=2&cursor=${encodeURIComponent(p1.next_cursor!)}`, headers: ctx.headers() })
    ).json() as { items: { id: string }[]; next_cursor: string | null };
    expect(p2.items.map((c) => c.id)).toEqual([ids[0]]);
    expect(p2.next_cursor).toBeNull();
  });

  it.each(["limit=0", "limit=101", "limit=abc", "cursor="])("rejects query %s with 400 invalid_cursor", async (q) => {
    ctx = await makeServer();
    const r = await ctx.app.inject({ method: "GET", url: `/api/v1/conversations?${q}`, headers: ctx.headers() });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: { code: string } }).error.code).toBe("invalid_cursor");
  });

  // Regression: a syntactically valid but undecodable cursor used to throw
  // out of the repository and surface as 500.
  it.each([
    "not-base64-json",
    Buffer.from("not json").toString("base64url"),
    Buffer.from(JSON.stringify({ u: 1, i: 2 })).toString("base64url"),
    Buffer.from("null").toString("base64url"),
  ])("rejects an undecodable cursor %s with 400 invalid_cursor (not 500)", async (cursor) => {
    ctx = await makeServer();
    const r = await ctx.app.inject({ method: "GET", url: `/api/v1/conversations?cursor=${encodeURIComponent(cursor)}`, headers: ctx.headers() });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: { code: string } }).error.code).toBe("invalid_cursor");
  });

  it("deletes an idle conversation (204), removing its messages, and is idempotent for unknown ids", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const run = await postRun(ctx, id, quickRunBody("hello"));
    await waitTerminal(ctx, (run.json() as RunSnapshot).id);
    expect(ctx.bundle.messages.list(id).length).toBeGreaterThan(0);
    const del = await ctx.app.inject({ method: "DELETE", url: `/api/v1/conversations/${id}`, headers: ctx.bodyless() });
    expect(del.statusCode).toBe(204);
    expect(del.payload).toBe("");
    expect(ctx.bundle.conversations.get(id)).toBeNull();
    expect(ctx.bundle.messages.list(id)).toEqual([]);
    const again = await ctx.app.inject({ method: "DELETE", url: `/api/v1/conversations/${id}`, headers: ctx.bodyless() });
    expect(again.statusCode).toBe(204);
  });

  it("refuses to delete or export while a run is active (409 run_in_progress), then allows both after cancel", async () => {
    ctx = await makeServer({ profilesJson: SLOW_PROFILES });
    const id = await createConversation(ctx);
    const created = await postRun(ctx, id, quickRunBody("slow", {}, "mock-glacial"));
    expect(created.statusCode).toBe(201);
    const runId = (created.json() as RunSnapshot).id;

    const del = await ctx.app.inject({ method: "DELETE", url: `/api/v1/conversations/${id}`, headers: ctx.bodyless() });
    expect(del.statusCode).toBe(409);
    expect((del.json() as { error: { code: string } }).error.code).toBe("run_in_progress");
    const exp = await ctx.app.inject({ method: "GET", url: `/api/v1/conversations/${id}/export`, headers: ctx.headers() });
    expect(exp.statusCode).toBe(409);

    const cancel = await ctx.app.inject({ method: "PUT", url: `/api/v1/runs/${runId}/cancellation`, headers: ctx.bodyless() });
    expect(cancel.statusCode).toBe(200);
    expect((cancel.json() as RunSnapshot).status).toBe("canceled");
    expect((await ctx.app.inject({ method: "GET", url: `/api/v1/conversations/${id}/export`, headers: ctx.headers() })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "DELETE", url: `/api/v1/conversations/${id}`, headers: ctx.bodyless() })).statusCode).toBe(204);
  });

  it("lists messages (404 for unknown conversation) and exports a versioned bundle with attachment disposition", async () => {
    ctx = await makeServer();
    expect((await ctx.app.inject({ method: "GET", url: "/api/v1/conversations/nope/messages", headers: ctx.headers() })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: "/api/v1/conversations/nope/export", headers: ctx.headers() })).statusCode).toBe(404);
    const id = await createConversation(ctx);
    const empty = (await ctx.app.inject({ method: "GET", url: `/api/v1/conversations/${id}/messages`, headers: ctx.headers() })).json();
    expect(empty).toEqual({ items: [], next_cursor: null });

    const run = await postRun(ctx, id, quickRunBody("Explain tides"));
    const runId = (run.json() as RunSnapshot).id;
    await waitTerminal(ctx, runId);
    const msgs = (await ctx.app.inject({ method: "GET", url: `/api/v1/conversations/${id}/messages`, headers: ctx.headers() })).json() as {
      items: { role: string; text: string }[];
    };
    expect(msgs.items.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs.items[0]!.text).toBe("Explain tides");

    const exp = await ctx.app.inject({ method: "GET", url: `/api/v1/conversations/${id}/export`, headers: ctx.headers() });
    expect(exp.statusCode).toBe(200);
    expect(exp.headers["content-disposition"]).toBe(`attachment; filename="proofestra-${id}.json"`);
    const bundle = exp.json() as { export_version: number; exported_at: string; conversation: { id: string }; messages: unknown[]; runs: { id: string }[] };
    expect(bundle.export_version).toBe(1);
    expect(Number.isNaN(Date.parse(bundle.exported_at))).toBe(false);
    expect(bundle.conversation.id).toBe(id);
    expect(bundle.messages).toHaveLength(2);
    expect(bundle.runs.map((r) => r.id)).toEqual([runId]);
  });
});

describe("providers and runtime policy", () => {
  it("publishes providers, catalog version/source and capabilities booleans without leaking credentials", async () => {
    ctx = await makeServer({
      config: { liveEnabled: true, providerCredentials: { openaiKey: "sk-test-FAKE-SECRET", anthropicKey: null, googleKey: null } },
    });
    const r = await ctx.app.inject({ method: "GET", url: "/api/v1/providers", headers: ctx.headers() });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      live_enabled: boolean;
      capabilities: Record<string, unknown>;
      catalog_version: string;
      catalog_source: { source: string; file_configured: boolean };
      items: { provider: string; profiles: { profile_id: string; readiness: string }[] }[];
      next_cursor: null;
    };
    expect(body.live_enabled).toBe(true);
    expect(body.catalog_source).toEqual({ source: "built_in", file_configured: false });
    expect(body.catalog_version).toMatch(/^catalog-v2-local-20261021-[0-9a-f]{12}$/);
    expect(body.next_cursor).toBeNull();
    expect(body.items.map((p) => p.provider)).toEqual(["mock", "openai", "anthropic", "gemini"]);
    expect(Object.values(body.capabilities).every((v) => typeof v === "boolean" || typeof v === "object")).toBe(true);
    const readiness = Object.fromEntries(body.items.flatMap((p) => p.profiles.map((x) => [x.profile_id, x.readiness])));
    expect(readiness["openai-default"]).toBe("configured");
    expect(readiness["anthropic-default"]).toBe("missing_auth");
    expect(r.payload).not.toContain("sk-test-FAKE-SECRET");
  });

  it("serves the runtime policy with the live flag reflected", async () => {
    ctx = await makeServer();
    const off = (await ctx.app.inject({ method: "GET", url: "/api/v1/runtime-policy", headers: ctx.headers() })).json() as {
      policy_version: string;
      live_enabled: boolean;
      review_topologies: string[];
      defaults: { max_root_agents: number };
      deployment_ceilings: { max_root_agents: number };
    };
    expect(off.policy_version).toBe(RUNTIME_POLICY_VERSION);
    expect(off.live_enabled).toBe(false);
    expect(off.review_topologies).toEqual(["all_peers"]);
    expect(off.defaults.max_root_agents).toBeLessThanOrEqual(off.deployment_ceilings.max_root_agents);
    await ctx.cleanup();
    ctx = await makeServer({ config: { liveEnabled: true } });
    const on = (await ctx.app.inject({ method: "GET", url: "/api/v1/runtime-policy", headers: ctx.headers() })).json() as { live_enabled: boolean };
    expect(on.live_enabled).toBe(true);
  });
});

describe("POST /conversations/:id/runs", () => {
  it.each([undefined, "", "not-a-uuid", "12345678-1234-1234-1234-12345678901"])("rejects Idempotency-Key %j with 400", async (key) => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const headers = ctx.headers();
    if (key !== undefined) headers["idempotency-key"] = key;
    const r = await ctx.app.inject({ method: "POST", url: `/api/v1/conversations/${id}/runs`, headers, payload: quickRunBody("x") });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: { code: string } }).error.code).toBe("invalid_request");
  });

  it("rejects an invalid body with 422 validation_failed carrying the first schema message", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const r = await postRun(ctx, id, { prompt: "x", mode: "quick", agents: [] });
    expect(r.statusCode).toBe(422);
    expect((r.json() as { error: { code: string } }).error.code).toBe("validation_failed");
    const noBody = await ctx.app.inject({ method: "POST", url: `/api/v1/conversations/${id}/runs`, headers: ctx.bodyless({ "idempotency-key": crypto.randomUUID() }) });
    expect(noBody.statusCode).toBe(422);
  });

  it("maps CoordinatorError to its HTTP status/code (404 unknown conversation, 422 unknown profile)", async () => {
    ctx = await makeServer();
    const unknownConv = await postRun(ctx, crypto.randomUUID(), quickRunBody("x"));
    expect(unknownConv.statusCode).toBe(404);
    expect((unknownConv.json() as { error: { code: string } }).error.code).toBe("not_found");
    const id = await createConversation(ctx);
    const unknownProfile = await postRun(ctx, id, quickRunBody("x", {}, "no-such-profile"));
    expect(unknownProfile.statusCode).toBe(422);
    expect((unknownProfile.json() as { error: { code: string } }).error.code).toBe("profile_not_configured");
  });

  it.each([
    [{ max_output_tokens_per_call: 9000 }, "max_output_tokens_per_call"],
    [{ overall_timeout_seconds: 1200 }, "overall_timeout_seconds"],
  ])("a limit above the deployment ceiling is a 422, not a 500: %j", async (limits, field) => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const r = await postRun(ctx, id, quickRunBody("x", { limits }));
    expect(r.statusCode).toBe(422);
    const err = (r.json() as { error: { code: string; message: string } }).error;
    expect(err.code).toBe("validation_failed");
    expect(err.message).toContain(field);
  });

  it("creates (201 + Location), replays the same key (200, same run, nothing started twice) and detects payload conflicts (409)", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const body = quickRunBody("Idempotent question");
    const key = crypto.randomUUID();
    const first = await postRun(ctx, id, body, key);
    expect(first.statusCode).toBe(201);
    const snap = first.json() as RunSnapshot;
    expect(first.headers.location).toBe(`/api/v1/runs/${snap.id}`);
    expect(snap.status).toBe("queued");

    const replay = await postRun(ctx, id, body, key);
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as RunSnapshot).id).toBe(snap.id);
    expect(replay.headers.location).toBe(`/api/v1/runs/${snap.id}`);

    const conflict = await postRun(ctx, id, quickRunBody("Different question"), key);
    expect(conflict.statusCode).toBe(409);
    expect((conflict.json() as { error: { code: string } }).error.code).toBe("idempotency_conflict");

    const done = await waitTerminal(ctx, snap.id);
    expect(done.status).toBe("completed");
    // Replaying after completion still returns the stored run (never re-executes).
    const late = await postRun(ctx, id, body, key);
    expect(late.statusCode).toBe(200);
    expect(ctx.bundle.messages.list(id)).toHaveLength(2);
  });

  it("allows one active run per instance: a second run gets 409 run_in_progress, then succeeds after cancel", async () => {
    ctx = await makeServer({ profilesJson: SLOW_PROFILES });
    const a = await createConversation(ctx);
    const b = await createConversation(ctx);
    const first = await postRun(ctx, a, quickRunBody("one", {}, "mock-glacial"));
    const runId = (first.json() as RunSnapshot).id;
    const second = await postRun(ctx, b, quickRunBody("two"));
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: { code: string } }).error.code).toBe("run_in_progress");
    await ctx.app.inject({ method: "PUT", url: `/api/v1/runs/${runId}/cancellation`, headers: ctx.bodyless() });
    const third = await postRun(ctx, b, quickRunBody("two"));
    expect(third.statusCode).toBe(201);
    await waitTerminal(ctx, (third.json() as RunSnapshot).id);
  });
});

describe("run reads and cancellation", () => {
  it("returns 404 for unknown runs on GET, cancel, and events", async () => {
    ctx = await makeServer();
    const missing = crypto.randomUUID();
    for (const [method, url] of [
      ["GET", `/api/v1/runs/${missing}`],
      ["PUT", `/api/v1/runs/${missing}/cancellation`],
      ["GET", `/api/v1/runs/${missing}/events`],
    ] as const) {
      const r = await ctx.app.inject({ method, url, headers: ctx.bodyless() });
      expect(r.statusCode, `${method} ${url}`).toBe(404);
      expect((r.json() as { error: { code: string } }).error.code).toBe("not_found");
    }
  });

  it("lists runs for a conversation with the active run id, and 404s an unknown conversation", async () => {
    ctx = await makeServer({ profilesJson: SLOW_PROFILES });
    expect((await ctx.app.inject({ method: "GET", url: "/api/v1/conversations/nope/runs", headers: ctx.headers() })).statusCode).toBe(404);
    const id = await createConversation(ctx);
    expect((await ctx.app.inject({ method: "GET", url: `/api/v1/conversations/${id}/runs`, headers: ctx.headers() })).json()).toEqual({ items: [], active_run_id: null });
    const created = await postRun(ctx, id, quickRunBody("x", {}, "mock-glacial"));
    const runId = (created.json() as RunSnapshot).id;
    const active = (await ctx.app.inject({ method: "GET", url: `/api/v1/conversations/${id}/runs`, headers: ctx.headers() })).json() as { items: { id: string }[]; active_run_id: string | null };
    expect(active.active_run_id).toBe(runId);
    await ctx.app.inject({ method: "PUT", url: `/api/v1/runs/${runId}/cancellation`, headers: ctx.bodyless() });
    const after = (await ctx.app.inject({ method: "GET", url: `/api/v1/conversations/${id}/runs`, headers: ctx.headers() })).json() as { active_run_id: string | null };
    expect(after.active_run_id).toBeNull();
  });

  it("cancelling a terminal run is a no-op that returns the committed snapshot", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const runId = ((await postRun(ctx, id, quickRunBody("x"))).json() as RunSnapshot).id;
    const done = await waitTerminal(ctx, runId);
    const cancel = await ctx.app.inject({ method: "PUT", url: `/api/v1/runs/${runId}/cancellation`, headers: ctx.bodyless() });
    expect(cancel.statusCode).toBe(200);
    expect((cancel.json() as RunSnapshot).status).toBe(done.status);
    const get = await ctx.app.inject({ method: "GET", url: `/api/v1/runs/${runId}`, headers: ctx.headers() });
    expect((get.json() as RunSnapshot).final_answer).toEqual(done.final_answer);
  });
});

describe("GET /runs/:id/events (replay)", () => {
  async function finishedRun(c: ServerCtx): Promise<{ runId: string; last: number }> {
    const id = await createConversation(c);
    const runId = ((await postRun(c, id, quickRunBody("events"))).json() as RunSnapshot).id;
    const done = await waitTerminal(c, runId);
    return { runId, last: done.last_event_sequence };
  }

  const frames = (payload: string) =>
    payload
      .split("\n\n")
      .filter((f) => f.startsWith("id:"))
      .map((f) => ({
        id: Number(/^id: (\d+)/.exec(f)![1]),
        type: /event: (.+)/.exec(f)![1]!,
        data: JSON.parse(/data: (.+)/.exec(f)![1]!) as { sequence: number; type: string },
      }));

  it("replays every persisted event in order for a finished run and ends the stream", async () => {
    ctx = await makeServer();
    const { runId, last } = await finishedRun(ctx);
    const r = await ctx.app.inject({ method: "GET", url: `/api/v1/runs/${runId}/events`, headers: ctx.headers() });
    expect(r.statusCode).toBe(200);
    expect(String(r.headers["content-type"])).toContain("text/event-stream");
    expect(r.headers["x-accel-buffering"]).toBe("no");
    const f = frames(r.payload);
    expect(f.map((x) => x.id)).toEqual(Array.from({ length: last }, (_, i) => i + 1));
    expect(f[0]!.type).toBe("run.created");
    expect(f.at(-1)!.type).toBe("run.terminal");
    expect(f.every((x) => x.data.sequence === x.id && x.data.type === x.type)).toBe(true);
  });

  it("resumes strictly after Last-Event-ID", async () => {
    ctx = await makeServer();
    const { runId, last } = await finishedRun(ctx);
    const r = await ctx.app.inject({ method: "GET", url: `/api/v1/runs/${runId}/events`, headers: ctx.headers({ "last-event-id": String(last - 1) }) });
    expect(frames(r.payload).map((x) => x.id)).toEqual([last]);
  });

  it("returns 204 when the run is terminal and the client is already caught up", async () => {
    ctx = await makeServer();
    const { runId, last } = await finishedRun(ctx);
    const r = await ctx.app.inject({ method: "GET", url: `/api/v1/runs/${runId}/events`, headers: ctx.headers({ "last-event-id": String(last) }) });
    expect(r.statusCode).toBe(204);
    expect(r.payload).toBe("");
  });

  it.each(["abc", "-1", "1.5", "01", " 2", ""])("rejects Last-Event-ID %j with 400 invalid_event_id", async (value) => {
    ctx = await makeServer();
    const { runId } = await finishedRun(ctx);
    const r = await ctx.app.inject({ method: "GET", url: `/api/v1/runs/${runId}/events`, headers: ctx.headers({ "last-event-id": value }) });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: { code: string } }).error.code).toBe("invalid_event_id");
  });

  it("rejects a Last-Event-ID from the future with 400", async () => {
    ctx = await makeServer();
    const { runId, last } = await finishedRun(ctx);
    const r = await ctx.app.inject({ method: "GET", url: `/api/v1/runs/${runId}/events`, headers: ctx.headers({ "last-event-id": String(last + 5) }) });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: { message: string } }).error.message).toContain("past the latest server sequence");
  });
});

// ---- live tail over a real loopback socket (port 0) ------------------------

interface LiveStream {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: () => string;
  ended: Promise<void>;
  destroy: () => void;
  req: http.ClientRequest;
}

async function openStream(c: ServerCtx, listenPort: number, runId: string, extra: Record<string, string> = {}): Promise<LiveStream> {
  return new Promise((resolve, reject) => {
    let body = "";
    let endResolve!: () => void;
    const ended = new Promise<void>((r) => (endResolve = r));
    const req = http.get(
      {
        host: "127.0.0.1",
        port: listenPort,
        path: `/api/v1/runs/${runId}/events`,
        headers: { host: c.hostHeader, cookie: c.cookie, ...extra },
      },
      (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => endResolve());
        res.on("close", () => endResolve());
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text: () => body, ended, destroy: () => req.destroy(), req });
      },
    );
    req.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ECONNRESET") return;
      reject(err);
    });
  });
}

describe("GET /runs/:id/events (live tail over a real loopback socket)", () => {
  it("streams events live and closes the stream after run.terminal, unsubscribing from the bus", async () => {
    // A 500 ms fixture so the stream attaches mid-run.
    const slowOk = {
      mode: "append",
      profiles: [{ ...SLOW_PROFILES.profiles[0]!, profile_id: "mock-half-second", fixture: { extra_latency_ms: 500 } }],
    };
    ctx = await makeServer({ profilesJson: slowOk });
    const convId = await createConversation(ctx);
    const runId = ((await postRun(ctx, convId, quickRunBody("tail", {}, "mock-half-second"))).json() as RunSnapshot).id;
    await ctx.app.listen({ host: "127.0.0.1", port: 0 });
    const port = (ctx.app.server.address() as AddressInfo).port;

    const stream = await openStream(ctx, port, runId);
    expect(stream.status).toBe(200);
    expect(String(stream.headers["content-type"])).toContain("text/event-stream");
    await waitFor(() => ctx!.bundle.coordinator.bus.listenerCount(`run:${runId}`) === 1);
    await stream.ended;
    const ids = [...stream.text().matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    const final = ctx.bundle.runs.get(runId)!;
    expect(final.status).toBe("completed");
    expect(ids).toEqual(Array.from({ length: final.last_event_sequence }, (_, i) => i + 1));
    expect(stream.text()).toContain("event: run.terminal");
    expect(ctx.bundle.coordinator.bus.listenerCount(`run:${runId}`)).toBe(0);
  });

  it("removes its bus listener when the client disconnects mid-run", async () => {
    ctx = await makeServer({ profilesJson: SLOW_PROFILES });
    const convId = await createConversation(ctx);
    const runId = ((await postRun(ctx, convId, quickRunBody("tail", {}, "mock-glacial"))).json() as RunSnapshot).id;
    await ctx.app.listen({ host: "127.0.0.1", port: 0 });
    const port = (ctx.app.server.address() as AddressInfo).port;

    const stream = await openStream(ctx, port, runId);
    await waitFor(() => ctx!.bundle.coordinator.bus.listenerCount(`run:${runId}`) === 1);
    await waitFor(() => stream.text().includes("event: run.created"));
    stream.destroy();
    await waitFor(() => ctx!.bundle.coordinator.bus.listenerCount(`run:${runId}`) === 0);

    // The run itself is unaffected by the disconnect; cancel to finish.
    expect(ctx.bundle.runs.get(runId)!.finished_at).toBeNull();
    await ctx.app.inject({ method: "PUT", url: `/api/v1/runs/${runId}/cancellation`, headers: ctx.bodyless() });
    expect(ctx.bundle.runs.get(runId)!.status).toBe("canceled");
  });

  it("a reconnect with Last-Event-ID receives only events after it, live", async () => {
    ctx = await makeServer({ profilesJson: SLOW_PROFILES });
    const convId = await createConversation(ctx);
    const runId = ((await postRun(ctx, convId, quickRunBody("tail", {}, "mock-glacial"))).json() as RunSnapshot).id;
    await ctx.app.listen({ host: "127.0.0.1", port: 0 });
    const port = (ctx.app.server.address() as AddressInfo).port;
    const current = ctx.bundle.runs.get(runId)!.last_event_sequence;
    const stream = await openStream(ctx, port, runId, { "last-event-id": String(current) });
    await waitFor(() => ctx!.bundle.coordinator.bus.listenerCount(`run:${runId}`) === 1);
    await ctx.app.inject({ method: "PUT", url: `/api/v1/runs/${runId}/cancellation`, headers: ctx.bodyless() });
    await stream.ended;
    const ids = [...stream.text().matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids.length).toBeGreaterThan(0);
    expect(Math.min(...ids)).toBeGreaterThan(current);
    expect(stream.text()).toContain("event: run.terminal");
  });
});

describe("team runs through the HTTP surface", () => {
  it("a Team run with one failing reviewer completes as partial and exposes the run via GET", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const body = teamRunBody("Compare options", ["mock-balanced", "mock-fail-review"]);
    const r = await postRun(ctx, id, body);
    expect(r.statusCode).toBe(201);
    const runId = (r.json() as RunSnapshot).id;
    const done = await waitTerminal(ctx, runId);
    expect(done.status).toBe("partial");
    const get = (await ctx.app.inject({ method: "GET", url: `/api/v1/runs/${runId}`, headers: ctx.headers() })).json() as RunSnapshot;
    expect(get.steps.filter((s) => s.stage === "review").some((s) => s.status === "failed")).toBe(true);
  });
});

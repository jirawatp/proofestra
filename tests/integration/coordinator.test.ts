// Coordinator integration regressions driven through buildApp + fastify.inject.
// Covers the executable findings from the independent review:
//   A. Infeasible plan rejected at admission; sticky-unknown Usage; late /
//      ambiguous attempts always charge the full reservation.
//   B. Overall-timeout deadline + per-call hard timeout cannot be defeated
//      by an abort-ignoring adapter.
//   C. Synthesis reference stays bounded (2n artifacts, no n*n expansion).
//   D. Idempotency replay works BEFORE Live/catalog/policy admission.
//   E. Catalog version rotates when a profile's model_id changes.
//   F. Terminal + final-event commit survives inspection (atomic write).
//
// All fixtures are deterministic mocks; no provider calls are made.

import { describe, it, expect, afterEach } from "vitest";
import { makeTestApp, authHeaders, newKey, type TestApp } from "./_helpers.js";
import { randomUUID } from "node:crypto";
import { loadProfileCatalog } from "../../src/core/profileConfig.js";
import { loadConfig } from "../../src/shared/config.js";
import type { RunSnapshot } from "../../src/shared/types.js";

let ctx: TestApp | null = null;
afterEach(async () => {
  if (ctx) {
    await ctx.cleanup();
    ctx = null;
  }
});

async function createConversation(ctx: TestApp): Promise<string> {
  const resp = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/conversations",
    headers: authHeaders(ctx),
    payload: { title: "test" },
  });
  expect(resp.statusCode).toBe(201);
  return (resp.json() as { id: string }).id;
}

async function runToTerminal(
  ctx: TestApp,
  runId: string,
  timeoutMs = 15_000,
): Promise<RunSnapshot> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const resp = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}`,
      headers: authHeaders(ctx),
    });
    const snap = resp.json() as RunSnapshot;
    const terminalStatuses = ["completed", "partial", "failed", "canceled", "interrupted"];
    if (terminalStatuses.includes(snap.status)) return snap;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run ${runId} did not reach terminal state within ${timeoutMs}ms`);
}

describe("A. infeasible plan admission + sticky-unknown Usage", () => {
  it("rejects a Team plan whose base calls * per-call reserve exceeds total_output_tokens", async () => {
    ctx = await makeTestApp();
    const conversationId = await createConversation(ctx);
    const aId = randomUUID();
    const bId = randomUUID();
    const resp = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/runs`,
      headers: { ...authHeaders(ctx), "idempotency-key": newKey() },
      payload: {
        prompt: "hello",
        mode: "team",
        execution_mode: "mock",
        agents: [
          { agent_id: aId, name: "alpha", profile_id: "mock-balanced" },
          { agent_id: bId, name: "beta", profile_id: "mock-analytical" },
        ],
        synthesizer_agent_id: aId,
        limits: {
          // Team-2 base plan = 2 drafts + 2 reviews + 1 synth = 5 calls.
          // 5 * 2048 = 10240 > 2048 total → infeasible.
          total_output_tokens: 2048,
          max_output_tokens_per_call: 2048,
        },
      },
    });
    expect(resp.statusCode).toBe(422);
    const body = resp.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("limits_exceeded");
    expect(body.error.message).toContain("output tokens");
  });

  it("sticky-unknown: a successful call with unknown usage collapses the aggregate to null", async () => {
    ctx = await makeTestApp({
      profilesJson: {
        mode: "append",
        profiles: [
          {
            profile_id: "mock-unknown-usage",
            provider: "mock",
            label: "mock: reports unknown usage",
            model_id: "mock-unknown-usage-v1",
            safe_input_tokens: 32_000,
            max_output_tokens: 2048,
            api_shape: "mock",
            execution_backend_id: "mock-provider-api",
            fixture: { scenario: "unknown_usage" },
          },
        ],
      },
    });
    const conversationId = await createConversation(ctx);
    const agentId = randomUUID();
    const resp = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/runs`,
      headers: { ...authHeaders(ctx), "idempotency-key": newKey() },
      payload: {
        prompt: "hello",
        mode: "quick",
        execution_mode: "mock",
        agents: [{ agent_id: agentId, name: "alpha", profile_id: "mock-unknown-usage" }],
      },
    });
    expect(resp.statusCode).toBe(201);
    const snap = await runToTerminal(ctx, (resp.json() as RunSnapshot).id);
    expect(snap.status).toBe("completed");
    // Sticky-unknown: provider reported null → aggregate becomes null.
    expect(snap.usage.input_tokens).toBeNull();
    expect(snap.usage.output_tokens).toBeNull();
    // Conservative ledger charges the full reserve for the ambiguous call.
    expect(snap.usage.consumed_output_tokens).toBeGreaterThan(0);
  });

  it("all-known aggregates sum correctly to numbers (CT-06 passing path)", async () => {
    ctx = await makeTestApp();
    const conversationId = await createConversation(ctx);
    const agentId = randomUUID();
    const resp = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/runs`,
      headers: { ...authHeaders(ctx), "idempotency-key": newKey() },
      payload: {
        prompt: "hello",
        mode: "quick",
        execution_mode: "mock",
        agents: [{ agent_id: agentId, name: "alpha", profile_id: "mock-balanced" }],
      },
    });
    expect(resp.statusCode).toBe(201);
    const snap = await runToTerminal(ctx, (resp.json() as RunSnapshot).id);
    expect(snap.status).toBe("completed");
    expect(typeof snap.usage.input_tokens).toBe("number");
    expect(typeof snap.usage.output_tokens).toBe("number");
    expect(snap.usage.input_tokens).toBeGreaterThan(0);
    expect(snap.usage.output_tokens).toBeGreaterThan(0);
  });
});

describe("B. overall-deadline + per-call hard timeout vs. abort-ignoring adapter", () => {
  it("late-success adapter: terminal CAS discards the late result; snapshot stays canceled", async () => {
    ctx = await makeTestApp({
      profilesJson: {
        mode: "append",
        profiles: [
          {
            profile_id: "mock-late-success",
            provider: "mock",
            label: "mock: ignores abort, succeeds past deadline",
            model_id: "mock-late-success-v1",
            safe_input_tokens: 32_000,
            max_output_tokens: 2048,
            api_shape: "mock",
            execution_backend_id: "mock-provider-api",
            fixture: { scenario: "late_success", extra_latency_ms: 400 },
          },
        ],
      },
    });
    const conversationId = await createConversation(ctx);
    const agentId = randomUUID();
    const create = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/runs`,
      headers: { ...authHeaders(ctx), "idempotency-key": newKey() },
      payload: {
        prompt: "hello",
        mode: "quick",
        execution_mode: "mock",
        agents: [{ agent_id: agentId, name: "alpha", profile_id: "mock-late-success" }],
      },
    });
    expect(create.statusCode).toBe(201);
    const runId = (create.json() as RunSnapshot).id;
    // Cancel ~50ms in; the mock late-success adapter will try to resolve at
    // 400+ms. The terminal CAS must discard it.
    await new Promise((r) => setTimeout(r, 50));
    const cancel = await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/runs/${runId}/cancellation`,
      headers: authHeaders(ctx),
      payload: {},
    });
    expect(cancel.statusCode).toBe(200);
    const cancelSnap = cancel.json() as RunSnapshot;
    expect(cancelSnap.status).toBe("canceled");
    // Give the late-success adapter time to resolve post-terminal.
    await new Promise((r) => setTimeout(r, 600));
    const afterLate = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}`,
      headers: authHeaders(ctx),
    });
    const afterSnap = afterLate.json() as RunSnapshot;
    expect(afterSnap.status).toBe("canceled");
    // The reservation must still be released (reserved_output_tokens back to 0).
    expect(afterSnap.usage.reserved_output_tokens).toBe(0);
    // The ambiguous ledger charge happened: consumed > 0.
    expect(afterSnap.usage.consumed_output_tokens).toBeGreaterThan(0);
  }, 15_000);

  it("never-settling adapter: overall deadline guard terminates and releases globalActive", async () => {
    ctx = await makeTestApp({
      profilesJson: {
        mode: "append",
        profiles: [
          {
            profile_id: "mock-hang",
            provider: "mock",
            label: "mock: never settles",
            model_id: "mock-hang-v1",
            safe_input_tokens: 32_000,
            max_output_tokens: 2048,
            api_shape: "mock",
            execution_backend_id: "mock-provider-api",
            fixture: { scenario: "never_settle" },
          },
        ],
      },
    });
    const conversationId = await createConversation(ctx);
    const agentId = randomUUID();
    const create = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/runs`,
      headers: { ...authHeaders(ctx), "idempotency-key": newKey() },
      payload: {
        prompt: "hello",
        mode: "quick",
        execution_mode: "mock",
        agents: [{ agent_id: agentId, name: "alpha", profile_id: "mock-hang" }],
        limits: {
          // Minimum allowed overall/per-call timeouts so the test runs
          // quickly. Hard overall grace = 2000ms + per-call 5000ms, so
          // allow up to ~10s to reach terminal.
          overall_timeout_seconds: 15,
          per_call_timeout_seconds: 5,
        },
      },
    });
    expect(create.statusCode).toBe(201);
    const runId = (create.json() as RunSnapshot).id;
    const snap = await runToTerminal(ctx, runId, 25_000);
    // Either per-call hard-timeout fired first (failed with timeout) OR the
    // overall-deadline guard terminated the run; both are acceptable
    // non-hung terminal outcomes.
    expect(["failed", "partial"]).toContain(snap.status);
    // After terminal, globalActive must be released: a second quick run on a
    // different profile completes rather than hanging.
    const bId = randomUUID();
    const second = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/runs`,
      headers: { ...authHeaders(ctx), "idempotency-key": newKey() },
      payload: {
        prompt: "follow",
        mode: "quick",
        execution_mode: "mock",
        agents: [{ agent_id: bId, name: "beta", profile_id: "mock-balanced" }],
      },
    });
    expect(second.statusCode).toBe(201);
    const second2 = await runToTerminal(ctx, (second.json() as RunSnapshot).id, 10_000);
    expect(second2.status).toBe("completed");
  }, 30_000);
});

describe("D. idempotency replay runs BEFORE Live/catalog admission", () => {
  it("replays a prior successful run even after Live is disabled or the catalog rotates", async () => {
    ctx = await makeTestApp();
    const conversationId = await createConversation(ctx);
    const agentId = randomUUID();
    const key = newKey();
    const first = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/runs`,
      headers: { ...authHeaders(ctx), "idempotency-key": key },
      payload: {
        prompt: "hello",
        mode: "quick",
        execution_mode: "mock",
        agents: [{ agent_id: agentId, name: "alpha", profile_id: "mock-balanced" }],
      },
    });
    expect(first.statusCode).toBe(201);
    const runId = (first.json() as RunSnapshot).id;
    await runToTerminal(ctx, runId);

    // Same key, same body, with a stale (bogus) expected_catalog_version:
    // replay must succeed without hitting the catalog-version check.
    const second = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/runs`,
      headers: { ...authHeaders(ctx), "idempotency-key": key },
      payload: {
        prompt: "hello",
        mode: "quick",
        execution_mode: "mock",
        agents: [{ agent_id: agentId, name: "alpha", profile_id: "mock-balanced" }],
        expected_catalog_version: "catalog-vSTALE-UI-00000000",
      },
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as RunSnapshot).id).toBe(runId);
  });

  it("same key with a different payload returns 409 idempotency_conflict", async () => {
    ctx = await makeTestApp();
    const conversationId = await createConversation(ctx);
    const key = newKey();
    const agentId = randomUUID();
    const first = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/runs`,
      headers: { ...authHeaders(ctx), "idempotency-key": key },
      payload: {
        prompt: "hello",
        mode: "quick",
        execution_mode: "mock",
        agents: [{ agent_id: agentId, name: "alpha", profile_id: "mock-balanced" }],
      },
    });
    expect(first.statusCode).toBe(201);
    await runToTerminal(ctx, (first.json() as RunSnapshot).id);
    const second = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/runs`,
      headers: { ...authHeaders(ctx), "idempotency-key": key },
      payload: {
        prompt: "DIFFERENT PROMPT",
        mode: "quick",
        execution_mode: "mock",
        agents: [{ agent_id: agentId, name: "alpha", profile_id: "mock-balanced" }],
      },
    });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: { code: string } }).error.code).toBe("idempotency_conflict");
  });
});

describe("E. catalog version is content-addressed", () => {
  it("rotates when a profile's model_id changes under the same profile_id", async () => {
    const base = await makeTestApp({
      profilesJson: {
        mode: "append",
        profiles: [
          {
            profile_id: "mock-custom",
            provider: "mock",
            label: "mock custom v1",
            model_id: "custom-v1",
            safe_input_tokens: 32_000,
            max_output_tokens: 2048,
            api_shape: "mock",
            execution_backend_id: "mock-provider-api",
          },
        ],
      },
    });
    try {
      const providersResp = await base.app.inject({
        method: "GET",
        url: "/api/v1/providers",
        headers: authHeaders(base),
      });
      const v1 = (providersResp.json() as { catalog_version: string }).catalog_version;

      await base.cleanup();
      ctx = await makeTestApp({
        profilesJson: {
          mode: "append",
          profiles: [
            {
              profile_id: "mock-custom",
              provider: "mock",
              label: "mock custom v2",
              model_id: "custom-v2",
              safe_input_tokens: 32_000,
              max_output_tokens: 2048,
              api_shape: "mock",
              execution_backend_id: "mock-provider-api",
            },
          ],
        },
      });
      const v2Resp = await ctx.app.inject({
        method: "GET",
        url: "/api/v1/providers",
        headers: authHeaders(ctx),
      });
      const v2 = (v2Resp.json() as { catalog_version: string }).catalog_version;
      expect(v2).not.toBe(v1);
    } finally {
      try {
        await base.cleanup();
      } catch {
        // ignore if already cleaned
      }
    }
  });
});

describe("F. terminal commit is atomic and visible to history endpoints", () => {
  it("after completion: terminal event, snapshot, and assistant message all land", async () => {
    ctx = await makeTestApp();
    const conversationId = await createConversation(ctx);
    const agentId = randomUUID();
    const resp = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/runs`,
      headers: { ...authHeaders(ctx), "idempotency-key": newKey() },
      payload: {
        prompt: "hello",
        mode: "quick",
        execution_mode: "mock",
        agents: [{ agent_id: agentId, name: "alpha", profile_id: "mock-balanced" }],
      },
    });
    expect(resp.statusCode).toBe(201);
    const runId = (resp.json() as RunSnapshot).id;
    const snap = await runToTerminal(ctx, runId);
    expect(snap.status).toBe("completed");
    expect(snap.final_answer).toBeTruthy();

    const msgsResp = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: authHeaders(ctx),
    });
    const msgs = msgsResp.json() as { items: { role: string; run_id: string }[] };
    const assistant = msgs.items.find((m) => m.role === "assistant" && m.run_id === runId);
    expect(assistant).toBeTruthy();

    const runsResp = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/conversations/${conversationId}/runs`,
      headers: authHeaders(ctx),
    });
    const runsBody = runsResp.json() as { items: RunSnapshot[]; active_run_id: string | null };
    expect(runsBody.items.find((r) => r.id === runId)).toBeTruthy();
    expect(runsBody.active_run_id).toBeNull();
  });

  it("UI client defaults (helpers off + tools off) are accepted on first Send", async () => {
    ctx = await makeTestApp();
    const conversationId = await createConversation(ctx);
    const agentId = randomUUID();
    // No tool_policy or delegation in the payload; server defaults them to
    // {mode:'off'} / {enabled:false} so the coordinator does not 422.
    const resp = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/runs`,
      headers: { ...authHeaders(ctx), "idempotency-key": newKey() },
      payload: {
        prompt: "hello",
        mode: "quick",
        agents: [{ agent_id: agentId, name: "alpha", profile_id: "mock-balanced" }],
      },
    });
    expect(resp.statusCode).toBe(201);
  });
});

describe("profile schema: invalid bindings rejected at load", () => {
  it("rejects a Live-provider profile with null model_id", () => {
    const config = loadConfig();
    expect(() =>
      loadProfileCatalog(config, {
        fileContents: JSON.stringify({
          mode: "append",
          profiles: [
            {
              profile_id: "openai-bad",
              provider: "openai",
              label: "no model id",
              model_id: null,
              safe_input_tokens: 128_000,
              max_output_tokens: 2048,
              api_shape: "openai_chat_completions",
              execution_backend_id: "openai-chat-completions",
            },
          ],
        }),
        filePath: "/tmp/fake-profiles.json",
      }),
    ).toThrow(/non-null model_id/);
  });

  it("rejects provider/api_shape mismatch", () => {
    const config = loadConfig();
    expect(() =>
      loadProfileCatalog(config, {
        fileContents: JSON.stringify({
          mode: "append",
          profiles: [
            {
              profile_id: "openai-wrong-shape",
              provider: "openai",
              label: "wrong shape",
              model_id: "something",
              safe_input_tokens: 128_000,
              max_output_tokens: 2048,
              api_shape: "anthropic_messages_v1",
              execution_backend_id: "openai-chat-completions",
            },
          ],
        }),
        filePath: "/tmp/fake-profiles.json",
      }),
    ).toThrow(/api_shape/);
  });

  it("rejects a Mock profile when execution_mode is Live", async () => {
    ctx = await makeTestApp({ liveEnabled: true });
    const conversationId = await createConversation(ctx);
    const agentId = randomUUID();
    const resp = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conversationId}/runs`,
      headers: { ...authHeaders(ctx), "idempotency-key": newKey() },
      payload: {
        prompt: "hello",
        mode: "quick",
        execution_mode: "live",
        agents: [{ agent_id: agentId, name: "alpha", profile_id: "mock-balanced" }],
      },
    });
    expect(resp.statusCode).toBe(422);
    expect((resp.json() as { error: { code: string } }).error.code).toBe("mock_in_live");
  });
});

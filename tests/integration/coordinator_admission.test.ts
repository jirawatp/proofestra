// Run admission (Coordinator.createRun): every refusal path, the idempotency
// contract, and what a successful admission freezes. Driven directly against
// the coordinator of a real (temp) app so each error carries its exact HTTP
// status and stable code.

import { afterEach, describe, expect, it } from "vitest";
import { CoordinatorError, type CreateRunInput } from "../../src/core/coordinator.js";
import { catalogVersion } from "../../src/core/registry.js";
import { RUNTIME_POLICY_VERSION } from "../../src/shared/config.js";
import { createConversation, makeServer, seedAttachment, waitTerminal, type ServerCtx } from "./_server_helpers.js";

let ctx: ServerCtx | null = null;
afterEach(async () => {
  await ctx?.cleanup();
  ctx = null;
});

const uuid = () => crypto.randomUUID();

function quick(conversationId: string, over: Partial<CreateRunInput> = {}): CreateRunInput {
  return {
    conversationId,
    prompt: "hello",
    mode: "quick",
    executionMode: "mock",
    agents: [{ agent_id: uuid(), name: "A", profile_id: "mock-balanced" }],
    synthesizerAgentId: null,
    idempotencyKey: uuid(),
    ...over,
  };
}

function team(conversationId: string, profiles: string[] = ["mock-balanced", "mock-analytical"], over: Partial<CreateRunInput> = {}): CreateRunInput {
  const agents = profiles.map((profile_id, i) => ({ agent_id: uuid(), name: `T${i}`, profile_id }));
  return { ...quick(conversationId), mode: "team", agents, synthesizerAgentId: agents[0]!.agent_id, ...over };
}

function expectRefusal(c: ServerCtx, input: CreateRunInput, status: number, code: string, messagePart?: string): CoordinatorError {
  let caught: unknown;
  try {
    c.bundle.coordinator.createRun(input);
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected ${code}`).toBeInstanceOf(CoordinatorError);
  const e = caught as CoordinatorError;
  expect({ status: e.httpStatus, code: e.code }).toEqual({ status, code });
  if (messagePart) expect(e.message).toContain(messagePart);
  return e;
}

const SMALL_PROFILE = {
  mode: "append",
  profiles: [
    {
      profile_id: "mock-small",
      provider: "mock",
      label: "small",
      model_id: "small-v1",
      safe_input_tokens: 1_000,
      max_output_tokens: 256,
      api_shape: "mock",
      execution_backend_id: "mock-provider-api",
    },
  ],
};

describe("attachment id validation", () => {
  it("rejects more than eight ids and duplicate ids before touching the database", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    expectRefusal(ctx, quick(id, { attachmentIds: Array.from({ length: 9 }, uuid) }), 400, "validation_failed", "max 8");
    const dup = uuid();
    expectRefusal(ctx, quick(id, { attachmentIds: [dup, dup] }), 400, "validation_failed", "duplicate attachment id");
  });

  it("404s an unknown attachment and one that belongs to a DIFFERENT conversation (IDOR)", async () => {
    ctx = await makeServer();
    const mine = await createConversation(ctx);
    const theirs = await createConversation(ctx);
    const foreign = seedAttachment(ctx, theirs, { kind: "text", mime: "text/plain" });
    expectRefusal(ctx, quick(mine, { attachmentIds: [uuid()] }), 404, "not_found");
    const e = expectRefusal(ctx, quick(mine, { attachmentIds: [foreign.id] }), 404, "not_found");
    expect(e.message).not.toContain(theirs);
    // Nothing was bound as a side effect.
    expect(ctx.bundle.attachments.get(foreign.id)!.state).toBe("ready");
  });

  it.each([
    ["uploading", 409, "attachment_pending"],
    ["failed", 409, "attachment_failed"],
    ["bound", 409, "attachment_bound"],
  ] as const)("a %s attachment cannot be sent (%i %s)", async (state, status, code) => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const a = seedAttachment(ctx, id, { kind: "text", mime: "text/plain", state });
    expectRefusal(ctx, quick(id, { attachmentIds: [a.id] }), status, code);
    expect(ctx.bundle.runs.countActive()).toBe(0);
  });

  it("binds ready attachments atomically to the user message, in order, on success", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const a = seedAttachment(ctx, id, { kind: "text", mime: "text/plain", name: "a.txt", extractedText: "alpha", extractionStatus: "text_extracted" });
    const b = seedAttachment(ctx, id, { kind: "text", mime: "text/plain", name: "b.txt", extractedText: "beta", extractionStatus: "text_extracted" });
    const result = ctx.bundle.coordinator.createRun(quick(id, { prompt: "", attachmentIds: [b.id, a.id] }));
    expect(result.replayed).toBe(false);
    expect(ctx.bundle.attachments.get(a.id)!.state).toBe("bound");
    expect(ctx.bundle.attachments.get(b.id)!.state).toBe("bound");
    const stored = ctx.bundle.messages.list(id)[0]!;
    expect(stored.attachments!.map((r) => r.sanitized_display_name)).toEqual(["b.txt", "a.txt"]);
    expect(result.snapshot.context.attachments!.map((r) => r.id)).toEqual([b.id, a.id]);
    // Mock execution routes every attachment honestly: nothing is native.
    const coverage = result.snapshot.context.attachment_coverage![0]!;
    expect(coverage.routes.every((r) => !r.route.startsWith("native_"))).toBe(true);
  });
});

describe("conversation, versions and execution mode", () => {
  it("404s an unknown conversation", async () => {
    ctx = await makeServer();
    expectRefusal(ctx, quick(uuid()), 404, "not_found", "conversation");
  });

  it("rejects a stale catalog version or runtime-policy version with 409 runtime_policy_changed, accepts current ones", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    expectRefusal(ctx, quick(id, { expectedCatalogVersion: "catalog-stale" }), 409, "runtime_policy_changed", "catalog");
    expectRefusal(ctx, quick(id, { expectedRuntimePolicyVersion: "policy-stale" }), 409, "runtime_policy_changed", "runtime policy");
    const ok = ctx.bundle.coordinator.createRun(
      quick(id, { expectedCatalogVersion: catalogVersion(ctx.config), expectedRuntimePolicyVersion: RUNTIME_POLICY_VERSION }),
    );
    expect(ok.snapshot.catalog_version).toBe(catalogVersion(ctx.config));
    expect(ok.snapshot.runtime_policy_version).toBe(RUNTIME_POLICY_VERSION);
  });

  it("refuses Live when the server has it disabled", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    expectRefusal(ctx, quick(id, { executionMode: "live" }), 422, "live_disabled");
  });

  it("refuses mock profiles in Live and live profiles without credentials (backend_not_ready)", async () => {
    ctx = await makeServer({ config: { liveEnabled: true, providerCredentials: { openaiKey: "sk-test-FAKE", anthropicKey: null, googleKey: null } } });
    const id = await createConversation(ctx);
    expectRefusal(ctx, quick(id, { executionMode: "live" }), 422, "mock_in_live", "mock-balanced");
    const noKey = { agents: [{ agent_id: uuid(), name: "C", profile_id: "anthropic-default" }] };
    const e = expectRefusal(ctx, quick(id, { executionMode: "live", ...noKey }), 422, "backend_not_ready", "missing_auth");
    expect(e.message).not.toContain("sk-test-FAKE");
    // A configured live profile is admitted (no call is made at admission).
    const ok = ctx.bundle.coordinator.createRun(quick(id, { executionMode: "live", agents: [{ agent_id: uuid(), name: "O", profile_id: "openai-default" }] }));
    expect(ok.snapshot.execution_mode).toBe("live");
    expect(ok.snapshot.usage.token_scope).toBe("harness_only");
    expect(ok.snapshot.usage.accounting).toBe("unknown");
  });

  it("422s a profile that is not configured", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    expectRefusal(ctx, quick(id, { agents: [{ agent_id: uuid(), name: "A", profile_id: "ghost" }] }), 422, "profile_not_configured", "ghost");
  });

  it("rejects duplicate agent ids and a synthesizer that is not one of the agents", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const dup = uuid();
    const e = expectRefusal(
      ctx,
      team(id, ["mock-balanced", "mock-analytical"], {
        agents: [
          { agent_id: dup, name: "A", profile_id: "mock-balanced" },
          { agent_id: dup, name: "B", profile_id: "mock-analytical" },
        ],
        synthesizerAgentId: dup,
      }),
      422,
      "validation_failed",
      "duplicate agent_id",
    );
    expect(e.details).toEqual([{ field: "agents", code: "duplicate_agent_id" }]);
    expectRefusal(ctx, team(id, ["mock-balanced", "mock-analytical"], { synthesizerAgentId: uuid() }), 422, "validation_failed", "synthesizer_agent_id");
    expect(ctx.bundle.runs.countActive()).toBe(0);
  });
});

describe("tools, delegation and limits", () => {
  it("is honest that tools and delegation are not implemented", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    expectRefusal(ctx, quick(id, { tool_policy: { mode: "auto" } }), 422, "tools_not_supported");
    expectRefusal(ctx, quick(id, { delegation: { enabled: true } }), 422, "helpers_not_supported");
    // Explicitly-off policies are fine and recorded.
    const ok = ctx.bundle.coordinator.createRun(quick(id, { tool_policy: { mode: "off" }, delegation: { enabled: false } }));
    expect(ok.snapshot.tool_policy.mode).toBe("off");
    expect(ok.snapshot.delegation.enabled).toBe(false);
  });

  it("refuses limits above the deployment ceiling as 422 validation_failed", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    expectRefusal(ctx, quick(id, { limits: { concurrency: 99 } }), 422, "validation_failed", "concurrency");
  });

  it("enforces agent-count, base-plan and output-budget limits", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    expectRefusal(ctx, team(id, Array(7).fill("mock-balanced")), 422, "limits_exceeded", "max_root_agents=6");
    expectRefusal(ctx, team(id, ["mock-balanced", "mock-analytical"], { limits: { max_total_agents: 1 } }), 422, "limits_exceeded", "max_total_agents=1");
    expectRefusal(ctx, team(id, ["mock-balanced", "mock-analytical"], { limits: { max_harness_invocations: 3 } }), 422, "limits_exceeded", "base_planned_calls=5 > max_harness_invocations=3");
    expectRefusal(ctx, quick(id, { limits: { total_output_tokens: 100, max_output_tokens_per_call: 2048 } }), 422, "limits_exceeded", "base plan needs 2048 output tokens");
  });

  it("refuses a requested per-call ceiling the profile cannot honour", async () => {
    ctx = await makeServer({ profilesJson: SMALL_PROFILE });
    const id = await createConversation(ctx);
    expectRefusal(ctx, quick(id, { agents: [{ agent_id: uuid(), name: "S", profile_id: "mock-small" }] }), 422, "limits_exceeded", "max_output_tokens=256 < requested max_output_tokens_per_call=2048");
    const ok = ctx.bundle.coordinator.createRun(
      quick(id, { agents: [{ agent_id: uuid(), name: "S", profile_id: "mock-small" }], limits: { max_output_tokens_per_call: 256 } }),
    );
    expect(ok.snapshot.limits.max_output_tokens_per_call).toBe(256);
  });

  it("quick mode defaults to a single invocation and no retries; team mode to the standard defaults", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const q = ctx.bundle.coordinator.createRun(quick(id));
    expect(q.snapshot.limits.max_harness_invocations).toBe(1);
    expect(q.snapshot.limits.max_retries_per_step).toBe(0);
    expect(q.snapshot.base_planned_calls).toBe(1);
    expect(q.snapshot.steps.map((s) => s.stage)).toEqual(["draft"]);
    await ctx.bundle.coordinator.startRun(q.snapshot.id);
    const t = ctx.bundle.coordinator.createRun(team(id, ["mock-balanced", "mock-analytical", "mock-concise"]));
    expect(t.snapshot.base_planned_calls).toBe(7);
    expect(t.snapshot.steps.map((s) => s.stage)).toEqual(["draft", "review", "draft", "review", "draft", "review", "synthesis"]);
  });
});

describe("context size", () => {
  it("refuses a prompt over 16 000 characters as a typed 422 (not an internal error)", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    expectRefusal(ctx, quick(id, { prompt: "x".repeat(16_001) }), 422, "context_too_large", "16000");
  });

  it("refuses when the frozen history alone is too large", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    for (let i = 0; i < 19; i += 1) {
      ctx.bundle.messages.insert({
        id: uuid(),
        conversation_id: id,
        run_id: uuid(),
        role: i % 2 === 0 ? "user" : "assistant",
        text: "y".repeat(10_000),
        sequence: ctx.bundle.messages.nextSequence(id),
        created_at: new Date().toISOString(),
      });
    }
    expectRefusal(ctx, quick(id), 422, "context_too_large", "history too large");
  });

  it("refuses when the worst-case stage artifacts cannot fit the profile (per-profile capacity)", async () => {
    ctx = await makeServer({ profilesJson: SMALL_PROFILE });
    const id = await createConversation(ctx);
    const e = expectRefusal(
      ctx,
      quick(id, { prompt: "p".repeat(5_000), agents: [{ agent_id: uuid(), name: "S", profile_id: "mock-small" }], limits: { max_output_tokens_per_call: 256 } }),
      422,
      "context_too_large",
      "mock-small",
    );
    expect(e.message).toContain("exceeds profile mock-small capacity 1000");
  });

  it("charges extracted attachment text against capacity at admission", async () => {
    ctx = await makeServer({ profilesJson: SMALL_PROFILE });
    const id = await createConversation(ctx);
    const big = seedAttachment(ctx, id, { kind: "text", mime: "text/plain", extractedText: "z".repeat(3_000), extractionStatus: "text_extracted" });
    expectRefusal(
      ctx,
      quick(id, { prompt: "short", attachmentIds: [big.id], agents: [{ agent_id: uuid(), name: "S", profile_id: "mock-small" }], limits: { max_output_tokens_per_call: 256 } }),
      422,
      "context_too_large",
    );
    expect(ctx.bundle.attachments.get(big.id)!.state).toBe("ready");
  });
});

describe("one active run per instance", () => {
  it("refuses a second admission while a run is queued or running, then admits after it ends", async () => {
    ctx = await makeServer();
    const a = await createConversation(ctx);
    const b = await createConversation(ctx);
    const first = ctx.bundle.coordinator.createRun(quick(a));
    expectRefusal(ctx, quick(b), 409, "run_in_progress");
    expectRefusal(ctx, quick(a), 409, "run_in_progress");
    await ctx.bundle.coordinator.startRun(first.snapshot.id);
    await waitTerminal(ctx, first.snapshot.id);
    expect(ctx.bundle.coordinator.createRun(quick(b)).replayed).toBe(false);
  });
});

describe("idempotency", () => {
  it("replays an identical request with the original snapshot and user message, without a second admission", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const input = quick(id, { prompt: "same" });
    const first = ctx.bundle.coordinator.createRun(input);
    const again = ctx.bundle.coordinator.createRun(input);
    expect(again.replayed).toBe(true);
    expect(again.snapshot.id).toBe(first.snapshot.id);
    expect(again.userMessage.id).toBe(first.userMessage.id);
    expect(ctx.bundle.messages.list(id)).toHaveLength(1);
  });

  it("a changed payload under the same key is a 409 idempotency_conflict (any field: prompt, mode, limits, attachments)", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const base = quick(id);
    ctx.bundle.coordinator.createRun(base);
    expectRefusal(ctx, { ...base, prompt: "changed" }, 409, "idempotency_conflict");
    expectRefusal(ctx, { ...base, limits: { concurrency: 1 } }, 409, "idempotency_conflict");
    expectRefusal(ctx, { ...base, agents: [{ ...base.agents[0]!, name: "renamed" }] }, 409, "idempotency_conflict");
    expectRefusal(ctx, { ...base, tool_policy: { mode: "off" } }, 409, "idempotency_conflict");
  });

  it("replay is resolved BEFORE catalog/policy/live admission, so it survives drift", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const base = quick(id);
    const first = ctx.bundle.coordinator.createRun(base);
    const replay = ctx.bundle.coordinator.createRun({ ...base, expectedCatalogVersion: "stale", expectedRuntimePolicyVersion: "stale" });
    expect(replay.replayed).toBe(true);
    expect(replay.snapshot.id).toBe(first.snapshot.id);
  });

  it("an attachment-carrying request replays after its attachments were bound, and a changed file set conflicts", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const a = seedAttachment(ctx, id, { kind: "text", mime: "text/plain" });
    const other = seedAttachment(ctx, id, { kind: "text", mime: "text/plain" });
    const base = quick(id, { attachmentIds: [a.id] });
    const first = ctx.bundle.coordinator.createRun(base);
    expect(ctx.bundle.attachments.get(a.id)!.state).toBe("bound");
    const replay = ctx.bundle.coordinator.createRun(base);
    expect(replay.replayed).toBe(true);
    expect(replay.snapshot.id).toBe(first.snapshot.id);
    expect(replay.userMessage.attachments!.map((r) => r.id)).toEqual([a.id]);
    expectRefusal(ctx, { ...base, attachmentIds: [other.id] }, 409, "idempotency_conflict");
  });

  it("the same key in a different conversation is an independent request", async () => {
    ctx = await makeServer();
    const a = await createConversation(ctx);
    const b = await createConversation(ctx);
    const key = uuid();
    const first = ctx.bundle.coordinator.createRun(quick(a, { idempotencyKey: key }));
    await ctx.bundle.coordinator.startRun(first.snapshot.id);
    await waitTerminal(ctx, first.snapshot.id);
    const second = ctx.bundle.coordinator.createRun(quick(b, { idempotencyKey: key }));
    expect(second.replayed).toBe(false);
    expect(second.snapshot.id).not.toBe(first.snapshot.id);
  });
});

describe("what admission freezes", () => {
  it("records agents, plan, context snapshot, versions and the opening event", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const r = ctx.bundle.coordinator.createRun(team(id, ["mock-balanced", "mock-concise"], { prompt: "Compare tea and coffee please" }));
    const s = r.snapshot;
    expect(s.status).toBe("queued");
    expect(s.mode).toBe("team");
    expect(s.base_planned_calls).toBe(5);
    expect(s.root_agent_ids).toEqual(s.agents.map((a) => a.agent_id));
    expect(s.agents.map((a) => a.model_id)).toEqual(["mock-balanced-v1", "mock-concise-v1"]);
    expect(s.context.policy).toBe("all_history_v1");
    expect(s.context.message_ids).toEqual([r.userMessage.id]);
    expect(s.context.notice).toContain("first turn");
    expect(s.prompt_version).toBe("proofestra-local-v1");
    expect(s.usage.token_scope).toBe("simulated");
    expect(s.external_work_status).toBe("none");
    expect(ctx.bundle.events.listAfter(s.id, 0).map((e) => e.type)).toEqual(["run.created"]);
    expect(ctx.bundle.conversations.get(id)!.title).toBe("Compare tea and coffee please");
  });

  it("freezes prior turns into the next run's context (all_history_v1)", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const first = ctx.bundle.coordinator.createRun(quick(id, { prompt: "turn one" }));
    await ctx.bundle.coordinator.startRun(first.snapshot.id);
    await waitTerminal(ctx, first.snapshot.id);
    const second = ctx.bundle.coordinator.createRun(quick(id, { prompt: "turn two" }));
    const history = ctx.bundle.messages.list(id);
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(second.snapshot.context.message_ids).toEqual(history.map((m) => m.id));
    expect(second.snapshot.context.notice).toBeUndefined();
  });
});

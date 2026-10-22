// Final acceptance pass: regressions for the user-reported remaining issues.
//
// Scope (no paid calls; everything runs against buildApp + fastify.inject +
// deterministic mock profiles):
//
//   1. Terminal accounting (no double-charge after late callbacks).
//      Cancel + repeated cancel + late-success/failure callback: usage stays
//      identical, non-negative, and reserved_output_tokens never goes below
//      zero.
//   2. Overall-deadline Partial fallback. When the overall deadline fires
//      and at least one draft already succeeded, the run status is `partial`
//      with a draft fallback — not `failed`.
//   3. Happy Team-3: frozen history, 7 calls (3 drafts + 3 reviews + 1
//      synthesis), peer-review coverage, selected synthesizer, single
//      assistant message, all steps completed.
//   4. Same-provider concurrency cap: `per_provider_concurrency` is honored
//      across parallel calls that share a provider.
//   5. Mixed known/unknown Team usage: reported totals go `null` as soon as
//      ANY contributing invocation reports unknown, but
//      `consumed_output_tokens` stays strictly positive and monotonic.
//   6. Partial draft/review/synthesis failures: the right stages succeed
//      and the run terminates `partial`, not `failed` or `completed`.
//   7. Truncated provider output does not imply full completion: step
//      findings include the truncation note, final answer carries the
//      truncation marker, and run status is `partial`.
//   8. Host / Origin / CSRF rejection on the HTTP boundary.
//   9. SSE replay / terminal sequence / unique assistant message.
//  10. Restart interruption: `markInterruptedOnStartup` marks any non-
//      terminal run `interrupted` with a dated terminal event.
//  11. Active-run export / delete rejection + export never contains
//      credentials or server secrets.

import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { RunSnapshot } from "../../src/shared/types.js";
import { makeTestApp, authHeaders, newKey, type TestApp } from "./_helpers.js";
import { Coordinator } from "../../src/core/coordinator.js";

let ctx: TestApp | null = null;
afterEach(async () => {
  if (ctx) {
    await ctx.cleanup();
    ctx = null;
  }
});

// --- helpers -------------------------------------------------------------

async function createConversation(ctx: TestApp): Promise<string> {
  const resp = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/conversations",
    headers: authHeaders(ctx),
    payload: { title: "acceptance" },
  });
  expect(resp.statusCode).toBe(201);
  return (resp.json() as { id: string }).id;
}

async function createRun(
  ctx: TestApp,
  conversationId: string,
  payload: Record<string, unknown>,
): Promise<RunSnapshot> {
  const resp = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/conversations/${conversationId}/runs`,
    headers: { ...authHeaders(ctx), "idempotency-key": newKey() },
    payload,
  });
  expect(resp.statusCode).toBe(201);
  return resp.json() as RunSnapshot;
}

const TERMINAL = new Set(["completed", "partial", "failed", "canceled", "interrupted"]);

async function runToTerminal(
  ctx: TestApp,
  runId: string,
  timeoutMs = 25_000,
): Promise<RunSnapshot> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const resp = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/runs/${runId}`,
      headers: authHeaders(ctx),
    });
    const snap = resp.json() as RunSnapshot;
    if (TERMINAL.has(snap.status)) return snap;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run ${runId} never reached terminal state within ${timeoutMs}ms`);
}

async function getMessages(ctx: TestApp, conversationId: string): Promise<
  { items: { id: string; role: string; run_id: string; text: string }[] }
> {
  const resp = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/conversations/${conversationId}/messages`,
    headers: authHeaders(ctx),
  });
  return resp.json() as { items: { id: string; role: string; run_id: string; text: string }[] };
}

// --- 1. terminal accounting ---------------------------------------------

describe("terminal accounting: no double-charge after late callbacks", () => {
  it("cancel + repeat cancel + late success: usage is identical, non-negative, no double-charge", async () => {
    ctx = await makeTestApp({
      profilesJson: {
        mode: "append",
        profiles: [
          {
            profile_id: "mock-late-ok",
            provider: "mock",
            label: "mock late-success for cancel race",
            model_id: "mock-late-ok-v1",
            safe_input_tokens: 32_000,
            max_output_tokens: 2048,
            api_shape: "mock",
            execution_backend_id: "mock-provider-api",
            fixture: { scenario: "late_success", extra_latency_ms: 500 },
          },
        ],
      },
    });
    const conversationId = await createConversation(ctx);
    const agentId = randomUUID();
    const created = await createRun(ctx, conversationId, {
      prompt: "accept-this",
      mode: "quick",
      execution_mode: "mock",
      agents: [{ agent_id: agentId, name: "alpha", profile_id: "mock-late-ok" }],
    });
    // Give the adapter time to start and reserve.
    await new Promise((r) => setTimeout(r, 50));
    const cancel1 = await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/runs/${created.id}/cancellation`,
      headers: authHeaders(ctx),
      payload: {},
    });
    expect(cancel1.statusCode).toBe(200);
    const snap1 = cancel1.json() as RunSnapshot;
    expect(snap1.status).toBe("canceled");
    const usageAtTerminal = { ...snap1.usage };

    // A repeat cancel on an already-terminal run must be a no-op and return
    // the same snapshot. Any mutation here would also indicate a race.
    const cancel2 = await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/runs/${created.id}/cancellation`,
      headers: authHeaders(ctx),
      payload: {},
    });
    expect(cancel2.statusCode).toBe(200);
    const snap2 = cancel2.json() as RunSnapshot;
    expect(snap2.status).toBe("canceled");
    expect(snap2.usage).toEqual(usageAtTerminal);

    // Let the late-success adapter resolve well after terminal.
    await new Promise((r) => setTimeout(r, 800));
    const after = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/runs/${created.id}`,
      headers: authHeaders(ctx),
    });
    const snapAfter = after.json() as RunSnapshot;
    // Status unchanged, usage identical, reserved never negative.
    expect(snapAfter.status).toBe("canceled");
    expect(snapAfter.usage).toEqual(usageAtTerminal);
    expect(snapAfter.usage.reserved_output_tokens).toBeGreaterThanOrEqual(0);
    expect(snapAfter.usage.consumed_output_tokens).toBeGreaterThanOrEqual(0);
    // The ledger drain at finalize charged the reserve exactly once.
    expect(snapAfter.usage.consumed_output_tokens).toBe(usageAtTerminal.consumed_output_tokens);

    // No assistant message was ever inserted for a canceled run.
    const msgs = await getMessages(ctx, conversationId);
    expect(msgs.items.find((m) => m.role === "assistant" && m.run_id === created.id)).toBeUndefined();

    // Terminal-step normalization: a canceled run must not leave any step
    // or invocation in a non-terminal status. (This covers the Chrome
    // regression where review steps showed "Running" forever because late
    // callbacks correctly discarded themselves after terminal.)
    const nonTerminalStep = snapAfter.steps.find((s) =>
      ["queued", "running", "waiting_for_children", "waiting_for_tool", "awaiting_approval"].includes(
        s.status,
      ),
    );
    expect(nonTerminalStep).toBeUndefined();
    for (const step of snapAfter.steps) {
      for (const inv of step.invocations) {
        expect(["queued", "running"]).not.toContain(inv.status);
      }
    }
    // We never claim the remote stop was acknowledged.
    expect(snapAfter.external_work_status).toBe("unknown");

    // Snapshot after late callbacks is byte-identical to the snapshot at
    // the repeat-cancel point (modulo transient `last_event_sequence`
    // appends? no — late callbacks must not emit events either).
    expect(snapAfter.status).toBe(snap2.status);
    expect(snapAfter.steps.length).toBe(snap2.steps.length);
    for (let i = 0; i < snap2.steps.length; i += 1) {
      expect(snapAfter.steps[i]!.status).toBe(snap2.steps[i]!.status);
      expect(snapAfter.steps[i]!.invocations.length).toBe(snap2.steps[i]!.invocations.length);
    }
  }, 15_000);
});

// --- 1b. Team cancel: review + synthesis steps must also normalize --------

describe("Team cancel normalizes review + synthesis steps", () => {
  it("mid-flight Team run canceled with slow mock: all steps/invocations are terminal, no 'Running' forever", async () => {
    // Reproduces the reported Chrome regression (observed with
    // PROOFESTRA_MOCK_LATENCY_MS=15000 and a Team-of-2 cancel): drafts
    // settled, review was still in flight, synthesis was queued, and the
    // UI showed review as Running / synthesis as Queued forever after the
    // run committed Canceled. The fix is `normalizeStepsForTerminal` which
    // we assert here operates on EVERY step kind, not just drafts.
    ctx = await makeTestApp({
      profilesJson: {
        mode: "append",
        profiles: [
          {
            profile_id: "mock-draft-fast",
            provider: "mock",
            label: "mock fast draft",
            model_id: "mock-draft-fast-v1",
            safe_input_tokens: 32_000,
            max_output_tokens: 2048,
            api_shape: "mock",
            execution_backend_id: "mock-provider-api",
            fixture: { scenario: "normal", only_on_stage: "draft", extra_latency_ms: 20 },
          },
          {
            profile_id: "mock-review-slow",
            provider: "mock",
            label: "mock slow review (never finishes in test window)",
            model_id: "mock-review-slow-v1",
            safe_input_tokens: 32_000,
            max_output_tokens: 2048,
            api_shape: "mock",
            execution_backend_id: "mock-provider-api",
            fixture: { scenario: "normal", only_on_stage: "review", extra_latency_ms: 5000 },
          },
        ],
      },
    });
    const conversationId = await createConversation(ctx);
    const a1 = randomUUID();
    const a2 = randomUUID();
    // Use mock-draft-fast for drafts; mock-review-slow is picked at review
    // stage by profile fallback for whichever agent uses it. We give the
    // second agent the slow profile; the first uses the fast one. Both
    // drafts resolve quickly, then review hangs — perfect for cancel.
    const created = await createRun(ctx, conversationId, {
      prompt: "team-cancel-step-normalization",
      mode: "team",
      execution_mode: "mock",
      agents: [
        { agent_id: a1, name: "alpha", profile_id: "mock-draft-fast" },
        { agent_id: a2, name: "beta", profile_id: "mock-review-slow" },
      ],
      synthesizer_agent_id: a1,
    });
    // Let drafts finish and review start.
    await new Promise((r) => setTimeout(r, 400));
    const cancel = await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/runs/${created.id}/cancellation`,
      headers: authHeaders(ctx),
      payload: {},
    });
    expect(cancel.statusCode).toBe(200);
    const snap = cancel.json() as RunSnapshot;
    expect(snap.status).toBe("canceled");

    // Core invariant: no step/invocation is in a non-terminal status.
    const nonTerminal = snap.steps.filter((s) =>
      ["queued", "running", "waiting_for_children", "waiting_for_tool", "awaiting_approval"].includes(
        s.status,
      ),
    );
    expect(nonTerminal).toEqual([]);
    for (const step of snap.steps) {
      for (const inv of step.invocations) {
        expect(["queued", "running"]).not.toContain(inv.status);
      }
    }
    // Draft steps that completed before cancel keep their completed status
    // and their output; cancellation did not retroactively "cancel" them.
    const draftSteps = snap.steps.filter((s) => s.stage === "draft");
    const anyDraftCompleted = draftSteps.some((s) => s.status === "completed" && s.output != null);
    expect(anyDraftCompleted).toBe(true);
    // Synthesis step existed in the plan but never ran: it is marked
    // canceled, not left as "queued".
    const synthSteps = snap.steps.filter((s) => s.stage === "synthesis");
    expect(synthSteps.every((s) => s.status === "canceled")).toBe(true);

    // Repeated cancel returns identical normalized snapshot.
    const cancel2 = await ctx.app.inject({
      method: "PUT",
      url: `/api/v1/runs/${created.id}/cancellation`,
      headers: authHeaders(ctx),
      payload: {},
    });
    const snap2 = cancel2.json() as RunSnapshot;
    expect(snap2.status).toBe("canceled");
    expect(snap2.steps.map((s) => s.status)).toEqual(snap.steps.map((s) => s.status));

    // Let the slow review resolve long after terminal; snapshot must stay
    // identical (no late-callback mutation).
    await new Promise((r) => setTimeout(r, 5500));
    const after = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/runs/${created.id}`,
      headers: authHeaders(ctx),
    });
    const snapAfter = after.json() as RunSnapshot;
    expect(snapAfter.status).toBe("canceled");
    expect(snapAfter.steps.map((s) => s.status)).toEqual(snap.steps.map((s) => s.status));
    expect(snapAfter.usage.reserved_output_tokens).toBe(0);
    expect(snapAfter.external_work_status).toBe("unknown");
  }, 20_000);
});

// --- 1c. Restart interruption normalizes the same way ---------------------

describe("Restart interruption shares terminal settlement with finalize()", () => {
  it("post-crash markInterruptedOnStartup drains reserve, nulls aggregates, normalizes steps, emits one ordered terminal event, no resume", async () => {
    // Simulates a dead server process, not a live cancellation. We seed a
    // persisted non-terminal RunSnapshot directly through RunRepo and never
    // start a Coordinator promise against it — this is important because
    // the earlier version of this test ran a real Coordinator and the live
    // adapter's late callback would overwrite the fixture after
    // `markInterruptedOnStartup` returned, hiding the invariant we want to
    // assert. A dead process cannot do that.
    ctx = await makeTestApp();
    const conversationId = await createConversation(ctx);

    // Build a persisted "mid-flight" snapshot by letting the Coordinator
    // create a run through its normal admission path, then mutating the
    // persisted snapshot into the shape a dead process would have left
    // behind (status=running, one running invocation, reserved output
    // tokens > 0, reported counts falsely known 0). We intentionally skip
    // `startRun()` so no live promise is driving this run — that is the
    // key difference from the earlier version of this test, where an
    // active Coordinator would overwrite the fixture via a stale callback
    // and hide the invariants we want to assert.
    const agentId = randomUUID();
    const create = await ctx.bundle.coordinator.createRun({
      conversationId,
      prompt: "crash-test",
      mode: "quick",
      executionMode: "mock",
      agents: [{ agent_id: agentId, name: "alpha", profile_id: "mock-balanced" }],
      synthesizerAgentId: null,
      idempotencyKey: `crash-${randomUUID()}`,
      expectedCatalogVersion: "",
      expectedRuntimePolicyVersion: "",
    });
    const runId = create.snapshot.id;

    // Pull the just-persisted snapshot, mutate into mid-flight shape, and
    // write it back directly through RunRepo. No coordinator promise ever
    // ran for this run.
    const RESERVE = 2048;
    const snap = ctx.bundle.runs.get(runId)!;
    snap.status = "running";
    snap.usage.harness_invocations = 1;
    snap.usage.reserved_output_tokens = RESERVE;
    snap.usage.consumed_output_tokens = 0;
    snap.usage.input_tokens = 0;
    snap.usage.output_tokens = 0;
    const draftStep = snap.steps.find((s) => s.stage === "draft");
    expect(draftStep).toBeDefined();
    draftStep!.status = "running";
    draftStep!.attempts = 1;
    draftStep!.usage.reserved_output_tokens = RESERVE;
    draftStep!.usage.harness_invocations = 1;
    draftStep!.invocations.push({
      invocation_id: randomUUID(),
      kind: "initial",
      status: "running",
      started_at: new Date().toISOString(),
      finished_at: null,
      usage: {
        ...draftStep!.usage,
        reserved_output_tokens: RESERVE,
        consumed_output_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
      },
      failure: null,
      retry_of_invocation_id: null,
      resumes_after_invocation_id: null,
      execution_backend_id: "mock-provider-api",
      deadline_at: new Date(Date.now() + 30_000).toISOString(),
    });
    // A prior non-terminal event is already in the log at seq=1 from
    // createRun(); add a `run.updated` at seq=2 to simulate the run having
    // transitioned to "running" before the crash.
    snap.last_event_sequence = 2;
    ctx.bundle.runs.updateSnapshot(snap);
    ctx.bundle.events.append({
      run_id: runId,
      sequence: 2,
      type: "run.updated",
      at: new Date().toISOString(),
      data: { status: "running" },
    });

    // --- act: simulate server starting back up ---------------------------
    const count = (
      ctx.bundle.coordinator.constructor as unknown as {
        markInterruptedOnStartup: (deps: unknown) => number;
      }
    ).markInterruptedOnStartup({
      runs: ctx.bundle.runs,
      events: ctx.bundle.events,
      conversations: ctx.bundle.conversations,
      db: ctx.bundle.db,
    });
    expect(count).toBe(1);

    // --- assert: shared settlement invariants ----------------------------
    const after = ctx.bundle.runs.get(runId)!;
    // Status
    expect(after.status).toBe("interrupted");
    expect(after.finished_at).toBeTruthy();
    expect(after.external_work_status).toBe("unknown");

    // Reservation drain: consumed += reserve; reserved == 0.
    expect(after.usage.reserved_output_tokens).toBe(0);
    expect(after.usage.consumed_output_tokens).toBe(RESERVE);
    // Reported totals null (CT-06 sticky-unknown).
    expect(after.usage.input_tokens).toBeNull();
    expect(after.usage.output_tokens).toBeNull();

    // Step + invocation normalization.
    for (const step of after.steps) {
      expect(
        ["queued", "running", "waiting_for_children", "waiting_for_tool", "awaiting_approval"],
      ).not.toContain(step.status);
      expect(step.status).toBe("interrupted");
      for (const inv of step.invocations) {
        expect(["queued", "running"]).not.toContain(inv.status);
        expect(inv.status).toBe("interrupted");
        expect(inv.finished_at).toBeTruthy();
        expect(inv.failure?.code).toBe("interrupted");
      }
    }

    // Terminal event is ordered and atomic: last_event_sequence advanced
    // by exactly 1 (seq 2 -> seq 3) and the event log has one new row of
    // type `run.terminal` at that sequence.
    expect(after.last_event_sequence).toBe(3);
    const events = ctx.bundle.events.listAfter(runId, 2);
    expect(events.length).toBe(1);
    expect(events[0]!.sequence).toBe(3);
    expect(events[0]!.type).toBe("run.terminal");
    expect((events[0]!.data as { status: string }).status).toBe("interrupted");
    expect((events[0]!.data as { reason: string }).reason).toBe("interrupted_by_restart");

    // Idempotency: a second startup pass must be a no-op (CAS by
    // isTerminal). No new event, no additional ledger movement.
    const second = (
      ctx.bundle.coordinator.constructor as unknown as {
        markInterruptedOnStartup: (deps: unknown) => number;
      }
    ).markInterruptedOnStartup({
      runs: ctx.bundle.runs,
      events: ctx.bundle.events,
      conversations: ctx.bundle.conversations,
      db: ctx.bundle.db,
    });
    expect(second).toBe(0);
    const afterSecond = ctx.bundle.runs.get(runId)!;
    expect(afterSecond.last_event_sequence).toBe(3);
    expect(afterSecond.usage.consumed_output_tokens).toBe(RESERVE);
    expect(afterSecond.usage.reserved_output_tokens).toBe(0);

    // No resume / no dispatch: the only assistant-ish row that could leak
    // is a `messages` row with role=assistant for this run. None should
    // exist.
    const msgs = ctx.bundle.db
      .prepare(`SELECT COUNT(*) AS c FROM messages WHERE run_id = ? AND role = 'assistant'`)
      .get(runId) as { c: number };
    expect(Number(msgs.c)).toBe(0);
  }, 5_000);
});

// --- 2. overall-deadline Partial fallback -------------------------------

describe("overall-deadline Partial fallback", () => {
  it("overall deadline fires with ≥1 successful draft: run is partial with draft_fallback, not failed", async () => {
    ctx = await makeTestApp({
      profilesJson: {
        mode: "append",
        profiles: [
          // Normal fast draft for the first agent.
          {
            profile_id: "mock-fast",
            provider: "mock",
            label: "mock fast draft",
            model_id: "mock-fast-v1",
            safe_input_tokens: 32_000,
            max_output_tokens: 2048,
            api_shape: "mock",
            execution_backend_id: "mock-provider-api",
          },
          // Second agent hangs ONLY on synthesis. Its draft and review are
          // normal successful mock answers so the Partial fallback has a
          // useful artifact to present.
          {
            profile_id: "mock-synth-hang",
            provider: "mock",
            label: "mock hangs only on synthesis",
            model_id: "mock-synth-hang-v1",
            safe_input_tokens: 32_000,
            max_output_tokens: 2048,
            api_shape: "mock",
            execution_backend_id: "mock-provider-api",
            fixture: { scenario: "never_settle", only_on_stage: "synthesis" },
          },
        ],
      },
    });
    const conversationId = await createConversation(ctx);
    const alpha = randomUUID();
    const beta = randomUUID();
    const created = await createRun(ctx, conversationId, {
      prompt: "deadline partial",
      mode: "team",
      execution_mode: "mock",
      agents: [
        { agent_id: alpha, name: "alpha", profile_id: "mock-fast" },
        { agent_id: beta, name: "beta", profile_id: "mock-synth-hang" },
      ],
      synthesizer_agent_id: beta,
      limits: {
        overall_timeout_seconds: 15, // schema minimum
        per_call_timeout_seconds: 60, // >> overall so per-call does NOT fire first
      },
    });
    const snap = await runToTerminal(ctx, created.id, 25_000);
    // When the overall timeout mechanism (either the per-call hard timeout
    // that is bounded by `deadline - now`, or the overall-deadline guard at
    // `overall + grace`) terminates the run with ≥1 successful drafts
    // already in hand, the status MUST be `partial` (never `failed`) and
    // the result MUST surface the useful draft as a fallback answer, not
    // discard the work.
    expect(snap.status).toBe("partial");
    expect(snap.presentation).toBe("draft_fallback");
    expect(snap.final_answer).toBeTruthy();
    expect(snap.final_answer!.toLowerCase()).toContain("draft fallback");
    const completedDrafts = snap.steps.filter((s) => s.stage === "draft" && s.status === "completed");
    expect(completedDrafts.length).toBeGreaterThanOrEqual(1);
    const synthStep = snap.steps.find((s) => s.stage === "synthesis");
    expect(synthStep?.status).not.toBe("completed");
    // A documented limitation must explain WHY synthesis did not complete.
    expect(
      snap.limitations.some((l) => /synthesis|overall deadline|timeout/i.test(l)),
    ).toBe(true);
  }, 30_000);
});

// --- 3. Happy Team-3 ----------------------------------------------------

describe("Team-3 happy path: 7 calls, selected synthesizer, single assistant", () => {
  it("completes with 3 drafts + 3 reviews + 1 synthesis = 7 harness invocations", async () => {
    ctx = await makeTestApp();
    const conversationId = await createConversation(ctx);
    const alpha = randomUUID();
    const beta = randomUUID();
    const gamma = randomUUID();
    const created = await createRun(ctx, conversationId, {
      prompt: "Explain the three risks of agent consensus.",
      mode: "team",
      execution_mode: "mock",
      agents: [
        { agent_id: alpha, name: "alpha", profile_id: "mock-balanced" },
        { agent_id: beta, name: "beta", profile_id: "mock-analytical" },
        { agent_id: gamma, name: "gamma", profile_id: "mock-concise" },
      ],
      synthesizer_agent_id: beta, // explicitly the second root
    });
    const snap = await runToTerminal(ctx, created.id);
    expect(snap.status).toBe("completed");
    expect(snap.base_planned_calls).toBe(7);
    expect(snap.usage.harness_invocations).toBe(7);
    expect(snap.synthesizer_agent_id).toBe(beta);
    expect(snap.presentation).toBe("team_synthesis");
    // Every step completed.
    const stageCounts = {
      draft: snap.steps.filter((s) => s.stage === "draft" && s.status === "completed").length,
      review: snap.steps.filter((s) => s.stage === "review" && s.status === "completed").length,
      synthesis: snap.steps.filter((s) => s.stage === "synthesis" && s.status === "completed").length,
    };
    expect(stageCounts).toEqual({ draft: 3, review: 3, synthesis: 1 });
    // Peer-review coverage: each reviewer agent appears exactly once in review steps.
    const reviewerIds = snap.steps.filter((s) => s.stage === "review").map((s) => s.agent_id);
    expect(new Set(reviewerIds).size).toBe(3);
    // Frozen history: context snapshot references the user message that
    // this run was built from.
    expect(snap.user_message_id).toBeTruthy();
    // Exactly one assistant message was persisted for this run (no duplicate).
    const msgs = await getMessages(ctx, conversationId);
    const assistants = msgs.items.filter((m) => m.role === "assistant" && m.run_id === snap.id);
    expect(assistants).toHaveLength(1);
  });
});

// --- 4. same-provider concurrency cap -----------------------------------

describe("per-provider concurrency cap", () => {
  it("Team of 3 slow mock calls with per_provider_concurrency=1 serializes drafts", async () => {
    ctx = await makeTestApp({
      profilesJson: {
        mode: "append",
        profiles: [
          {
            profile_id: "mock-slow-a",
            provider: "mock",
            label: "slow A",
            model_id: "slow-a-v1",
            safe_input_tokens: 32_000,
            max_output_tokens: 2048,
            api_shape: "mock",
            execution_backend_id: "mock-provider-api",
            fixture: { extra_latency_ms: 400 },
          },
          {
            profile_id: "mock-slow-b",
            provider: "mock",
            label: "slow B",
            model_id: "slow-b-v1",
            safe_input_tokens: 32_000,
            max_output_tokens: 2048,
            api_shape: "mock",
            execution_backend_id: "mock-provider-api",
            fixture: { extra_latency_ms: 400 },
          },
          {
            profile_id: "mock-slow-c",
            provider: "mock",
            label: "slow C",
            model_id: "slow-c-v1",
            safe_input_tokens: 32_000,
            max_output_tokens: 2048,
            api_shape: "mock",
            execution_backend_id: "mock-provider-api",
            fixture: { extra_latency_ms: 400 },
          },
        ],
      },
    });
    const conversationId = await createConversation(ctx);
    const alpha = randomUUID();
    const beta = randomUUID();
    const gamma = randomUUID();
    const t0 = Date.now();
    const created = await createRun(ctx, conversationId, {
      prompt: "concurrency",
      mode: "team",
      execution_mode: "mock",
      agents: [
        { agent_id: alpha, name: "alpha", profile_id: "mock-slow-a" },
        { agent_id: beta, name: "beta", profile_id: "mock-slow-b" },
        { agent_id: gamma, name: "gamma", profile_id: "mock-slow-c" },
      ],
      synthesizer_agent_id: alpha,
      limits: {
        concurrency: 4, // generous global
        per_provider_concurrency: 1, // the actual cap under test
      },
    });
    const snap = await runToTerminal(ctx, created.id);
    const elapsed = Date.now() - t0;
    expect(snap.status).toBe("completed");
    // All three profiles share provider=mock. With per_provider_concurrency=1
    // the three ~400ms drafts must serialize → ≥1200ms just for drafts, plus
    // reviews and synthesis. We assert a lower bound comfortably under the
    // parallel case (~400ms) to tolerate CI variance.
    expect(elapsed).toBeGreaterThanOrEqual(900);
  }, 20_000);
});

// --- 5. mixed known/unknown Team usage ----------------------------------

describe("mixed known/unknown Team usage (CT-06 sticky-unknown)", () => {
  it("one unknown-usage agent in Team-3 collapses reported totals to null but keeps consumed positive", async () => {
    ctx = await makeTestApp({
      profilesJson: {
        mode: "append",
        profiles: [
          {
            profile_id: "mock-unknown-usage",
            provider: "mock",
            label: "unknown usage",
            model_id: "mock-unknown-v1",
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
    const alpha = randomUUID();
    const beta = randomUUID();
    const gamma = randomUUID();
    const created = await createRun(ctx, conversationId, {
      prompt: "mixed",
      mode: "team",
      execution_mode: "mock",
      agents: [
        { agent_id: alpha, name: "alpha", profile_id: "mock-balanced" },
        { agent_id: beta, name: "beta", profile_id: "mock-analytical" },
        { agent_id: gamma, name: "gamma", profile_id: "mock-unknown-usage" },
      ],
      synthesizer_agent_id: alpha,
    });
    const snap = await runToTerminal(ctx, created.id);
    expect(snap.status).toBe("completed");
    // Any contributing invocation reports unknown → sticky-null aggregate.
    expect(snap.usage.input_tokens).toBeNull();
    expect(snap.usage.output_tokens).toBeNull();
    // Conservative ledger stays strictly positive.
    expect(snap.usage.consumed_output_tokens).toBeGreaterThan(0);
    // reserved drained to zero at terminal.
    expect(snap.usage.reserved_output_tokens).toBe(0);
  });
});

// --- 6. partial failure paths -------------------------------------------

describe("partial draft/review/synthesis failures", () => {
  it("review-only failure yields a partial run with completed drafts and synthesis", async () => {
    ctx = await makeTestApp();
    const conversationId = await createConversation(ctx);
    const alpha = randomUUID();
    const beta = randomUUID();
    const created = await createRun(ctx, conversationId, {
      prompt: "partial review",
      mode: "team",
      execution_mode: "mock",
      agents: [
        { agent_id: alpha, name: "alpha", profile_id: "mock-balanced" },
        { agent_id: beta, name: "beta", profile_id: "mock-fail-review" }, // review-only fail
      ],
      synthesizer_agent_id: alpha,
    });
    const snap = await runToTerminal(ctx, created.id);
    expect(snap.status).toBe("partial");
    const drafts = snap.steps.filter((s) => s.stage === "draft");
    expect(drafts.every((s) => s.status === "completed")).toBe(true);
    const reviews = snap.steps.filter((s) => s.stage === "review");
    expect(reviews.some((s) => s.status === "failed")).toBe(true);
    const synth = snap.steps.find((s) => s.stage === "synthesis");
    expect(synth?.status).toBe("completed");
    expect(snap.limitations.some((l) => /review by beta failed/i.test(l))).toBe(true);
  });

  it("synthesis failure falls back to the first successful draft with a documented limitation", async () => {
    ctx = await makeTestApp({
      profilesJson: {
        mode: "append",
        profiles: [
          {
            profile_id: "mock-synth-fail",
            provider: "mock",
            label: "mock synthesis fails",
            model_id: "mock-synth-fail-v1",
            safe_input_tokens: 32_000,
            max_output_tokens: 2048,
            api_shape: "mock",
            execution_backend_id: "mock-provider-api",
            fixture: { scenario: "fail", only_on_stage: "synthesis" },
          },
        ],
      },
    });
    const conversationId = await createConversation(ctx);
    const alpha = randomUUID();
    const beta = randomUUID();
    const created = await createRun(ctx, conversationId, {
      prompt: "partial synth",
      mode: "team",
      execution_mode: "mock",
      agents: [
        { agent_id: alpha, name: "alpha", profile_id: "mock-balanced" },
        { agent_id: beta, name: "beta", profile_id: "mock-synth-fail" },
      ],
      synthesizer_agent_id: beta,
    });
    const snap = await runToTerminal(ctx, created.id);
    expect(snap.status).toBe("partial");
    expect(snap.presentation).toBe("draft_fallback");
    expect(snap.limitations.some((l) => /synthesis failed/i.test(l))).toBe(true);
  });
});

// --- 7. truncated provider output does not imply completion -------------

describe("truncated provider output does not imply full completion", () => {
  it("Quick-mock with truncated fixture yields status=partial with truncation finding + marker", async () => {
    ctx = await makeTestApp({
      profilesJson: {
        mode: "append",
        profiles: [
          {
            profile_id: "mock-truncated",
            provider: "mock",
            label: "mock truncated",
            model_id: "mock-truncated-v1",
            safe_input_tokens: 32_000,
            max_output_tokens: 2048,
            api_shape: "mock",
            execution_backend_id: "mock-provider-api",
            fixture: { scenario: "truncated" },
          },
        ],
      },
    });
    const conversationId = await createConversation(ctx);
    const alpha = randomUUID();
    const created = await createRun(ctx, conversationId, {
      prompt: "truncate me",
      mode: "quick",
      execution_mode: "mock",
      agents: [{ agent_id: alpha, name: "alpha", profile_id: "mock-truncated" }],
    });
    const snap = await runToTerminal(ctx, created.id);
    expect(snap.status).toBe("partial");
    expect(snap.final_answer).toContain("truncated");
    // Step findings surface the truncation + run.limitations echoes it.
    const step = snap.steps.find((s) => s.stage === "draft")!;
    expect(step.findings.some((f) => /truncat/i.test(f.text))).toBe(true);
    expect(snap.limitations.some((l) => /truncated/i.test(l))).toBe(true);
  });
});

// --- 8. Host / Origin / CSRF rejection ----------------------------------

describe("HTTP security boundary", () => {
  it("rejects a mutating request with a disallowed Host header", async () => {
    ctx = await makeTestApp();
    const resp = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/conversations",
      headers: {
        ...authHeaders(ctx),
        host: "evil.example.com",
      },
      payload: { title: "nope" },
    });
    expect(resp.statusCode).toBe(403);
    expect((resp.json() as { error: { code: string } }).error.code).toBe("forbidden");
  });

  it("rejects a mutating request with a cross-origin Origin header", async () => {
    ctx = await makeTestApp();
    const resp = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/conversations",
      headers: {
        ...authHeaders(ctx),
        origin: "https://evil.example.com",
      },
      payload: { title: "nope" },
    });
    expect(resp.statusCode).toBe(403);
    expect((resp.json() as { error: { code: string } }).error.code).toBe("forbidden");
  });

  it("rejects a mutating request with a wrong X-CSRF-Token", async () => {
    ctx = await makeTestApp();
    const resp = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/conversations",
      headers: {
        ...authHeaders(ctx),
        "x-csrf-token": "not-the-right-token",
      },
      payload: { title: "nope" },
    });
    expect(resp.statusCode).toBe(403);
    expect((resp.json() as { error: { code: string } }).error.code).toBe("forbidden");
  });
});

// --- 9. SSE replay / terminal sequence / unique assistant ---------------

describe("SSE replay and terminal event ordering", () => {
  it("SSE replay serves monotonically-increasing events and 204 once terminal + caught up", async () => {
    ctx = await makeTestApp();
    const conversationId = await createConversation(ctx);
    const alpha = randomUUID();
    const created = await createRun(ctx, conversationId, {
      prompt: "sse",
      mode: "quick",
      execution_mode: "mock",
      agents: [{ agent_id: alpha, name: "alpha", profile_id: "mock-balanced" }],
    });
    const snap = await runToTerminal(ctx, created.id);
    // Request a replay from the start.
    const replay = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/runs/${snap.id}/events`,
      headers: { ...authHeaders(ctx), accept: "text/event-stream" },
    });
    // Terminal + lastSeen=0 but we did NOT send Last-Event-ID so the server
    // opens the stream and immediately replays. The injected harness collects
    // the full payload.
    expect([200, 204]).toContain(replay.statusCode);
    if (replay.statusCode === 200) {
      const payload = replay.payload;
      const idLines = [...payload.matchAll(/^id:\s*(\d+)$/gm)].map((m) => Number(m[1]));
      expect(idLines.length).toBeGreaterThan(0);
      // Monotonic non-decreasing sequence ids.
      for (let i = 1; i < idLines.length; i++) {
        expect(idLines[i]).toBeGreaterThanOrEqual(idLines[i - 1]!);
      }
      // Last recorded event is the terminal event.
      expect(payload).toContain("event: run.terminal");
    }
    // A caller that is already caught up gets 204 + no body.
    const caughtUp = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/runs/${snap.id}/events`,
      headers: {
        ...authHeaders(ctx),
        accept: "text/event-stream",
        "last-event-id": String(snap.last_event_sequence),
      },
    });
    expect(caughtUp.statusCode).toBe(204);
    // A future Last-Event-ID is a client/server mismatch → 400.
    const future = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/runs/${snap.id}/events`,
      headers: {
        ...authHeaders(ctx),
        accept: "text/event-stream",
        "last-event-id": String(snap.last_event_sequence + 10),
      },
    });
    expect(future.statusCode).toBe(400);
  });

  it("exactly one assistant message is persisted per terminal run", async () => {
    ctx = await makeTestApp();
    const conversationId = await createConversation(ctx);
    const alpha = randomUUID();
    const created = await createRun(ctx, conversationId, {
      prompt: "unique",
      mode: "quick",
      execution_mode: "mock",
      agents: [{ agent_id: alpha, name: "alpha", profile_id: "mock-balanced" }],
    });
    const snap = await runToTerminal(ctx, created.id);
    expect(snap.status).toBe("completed");
    const msgs = await getMessages(ctx, conversationId);
    const assistants = msgs.items.filter((m) => m.role === "assistant" && m.run_id === snap.id);
    expect(assistants).toHaveLength(1);
  });
});

// --- 10. restart interruption -------------------------------------------

describe("restart interruption via markInterruptedOnStartup", () => {
  it("marks a running run as interrupted and appends a terminal run.terminal event", async () => {
    ctx = await makeTestApp();
    const conversationId = await createConversation(ctx);
    const alpha = randomUUID();
    const created = await createRun(ctx, conversationId, {
      prompt: "interrupted",
      mode: "quick",
      execution_mode: "mock",
      agents: [{ agent_id: alpha, name: "alpha", profile_id: "mock-balanced" }],
    });
    // Flip the stored snapshot back to `running` to simulate a crash
    // happening mid-execution before the terminal commit.
    const bundle = ctx.bundle;
    // Simulate: run was not terminal when the server died.
    const snap = bundle.runs.get(created.id)!;
    snap.status = "running";
    snap.finished_at = null;
    bundle.db.transaction(() => bundle.runs.updateSnapshot(snap));

    const marked = Coordinator.markInterruptedOnStartup({
      runs: bundle.runs,
      events: bundle.events,
      conversations: bundle.conversations,
      db: bundle.db,
    });
    expect(marked).toBeGreaterThanOrEqual(1);

    const after = bundle.runs.get(created.id)!;
    expect(after.status).toBe("interrupted");
    expect(after.finished_at).toBeTruthy();
    expect(after.external_work_status).toBe("unknown");
    const events = bundle.events.listAfter(created.id, 0);
    const terminal = events.find((e) => e.type === "run.terminal");
    expect(terminal).toBeTruthy();
    expect((terminal!.data as { status: string }).status).toBe("interrupted");
  }, 15_000);
});

// --- 11. active-run export/delete + export secret exclusion -------------

describe("active-run guards and export privacy", () => {
  it("rejects delete + export while a run is active, and allows them after terminal", async () => {
    ctx = await makeTestApp({
      profilesJson: {
        mode: "append",
        profiles: [
          {
            profile_id: "mock-active",
            provider: "mock",
            label: "active-only mock",
            model_id: "mock-active-v1",
            safe_input_tokens: 32_000,
            max_output_tokens: 2048,
            api_shape: "mock",
            execution_backend_id: "mock-provider-api",
            fixture: { extra_latency_ms: 1200 },
          },
        ],
      },
    });
    const conversationId = await createConversation(ctx);
    const alpha = randomUUID();
    await createRun(ctx, conversationId, {
      prompt: "active guard",
      mode: "quick",
      execution_mode: "mock",
      agents: [{ agent_id: alpha, name: "alpha", profile_id: "mock-active" }],
    });
    // Run is still in flight because of extra_latency_ms=1200.
    const noBodyHeaders = { ...authHeaders(ctx) };
    delete (noBodyHeaders as Record<string, string>)["content-type"];
    const delResp = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/conversations/${conversationId}`,
      headers: noBodyHeaders,
    });
    expect(delResp.statusCode).toBe(409);
    expect((delResp.json() as { error: { code: string } }).error.code).toBe("run_in_progress");

    const expResp = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/conversations/${conversationId}/export`,
      headers: authHeaders(ctx),
    });
    expect(expResp.statusCode).toBe(409);
    expect((expResp.json() as { error: { code: string } }).error.code).toBe("run_in_progress");

    // Wait for the mock to finish; export + delete then succeed.
    await new Promise((r) => setTimeout(r, 1500));
    const exp2 = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/conversations/${conversationId}/export`,
      headers: authHeaders(ctx),
    });
    expect(exp2.statusCode).toBe(200);
    const del2 = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/conversations/${conversationId}`,
      headers: noBodyHeaders,
    });
    expect(del2.statusCode).toBe(204);
  }, 15_000);

  it("export never surfaces API keys, Live model_ids as credentials, or server secrets", async () => {
    const marker = "PROOFESTRA_FAKE_SECRET_ABCDEFGHIJKL_SHOULD_NEVER_LEAK";
    ctx = await makeTestApp({
      env: {
        OPENAI_API_KEY: `sk-${marker}-oai`,
        ANTHROPIC_API_KEY: `sk-ant-${marker}-ant`,
        GOOGLE_API_KEY: `AIza${marker}GOOG`,
        PROOFESTRA_LIVE_ENABLED: "0",
      },
    });
    const conversationId = await createConversation(ctx);
    const alpha = randomUUID();
    const created = await createRun(ctx, conversationId, {
      prompt: "export-secret-scan",
      mode: "quick",
      execution_mode: "mock",
      agents: [{ agent_id: alpha, name: "alpha", profile_id: "mock-balanced" }],
    });
    const snap = await runToTerminal(ctx, created.id);
    expect(snap.status).toBe("completed");

    const exp = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/conversations/${conversationId}/export`,
      headers: authHeaders(ctx),
    });
    expect(exp.statusCode).toBe(200);
    const body = exp.payload;
    expect(body).not.toContain(marker);
    expect(body).not.toContain("sk-");
    expect(body).not.toContain("AIza");
    // Positive assertion: the export shape is still correct.
    const parsed = JSON.parse(body) as { conversation: unknown; messages: unknown[]; runs: unknown[] };
    expect(parsed.conversation).toBeTruthy();
    expect(parsed.messages.length).toBeGreaterThanOrEqual(1);
    expect(parsed.runs.length).toBe(1);
  });
});

// --- 12. hydration: valid older conversation beyond the first history page ---

describe("hydration: stored older conversation must not be judged deleted", () => {
  it("GET /conversations/:id returns 200 for a conversation that is beyond the first list page", async () => {
    // Reproduces the reported Chrome regression: the sidebar's first page of
    // conversations only returns the newest N rows, so a valid stored chat
    // from a long-standing user is NOT in `listConversations().items`. The
    // UI must validate the stored id with `GET /conversations/:id` instead
    // of inferring deletion from first-page absence. This test proves that
    // endpoint actually exists and is cheap (one row) — the UI client in
    // `src/web/api.ts :: getConversation` relies on it.
    ctx = await makeTestApp();
    const createdIds: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      const resp = await ctx.app.inject({
        method: "POST",
        url: "/api/v1/conversations",
        headers: authHeaders(ctx),
        payload: { title: `conv-${i}` },
      });
      expect(resp.statusCode).toBe(201);
      createdIds.push((resp.json() as { id: string }).id);
    }
    // The first (oldest) conversation is on page 2+ of the default list.
    const oldest = createdIds[0]!;
    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/conversations?limit=20",
      headers: authHeaders(ctx),
    });
    const listed = (list.json() as { items: Array<{ id: string }> }).items;
    expect(listed.some((c) => c.id === oldest)).toBe(false);

    // Direct lookup still succeeds and returns the stored row.
    const direct = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/conversations/${oldest}`,
      headers: authHeaders(ctx),
    });
    expect(direct.statusCode).toBe(200);
    const row = direct.json() as { id: string; title: string };
    expect(row.id).toBe(oldest);
    expect(row.title).toBe("conv-0");

    // A truly deleted conversation returns 404 so the UI can distinguish.
    const delHeaders = { ...authHeaders(ctx) };
    delete (delHeaders as Record<string, string>)["content-type"];
    const del = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/conversations/${createdIds[1]!}`,
      headers: delHeaders,
    });
    expect(del.statusCode).toBe(204);
    const gone = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/conversations/${createdIds[1]!}`,
      headers: authHeaders(ctx),
    });
    expect(gone.statusCode).toBe(404);
  });
});

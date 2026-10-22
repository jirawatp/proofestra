// Run execution: stage outcomes, degraded/partial results, budgets, deadlines,
// cancellation races and the accounting invariants. Failure conditions are
// produced by deterministic mock fixtures or by tightening the PERSISTED run
// snapshot between admission and dispatch (the same state a long-running
// server could observe), never by network calls.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Coordinator, isTerminal, stickySum, type CreateRunInput } from "../../src/core/coordinator.js";
import { createConversation, makeServer, waitFor, waitTerminal, type ServerCtx } from "./_server_helpers.js";
import type { RunSnapshot, StepSnapshot } from "../../src/shared/types.js";

let ctx: ServerCtx | null = null;
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await ctx?.cleanup();
  ctx = null;
});

const uuid = () => crypto.randomUUID();

function mockProfile(id: string, fixture?: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    profile_id: id,
    provider: "mock",
    label: id,
    model_id: `${id}-v1`,
    safe_input_tokens: 32_000,
    max_output_tokens: 2048,
    api_shape: "mock",
    execution_backend_id: "mock-provider-api",
    ...(fixture ? { fixture } : {}),
    ...extra,
  };
}
const catalog = (...profiles: unknown[]) => ({ mode: "append", profiles });

function input(conversationId: string, profiles: string[], over: Partial<CreateRunInput> = {}): CreateRunInput {
  const agents = profiles.map((profile_id, i) => ({ agent_id: uuid(), name: `Agent${i}`, profile_id }));
  const isTeam = profiles.length > 1;
  return {
    conversationId,
    prompt: "Explain tides",
    mode: isTeam ? "team" : "quick",
    executionMode: "mock",
    agents,
    synthesizerAgentId: isTeam ? agents[0]!.agent_id : null,
    idempotencyKey: uuid(),
    ...over,
  };
}

async function runIt(c: ServerCtx, profiles: string[], over: Partial<CreateRunInput> = {}, mutate?: (s: RunSnapshot) => void) {
  const convId = await createConversation(c);
  const { snapshot } = c.bundle.coordinator.createRun(input(convId, profiles, over));
  if (mutate) {
    const s = c.bundle.runs.get(snapshot.id)!;
    mutate(s);
    c.bundle.runs.updateSnapshot(s);
  }
  await c.bundle.coordinator.startRun(snapshot.id);
  return { convId, run: await waitTerminal(c, snapshot.id) };
}

const steps = (run: RunSnapshot, stage: StepSnapshot["stage"]) => run.steps.filter((s) => s.stage === stage);

describe("happy paths", () => {
  it("Quick: one unreviewed answer, completed, with the honest limitation and the assistant message committed with the terminal event", async () => {
    ctx = await makeServer();
    const { convId, run } = await runIt(ctx, ["mock-balanced"]);
    expect(run.status).toBe("completed");
    expect(run.presentation).toBe("quick_unreviewed");
    expect(run.final_answer).toContain("draft");
    expect(run.limitations.join(" ")).toContain("not peer-reviewed");
    expect(run.usage.harness_invocations).toBe(1);
    expect(run.usage.reserved_output_tokens).toBe(0);
    const assistant = ctx.bundle.messages.list(convId).find((m) => m.role === "assistant")!;
    expect(assistant.text).toBe(run.final_answer);
    expect(ctx.bundle.coordinator.commitAssistantMessage(run.id)!.id).toBe(assistant.id);
    const events = ctx.bundle.events.listAfter(run.id, 0);
    expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i + 1));
    expect(events.at(-1)!.type).toBe("run.terminal");
    expect(run.last_event_sequence).toBe(events.length);
  });

  it("Team: n drafts, n reviews and one synthesis; synthesis is the answer; every step completed with sums known", async () => {
    ctx = await makeServer();
    const { run } = await runIt(ctx, ["mock-balanced", "mock-analytical", "mock-concise"]);
    expect(run.status).toBe("completed");
    expect(run.presentation).toBe("team_synthesis");
    expect(steps(run, "draft")).toHaveLength(3);
    expect(steps(run, "review")).toHaveLength(3);
    expect(steps(run, "synthesis")).toHaveLength(1);
    expect(run.steps.every((s) => s.status === "completed")).toBe(true);
    expect(run.usage.harness_invocations).toBe(7);
    expect(typeof run.usage.input_tokens).toBe("number");
    expect(typeof run.usage.output_tokens).toBe("number");
    expect(run.final_answer).toBe(steps(run, "synthesis")[0]!.output);
    // Reviews saw ONLY peers' drafts; the synthesis saw drafts and reviews.
    expect(steps(run, "review")[0]!.findings.length).toBeGreaterThan(0);
  });

  it("isTerminal and stickySum helpers", () => {
    expect(["completed", "partial", "failed", "canceled", "interrupted"].every((s) => isTerminal(s as never))).toBe(true);
    expect(["queued", "running", "waiting_for_tool"].some((s) => isTerminal(s as never))).toBe(false);
    expect(stickySum(1, 2)).toBe(3);
    expect(stickySum(null, 2)).toBeNull();
    expect(stickySum(1, null)).toBeNull();
  });

  it("startRun is idempotent while in flight: the same promise, one execution", async () => {
    ctx = await makeServer();
    const convId = await createConversation(ctx);
    const { snapshot } = ctx.bundle.coordinator.createRun(input(convId, ["mock-balanced"]));
    const p1 = ctx.bundle.coordinator.startRun(snapshot.id);
    const p2 = ctx.bundle.coordinator.startRun(snapshot.id);
    expect(p2).toBe(p1);
    await p1;
    const done = ctx.bundle.runs.get(snapshot.id)!;
    expect(done.usage.harness_invocations).toBe(1);
    // Starting a terminal run again does nothing.
    await ctx.bundle.coordinator.startRun(snapshot.id);
    expect(ctx.bundle.runs.get(snapshot.id)!.last_event_sequence).toBe(done.last_event_sequence);
  });

  it("starting an unknown run id is a harmless no-op", async () => {
    ctx = await makeServer();
    await expect(ctx.bundle.coordinator.startRun(uuid())).resolves.toBeUndefined();
  });

  it("a run is only executed from 'queued' (a tampered 'running' snapshot is left alone)", async () => {
    ctx = await makeServer();
    const convId = await createConversation(ctx);
    const { snapshot } = ctx.bundle.coordinator.createRun(input(convId, ["mock-balanced"]));
    const s = ctx.bundle.runs.get(snapshot.id)!;
    s.status = "running";
    ctx.bundle.runs.updateSnapshot(s);
    await ctx.bundle.coordinator.startRun(snapshot.id);
    expect(ctx.bundle.runs.get(snapshot.id)!.status).toBe("running");
    expect(ctx.bundle.runs.get(snapshot.id)!.usage.harness_invocations).toBe(0);
  });
});

describe("degraded outcomes", () => {
  it("a failing reviewer makes the run partial but the synthesis still answers", async () => {
    ctx = await makeServer();
    const { run } = await runIt(ctx, ["mock-balanced", "mock-fail-review"]);
    expect(run.status).toBe("partial");
    expect(run.presentation).toBe("team_synthesis");
    const failedReview = steps(run, "review").find((s) => s.status === "failed")!;
    expect(failedReview.failure).toEqual({ code: "provider_unavailable", message: "mock fixture scenario=fail" });
    expect(failedReview.invocations[0]!.status).toBe("failed");
    expect(run.limitations.join(" ")).toContain("review by Agent1 failed: mock fixture scenario=fail");
    // A failed dispatched call charges the whole reservation and makes reported usage unknown.
    expect(run.usage.input_tokens).toBeNull();
    expect(run.usage.output_tokens).toBeNull();
    expect(run.usage.token_scope).toBe("simulated");
    expect(run.usage.consumed_output_tokens).toBeGreaterThanOrEqual(2048);
  });

  it("one successful draft skips peer review with an explicit limitation, then synthesizes from that single draft", async () => {
    ctx = await makeServer({ profilesJson: catalog(mockProfile("mock-draft-down", { scenario: "fail", only_on_stage: "draft" })) });
    const { run } = await runIt(ctx, ["mock-balanced", "mock-draft-down"]);
    expect(run.status).toBe("partial");
    const reviews = steps(run, "review");
    expect(reviews).toHaveLength(2);
    expect(reviews.every((s) => s.status === "skipped")).toBe(true);
    expect(reviews.map((s) => s.failure!.message).sort()).toEqual([
      "peer review skipped: fewer than two successful drafts",
      "peer review skipped: this agent's draft did not succeed",
    ]);
    expect(run.limitations.join(" ")).toContain("Peer review was skipped: only one draft succeeded");
    expect(steps(run, "synthesis")[0]!.status).toBe("completed");
    expect(run.usage.harness_invocations).toBe(3); // 2 drafts + 1 synthesis
  });

  it("when no draft succeeds the run FAILS, publishes no answer and writes no assistant message", async () => {
    ctx = await makeServer({ profilesJson: catalog(mockProfile("mock-always-down", { scenario: "fail", only_on_stage: "draft" })) });
    const { convId, run } = await runIt(ctx, ["mock-always-down", "mock-always-down"]);
    expect(run.status).toBe("failed");
    expect(run.final_answer).toBeNull();
    expect(run.presentation).toBe("none");
    expect(ctx.bundle.messages.list(convId).map((m) => m.role)).toEqual(["user"]);
    const terminal = ctx.bundle.events.listAfter(run.id, 0).at(-1)!;
    expect(terminal.data).toMatchObject({ status: "failed", reason: "no_successful_drafts" });
    expect(run.steps.filter((s) => s.stage !== "draft").every((s) => s.status === "failed" || s.status === "skipped" || s.status === "canceled")).toBe(true);
  });

  it("a failing synthesis falls back to the first successful draft, labelled as such (partial)", async () => {
    ctx = await makeServer({ profilesJson: catalog(mockProfile("mock-synth-down", { scenario: "fail", only_on_stage: "synthesis" })) });
    const convId = await createConversation(ctx);
    const agents = [
      { agent_id: uuid(), name: "Synth", profile_id: "mock-synth-down" },
      { agent_id: uuid(), name: "Other", profile_id: "mock-concise" },
    ];
    const { snapshot } = ctx.bundle.coordinator.createRun(input(convId, [], { mode: "team", agents, synthesizerAgentId: agents[0]!.agent_id }));
    await ctx.bundle.coordinator.startRun(snapshot.id);
    const run = await waitTerminal(ctx, snapshot.id);
    expect(run.status).toBe("partial");
    expect(run.presentation).toBe("draft_fallback");
    expect(run.final_answer).toContain("Draft fallback: synthesis did not finish");
    expect(run.limitations.join(" ")).toContain("Synthesis failed; presenting the first successful draft by Synth");
  });

  it("truncated provider output downgrades 'completed' to 'partial' with reason truncated_output", async () => {
    ctx = await makeServer({ profilesJson: catalog(mockProfile("mock-cut", { scenario: "truncated" })) });
    const { run } = await runIt(ctx, ["mock-cut"]);
    expect(run.status).toBe("partial");
    expect(run.limitations.join(" ")).toContain("returned truncated output; the answer is incomplete");
    expect(ctx.bundle.events.listAfter(run.id, 0).at(-1)!.data).toMatchObject({ status: "partial", reason: "truncated_output" });
  });

  it("an empty provider answer is a failed step: the run fails and no blank assistant message is written", async () => {
    ctx = await makeServer({ profilesJson: catalog(mockProfile("mock-blank", { scenario: "empty" })) });
    const { convId, run } = await runIt(ctx, ["mock-blank"]);
    expect(run.status).toBe("failed");
    expect(run.steps[0]!.status).toBe("failed");
    expect(run.steps[0]!.failure).toEqual({ code: "model_unavailable", message: "provider returned an empty answer" });
    expect(run.final_answer).toBeNull();
    expect(ctx.bundle.messages.list(convId).map((m) => m.role)).toEqual(["user"]);
    // The dispatched call is still charged conservatively.
    expect(run.usage.consumed_output_tokens).toBe(2048);
    expect(run.usage.reserved_output_tokens).toBe(0);
  });

  it("unknown provider usage is sticky: reported totals become null but the conservative ledger still charges", async () => {
    ctx = await makeServer({ profilesJson: catalog(mockProfile("mock-unknown", { scenario: "unknown_usage" })) });
    const { run } = await runIt(ctx, ["mock-balanced", "mock-unknown"]);
    expect(run.usage.input_tokens).toBeNull();
    expect(run.usage.output_tokens).toBeNull();
    expect(run.usage.consumed_output_tokens).toBeGreaterThan(0);
    expect(run.usage.reserved_output_tokens).toBe(0);
  });
});

describe("budgets and capacity at dispatch time", () => {
  it("skips steps once the harness invocation budget is spent", async () => {
    ctx = await makeServer();
    const { run } = await runIt(ctx, ["mock-balanced", "mock-analytical"], {}, (s) => {
      s.limits.max_harness_invocations = 2;
    });
    expect(run.usage.harness_invocations).toBe(2);
    const skipped = run.steps.filter((s) => s.status === "skipped");
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every((s) => s.failure!.code === "budget_exhausted")).toBe(true);
    expect(run.limitations.join(" ")).toContain("Harness invocation budget exhausted before");
    expect(run.status).toBe("partial");
  });

  it("skips steps once the output-token budget cannot cover another reservation", async () => {
    ctx = await makeServer();
    const { run } = await runIt(ctx, ["mock-balanced", "mock-analytical"], {}, (s) => {
      s.limits.total_output_tokens = 2048 * 2 + 100;
    });
    const skipped = run.steps.filter((s) => s.status === "skipped");
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped[0]!.failure).toEqual({ code: "budget_exhausted", message: "total output token budget exhausted" });
    expect(run.limitations.join(" ")).toContain("Output token budget exhausted before");
    expect(run.usage.reserved_output_tokens).toBe(0);
    expect(run.usage.consumed_output_tokens).toBeLessThanOrEqual(run.limits.total_output_tokens);
  });

  it("fails (not dispatches) a step whose real inputs no longer fit the profile, with a typed context_too_large", async () => {
    ctx = await makeServer({
      profilesJson: catalog(mockProfile("mock-tight", undefined, { safe_input_tokens: 1_000, max_output_tokens: 64 })),
    });
    const convId = await createConversation(ctx);
    const agents = [
      { agent_id: uuid(), name: "Tight1", profile_id: "mock-tight" },
      { agent_id: uuid(), name: "Tight2", profile_id: "mock-tight" },
    ];
    // Admission passes (worst case is priced with the tiny per-call cap); the actual
    // peer drafts and synthesis instructions at dispatch time are larger.
    const { snapshot } = ctx.bundle.coordinator.createRun(
      input(convId, [], { mode: "team", prompt: "hi", agents, synthesizerAgentId: agents[0]!.agent_id, limits: { max_output_tokens_per_call: 32 } }),
    );
    await ctx.bundle.coordinator.startRun(snapshot.id);
    const run = await waitTerminal(ctx, snapshot.id);
    const failed = run.steps.filter((s) => s.failure?.code === "context_too_large");
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((s) => s.invocations.length === 0)).toBe(true);
    expect(run.limitations.join(" ")).toContain("skipped: estimated");
    expect(run.status).toBe("partial");
    expect(run.usage.reserved_output_tokens).toBe(0);
  });

  it("a profile that disappears between admission and dispatch fails the step with model_unavailable", async () => {
    ctx = await makeServer();
    const { run } = await runIt(ctx, ["mock-balanced"], {}, (s) => {
      s.agents[0]!.profile_id = "ghost-profile";
    });
    expect(run.status).toBe("failed");
    expect(run.steps[0]!.failure).toEqual({ code: "model_unavailable", message: "profile not configured" });
    expect(run.usage.harness_invocations).toBe(0);
  });
});

describe("cancellation", () => {
  const SLOW = catalog(mockProfile("mock-glacial", { extra_latency_ms: 30_000 }));

  it("cancelAndFinalize on a running run commits 'canceled' atomically, normalizes steps, drains the reservation and never resurrects the run", async () => {
    ctx = await makeServer({ profilesJson: SLOW });
    const convId = await createConversation(ctx);
    const { snapshot } = ctx.bundle.coordinator.createRun(input(convId, ["mock-glacial"]));
    const started = ctx.bundle.coordinator.startRun(snapshot.id);
    await waitFor(() => ctx!.bundle.runs.get(snapshot.id)?.steps[0]?.status === "running");
    const canceled = ctx.bundle.coordinator.cancelAndFinalize(snapshot.id)!;
    expect(canceled.status).toBe("canceled");
    expect(canceled.usage.reserved_output_tokens).toBe(0);
    expect(canceled.usage.consumed_output_tokens).toBeGreaterThan(0);
    expect(canceled.external_work_status).toBe("unknown");
    expect(canceled.limitations.join(" ")).toContain("Canceled by user");
    await started;
    const stored = ctx.bundle.runs.get(snapshot.id)!;
    expect(stored.status).toBe("canceled");
    expect(stored.steps[0]!.status).toBe("canceled");
    expect(stored.steps[0]!.invocations[0]!.status).toBe("canceled");
    expect(stored.usage.reserved_output_tokens).toBe(0);
    const events = ctx.bundle.events.listAfter(snapshot.id, 0);
    expect(events.filter((e) => e.type === "run.terminal")).toHaveLength(1);
    expect(events.at(-1)!.data).toMatchObject({ status: "canceled", reason: "user_cancel" });
    // Cancelling again returns the committed snapshot untouched.
    const again = ctx.bundle.coordinator.cancelAndFinalize(snapshot.id)!;
    expect(again.status).toBe("canceled");
    expect(ctx.bundle.events.listAfter(snapshot.id, 0)).toHaveLength(events.length);
  });

  it("cancelAndFinalize returns null for an unknown run and the stored snapshot for a terminal one", async () => {
    ctx = await makeServer();
    expect(ctx.bundle.coordinator.cancelAndFinalize(uuid())).toBeNull();
    const { run } = await runIt(ctx, ["mock-balanced"]);
    expect(ctx.bundle.coordinator.cancelAndFinalize(run.id)!.status).toBe("completed");
  });

  it("cancelling a queued run that never started finalizes it; a later startRun does not execute it", async () => {
    ctx = await makeServer();
    const convId = await createConversation(ctx);
    const { snapshot } = ctx.bundle.coordinator.createRun(input(convId, ["mock-balanced"]));
    const canceled = ctx.bundle.coordinator.cancelAndFinalize(snapshot.id)!;
    expect(canceled.status).toBe("canceled");
    await ctx.bundle.coordinator.startRun(snapshot.id);
    const stored = ctx.bundle.runs.get(snapshot.id)!;
    expect(stored.status).toBe("canceled");
    expect(stored.usage.harness_invocations).toBe(0);
    expect(ctx.bundle.messages.list(convId).map((m) => m.role)).toEqual(["user"]);
  });

  it("cancelRun on an unknown or finished run is a harmless no-op", async () => {
    ctx = await makeServer();
    expect(() => ctx!.bundle.coordinator.cancelRun(uuid())).not.toThrow();
  });

  it("a canceled Team run keeps the work that finished (draft output) and stops the rest", async () => {
    ctx = await makeServer({ profilesJson: catalog(mockProfile("mock-glacial", { extra_latency_ms: 30_000, only_on_stage: undefined })) });
    const convId = await createConversation(ctx);
    const agents = [
      { agent_id: uuid(), name: "Fast", profile_id: "mock-concise" },
      { agent_id: uuid(), name: "Slow", profile_id: "mock-glacial" },
    ];
    const { snapshot } = ctx.bundle.coordinator.createRun(input(convId, [], { mode: "team", agents, synthesizerAgentId: agents[0]!.agent_id }));
    const started = ctx.bundle.coordinator.startRun(snapshot.id);
    await waitFor(() => {
      const s = ctx!.bundle.runs.get(snapshot.id)!;
      return s.steps.find((x) => x.agent_id === agents[0]!.agent_id && x.stage === "draft")?.status === "completed";
    });
    ctx.bundle.coordinator.cancelAndFinalize(snapshot.id);
    await started;
    const stored = ctx.bundle.runs.get(snapshot.id)!;
    expect(stored.status).toBe("canceled");
    const fastDraft = stored.steps.find((x) => x.agent_id === agents[0]!.agent_id && x.stage === "draft")!;
    expect(fastDraft.status).toBe("completed");
    expect(fastDraft.output).toBeTruthy();
    expect(stored.steps.filter((s) => s.stage !== "draft").every((s) => s.status === "canceled")).toBe(true);
  });
});

describe("deadlines and uncooperative adapters", () => {
  it("an adapter that never settles cannot hang the run: the per-call hard timeout fails the step and the run ends", async () => {
    ctx = await makeServer({ profilesJson: catalog(mockProfile("mock-stuck", { scenario: "never_settle" })) });
    const { run } = await runIt(ctx, ["mock-stuck"], { limits: { overall_timeout_seconds: 1, per_call_timeout_seconds: 1 } });
    expect(run.status).toBe("failed");
    expect(run.steps[0]!.failure!.code).toBe("timeout");
    expect(run.steps[0]!.invocations[0]!.status).toBe("failed");
    expect(run.usage.reserved_output_tokens).toBe(0);
    // The failed call is billed conservatively and usage is honest about it.
    expect(run.usage.consumed_output_tokens).toBe(2048);
    expect(run.usage.output_tokens).toBeNull();
  }, 20_000);

  it("a late success from an abort-ignoring adapter is discarded after the terminal commit (no double charge, no new events)", async () => {
    ctx = await makeServer({ profilesJson: catalog(mockProfile("mock-late", { scenario: "late_success", extra_latency_ms: 1_800 })) });
    const convId = await createConversation(ctx);
    const { snapshot } = ctx.bundle.coordinator.createRun(input(convId, ["mock-late"], { limits: { per_call_timeout_seconds: 1, overall_timeout_seconds: 5 } }));
    await ctx.bundle.coordinator.startRun(snapshot.id);
    const done = ctx.bundle.runs.get(snapshot.id)!;
    expect(done.status).toBe("failed");
    const before = JSON.stringify(done);
    const events = ctx.bundle.events.listAfter(snapshot.id, 0).length;
    await new Promise((r) => setTimeout(r, 1_200)); // let the late adapter promise resolve
    expect(JSON.stringify(ctx.bundle.runs.get(snapshot.id))).toBe(before);
    expect(ctx.bundle.events.listAfter(snapshot.id, 0)).toHaveLength(events);
    expect(ctx.bundle.messages.list(convId).map((m) => m.role)).toEqual(["user"]);
  }, 20_000);
});

describe("overall deadline guard (last-resort commit)", () => {
  // The guard is the backstop for a run whose stages are still pending when
  // the hard deadline passes. It is private, so these tests drive it directly
  // with realistic persisted snapshots and assert the committed outcome.
  async function guarded(mutate: (s: RunSnapshot) => void, profiles = ["mock-balanced", "mock-analytical"]) {
    ctx = await makeServer();
    const convId = await createConversation(ctx);
    const { snapshot } = ctx.bundle.coordinator.createRun(input(convId, profiles));
    const s = ctx.bundle.runs.get(snapshot.id)!;
    s.status = "running";
    mutate(s);
    ctx.bundle.runs.updateSnapshot(s);
    await (ctx.bundle.coordinator as unknown as { overallDeadlineGuard(s: RunSnapshot, ms: number): Promise<void> }).overallDeadlineGuard(s, 0);
    return { convId, committed: ctx.bundle.runs.get(snapshot.id)!, live: s };
  }

  it("commits PARTIAL with the completed synthesis as the answer", async () => {
    const { convId, committed } = await guarded((s) => {
      for (const step of s.steps) {
        step.status = "completed";
        step.output = `out-${step.stage}`;
      }
      s.steps.find((x) => x.stage === "review")!.status = "running";
    });
    expect(committed.status).toBe("partial");
    expect(committed.presentation).toBe("team_synthesis");
    expect(committed.final_answer).toBe("out-synthesis");
    expect(committed.external_work_status).toBe("unknown");
    expect(committed.limitations.join(" ")).toContain("Overall deadline exceeded");
    expect(ctx!.bundle.events.listAfter(committed.id, 0).at(-1)!.data).toMatchObject({ status: "partial", reason: "overall_deadline" });
    expect(ctx!.bundle.messages.list(convId).at(-1)).toMatchObject({ role: "assistant", text: "out-synthesis" });
    expect(committed.steps.find((x) => x.status === "running")).toBeUndefined();
  });

  it("commits PARTIAL with a labelled draft fallback when only drafts finished", async () => {
    const { convId, committed } = await guarded((s) => {
      const draft = s.steps.find((x) => x.stage === "draft")!;
      draft.status = "completed";
      draft.output = "the only draft";
    });
    expect(committed.status).toBe("partial");
    expect(committed.presentation).toBe("draft_fallback");
    expect(committed.final_answer).toContain("Draft fallback");
    expect(committed.final_answer).toContain("the only draft");
    expect(committed.limitations.join(" ")).toContain("Overall deadline cut synthesis; presenting the first successful draft by Agent0");
    expect(ctx!.bundle.messages.list(convId).at(-1)!.role).toBe("assistant");
  });

  it("commits FAILED, with no answer and no assistant message, when nothing finished", async () => {
    const { convId, committed } = await guarded(() => undefined);
    expect(committed.status).toBe("failed");
    expect(committed.final_answer).toBeNull();
    expect(ctx!.bundle.events.listAfter(committed.id, 0).at(-1)!.data).toMatchObject({ status: "failed", reason: "overall_deadline" });
    expect(ctx!.bundle.messages.list(convId).map((m) => m.role)).toEqual(["user"]);
    expect(committed.steps.every((s) => s.status === "failed")).toBe(true);
  });

  it("does nothing to a run that is already terminal", async () => {
    ctx = await makeServer();
    const { run } = await runIt(ctx, ["mock-balanced"]);
    const before = JSON.stringify(ctx.bundle.runs.get(run.id));
    await (ctx.bundle.coordinator as unknown as { overallDeadlineGuard(s: RunSnapshot, ms: number): Promise<void> }).overallDeadlineGuard(run, 0);
    expect(JSON.stringify(ctx.bundle.runs.get(run.id))).toBe(before);
  });
});

describe("startup interruption helper", () => {
  it("ignores an id whose snapshot vanished and a run that is already terminal; returns the count it marked", async () => {
    ctx = await makeServer();
    const { run } = await runIt(ctx, ["mock-balanced"]);
    const deps = { runs: ctx.bundle.runs, events: ctx.bundle.events, conversations: ctx.bundle.conversations, db: ctx.bundle.db };
    expect(Coordinator.markInterruptedOnStartup(deps)).toBe(0);
    vi.spyOn(ctx.bundle.runs, "activeRunIds").mockReturnValue([run.id, uuid()]);
    expect(Coordinator.markInterruptedOnStartup(deps)).toBe(0);
    expect(ctx.bundle.runs.get(run.id)!.status).toBe("completed");
  });
});

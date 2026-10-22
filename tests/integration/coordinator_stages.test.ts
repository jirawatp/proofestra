// Stage-by-stage coordinator control flow with a scripted adapter: cancellation
// at every stage, concurrency gates, aborted signals, and defensive paths for
// persisted state that no longer matches what admission froze.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateRunInput } from "../../src/core/coordinator.js";
import { AdapterFailure } from "../../src/providers/types.js";
import type { AdapterRequest, AdapterResult } from "../../src/providers/types.js";
import { createConversation, makeServer, seedAttachment, waitFor, waitTerminal, type ServerCtx } from "./_server_helpers.js";
import type { RunSnapshot } from "../../src/shared/types.js";

let ctx: ServerCtx | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await ctx?.cleanup();
  ctx = null;
});

const uuid = () => crypto.randomUUID();

type Script = (req: AdapterRequest) => Promise<AdapterResult> | AdapterResult;

function okResult(req: AdapterRequest, text = `scripted ${req.stage} by ${req.agent.name}`): AdapterResult {
  return { text, findings: [], usage: { input_tokens: 3, output_tokens: 4 }, provider: "mock", model_id: "scripted" };
}

// Replace the mock adapter of the running coordinator with a scripted one.
function script(c: ServerCtx, generate: Script): AdapterRequest[] {
  const seen: AdapterRequest[] = [];
  const adapters = (c.bundle.coordinator as unknown as { adapters: { adapters: Record<string, unknown> } }).adapters.adapters;
  adapters.mock = {
    provider: "mock",
    supports: () => true,
    readiness: () => "configured",
    generate: async (req: AdapterRequest) => {
      seen.push(req);
      return generate(req);
    },
  };
  return seen;
}

// A promise that rejects with the adapter-style abort once the run's signal fires.
const untilAborted = (req: AdapterRequest): Promise<never> =>
  new Promise((_resolve, reject) => {
    if (req.signal.aborted) reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    req.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  });

function teamInput(conversationId: string, n: number, over: Partial<CreateRunInput> = {}): CreateRunInput {
  const agents = Array.from({ length: n }, (_, i) => ({ agent_id: uuid(), name: `S${i}`, profile_id: "mock-balanced" }));
  return {
    conversationId,
    prompt: "go",
    mode: n > 1 ? "team" : "quick",
    executionMode: "mock",
    agents,
    synthesizerAgentId: n > 1 ? agents[0]!.agent_id : null,
    idempotencyKey: uuid(),
    ...over,
  };
}

async function start(c: ServerCtx, input: (id: string) => CreateRunInput) {
  const convId = await createConversation(c);
  const { snapshot } = c.bundle.coordinator.createRun(input(convId));
  return { convId, id: snapshot.id, started: c.bundle.coordinator.startRun(snapshot.id) };
}

const stageRunning = (c: ServerCtx, id: string, stage: string) => () =>
  c.bundle.runs.get(id)!.steps.some((s) => s.stage === stage && s.status === "running");

describe("cancellation at each stage", () => {
  it("during the review stage: drafts are kept, reviews/synthesis are canceled, one terminal event", async () => {
    ctx = await makeServer();
    script(ctx, (req) => (req.stage === "review" ? untilAborted(req) : okResult(req)));
    const { id, started } = await start(ctx, (c) => teamInput(c, 2));
    await waitFor(stageRunning(ctx, id, "review"));
    const canceled = ctx.bundle.coordinator.cancelAndFinalize(id)!;
    await started;
    const stored = ctx.bundle.runs.get(id)!;
    expect(canceled.status).toBe("canceled");
    expect(stored.status).toBe("canceled");
    expect(stored.steps.filter((s) => s.stage === "draft").every((s) => s.status === "completed")).toBe(true);
    expect(stored.steps.filter((s) => s.stage !== "draft").every((s) => s.status === "canceled")).toBe(true);
    expect(stored.steps.find((s) => s.stage === "synthesis")!.invocations).toHaveLength(0);
    expect(ctx.bundle.events.listAfter(id, 0).filter((e) => e.type === "run.terminal")).toHaveLength(1);
    expect(stored.final_answer).toBeNull();
  });

  it("during synthesis: no draft fallback is published after the cancel, and no assistant message exists", async () => {
    ctx = await makeServer();
    script(ctx, (req) => (req.stage === "synthesis" ? untilAborted(req) : okResult(req)));
    const { convId, id, started } = await start(ctx, (c) => teamInput(c, 2));
    await waitFor(stageRunning(ctx, id, "synthesis"));
    ctx.bundle.coordinator.cancelAndFinalize(id);
    await started;
    const stored = ctx.bundle.runs.get(id)!;
    expect(stored.status).toBe("canceled");
    expect(stored.presentation).toBe("none");
    expect(ctx.bundle.messages.list(convId).map((m) => m.role)).toEqual(["user"]);
  });

  it("with concurrency 1, steps still waiting for a slot never dispatch once the run is canceled", async () => {
    ctx = await makeServer();
    const seen = script(ctx, (req) => untilAborted(req));
    const { id, started } = await start(ctx, (c) => teamInput(c, 3, { limits: { concurrency: 1, per_provider_concurrency: 1 } }));
    await waitFor(() => seen.length === 1);
    ctx.bundle.coordinator.cancelAndFinalize(id);
    await started;
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toHaveLength(1);
    const stored = ctx.bundle.runs.get(id)!;
    expect(stored.steps.every((s) => s.status === "canceled")).toBe(true);
    expect(stored.usage.reserved_output_tokens).toBe(0);
  });
});

describe("a fired abort signal that has not been finalized", () => {
  it("running steps fail as 'canceled', undispatched steps are canceled before dispatch, and the run FAILS (nothing succeeded)", async () => {
    ctx = await makeServer();
    const seen = script(ctx, (req) => untilAborted(req));
    const { id, started } = await start(ctx, (c) => teamInput(c, 2, { limits: { concurrency: 1, per_provider_concurrency: 1 } }));
    await waitFor(() => seen.length === 1);
    ctx.bundle.coordinator.cancelRun(id); // abort only; no finalize
    await started;
    const stored = ctx.bundle.runs.get(id)!;
    expect(seen).toHaveLength(1);
    const drafts = stored.steps.filter((s) => s.stage === "draft");
    expect(drafts.map((d) => d.status)).toEqual(["canceled", "canceled"]);
    expect(drafts[0]!.failure).toEqual({ code: "canceled", message: "aborted" });
    expect(drafts[0]!.invocations[0]!.status).toBe("canceled");
    expect(drafts[1]!.failure).toEqual({ code: "canceled", message: "canceled before dispatch" });
    expect(drafts[1]!.invocations).toHaveLength(0);
    expect(stored.status).toBe("failed");
    expect(ctx.bundle.events.listAfter(id, 0).at(-1)!.data).toMatchObject({ reason: "no_successful_drafts" });
    expect(stored.usage.reserved_output_tokens).toBe(0);
  });

  it("the overall timeout aborts the signal: a cooperative adapter ends the run well before the grace period", async () => {
    ctx = await makeServer();
    script(ctx, (req) => untilAborted(req));
    const started = Date.now();
    const { id, started: done } = await start(ctx, (c) => teamInput(c, 1, { limits: { overall_timeout_seconds: 1, per_call_timeout_seconds: 5 } }));
    await done;
    const stored = ctx.bundle.runs.get(id)!;
    expect(stored.status).toBe("failed");
    expect(Date.now() - started).toBeLessThan(2_800);
    expect(stored.steps[0]!.failure!.code === "canceled" || stored.steps[0]!.failure!.code === "timeout").toBe(true);
  }, 15_000);
});

describe("persisted state that drifted after admission", () => {
  it("a Team snapshot without its synthesis step fails the run with reason synthesis_missing (drafts and reviews are kept)", async () => {
    ctx = await makeServer();
    const convId = await createConversation(ctx);
    const { snapshot } = ctx.bundle.coordinator.createRun(teamInput(convId, 2));
    const s = ctx.bundle.runs.get(snapshot.id)!;
    s.steps = s.steps.filter((x) => x.stage !== "synthesis");
    ctx.bundle.runs.updateSnapshot(s);
    await ctx.bundle.coordinator.startRun(snapshot.id);
    const run = await waitTerminal(ctx, snapshot.id);
    expect(run.status).toBe("failed");
    expect(ctx.bundle.events.listAfter(snapshot.id, 0).at(-1)!.data).toMatchObject({ status: "failed", reason: "synthesis_missing" });
    expect(run.steps.filter((x) => x.stage === "draft").every((x) => x.status === "completed")).toBe(true);
    expect(ctx.bundle.messages.list(convId).map((m) => m.role)).toEqual(["user"]);
  });

  it("an attachment row that vanished before dispatch crashes the run safely: failed/coordinator_crash, bounded message, reservation drained", async () => {
    ctx = await makeServer({ config: { liveEnabled: true, providerCredentials: { openaiKey: "sk-test-FAKE", anthropicKey: null, googleKey: null } } });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const convId = await createConversation(ctx);
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f000500010191a1b1a60000000049454e44ae426082", "hex");
    png.writeUInt32BE(8, 16);
    png.writeUInt32BE(8, 20);
    const att = seedAttachment(ctx, convId, { kind: "image", mime: "image/png", bytes: png, width: 8, height: 8 });
    const { snapshot } = ctx.bundle.coordinator.createRun({
      ...teamInput(convId, 1, { executionMode: "live", attachmentIds: [att.id] }),
      agents: [{ agent_id: uuid(), name: "L", profile_id: "openai-default" }],
    });
    expect(snapshot.context.attachment_coverage![0]!.routes[0]!.route).toBe("native_image");
    ctx.bundle.db.db.exec("PRAGMA foreign_keys = OFF");
    ctx.bundle.db.prepare("DELETE FROM message_attachments WHERE attachment_id = ?").run(att.id);
    ctx.bundle.db.prepare("DELETE FROM attachments WHERE id = ?").run(att.id);
    ctx.bundle.db.db.exec("PRAGMA foreign_keys = ON");
    await ctx.bundle.coordinator.startRun(snapshot.id);
    const run = await waitTerminal(ctx, snapshot.id);
    expect(run.status).toBe("failed");
    const terminal = ctx.bundle.events.listAfter(snapshot.id, 0).at(-1)!;
    expect(terminal.data).toMatchObject({ status: "failed", reason: "coordinator_crash" });
    expect(String((terminal.data as { message: string }).message).length).toBeLessThanOrEqual(160);
    expect(run.usage.reserved_output_tokens).toBe(0);
    expect(run.steps[0]!.status).toBe("failed");
    expect(run.external_work_status).toBe("unknown");
    expect(errorLog.mock.calls.some((c) => String(c[0]).includes("executeRun crashed"))).toBe(true);
  });

  it("an extracted-text attachment whose row vanished is sent as an empty extract rather than failing the run", async () => {
    const seen: string[] = [];
    ctx = await makeServer();
    script(ctx, (req) => {
      seen.push(JSON.stringify(req.user_messages));
      return okResult(req);
    });
    const convId = await createConversation(ctx);
    const att = seedAttachment(ctx, convId, { kind: "text", mime: "text/plain", name: "gone.txt", extractedText: "will vanish", extractionStatus: "text_extracted" });
    const { snapshot } = ctx.bundle.coordinator.createRun(teamInput(convId, 1, { attachmentIds: [att.id] }));
    ctx.bundle.db.db.exec("PRAGMA foreign_keys = OFF");
    ctx.bundle.db.prepare("DELETE FROM message_attachments WHERE attachment_id = ?").run(att.id);
    ctx.bundle.db.prepare("DELETE FROM attachments WHERE id = ?").run(att.id);
    ctx.bundle.db.db.exec("PRAGMA foreign_keys = ON");
    await ctx.bundle.coordinator.startRun(snapshot.id);
    const run = await waitTerminal(ctx, snapshot.id);
    expect(run.status).toBe("completed");
    expect(seen).toHaveLength(1);
  });

  it("an attachment-only send (no prompt text) projects only the attachment parts", async () => {
    ctx = await makeServer();
    const seen = script(ctx, (req) => okResult(req));
    const convId = await createConversation(ctx);
    const att = seedAttachment(ctx, convId, { kind: "text", mime: "text/plain", name: "only.txt", extractedText: "body", extractionStatus: "text_extracted" });
    const { snapshot } = ctx.bundle.coordinator.createRun(teamInput(convId, 1, { prompt: "", attachmentIds: [att.id] }));
    await ctx.bundle.coordinator.startRun(snapshot.id);
    await waitTerminal(ctx, snapshot.id);
    const parts = seen[0]!.user_messages.at(-1)!.parts!;
    expect(parts.some((p) => p.kind === "text")).toBe(false);
    expect(parts.map((p) => p.kind)).toEqual(["attachment_extracted_text"]);
  });
});

describe("terminal-state idempotence", () => {
  it("finalizing an already-final run changes nothing", async () => {
    ctx = await makeServer();
    script(ctx, (req) => okResult(req));
    const { convId, id, started } = await start(ctx, (c) => teamInput(c, 1));
    await started;
    const done = ctx.bundle.runs.get(id)!;
    const before = JSON.stringify(done);
    const events = ctx.bundle.events.listAfter(id, 0).length;
    const c = ctx.bundle.coordinator as unknown as { finalize(s: RunSnapshot, st: string, d: object): void };
    c.finalize(done, "failed", { reason: "late" });
    expect(JSON.stringify(ctx.bundle.runs.get(id))).toBe(before);
    expect(ctx.bundle.events.listAfter(id, 0)).toHaveLength(events);
    expect(ctx.bundle.messages.list(convId).filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("never writes a second assistant message for the same run", async () => {
    ctx = await makeServer();
    script(ctx, (req) => okResult(req));
    const convId = await createConversation(ctx);
    const { snapshot } = ctx.bundle.coordinator.createRun(teamInput(convId, 1));
    ctx.bundle.messages.insert({
      id: uuid(),
      conversation_id: convId,
      run_id: snapshot.id,
      role: "assistant",
      text: "already written",
      sequence: ctx.bundle.messages.nextSequence(convId),
      created_at: new Date().toISOString(),
    });
    await ctx.bundle.coordinator.startRun(snapshot.id);
    await waitTerminal(ctx, snapshot.id);
    const assistants = ctx.bundle.messages.list(convId).filter((m) => m.role === "assistant");
    expect(assistants.map((m) => m.text)).toEqual(["already written"]);
  });

  it("commitAssistantMessage is null for unknown runs and for runs that produced no answer", async () => {
    ctx = await makeServer();
    expect(ctx.bundle.coordinator.commitAssistantMessage(uuid())).toBeNull();
    script(ctx, () => {
      throw new AdapterFailure({ code: "provider_unavailable", message: "down" });
    });
    const { id, started } = await start(ctx, (c) => teamInput(c, 1));
    await started;
    expect(ctx.bundle.runs.get(id)!.status).toBe("failed");
    expect(ctx.bundle.coordinator.commitAssistantMessage(id)).toBeNull();
  });

  it("a step's adapter result that arrives after the run was canceled is discarded without double-charging", async () => {
    ctx = await makeServer();
    let release!: (r: AdapterResult) => void;
    const late = new Promise<AdapterResult>((resolve) => (release = resolve));
    const seen = script(ctx, () => late);
    const { id, started } = await start(ctx, (c) => teamInput(c, 1));
    await waitFor(() => seen.length === 1);
    ctx.bundle.coordinator.cancelAndFinalize(id);
    const afterCancel = JSON.stringify(ctx.bundle.runs.get(id));
    release(okResult(seen[0]!));
    await started;
    expect(JSON.stringify(ctx.bundle.runs.get(id))).toBe(afterCancel);
    expect(ctx.bundle.runs.get(id)!.usage.reserved_output_tokens).toBe(0);
  });

  it("a step that FAILS after the run was canceled is also discarded", async () => {
    ctx = await makeServer();
    let fail!: (e: Error) => void;
    const late = new Promise<AdapterResult>((_r, reject) => (fail = reject));
    const seen = script(ctx, () => late);
    const { id, started } = await start(ctx, (c) => teamInput(c, 1));
    await waitFor(() => seen.length === 1);
    ctx.bundle.coordinator.cancelAndFinalize(id);
    const afterCancel = JSON.stringify(ctx.bundle.runs.get(id));
    fail(new Error("boom"));
    await started;
    expect(JSON.stringify(ctx.bundle.runs.get(id))).toBe(afterCancel);
  });
});

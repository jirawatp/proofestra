// Native (Codex CLI) backend through the real coordinator, store and routes,
// against a FAKE `codex` executable and an injected fetch that fails the test
// if any API call is made. Proves backend-keyed dispatch, frozen admission
// policy, fail-closed readiness, native-job accounting, and that private
// native events never reach the snapshot or export. This is NOT evidence that
// a real Codex job is safe or that the real login works.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoordinatorError, type CreateRunInput } from "../../src/core/coordinator.js";
import { CodexCliAdapter } from "../../src/providers/codexCli.js";
import type { ProofestraConfig } from "../../src/shared/config.js";
import type { RunSnapshot } from "../../src/shared/types.js";
import {
  TEST_COMPLETE_VERIFICATION,
  ev,
  makeFakeCodex,
  okTranscript,
  type FakeCodex,
  type FakeCodexSpec,
} from "../adapters/_fakeCodex.js";
import { createConversation, makeServer, waitTerminal, type ServerCtx } from "./_server_helpers.js";

let ctx: ServerCtx | null = null;
const fakes: FakeCodex[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await ctx?.cleanup();
  ctx = null;
  for (const f of fakes.splice(0)) f.cleanup();
});

const uuid = () => crypto.randomUUID();

/** A fetch that records any call: a native run must never reach it. */
function noApiFetch() {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    throw new Error("API must not be called for a native backend");
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

async function nativeServer(spec: FakeCodexSpec, opts: { verified: boolean; liveEnabled?: boolean }) {
  const fake = makeFakeCodex(spec);
  fakes.push(fake);
  const api = noApiFetch();
  const config: Partial<ProofestraConfig> = {
    liveEnabled: opts.liveEnabled ?? true,
    // API credentials ARE present: the only thing stopping an API fallback is dispatch policy.
    providerCredentials: { openaiKey: "sk-test-FAKE-must-not-be-used", anthropicKey: null, googleKey: "g-FAKE" },
    nativeBackends: {
      codex: {
        enabled: true,
        model: "gpt-5.6-sol",
        executable: fake.bin,
        codexHome: null,
        ...(opts.verified ? { verification: TEST_COMPLETE_VERIFICATION } : {}),
      },
    },
  };
  ctx = await makeServer({ config, buildOptions: { fetchImpl: api.fetchImpl } });
  return { fake, api, ctx };
}

function liveInput(conversationId: string, profiles: string[], over: Partial<CreateRunInput> = {}): CreateRunInput {
  const agents = profiles.map((profile_id, i) => ({ agent_id: uuid(), name: `N${i}`, profile_id }));
  const isTeam = profiles.length > 1;
  return {
    conversationId,
    prompt: "Say hello",
    mode: isTeam ? "team" : "quick",
    executionMode: "live",
    agents,
    synthesizerAgentId: isTeam ? agents[0]!.agent_id : null,
    idempotencyKey: uuid(),
    // A native job is opaque and has no enforceable output ceiling, so it must
    // be requested explicitly as a bounded job (strict is refused, see below).
    tool_policy: { bounds_mode: "bounded_job", allow_unknown_internal_usage: true },
    ...over,
  };
}

async function runToEnd(c: ServerCtx, input: CreateRunInput): Promise<RunSnapshot> {
  const { snapshot } = c.bundle.coordinator.createRun(input);
  await c.bundle.coordinator.startRun(snapshot.id);
  return waitTerminal(c, snapshot.id);
}

function refusal(c: ServerCtx, input: CreateRunInput): CoordinatorError {
  try {
    c.bundle.coordinator.createRun(input);
  } catch (err) {
    expect(err).toBeInstanceOf(CoordinatorError);
    return err as CoordinatorError;
  }
  throw new Error("expected refusal");
}

describe("fail-closed admission with the real verification record", () => {
  it("refuses a Live run on the native profile (readiness=unverified) and touches neither the CLI nor the API", async () => {
    const { fake, api, ctx: c } = await nativeServer({ exec: { lines: okTranscript() } }, { verified: false });
    const conv = await createConversation(c);
    const e = refusal(c, liveInput(conv, ["codex-local-default"]));
    expect({ status: e.httpStatus, code: e.code }).toEqual({ status: 422, code: "backend_not_ready" });
    expect(e.message).toContain("readiness=unverified");
    expect(fake.calls()).toEqual([]);
    expect(api.calls).toEqual([]);
    expect(c.bundle.runs.countActive()).toBe(0);
  });

  it("publishes the exact blocked state to the UI without paths, versions, login state or vendor text", async () => {
    const { fake, ctx: c } = await nativeServer({}, { verified: false });
    const resp = await c.app.inject({ method: "GET", url: "/api/v1/providers", headers: c.headers() });
    expect(resp.statusCode).toBe(200);
    const body = resp.json() as {
      native_backends: Array<Record<string, unknown>>;
      items: Array<{ profiles: Array<{ profile_id: string; readiness: string; execution_backend_id: string }> }>;
    };
    const codex = body.native_backends.find((b) => b.backend_id === "codex-local-cli")!;
    expect(codex).toMatchObject({
      readiness: "unverified",
      reason_code: "tool_surface_unproven",
      credentials: "vendor_managed",
      billing: "subscription_quota_cost_unknown",
      tool_surface: "unproven",
    });
    expect(codex.unproven_controls).toEqual(expect.arrayContaining(["unified_exec_not_disableable", "apply_patch_not_removable"]));
    expect(body.native_backends.find((b) => b.backend_id === "antigravity-local-cli")).toMatchObject({
      readiness: "unverified",
      reason_code: "protocol_unverified",
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain(fake.bin);
    expect(text).not.toContain(os.homedir());
    expect(text).not.toMatch(/FAKE-must-not-be-used|0\.163\.0|auth\.json/);
    const profile = body.items.flatMap((i) => i.profiles).find((p) => p.profile_id === "codex-local-default")!;
    expect(profile).toMatchObject({ readiness: "unverified", execution_backend_id: "codex-local-cli" });
    // The OpenAI API profile is a separate backend and stays configured.
    const api = body.items.flatMap((i) => i.profiles).find((p) => p.profile_id === "openai-default")!;
    expect(api).toMatchObject({ readiness: "configured", execution_backend_id: "openai-chat-completions" });
  });

  it("a Live-disabled server reports the exact reason and keeps the native profile unusable", async () => {
    const { ctx: c } = await nativeServer({}, { verified: true, liveEnabled: false });
    const body = (await c.app.inject({ method: "GET", url: "/api/v1/providers", headers: c.headers() })).json() as {
      native_backends: Array<{ backend_id: string; readiness: string; reason_code: string }>;
    };
    expect(body.native_backends.find((b) => b.backend_id === "codex-local-cli")).toMatchObject({
      readiness: "disabled",
      reason_code: "live_disabled",
    });
    const conv = await createConversation(c);
    expect(refusal(c, liveInput(conv, ["codex-local-default"])).code).toBe("live_disabled");
  });

  it("an Antigravity profile can be declared but never admitted or executed", async () => {
    const fake = makeFakeCodex({});
    fakes.push(fake);
    const api = noApiFetch();
    ctx = await makeServer({
      config: { liveEnabled: true, providerCredentials: { openaiKey: null, anthropicKey: null, googleKey: "g-FAKE-must-not-be-used" } },
      buildOptions: { fetchImpl: api.fetchImpl },
      profilesJson: {
        mode: "append",
        profiles: [
          {
            profile_id: "agy-local",
            provider: "gemini",
            label: "Antigravity",
            model_id: "agy-model",
            safe_input_tokens: 64_000,
            max_output_tokens: 2048,
            api_shape: "antigravity_cli",
            execution_backend_id: "antigravity-local-cli",
          },
        ],
      },
    });
    const conv = await createConversation(ctx);
    const e = refusal(ctx, liveInput(conv, ["agy-local"]));
    expect({ status: e.httpStatus, code: e.code }).toEqual({ status: 422, code: "backend_not_ready" });
    expect(e.message).toContain("readiness=unverified");
    expect(api.calls).toEqual([]);
    expect(fake.calls()).toEqual([]);
  });

  it("a native profile whose model id cannot be pinned safely is refused even when the backend is configured", async () => {
    const fake = makeFakeCodex({});
    fakes.push(fake);
    ctx = await makeServer({
      config: {
        liveEnabled: true,
        nativeBackends: { codex: { enabled: true, model: "gpt-5.6-sol", executable: fake.bin, codexHome: null, verification: TEST_COMPLETE_VERIFICATION } },
      },
      profilesJson: {
        mode: "append",
        profiles: [
          {
            profile_id: "codex-bad-model",
            provider: "openai",
            label: "bad",
            model_id: "bad model; id",
            safe_input_tokens: 64_000,
            max_output_tokens: 2048,
            api_shape: "codex_exec_cli",
            execution_backend_id: "codex-local-cli",
          },
        ],
      },
    });
    const conv = await createConversation(ctx);
    const e = refusal(ctx, liveInput(conv, ["codex-bad-model"]));
    expect(e.code).toBe("backend_not_ready");
    expect(e.message).toContain("cannot be frozen");
    expect(fake.calls()).toEqual([]);
  });
});

describe("a (test-only) fully verified policy: dispatch, freeze and accounting", () => {
  it("runs through the native backend, never the API, and records an honest frozen policy", async () => {
    const { fake, api, ctx: c } = await nativeServer({ exec: { lines: okTranscript("Hello from codex."), exitCode: 0 } }, { verified: true });
    const conv = await createConversation(c);
    const snap = await runToEnd(c, liveInput(conv, ["codex-local-default"]));
    expect(snap.status).toBe("completed");
    expect(snap.final_answer).toBe("Hello from codex.");
    // Backend-keyed dispatch: the API (with a credential present) was never touched.
    expect(api.calls).toEqual([]);
    expect(fake.execCalls()).toHaveLength(1);
    // Frozen policy at admission.
    expect(snap.native_backends).toHaveLength(1);
    expect(snap.native_backends![0]).toMatchObject({
      backend_id: "codex-local-cli",
      model_id: "gpt-5.6-sol",
      policy_id: "codex-exec-notools-v1",
      tool_surface: "proven_off",
      permissions: { sandbox: "read-only", approvals: "never", env: "credential_free" },
      max_native_job_seconds: 120,
    });
    expect(snap.agents[0]!.execution_backend_id).toBe("codex-local-cli");
    const invocation = snap.steps[0]!.invocations[0]!;
    expect(invocation.execution_backend_id).toBe("codex-local-cli");
    // Native accounting: counted as a native job, internals opaque, cost NEVER $0.
    expect(snap.usage).toMatchObject({
      harness_invocations: 1,
      native_jobs_started: 1,
      internal_usage_visibility: "opaque",
      input_tokens: 120,
      output_tokens: 34,
      estimated_cost_usd: null,
      cost_scope: "unknown",
    });
    expect(invocation.usage).toMatchObject({ native_jobs_started: 1, internal_usage_visibility: "opaque", estimated_cost_usd: null });
    // Private reasoning and the real paths never reach the snapshot or the export.
    const exported = await c.app.inject({ method: "GET", url: `/api/v1/conversations/${conv}/export`, headers: c.headers() });
    for (const text of [JSON.stringify(snap), exported.payload]) {
      expect(text).not.toContain("PRIVATE-REASONING-MARKER");
      expect(text).not.toContain(fake.bin);
      expect(text).not.toContain("FAKE-must-not-be-used");
    }
  });

  it("a native step uses the native wallclock limit and reported-usage ledger, not the API per-call timeout", async () => {
    const { fake, ctx: c } = await nativeServer({ exec: { lines: okTranscript(), exitCode: 0 } }, { verified: true });
    const conv = await createConversation(c);
    const snap = await runToEnd(c, liveInput(conv, ["codex-local-default"], { limits: { per_call_timeout_seconds: 1, max_native_job_seconds: 60 } }));
    expect(snap.status).toBe("completed");
    const inv = snap.steps[0]!.invocations[0]!;
    const window = Date.parse(inv.deadline_at) - Date.parse(inv.started_at!);
    expect(window).toBeGreaterThan(30_000);
    expect(window).toBeLessThanOrEqual(60_000);
    expect(snap.usage.consumed_output_tokens).toBe(34);
    expect(fake.execCalls()).toHaveLength(1);
  });

  it("a Team of native agents needs native-job headroom at admission, then runs every stage as its own isolated job", async () => {
    const { fake, api, ctx: c } = await nativeServer({ exec: { lines: okTranscript("Team answer."), exitCode: 0 } }, { verified: true });
    const conv = await createConversation(c);
    // 2 drafts + 2 reviews + 1 synthesis = 5 native jobs > default max_native_jobs 4.
    const e = refusal(c, liveInput(conv, ["codex-local-default", "codex-local-default"]));
    expect({ status: e.httpStatus, code: e.code }).toEqual({ status: 422, code: "limits_exceeded" });
    expect(e.message).toContain("planned native jobs=5 > max_native_jobs=4");
    expect(fake.calls()).toEqual([]);

    const snap = await runToEnd(c, liveInput(conv, ["codex-local-default", "codex-local-default"], { limits: { max_native_jobs: 5 } }));
    expect(snap.status).toBe("completed");
    expect(snap.usage.native_jobs_started).toBe(5);
    expect(snap.native_backends).toHaveLength(1); // one policy per backend+model, not per agent
    const execs = fake.execCalls();
    expect(execs).toHaveLength(5);
    // Every job: its own scratch dir, empty at start.
    expect(new Set(execs.map((x) => x.cwd)).size).toBe(5);
    expect(execs.every((x) => x.cwdEntries.length === 0)).toBe(true);
    expect(api.calls).toEqual([]);
  });

  it("a tool event fails the step and the run, and no tool payload reaches the snapshot or export", async () => {
    const lines = [ev.thread, ev.turn, ev.item("command_execution", { command: "rm -rf /secret-target", aggregated_output: "TOOL-OUTPUT-MARKER" }), ev.message("TAINTED"), ev.done()];
    const { api, ctx: c } = await nativeServer({ exec: { lines, hang: true } }, { verified: true });
    const conv = await createConversation(c);
    const snap = await runToEnd(c, liveInput(conv, ["codex-local-default"]));
    expect(snap.status).toBe("failed");
    expect(snap.steps[0]!.failure).toEqual({ code: "invalid_request", message: "codex-local-cli: invalid_request (policy_violation)" });
    expect(snap.final_answer).toBeNull();
    expect(api.calls).toEqual([]);
    const exported = await c.app.inject({ method: "GET", url: `/api/v1/conversations/${conv}/export`, headers: c.headers() });
    for (const text of [JSON.stringify(snap), exported.payload]) {
      expect(text).not.toMatch(/rm -rf|TOOL-OUTPUT-MARKER|TAINTED/);
    }
    // A failed dispatched job is charged conservatively and its usage stays unknown, never zero.
    expect(snap.usage.consumed_output_tokens).toBeGreaterThan(0);
    expect(snap.usage.output_tokens).toBeNull();
    expect(snap.usage.estimated_cost_usd).toBeNull();
  });

  it("a vendor failure surfaces only as a fixed code (auth) with no vendor text in the run", async () => {
    const lines = [ev.thread, ev.turn, ev.failed("not logged in; token abc.SECRET at /Users/someone/.codex/auth.json")];
    const { ctx: c } = await nativeServer({ exec: { lines, exitCode: 1 } }, { verified: true });
    const conv = await createConversation(c);
    const snap = await runToEnd(c, liveInput(conv, ["codex-local-default"]));
    expect(snap.status).toBe("failed");
    expect(snap.steps[0]!.failure).toEqual({ code: "authentication", message: "codex-local-cli: authentication (incomplete)" });
    expect(JSON.stringify(snap)).not.toMatch(/SECRET|auth\.json|someone/);
  });

  it("canceling the run kills the native job's whole process tree", async () => {
    const pidFile = path.join(os.tmpdir(), `pf-native-cancel-${process.pid}-${Date.now()}.pid`);
    const { fake, ctx: c } = await nativeServer({ exec: { lines: [ev.thread, ev.turn], hang: true, grandchildPidFile: pidFile } }, { verified: true });
    const conv = await createConversation(c);
    const { snapshot } = c.bundle.coordinator.createRun(liveInput(conv, ["codex-local-default"]));
    const started = c.bundle.coordinator.startRun(snapshot.id);
    for (let i = 0; i < 200 && !fs.existsSync(pidFile); i += 1) await new Promise((r) => setTimeout(r, 25));
    expect(fake.execCalls()).toHaveLength(1);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    c.bundle.coordinator.cancelAndFinalize(snapshot.id);
    await started;
    const final = await waitTerminal(c, snapshot.id);
    expect(final.status).toBe("canceled");
    // The job's remote effects are not known to have stopped: never "none".
    expect(final.external_work_status).toBe("unknown");
    expect(final.usage.native_jobs_started).toBe(1);
    let alive = true;
    for (let i = 0; i < 100 && alive; i += 1) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 30));
      } catch {
        alive = false;
      }
    }
    fs.rmSync(pidFile, { force: true });
    expect(alive).toBe(false);
    // The job was launched and stopped locally: its external effects are unknown.
    expect(final.external_work_status).toBe("unknown");
  });
});

describe("dispatch re-checks the FROZEN policy (a tampered stored snapshot is refused)", () => {
  async function tampered(mutate: (s: RunSnapshot) => void) {
    const { fake, api, ctx: c } = await nativeServer({ exec: { lines: okTranscript() } }, { verified: true });
    const conv = await createConversation(c);
    const { snapshot } = c.bundle.coordinator.createRun(liveInput(conv, ["codex-local-default"]));
    const stored = c.bundle.runs.get(snapshot.id)!;
    mutate(stored);
    c.bundle.runs.updateSnapshot(stored);
    await c.bundle.coordinator.startRun(snapshot.id);
    return { fake, api, snap: await waitTerminal(c, snapshot.id) };
  }

  it("missing frozen native policy => the step fails before anything runs", async () => {
    const { fake, api, snap } = await tampered((s) => delete s.native_backends);
    expect(snap.steps[0]!.failure).toEqual({ code: "invalid_request", message: "native backend policy was not frozen" });
    expect(fake.calls()).toEqual([]);
    expect(api.calls).toEqual([]);
  });

  it("an agent relabeled to the API backend is refused (no silent API reroute)", async () => {
    const { fake, api, snap } = await tampered((s) => {
      s.agents[0]!.execution_backend_id = "openai-chat-completions";
    });
    expect(snap.steps[0]!.failure).toEqual({ code: "invalid_request", message: "profile backend changed since admission" });
    expect(fake.calls()).toEqual([]);
    expect(api.calls).toEqual([]);
  });

  it("an exhausted native-job budget skips the step instead of launching", async () => {
    const { fake, snap } = await tampered((s) => {
      s.usage.native_jobs_started = s.limits.max_native_jobs;
    });
    expect(snap.steps[0]!.status).toBe("skipped");
    expect(snap.steps[0]!.failure).toEqual({ code: "budget_exhausted", message: "native job budget exhausted" });
    expect(snap.limitations.join(" ")).toContain("Native job budget exhausted");
    // A Live step that never dispatched is not "simulated" usage either.
    expect(snap.steps[0]!.usage).toMatchObject({ token_scope: "harness_only", accounting: "unknown", internal_usage_visibility: "unknown", internal_model_invocations: null });
    expect(fake.calls()).toEqual([]);
  });
});

describe("requested strict/opaque policy is enforced at admission and dispatch", () => {
  const strictDefault = { tool_policy: undefined } as const;

  it("the default (strict, unknown usage not allowed) is refused before anything starts", async () => {
    const { fake, api, ctx: c } = await nativeServer({ exec: { lines: okTranscript() } }, { verified: true });
    const conv = await createConversation(c);
    for (const tool_policy of [
      strictDefault.tool_policy,
      { bounds_mode: "strict" as const },
      { bounds_mode: "bounded_job" as const },
      { bounds_mode: "strict" as const, allow_unknown_internal_usage: true },
      { allow_unknown_internal_usage: true },
    ]) {
      const input = liveInput(conv, ["codex-local-default"]);
      if (tool_policy === undefined) delete input.tool_policy;
      else input.tool_policy = tool_policy;
      const e = refusal(c, input);
      expect({ status: e.httpStatus, code: e.code }, JSON.stringify(tool_policy)).toEqual({
        status: 422,
        code: "unsupported_bounds",
      });
      expect(e.message).toContain("bounds_mode=bounded_job with allow_unknown_internal_usage=true");
    }
    expect(fake.calls()).toEqual([]);
    expect(api.calls).toEqual([]);
    expect(c.bundle.runs.countActive()).toBe(0);
  });

  it("a required control a native job cannot enforce is refused; enforceable ones are admitted", async () => {
    const { fake, ctx: c } = await nativeServer({ exec: { lines: okTranscript("fine") } }, { verified: true });
    const conv = await createConversation(c);
    const policy = (required_controls: string[]) => ({
      bounds_mode: "bounded_job" as const,
      allow_unknown_internal_usage: true,
      required_controls,
    });
    const e = refusal(c, liveInput(conv, ["codex-local-default"], { tool_policy: policy(["deadline", "output_token_ceiling"]) }));
    expect({ status: e.httpStatus, code: e.code }).toEqual({ status: 422, code: "unsupported_bounds" });
    expect(e.message).toBe("the native backend cannot enforce 1 of the requested required_controls");
    expect(fake.calls()).toEqual([]);

    const snap = await runToEnd(
      c,
      liveInput(conv, ["codex-local-default"], { tool_policy: policy(["deadline", "context_isolation", "harness_invocations"]) }),
    );
    expect(snap.status).toBe("completed");
    expect(snap.tool_policy).toMatchObject({ bounds_mode: "bounded_job", allow_unknown_internal_usage: true });
  });

  it("an unadmittable backend is reported as not ready BEFORE the strict-policy refusal; mock mode is unaffected", async () => {
    const { ctx: c } = await nativeServer({ exec: { lines: okTranscript() } }, { verified: false });
    const conv = await createConversation(c);
    const strict = liveInput(conv, ["codex-local-default"]);
    delete strict.tool_policy;
    expect(refusal(c, strict).code).toBe("backend_not_ready");
    const mock = liveInput(conv, ["codex-local-default"], { executionMode: "mock" });
    delete mock.tool_policy;
    expect((await runToEnd(c, mock)).status).toBe("completed");
  });

  it("a stored snapshot whose policy is no longer bounded_job/opaque is refused at dispatch (tampered)", async () => {
    const { fake, api, ctx: c } = await nativeServer({ exec: { lines: okTranscript() } }, { verified: true });
    const conv = await createConversation(c);
    const { snapshot } = c.bundle.coordinator.createRun(liveInput(conv, ["codex-local-default"]));
    const stored = c.bundle.runs.get(snapshot.id)!;
    stored.tool_policy.bounds_mode = "strict";
    stored.tool_policy.allow_unknown_internal_usage = false;
    c.bundle.runs.updateSnapshot(stored);
    await c.bundle.coordinator.startRun(snapshot.id);
    const snap = await waitTerminal(c, snapshot.id);
    expect(snap.steps[0]!.status).toBe("failed");
    expect(snap.steps[0]!.failure).toEqual({ code: "invalid_request", message: "native job policy was not admitted" });
    expect(fake.calls()).toEqual([]);
    expect(api.calls).toEqual([]);
  });
});

describe("native output ceiling is never a successful within-budget step", () => {
  it("reported output above the requested ceiling fails the step and charges at least the reservation plus the excess", async () => {
    const over = { input_tokens: 50, cached_input_tokens: 0, output_tokens: 900 };
    const { ctx: c } = await nativeServer({ exec: { lines: okTranscript("TOO-LONG-ANSWER-MARKER", over), exitCode: 0 } }, { verified: true });
    const conv = await createConversation(c);
    const snap = await runToEnd(c, liveInput(conv, ["codex-local-default"], { limits: { max_output_tokens_per_call: 256 } }));
    expect(snap.status).toBe("failed");
    const step = snap.steps[0]!;
    expect(step.status).toBe("failed");
    expect(step.output).toBeNull();
    expect(step.failure).toEqual({
      code: "invalid_request",
      message: "native job reported output above the requested output-token ceiling",
    });
    expect(step.findings).toEqual([]);
    // The over-long answer is not a result anywhere.
    expect(snap.final_answer).toBeNull();
    expect(JSON.stringify(snap)).not.toContain("TOO-LONG-ANSWER-MARKER");
    // Conservative ledger: reservation (256) + the excess actually reported (900-256) = 900, none left reserved.
    expect(snap.usage.consumed_output_tokens).toBe(900);
    expect(snap.usage.reserved_output_tokens).toBe(0);
    // Reported totals are unknown, never 0, at run, step and invocation level.
    for (const usage of [snap.usage, step.usage, step.invocations[0]!.usage]) {
      expect(usage).toMatchObject({ input_tokens: null, output_tokens: null, accounting: "conservative", token_scope: "partial" });
    }
  });

  it("output exactly at the ceiling is still a normal success", async () => {
    const at = { input_tokens: 10, cached_input_tokens: 0, output_tokens: 256 };
    const { ctx: c } = await nativeServer({ exec: { lines: okTranscript("ok", at), exitCode: 0 } }, { verified: true });
    const conv = await createConversation(c);
    const snap = await runToEnd(c, liveInput(conv, ["codex-local-default"], { limits: { max_output_tokens_per_call: 256 } }));
    expect(snap.status).toBe("completed");
    expect(snap.usage.consumed_output_tokens).toBe(256);
  });

  it("unreported output usage is charged the full reservation (unknown stays unknown)", async () => {
    const { ctx: c } = await nativeServer({ exec: { lines: okTranscript("ok", {}), exitCode: 0 } }, { verified: true });
    const conv = await createConversation(c);
    const snap = await runToEnd(c, liveInput(conv, ["codex-local-default"], { limits: { max_output_tokens_per_call: 256 } }));
    expect(snap.status).toBe("completed");
    expect(snap.usage.consumed_output_tokens).toBe(256);
    expect(snap.usage).toMatchObject({ output_tokens: null, accounting: "conservative", token_scope: "partial" });
  });
});

describe("native usage is honest at invocation, step and run level", () => {
  it("never inherits simulated scope, zero job counts or false internal counts, and never claims $0", async () => {
    const { ctx: c } = await nativeServer({ exec: { lines: okTranscript("Hello"), exitCode: 0 } }, { verified: true });
    const conv = await createConversation(c);
    const snap = await runToEnd(c, liveInput(conv, ["codex-local-default"]));
    expect(snap.status).toBe("completed");
    const step = snap.steps[0]!;
    const invocation = step.invocations[0]!;
    for (const [name, usage] of [
      ["run", snap.usage],
      ["step", step.usage],
      ["invocation", invocation.usage],
    ] as const) {
      expect(usage, name).toMatchObject({
        harness_invocations: 1,
        native_jobs_started: 1,
        internal_usage_visibility: "opaque",
        internal_model_invocations: null,
        internal_tool_operations: null,
        input_tokens: 120,
        output_tokens: 34,
        token_scope: "partial",
        accounting: "reported",
        estimated_cost_usd: null,
        cost_scope: "unknown",
      });
    }
    expect(JSON.stringify([snap.usage, step.usage, invocation.usage])).not.toContain("simulated");
  });

  it("a failed native job reports unknown (null) token totals at every level, not zeros", async () => {
    const { ctx: c } = await nativeServer({ exec: { lines: [ev.thread, ev.turn, ev.failed("boom")], exitCode: 1 } }, { verified: true });
    const conv = await createConversation(c);
    const snap = await runToEnd(c, liveInput(conv, ["codex-local-default"]));
    expect(snap.status).toBe("failed");
    const step = snap.steps[0]!;
    for (const usage of [snap.usage, step.usage, step.invocations[0]!.usage]) {
      expect(usage).toMatchObject({
        native_jobs_started: 1,
        harness_invocations: 1,
        internal_usage_visibility: "opaque",
        internal_model_invocations: null,
        input_tokens: null,
        output_tokens: null,
        estimated_cost_usd: null,
        cost_scope: "unknown",
      });
    }
    expect(snap.usage.consumed_output_tokens).toBeGreaterThan(0);
  });

  it("a mock run keeps its simulated, complete usage at step level (not relabeled native)", async () => {
    const { ctx: c } = await nativeServer({}, { verified: false });
    const conv = await createConversation(c);
    const mock = liveInput(conv, ["codex-local-default"], { executionMode: "mock" });
    delete mock.tool_policy;
    const snap = await runToEnd(c, mock);
    expect(snap.steps[0]!.usage).toMatchObject({ token_scope: "simulated", accounting: "simulated", internal_usage_visibility: "complete" });
    expect(snap.steps[0]!.usage.native_jobs_started).toBe(0);
  });
});

describe("subscription-only authentication through the coordinator", () => {
  it("a cached API-key login is refused before the job starts: no exec, no API call, fixed failure", async () => {
    const { fake, api, ctx: c } = await nativeServer(
      { loginText: "Logged in using an API key - sk-live-SECRET\n", exec: { lines: okTranscript() } },
      { verified: true },
    );
    const conv = await createConversation(c);
    const snap = await runToEnd(c, liveInput(conv, ["codex-local-default"]));
    expect(snap.status).toBe("failed");
    expect(snap.steps[0]!.failure).toEqual({
      code: "authentication",
      message: "codex-local-cli: authentication (auth_not_chatgpt)",
    });
    expect(fake.execCalls()).toEqual([]);
    expect(api.calls).toEqual([]);
    const exported = await c.app.inject({ method: "GET", url: `/api/v1/conversations/${conv}/export`, headers: c.headers() });
    for (const text of [JSON.stringify(snap), exported.payload]) expect(text).not.toMatch(/sk-live|SECRET/);
  });

  it("the real record keeps the auth gap visible alongside the tool-surface gap", async () => {
    const { ctx: c } = await nativeServer({}, { verified: false });
    const body = (await c.app.inject({ method: "GET", url: "/api/v1/providers", headers: c.headers() })).json() as {
      native_backends: Array<{ backend_id: string; unproven_controls: string[] }>;
    };
    expect(body.native_backends.find((b) => b.backend_id === "codex-local-cli")!.unproven_controls).toContain(
      "chatgpt_only_auth_unenforced",
    );
  });
});

describe("Mock mode ignores native profiles", () => {
  it("a mock-mode run on the native profile is served by the mock adapter and starts no process", async () => {
    const { fake, api, ctx: c } = await nativeServer({ exec: { lines: okTranscript() } }, { verified: false });
    const conv = await createConversation(c);
    const snap = await runToEnd(c, liveInput(conv, ["codex-local-default"], { executionMode: "mock" }));
    expect(snap.status).toBe("completed");
    expect(snap.native_backends).toBeUndefined();
    expect(snap.usage.native_jobs_started).toBe(0);
    expect(fake.calls()).toEqual([]);
    expect(api.calls).toEqual([]);
  });
});

describe("a native job that times out or is abandoned: bounded, exactly-once, external work unknown", () => {
  it("the job's own wallclock limit fails the step once, with unknown external work and one reservation charged", async () => {
    const pidFile = path.join(os.tmpdir(), `pf-native-timeout-${process.pid}-${Date.now()}.pid`);
    const { fake, ctx: c } = await nativeServer({ exec: { lines: [ev.thread, ev.turn], hang: true, grandchildPidFile: pidFile } }, { verified: true });
    const conv = await createConversation(c);
    const snap = await runToEnd(c, liveInput(conv, ["codex-local-default"], { limits: { max_native_job_seconds: 1 } }));
    expect(snap.status).toBe("failed");
    expect(snap.steps[0]!.failure!.code).toBe("timeout");
    expect(snap.steps[0]!.attempts).toBe(1);
    expect(snap.steps[0]!.invocations).toHaveLength(1);
    expect(snap.external_work_status).toBe("unknown");
    expect(fake.execCalls()).toHaveLength(1); // no retry relaunch
    expect(snap.usage.native_jobs_started).toBe(1);
    expect(snap.usage.reserved_output_tokens).toBe(0);
    // Charged once at the full reservation, never twice.
    expect(snap.usage.consumed_output_tokens).toBe(snap.limits.max_output_tokens_per_call);
    expect(snap.usage.output_tokens).toBeNull();
    let pidAlive = true;
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    for (let i = 0; i < 100 && pidAlive; i += 1) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 30));
      } catch {
        pidAlive = false;
      }
    }
    fs.rmSync(pidFile, { force: true });
    expect(pidAlive).toBe(false);
  }, 20_000);

  it("a native adapter that ignores its own timeout is told to stop, and the step waits (bounded) for it to settle", async () => {
    const { ctx: c } = await nativeServer({}, { verified: true });
    const seen: { signal: AbortSignal; abortedAt: number | null; settledAt: number | null }[] = [];
    vi.spyOn(CodexCliAdapter.prototype, "generate").mockImplementation((req) => {
      const rec = { signal: req.signal, abortedAt: null as number | null, settledAt: null as number | null };
      seen.push(rec);
      return new Promise((_resolve, reject) => {
        req.signal.addEventListener("abort", () => {
          rec.abortedAt = Date.now();
          // Settles only after a delay, like a job being killed.
          setTimeout(() => {
            rec.settledAt = Date.now();
            reject(new Error("killed"));
          }, 1_200);
        });
      });
    });
    const conv = await createConversation(c);
    const snap = await runToEnd(c, liveInput(conv, ["codex-local-default"], { limits: { max_native_job_seconds: 1 } }));
    const rec = seen[0]!;
    expect(seen).toHaveLength(1);
    expect(rec.signal.aborted).toBe(true);
    expect(rec.settledAt).not.toBeNull();
    expect(snap.status).toBe("failed");
    expect(snap.steps[0]!.failure!.code).toBe("timeout");
    // The failure was committed only after the abandoned job settled.
    expect(Date.parse(snap.steps[0]!.invocations[0]!.finished_at!)).toBeGreaterThanOrEqual(rec.settledAt! - 5);
    expect(snap.external_work_status).toBe("unknown");
    expect(snap.usage.consumed_output_tokens).toBe(snap.limits.max_output_tokens_per_call);
    // A late settle changes nothing.
    const before = JSON.stringify(c.bundle.runs.get(snap.id));
    await new Promise((r) => setTimeout(r, 200));
    expect(JSON.stringify(c.bundle.runs.get(snap.id))).toBe(before);
  }, 30_000);

  it("an adapter that never settles cannot hold the slot forever: the wait is bounded and the run still ends", async () => {
    const { ctx: c } = await nativeServer({}, { verified: true });
    let signal: AbortSignal | null = null;
    vi.spyOn(CodexCliAdapter.prototype, "generate").mockImplementation((req) => {
      signal = req.signal;
      return new Promise(() => undefined);
    });
    const conv = await createConversation(c);
    const started = Date.now();
    const snap = await runToEnd(c, liveInput(conv, ["codex-local-default"], { limits: { max_native_job_seconds: 1 } }));
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(signal!.aborted).toBe(true);
    expect(snap.status).toBe("failed");
    expect(snap.steps[0]!.failure!.code).toBe("timeout");
    expect(snap.external_work_status).toBe("unknown");
    expect(snap.usage.consumed_output_tokens).toBe(snap.limits.max_output_tokens_per_call);
  }, 30_000);

  it("a launched job that fails for a non-timeout reason (tool event) also leaves external work unknown", async () => {
    const lines = [ev.thread, ev.turn, ev.item("command_execution", { command: "x" }), ev.done()];
    const { ctx: c } = await nativeServer({ exec: { lines, hang: true } }, { verified: true });
    const conv = await createConversation(c);
    const snap = await runToEnd(c, liveInput(conv, ["codex-local-default"]));
    expect(snap.status).toBe("failed");
    expect(snap.external_work_status).toBe("unknown");
  });

  it("a refusal BEFORE any process starts (login gate) never claims unknown external work", async () => {
    const { fake, ctx: c } = await nativeServer({ loginText: "Not logged in\n", exec: { lines: okTranscript() } }, { verified: true });
    const conv = await createConversation(c);
    const snap = await runToEnd(c, liveInput(conv, ["codex-local-default"]));
    expect(snap.status).toBe("failed");
    expect(fake.execCalls()).toEqual([]);
    expect(snap.external_work_status).toBe("none");
  });
});

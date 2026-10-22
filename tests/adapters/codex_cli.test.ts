// Codex CLI native adapter against a FAKE `codex` executable. Transcript and
// fake-process tests only: no model, network, login or real CLI is involved.
// They prove what Proofestra does with what a CLI says and how it supervises
// the process, not that a real Codex job is safe (that stays unproven; see
// CODEX_VERIFICATION).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexCliAdapter,
  CodexTranscript,
  UnavailableNativeAdapter,
  classifyNativeText,
  renderCodexPrompt,
} from "../../src/providers/codexCli.js";
import { AdapterFailure, type AdapterRequest } from "../../src/providers/types.js";
import { buildAdapters } from "../../src/core/adapters.js";
import { CODEX_VERIFICATION } from "../../src/core/nativeBackends.js";
import {
  CODEX_PROFILE,
  MODEL,
  codexConfig,
  ev,
  frozenPolicy,
  makeFakeCodex,
  okTranscript,
  type FakeCodex,
  type FakeCodexSpec,
} from "./_fakeCodex.js";

const fakes: FakeCodex[] = [];
const scratchRoots: string[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) f.cleanup();
  for (const d of scratchRoots.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup(spec: FakeCodexSpec = {}, withPolicy = true) {
  const fake = makeFakeCodex(spec);
  fakes.push(fake);
  const config = codexConfig(fake);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-scratch-root-"));
  scratchRoots.push(root);
  const adapter = new CodexCliAdapter({ config, home: "/fake/home", scratchRoot: root });
  const request = (over: Partial<AdapterRequest> = {}): AdapterRequest => ({
    profile: CODEX_PROFILE,
    stage: "draft",
    agent: { agent_id: "a1", name: "Agent", role: null },
    system_instructions: "Be brief.",
    user_messages: [{ role: "user", content: "What is 2+2? PRIVATE-PROMPT-MARKER" }],
    reference_material: null,
    max_output_tokens: 2048,
    per_call_timeout_ms: 8_000,
    signal: new AbortController().signal,
    native_policy: withPolicy ? frozenPolicy(config) : undefined,
    ...over,
  });
  return { fake, config, adapter, request, root };
}

async function failureOf(p: Promise<unknown>): Promise<AdapterFailure> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AdapterFailure);
    return err as AdapterFailure;
  }
  throw new Error("expected AdapterFailure");
}

describe("successful single-turn job", () => {
  it("returns only the final answer and the reported usage, pinned to the exact model", async () => {
    const { adapter, request, fake } = setup({ exec: { lines: okTranscript("Four."), exitCode: 0 } });
    const result = await adapter.generate(request());
    expect(result).toEqual({
      text: "Four.",
      findings: [],
      usage: { input_tokens: 120, output_tokens: 34 },
      provider: "openai",
      model_id: MODEL,
    });
    // The discarded reasoning item is nowhere in the result.
    expect(JSON.stringify(result)).not.toContain("PRIVATE-REASONING-MARKER");
    expect(fake.execCalls()).toHaveLength(1);
  });

  it("launches with the full isolation policy, an empty scratch cwd, stdin-only prompt, credential-free env", async () => {
    const saved = { a: process.env.OPENAI_API_KEY, b: process.env.CODEX_API_KEY, c: process.env.CODEX_ACCESS_TOKEN, d: process.env.HTTPS_PROXY };
    process.env.OPENAI_API_KEY = "sk-must-not-leak";
    process.env.CODEX_API_KEY = "codex-must-not-leak";
    process.env.CODEX_ACCESS_TOKEN = "tok-must-not-leak";
    process.env.HTTPS_PROXY = "http://proxy.invalid";
    try {
      const { adapter, request, fake, root } = setup({ exec: { lines: okTranscript(), exitCode: 0 } });
      await adapter.generate(request());
      const exec = fake.execCalls()[0]!;
      const argv = exec.argv;
      // Policy flags are present, and the scratch dir is both -C and the cwd.
      expect(argv.slice(0, 2)).toEqual(["exec", "--ignore-user-config"]);
      for (const f of ["--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--json"]) expect(argv).toContain(f);
      expect(argv[argv.indexOf("-m") + 1]).toBe(MODEL);
      const scratch = argv[argv.indexOf("-C") + 1]!;
      // (The scratch dir is already removed, so compare via the still-existing root.)
      expect(exec.cwd).toBe(path.join(fs.realpathSync(root), path.basename(scratch)));
      expect(fs.realpathSync(path.dirname(scratch))).toBe(fs.realpathSync(root));
      // The scratch directory started EMPTY and is removed afterwards.
      expect(exec.cwdEntries).toEqual([]);
      expect(fs.readdirSync(root)).toEqual([]);
      // The private prompt is delivered on stdin, never in argv.
      expect(exec.stdin).toContain("PRIVATE-PROMPT-MARKER");
      expect(argv.join(" ")).not.toContain("PRIVATE-PROMPT-MARKER");
      expect(argv.at(-1)).toBe("-");
      // Minimal credential-free environment.
      const keys = Object.keys(exec.env).filter((k) => k !== "__CF_USER_TEXT_ENCODING").sort();
      expect(keys).toEqual(["HOME", "LC_ALL", "PATH"]);
      expect(exec.env.HOME).toBe("/fake/home");
      expect(JSON.stringify(exec.env)).not.toMatch(/must-not-leak|proxy\.invalid/);
    } finally {
      for (const [k, v] of [["OPENAI_API_KEY", saved.a], ["CODEX_API_KEY", saved.b], ["CODEX_ACCESS_TOKEN", saved.c], ["HTTPS_PROXY", saved.d]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("passes an operator-chosen Codex home PATH (never its contents) to the job only", async () => {
    const fake = makeFakeCodex({ exec: { lines: okTranscript(), exitCode: 0 } });
    fakes.push(fake);
    const config = codexConfig(fake, { codexHome: "/ops/codex-home" });
    const adapter = new CodexCliAdapter({ config, home: "/fake/home" });
    await adapter.generate({
      profile: CODEX_PROFILE,
      stage: "draft",
      agent: { agent_id: "a", name: "A", role: null },
      system_instructions: "",
      user_messages: [{ role: "user", content: "hi" }],
      reference_material: null,
      max_output_tokens: 2048,
      per_call_timeout_ms: 8_000,
      signal: new AbortController().signal,
      native_policy: frozenPolicy(config),
    });
    // The job and the login-status gate get the operator path (that is where the
    // CLI keeps ITS login); the preflight probes use an empty scratch home instead.
    expect(fake.execCalls()[0]!.env.CODEX_HOME).toBe("/ops/codex-home");
    expect(fake.calls().find((c) => c.kind === "login")!.env.CODEX_HOME).toBe("/ops/codex-home");
    const probes = fake.calls().filter((c) => c.kind === "version" || c.kind === "features");
    expect(probes.length).toBeGreaterThan(0);
    for (const probe of probes) expect(probe.env.CODEX_HOME).not.toBe("/ops/codex-home");
  });

  it("each job gets its own fresh scratch directory (no cross-step state)", async () => {
    const { adapter, request, fake } = setup({ exec: { lines: okTranscript(), exitCode: 0 } });
    await adapter.generate(request({ user_messages: [{ role: "user", content: "first PRIVATE-FIRST" }] }));
    await adapter.generate(request({ user_messages: [{ role: "user", content: "second" }] }));
    const [a, b] = fake.execCalls();
    expect(a!.cwd).not.toBe(b!.cwd);
    expect(b!.cwdEntries).toEqual([]);
    expect(b!.stdin).not.toContain("PRIVATE-FIRST");
    // Preflight ran once per CLI version, not per job.
    expect(fake.calls().filter((c) => c.kind === "features")).toHaveLength(1);
  });

  it("renders stage input as text only: extracted text and attachment-only notes, with system and reference", async () => {
    const { adapter, request, fake } = setup({ exec: { lines: okTranscript(), exitCode: 0 } });
    await adapter.generate(
      request({
        reference_material: "REF-BODY",
        user_messages: [
          { role: "assistant", content: "earlier answer" },
          {
            role: "user",
            content: "see files",
            parts: [
              { kind: "text", text: "see files" },
              { kind: "attachment_extracted_text", attachment_id: "x", sanitized_display_name: "n.txt", sniffed_mime: "text/plain", byte_size: 4, text: "EXTRACTED-BODY", truncated: false },
              { kind: "attachment_only", attachment_id: "y", sanitized_display_name: "p.bin", sniffed_mime: "application/octet-stream", byte_size: 9, reason: "unsupported" },
            ],
          },
          { role: "user", content: "fallback content", parts: [] },
        ],
      }),
    );
    const stdin = fake.execCalls()[0]!.stdin!;
    for (const needle of ["no tools in this session", "Be brief.", "REF-BODY", "[assistant]\nearlier answer", "EXTRACTED-BODY", "p.bin", "fallback content"]) {
      expect(stdin, needle).toContain(needle);
    }
  });

  it("flags (does not hide) usage above the requested ceiling, and nulls unreported or malformed counters", async () => {
    let s = setup({ exec: { lines: okTranscript("a", { input_tokens: 5, output_tokens: 99_999 }), exitCode: 0 } });
    const over = await s.adapter.generate(s.request({ max_output_tokens: 1024 }));
    expect(over.findings).toHaveLength(1);
    expect(over.findings[0]).toMatch(/cannot enforce an output-token limit/);
    expect(over.usage).toEqual({ input_tokens: 5, output_tokens: 99_999 });
    for (const usage of [null, "x", { input_tokens: 1.5, output_tokens: -1 }, { input_tokens: "7" }]) {
      s = setup({ exec: { lines: [ev.thread, ev.turn, ev.message("a"), ev.done(usage)], exitCode: 0 } });
      const r = await s.adapter.generate(s.request());
      expect(r.usage, JSON.stringify(usage)).toEqual({ input_tokens: null, output_tokens: null });
    }
    s = setup({ exec: { lines: [ev.thread, ev.turn, ev.message("a"), JSON.stringify({ type: "turn.completed" })], exitCode: 0 } });
    expect((await s.adapter.generate(s.request())).usage).toEqual({ input_tokens: null, output_tokens: null });
  });

  it("a retry-style error event followed by a completed turn is still a success", async () => {
    const { adapter, request } = setup({
      exec: { lines: [ev.thread, ev.turn, ev.error("Reconnecting... 1/5"), ev.message("ok"), ev.done()], exitCode: 0 },
    });
    expect((await adapter.generate(request())).text).toBe("ok");
  });

  it("uses the LAST completed agent message as the answer and ignores partial/updated ones", async () => {
    const partial = JSON.stringify({ type: "item.updated", item: { id: "i", type: "agent_message", text: "partial" } });
    const { adapter, request } = setup({ exec: { lines: [ev.thread, ev.turn, partial, ev.message("first"), ev.message("second"), ev.done()], exitCode: 0 } });
    expect((await adapter.generate(request())).text).toBe("second");
  });
});

describe("admission is re-checked before anything launches", () => {
  it("refuses a request without the frozen policy and never spawns", async () => {
    const { adapter, request, fake } = setup({ exec: { lines: okTranscript() } }, false);
    const f = await failureOf(adapter.generate(request()));
    expect(f.failure).toEqual({ code: "invalid_request", message: "codex-local-cli: invalid_request (policy_mismatch)" });
    expect(fake.calls()).toEqual([]);
  });

  it.each([
    ["model", (p: ReturnType<typeof frozenPolicy>) => ({ ...p, model_id: "other-model" })],
    ["policy id", (p: ReturnType<typeof frozenPolicy>) => ({ ...p, policy_id: "other-policy" })],
    ["cli version", (p: ReturnType<typeof frozenPolicy>) => ({ ...p, cli_version: "9.9.9" })],
    ["backend", (p: ReturnType<typeof frozenPolicy>) => ({ ...p, backend_id: "antigravity-local-cli" })],
  ])("refuses a frozen policy with a different %s", async (_n, mutate) => {
    const { adapter, request, fake } = setup({ exec: { lines: okTranscript() } });
    const f = await failureOf(adapter.generate(request({ native_policy: mutate(frozenPolicy(setup().config)) })));
    expect(f.failure.code).toBe("invalid_request");
    expect(fake.calls()).toEqual([]);
  });

  it("refuses a profile that is not the codex backend (no API reroute)", async () => {
    const { adapter, request, fake } = setup({});
    const f = await failureOf(
      adapter.generate(request({ profile: { ...CODEX_PROFILE, api_shape: "openai_chat_completions", execution_backend_id: "openai-chat-completions" } })),
    );
    expect(f.failure.message).toBe("codex-local-cli: invalid_request (not_admitted)");
    expect(fake.calls()).toEqual([]);
    expect(adapter.supports(CODEX_PROFILE)).toBe(true);
  });

  it("with the REAL verification record (tool surface unproven) it refuses to launch at all", async () => {
    const fake = makeFakeCodex({ exec: { lines: okTranscript() } });
    fakes.push(fake);
    const verified = codexConfig(fake);
    const policy = frozenPolicy(verified);
    const real = codexConfig(fake, { verification: undefined });
    const adapter = new CodexCliAdapter({ config: real });
    expect(adapter.readiness()).toBe("unsupported");
    const f = await failureOf(
      adapter.generate({
        profile: CODEX_PROFILE,
        stage: "draft",
        agent: { agent_id: "a", name: "A", role: null },
        system_instructions: "",
        user_messages: [{ role: "user", content: "hi" }],
        reference_material: null,
        max_output_tokens: 2048,
        per_call_timeout_ms: 5_000,
        signal: new AbortController().signal,
        native_policy: { ...policy, cli_version: CODEX_VERIFICATION.cli_version },
      }),
    );
    expect(f.failure).toEqual({ code: "provider_unavailable", message: "codex-local-cli: provider_unavailable (not_admitted)" });
    expect(fake.calls()).toEqual([]);
  });

  it("readiness maps to the adapter vocabulary", () => {
    const fake = makeFakeCodex();
    fakes.push(fake);
    expect(new CodexCliAdapter({ config: codexConfig(fake) }).readiness()).toBe("configured");
    expect(new CodexCliAdapter({ config: codexConfig(fake, {}, { liveEnabled: false }) }).readiness()).toBe("disabled");
  });

  it("fails cleanly if the executable disappears after admission", async () => {
    const { adapter, request, fake } = setup({});
    const req = request();
    fs.rmSync(fake.bin);
    const f = await failureOf(adapter.generate(req));
    expect(f.failure.code).toBe("provider_unavailable");
    expect(f.failure.message).toBe("codex-local-cli: provider_unavailable (not_admitted)");
  });

  it("refuses native attachment parts before spawning (this backend is text-only)", async () => {
    const { adapter, request, fake } = setup({});
    const f = await failureOf(
      adapter.generate(
        request({
          user_messages: [
            { role: "user", content: "x", parts: [{ kind: "attachment_native", native_route: "native_image", attachment_id: "i", sniffed_mime: "image/png", wire_mime: "image/png", byte_size: 1, sanitized_display_name: "i.png", blob_path: "/secret/path/i.png" }] },
          ],
        }),
      ),
    );
    expect(f.failure).toEqual({ code: "invalid_request", message: "codex-local-cli: invalid_request (attachment_not_supported)" });
    expect(f.failure.message).not.toContain("/secret");
    expect(fake.calls()).toEqual([]);
  });

  it("a pre-aborted request never spawns", async () => {
    const { adapter, request, fake } = setup({});
    const ac = new AbortController();
    ac.abort();
    const f = await failureOf(adapter.generate(request({ signal: ac.signal })));
    expect(f.failure.code).toBe("canceled");
    expect(fake.calls()).toEqual([]);
  });
});

describe("pre-launch preflight", () => {
  it("a different CLI version is refused before exec", async () => {
    const { adapter, request, fake } = setup({ versionText: "codex-cli 0.164.0" });
    const f = await failureOf(adapter.generate(request()));
    expect(f.failure.message).toBe("codex-local-cli: provider_unavailable (version_unverified)");
    expect(fake.execCalls()).toEqual([]);
  });

  it("a failing --version is refused", async () => {
    const { adapter, request, fake } = setup({ versionExit: 2 });
    expect((await failureOf(adapter.generate(request()))).failure.message).toContain("version_unverified");
    expect(fake.execCalls()).toEqual([]);
  });

  it("effective features that still enable unified_exec (the REAL 0.163.0 table) refuse the job", async () => {
    const real = fs.readFileSync(path.join(import.meta.dirname, "..", "fixtures", "native", "codex-0.163.0-features-denied.txt"), "utf8");
    const { adapter, request, fake } = setup({ featuresText: real, exec: { lines: okTranscript() } });
    const f = await failureOf(adapter.generate(request()));
    expect(f.failure.message).toBe("codex-local-cli: provider_unavailable (preflight_failed)");
    expect(fake.execCalls()).toEqual([]);
    // The probe saw the deny overrides and an EMPTY scratch home, not the job's.
    const features = fake.calls().find((c) => c.kind === "features")!;
    expect(features.argv).toEqual(expect.arrayContaining(["--disable", "shell_tool", "--disable", "hooks", "--disable", "apps"]));
  });

  it.each([
    ["unparseable output", { featuresText: "garbage output" }],
    ["non-zero exit", { featuresExit: 1 }],
    ["an unclassified enabled feature", { featuresText: `${fs.readFileSync(path.join(import.meta.dirname, "..", "fixtures", "native", "codex-0.163.0-features-default.txt"), "utf8")}` }],
  ])("refuses on %s", async (_n, spec) => {
    const { adapter, request, fake } = setup(spec);
    expect((await failureOf(adapter.generate(request()))).failure.message).toContain("preflight_failed");
    expect(fake.execCalls()).toEqual([]);
  });

  it("a failed preflight is not cached: a later fixed CLI is re-checked, not trusted", async () => {
    const { adapter, request, fake } = setup({ versionText: "codex-cli 0.164.0" });
    await failureOf(adapter.generate(request()));
    await failureOf(adapter.generate(request()));
    expect(fake.calls().filter((c) => c.kind === "version")).toHaveLength(2);
  });

  it("cancel during the preflight surfaces as canceled", async () => {
    const { adapter, request } = setup({});
    const ac = new AbortController();
    const p = adapter.generate(request({ signal: ac.signal }));
    ac.abort();
    expect((await failureOf(p)).failure.code).toBe("canceled");
  });
});

describe("subscription-only: a ChatGPT login is required before every job", () => {
  it("runs the vendor login-status gate (credential-free env, empty cwd) before exec, and forces the ChatGPT method on the job", async () => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-must-not-leak";
    try {
      const { adapter, request, fake } = setup({ exec: { lines: okTranscript(), exitCode: 0 } });
      await adapter.generate(request());
      const kinds = fake.calls().map((c) => c.kind);
      expect(kinds.indexOf("login")).toBeGreaterThan(kinds.indexOf("features"));
      expect(kinds.indexOf("login")).toBeLessThan(kinds.indexOf("exec"));
      const login = fake.calls().find((c) => c.kind === "login")!;
      expect(login.argv.slice(0, 2)).toEqual(["login", "status"]);
      expect(login.cwdEntries).toEqual([]);
      expect(JSON.stringify(login.env)).not.toContain("must-not-leak");
      expect(Object.keys(login.env).filter((k) => k !== "__CF_USER_TEXT_ENCODING").sort()).toEqual(["HOME", "LC_ALL", "PATH"]);
      const execArgv = fake.execCalls()[0]!.argv;
      expect(execArgv[execArgv.indexOf('forced_login_method="chatgpt"') - 1]).toBe("-c");
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
  });

  it.each([
    ["an API-key login", "Logged in using an API key - sk-live-SECRET1234\n"],
    ["a personal access token", "Logged in using personal access token\n"],
    ["extra status lines", "Logged in using ChatGPT\nLogged in using an API key - sk-x\n"],
    ["an empty status", ""],
  ])("refuses %s before launch, with a fixed message and no vendor text", async (_name, loginText) => {
    const { adapter, request, fake } = setup({ loginText, exec: { lines: okTranscript(), exitCode: 0 } });
    const failure = await failureOf(adapter.generate(request()));
    expect(failure.failure).toEqual({
      code: "authentication",
      message: "codex-local-cli: authentication (auth_not_chatgpt)",
    });
    expect(failure.message).not.toMatch(/sk-|SECRET|API key/);
    expect(fake.execCalls()).toEqual([]);
  });

  it("not logged in is an authentication failure even when the status exits non-zero", async () => {
    const { adapter, request, fake } = setup({ loginText: "Not logged in\n", loginExit: 1 });
    const failure = await failureOf(adapter.generate(request()));
    expect(failure.failure).toEqual({ code: "authentication", message: "codex-local-cli: authentication (not_logged_in)" });
    expect(fake.execCalls()).toEqual([]);
  });

  it("accepts the ChatGPT status on stderr when stdout is empty", async () => {
    const { adapter, request, fake } = setup({
      loginText: "Logged in using ChatGPT\n",
      loginStream: "stderr",
      exec: { lines: okTranscript("ok"), exitCode: 0 },
    });
    expect((await adapter.generate(request())).text).toBe("ok");
    expect(fake.execCalls()).toHaveLength(1);
  });

  it("a ChatGPT message with a failing status command is not trusted", async () => {
    const { adapter, request, fake } = setup({ loginExit: 2, exec: { lines: okTranscript(), exitCode: 0 } });
    const failure = await failureOf(adapter.generate(request()));
    expect(failure.failure).toEqual({ code: "provider_unavailable", message: "codex-local-cli: provider_unavailable (auth_probe_failed)" });
    expect(fake.execCalls()).toEqual([]);
  });

  it("is checked for EVERY job (login state can change), unlike the cached version preflight", async () => {
    const { adapter, request, fake } = setup({ exec: { lines: okTranscript(), exitCode: 0 } });
    await adapter.generate(request());
    await adapter.generate(request());
    expect(fake.calls().filter((c) => c.kind === "login")).toHaveLength(2);
    expect(fake.calls().filter((c) => c.kind === "version")).toHaveLength(1);
  });

  it("cancel during the pre-launch checks surfaces as canceled and never launches", async () => {
    const ac = new AbortController();
    const { adapter, request, fake } = setup({ exec: { lines: okTranscript(), exitCode: 0 } });
    const p = adapter.generate(request({ signal: ac.signal }));
    ac.abort();
    expect((await failureOf(p)).failure.code).toBe("canceled");
    expect(fake.execCalls()).toEqual([]);
  });
});

describe("executable identity: a replaced binary is never covered by an old preflight", () => {
  it("re-runs the preflight when the file's bytes change, and refuses a replacement of another version", async () => {
    const { adapter, request, fake } = setup({ exec: { lines: okTranscript(), exitCode: 0 } });
    await adapter.generate(request());
    await adapter.generate(request());
    expect(fake.calls().filter((c) => c.kind === "version")).toHaveLength(1); // cached while identical

    // Rewrite the same path with a binary that reports a different version.
    const other = makeFakeCodex({ versionText: "codex-cli 0.999.0", exec: { lines: okTranscript(), exitCode: 0 } });
    fakes.push(other);
    fs.copyFileSync(other.bin, fake.bin);
    const failure = await failureOf(adapter.generate(request()));
    expect(failure.failure).toEqual({ code: "provider_unavailable", message: "codex-local-cli: provider_unavailable (version_unverified)" });
    expect(failure.externalWork).toBeUndefined();
    expect(fake.execCalls()).toHaveLength(2); // none added by the refused job
  });

  it("a symlink re-pointed to another binary is not trusted from the cache, and the REAL path is what runs", async () => {
    const a = makeFakeCodex({ exec: { lines: okTranscript("from-a"), exitCode: 0 } });
    const b = makeFakeCodex({ versionText: "codex-cli 0.999.0", exec: { lines: okTranscript("from-b"), exitCode: 0 } });
    fakes.push(a, b);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-link-"));
    scratchRoots.push(dir);
    const link = path.join(dir, "codex");
    fs.symlinkSync(a.bin, link);
    const config = codexConfig({ bin: link });
    const adapter = new CodexCliAdapter({ config, home: "/fake/home" });
    const req = (): AdapterRequest => ({
      profile: CODEX_PROFILE,
      stage: "draft",
      agent: { agent_id: "a", name: "A", role: null },
      system_instructions: "",
      user_messages: [{ role: "user", content: "hi" }],
      reference_material: null,
      max_output_tokens: 2048,
      per_call_timeout_ms: 8_000,
      signal: new AbortController().signal,
      native_policy: frozenPolicy(config),
    });
    expect((await adapter.generate(req())).text).toBe("from-a");
    fs.unlinkSync(link);
    fs.symlinkSync(b.bin, link);
    const failure = await failureOf(adapter.generate(req()));
    expect(failure.failure.message).toContain("version_unverified");
    expect(b.execCalls()).toEqual([]);
    expect(a.execCalls()).toHaveLength(1);
  });

  it("a binary rewritten between the preflight and the launch is refused before the job starts", async () => {
    const { adapter, request, fake } = setup({ mutateOnLogin: true, exec: { lines: okTranscript(), exitCode: 0 } });
    const failure = await failureOf(adapter.generate(request()));
    expect(failure.failure).toEqual({ code: "provider_unavailable", message: "codex-local-cli: provider_unavailable (executable_changed)" });
    expect(failure.externalWork).toBeUndefined();
    expect(fake.execCalls()).toEqual([]);
  });
});

describe("the model is confirmed by the CLI, never assumed from the request", () => {
  const withEvents = (lines: string[]) => setup({ exec: { lines, exitCode: 0 } });

  it("a transcript that never reports a model fails closed (no 'requested == executed' claim)", async () => {
    const { adapter, request } = withEvents([ev.threadNoModel, ev.turn, ev.message("answer"), ev.done()]);
    const failure = await failureOf(adapter.generate(request()));
    expect(failure.failure).toEqual({ code: "model_unavailable", message: "codex-local-cli: model_unavailable (model_unconfirmed)" });
    expect(failure.externalWork).toBe("unknown");
  });

  it("a model reported by an event is confirmed; one reported by an ITEM also counts", async () => {
    const viaThread = withEvents(okTranscript("a"));
    expect((await viaThread.adapter.generate(viaThread.request())).model_id).toBe(MODEL);
    const viaItem = withEvents([
      ev.threadNoModel,
      ev.turn,
      JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "b", model: MODEL } }),
      ev.done(),
    ]);
    expect((await viaItem.adapter.generate(viaItem.request())).text).toBe("b");
  });

  it("a different model, even after a confirming one, still fails as a mismatch", async () => {
    const { adapter, request } = withEvents([
      ev.thread,
      ev.turn,
      JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "x", model: "gpt-other" } }),
      ev.done(),
    ]);
    const failure = await failureOf(adapter.generate(request()));
    expect(failure.failure.message).toContain("model_mismatch");
  });

  it("the transcript tracks confirmation without trusting the pinned id", () => {
    const t = new CodexTranscript(MODEL, 1024);
    t.accept(ev.threadNoModel);
    expect(t.modelConfirmed).toBe(false);
    t.accept(JSON.stringify({ type: "turn.started", model: MODEL }));
    expect(t.modelConfirmed).toBe(true);
  });
});

describe("external work is reported as unknown only when a job process was actually launched", () => {
  const cases: Array<[string, FakeCodexSpec, string]> = [
    ["a tool event", { exec: { lines: [ev.thread, ev.turn, ev.item("command_execution", { command: "x" }), ev.done()], hang: true } }, "policy_violation"],
    ["a non-zero exit", { exec: { lines: okTranscript(), exitCode: 3 } }, "nonzero_exit"],
    ["an incomplete turn", { exec: { lines: [ev.thread, ev.turn], exitCode: 0 } }, "incomplete"],
    ["an empty answer", { exec: { lines: [ev.thread, ev.turn, ev.message("  "), ev.done()], exitCode: 0 } }, "empty_answer"],
  ];
  it.each(cases)("after launch: %s is externalWork=unknown", async (_name, spec, reason) => {
    const { adapter, request } = setup(spec);
    const failure = await failureOf(adapter.generate(request()));
    expect(failure.failure.message).toContain(reason);
    expect(failure.externalWork).toBe("unknown");
  });

  it("before launch (login refusal, preflight refusal, spawn failure) it is not claimed", async () => {
    for (const spec of [{ loginText: "Not logged in\n" }, { versionText: "codex-cli 9.9.9" }] as FakeCodexSpec[]) {
      const { adapter, request, fake } = setup(spec);
      const failure = await failureOf(adapter.generate(request()));
      expect(failure.externalWork).toBeUndefined();
      expect(fake.execCalls()).toEqual([]);
    }
  });

  it("a launched job that timed out says unknown, and never claims the tree was stopped", async () => {
    const { adapter, request } = setup({ exec: { lines: [ev.thread, ev.turn], hang: true } });
    const failure = await failureOf(adapter.generate(request({ per_call_timeout_ms: 1_800 })));
    expect(failure.failure.code).toBe("timeout");
    expect(failure.externalWork).toBe("unknown");
    expect(failure.failure.message).not.toMatch(/killed|stopped|settled/);
  });
});

describe("one time budget covers the pre-launch probes and the job", () => {
  it("probes that eat the budget fail as a pre-launch timeout: no job, no external-work claim", async () => {
    const { adapter, request, fake } = setup({ featuresDelayMs: 700, loginDelayMs: 700, exec: { lines: okTranscript(), exitCode: 0 } });
    const started = Date.now();
    const failure = await failureOf(adapter.generate(request({ per_call_timeout_ms: 1_000 })));
    expect(failure.failure.code).toBe("timeout");
    expect(failure.externalWork).toBeUndefined();
    expect(fake.execCalls()).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it("the job gets only what is left: probe time plus job time stays within the per-call limit", async () => {
    const { adapter, request } = setup({ featuresDelayMs: 600, loginDelayMs: 600, exec: { lines: [ev.thread, ev.turn], hang: true } });
    const started = Date.now();
    const failure = await failureOf(adapter.generate(request({ per_call_timeout_ms: 2_400 })));
    const elapsed = Date.now() - started;
    expect(failure.failure.code).toBe("timeout");
    expect(failure.externalWork).toBe("unknown");
    // Without a shared budget this would be ~600 + 600 + 2400.
    expect(elapsed).toBeLessThan(3_100);
    expect(elapsed).toBeGreaterThan(2_000);
  });
});

describe("a descendant that escapes the process group is reported, never claimed killed", () => {
  const reap = (file: string): void => {
    try {
      process.kill(Number(fs.readFileSync(file, "utf8")), "SIGKILL");
    } catch {
      /* gone */
    }
  };

  it("a job that exits cleanly with a pipe-holding escapee is NOT trusted: containment_unverified, external unknown", async () => {
    const pidFile = path.join(os.tmpdir(), `pf-esc-${process.pid}-1.pid`);
    const { adapter, request } = setup({ exec: { lines: okTranscript("looks fine"), exitCode: 0, escapeGrandchildPidFile: pidFile } });
    const started = Date.now();
    try {
      const failure = await failureOf(adapter.generate(request()));
      expect(failure.failure).toEqual({ code: "provider_unavailable", message: "codex-local-cli: provider_unavailable (containment_unverified)" });
      expect(failure.externalWork).toBe("unknown");
      expect(Date.now() - started).toBeLessThan(3_500);
    } finally {
      reap(pidFile);
      fs.rmSync(pidFile, { force: true });
    }
  });

  it("a timed-out job with an escapee keeps the timeout code and adds the containment reason", async () => {
    const pidFile = path.join(os.tmpdir(), `pf-esc-${process.pid}-2.pid`);
    const { adapter, request } = setup({ exec: { lines: [ev.thread, ev.turn], hang: true, escapeGrandchildPidFile: pidFile } });
    try {
      const failure = await failureOf(adapter.generate(request({ per_call_timeout_ms: 2_000 })));
      expect(failure.failure).toEqual({ code: "timeout", message: "codex-local-cli: timeout (containment_unverified)" });
      expect(failure.externalWork).toBe("unknown");
    } finally {
      reap(pidFile);
      fs.rmSync(pidFile, { force: true });
    }
  });
});

describe("transcript policy: tool/private events fail closed", () => {
  it.each([
    ["command_execution", { command: "rm -rf /secret-target", aggregated_output: "x" }],
    ["file_change", { changes: [{ path: "/etc/passwd", kind: "update" }] }],
    ["mcp_tool_call", { server: "s", tool: "t" }],
    ["web_search", { query: "q" }],
    ["collab_tool_call", {}],
    ["some_future_tool", {}],
  ])("a %s item kills the job and fails the step without exposing it", async (type, extra) => {
    const { adapter, request } = setup({
      exec: { lines: [ev.thread, ev.turn, ev.item(type, extra), ev.message("TAINTED-ANSWER"), ev.done()], hang: true },
    });
    const started = Date.now();
    const f = await failureOf(adapter.generate(request()));
    expect(f.failure).toEqual({ code: "invalid_request", message: "codex-local-cli: invalid_request (policy_violation)" });
    expect(JSON.stringify(f.failure)).not.toMatch(/rm -rf|passwd|TAINTED/);
    // It was killed promptly rather than left running until the timeout.
    expect(Date.now() - started).toBeLessThan(6_000);
  });

  it.each([
    ["an unknown event type", JSON.stringify({ type: "mystery.event" })],
    ["a non-JSON line", "plain text on stdout"],
    ["JSON that is not an event", JSON.stringify([1, 2])],
    ["an item without a type", JSON.stringify({ type: "item.completed", item: {} })],
    ["a non-string agent message", JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: 42 } })],
    ["a second turn", ev.turn],
  ])("%s is a policy violation", async (_name, line) => {
    const { adapter, request } = setup({ exec: { lines: [ev.thread, ev.turn, line, ev.message("x"), ev.done()], exitCode: 0 } });
    expect((await failureOf(adapter.generate(request()))).failure.message).toBe("codex-local-cli: invalid_request (policy_violation)");
  });

  it("a second turn.completed is a policy violation", async () => {
    const { adapter, request } = setup({ exec: { lines: [ev.thread, ev.turn, ev.message("x"), ev.done(), ev.done()], exitCode: 0 } });
    expect((await failureOf(adapter.generate(request()))).failure.message).toContain("policy_violation");
  });

  it("an answer over the byte bound fails; it is never silently truncated", async () => {
    const { adapter, request } = setup({ exec: { lines: okTranscript("x".repeat(2_000)), exitCode: 0 } });
    const f = await failureOf(adapter.generate(request({ max_output_tokens: 100 })));
    expect(f.failure).toEqual({ code: "invalid_request", message: "codex-local-cli: invalid_request (answer_too_large)" });
  });

  it("an event reporting a different model than the pinned one (reroute) fails", async () => {
    for (const lines of [
      [JSON.stringify({ type: "thread.started", model: "gpt-other" }), ev.turn, ev.message("x"), ev.done()],
      [ev.thread, ev.turn, JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "x", model: "gpt-other" } }), ev.done()],
    ]) {
      const { adapter, request } = setup({ exec: { lines, exitCode: 0 } });
      expect((await failureOf(adapter.generate(request()))).failure).toEqual({
        code: "model_unavailable",
        message: "codex-local-cli: model_unavailable (model_mismatch)",
      });
    }
    // The pinned model echoed back is fine.
    const ok = setup({ exec: { lines: [JSON.stringify({ type: "thread.started", model: MODEL }), ev.turn, ev.message("x"), ev.done()], exitCode: 0 } });
    expect((await ok.adapter.generate(ok.request())).model_id).toBe(MODEL);
  });
});

describe("completion, exit and failure classification (fixed messages only)", () => {
  it.each([
    ["you are not logged in, please sign in", "authentication"],
    ["401 Unauthorized", "authentication"],
    ["rate limit reached (429)", "rate_limited"],
    ["You have hit your usage limit", "rate_limited"],
    ["model gpt-x does not exist", "model_unavailable"],
    ["context window exceeded", "context_too_large"],
    ["connection reset by peer", "provider_unavailable"],
    ["", "provider_unavailable"],
  ])("turn.failed %j is classified %s without echoing the text", async (text, code) => {
    const secret = `${text} SECRET-TOKEN-XYZ /Users/someone/.codex/auth.json`;
    const { adapter, request } = setup({ exec: { lines: [ev.thread, ev.turn, ev.failed(secret)], exitCode: 1 } });
    const f = await failureOf(adapter.generate(request()));
    expect(f.failure.code).toBe(code);
    expect(f.failure.message).toBe(`codex-local-cli: ${code} (incomplete)`);
    expect(JSON.stringify(f.failure)).not.toMatch(/SECRET|auth\.json|someone/);
  });

  it("an error event with no completed turn is classified from its text; stderr text is classified, never shown", async () => {
    const a = setup({ exec: { lines: [ev.thread, ev.turn, ev.error("please log in again")], exitCode: 1 } });
    expect((await failureOf(a.adapter.generate(a.request()))).failure.code).toBe("authentication");
    const b = setup({ exec: { lines: [ev.thread, ev.turn], exitCode: 1, stderr: "Error: 429 Too Many Requests SECRET-TOKEN" } });
    const f = await failureOf(b.adapter.generate(b.request()));
    expect(f.failure.code).toBe("rate_limited");
    expect(JSON.stringify(f.failure)).not.toContain("SECRET");
    // An error event that carries no message text is still just an error.
    const c = setup({ exec: { lines: [ev.thread, ev.turn, JSON.stringify({ type: "error" })], exitCode: 1 } });
    expect((await failureOf(c.adapter.generate(c.request()))).failure.code).toBe("provider_unavailable");
    // turn.failed with a non-object error payload.
    const d = setup({ exec: { lines: [ev.thread, ev.turn, JSON.stringify({ type: "turn.failed", error: "oops" })], exitCode: 1 } });
    expect((await failureOf(d.adapter.generate(d.request()))).failure.message).toContain("(incomplete)");
  });

  it("exit 0 without a completed turn is incomplete, not a success", async () => {
    const { adapter, request } = setup({ exec: { lines: [ev.thread, ev.turn, ev.message("never completed")], exitCode: 0 } });
    expect((await failureOf(adapter.generate(request()))).failure.message).toBe("codex-local-cli: provider_unavailable (incomplete)");
  });

  it("a completed turn with a non-zero exit is NOT trusted", async () => {
    const { adapter, request } = setup({ exec: { lines: okTranscript(), exitCode: 7, stderr: "boom" } });
    expect((await failureOf(adapter.generate(request()))).failure.message).toBe("codex-local-cli: provider_unavailable (nonzero_exit)");
  });

  it("a completed turn with no answer text is an empty-answer failure", async () => {
    for (const lines of [[ev.thread, ev.turn, ev.done()], [ev.thread, ev.turn, ev.message("   "), ev.done()]]) {
      const { adapter, request } = setup({ exec: { lines, exitCode: 0 } });
      expect((await failureOf(adapter.generate(request()))).failure).toEqual({
        code: "model_unavailable",
        message: "codex-local-cli: model_unavailable (empty_answer)",
      });
    }
  });

  it("output beyond the stdout or line bound fails as an overflow", async () => {
    const huge = JSON.stringify({ type: "item.updated", item: { type: "reasoning", text: "r".repeat(600_000) } });
    const a = setup({ exec: { lines: [ev.thread, huge], exitCode: 0 } });
    expect((await failureOf(a.adapter.generate(a.request()))).failure.message).toBe("codex-local-cli: provider_unavailable (output_overflow)");
    const many = Array.from({ length: 20 }, () => JSON.stringify({ type: "item.updated", item: { type: "reasoning", text: "r".repeat(120_000) } }));
    const b = setup({ exec: { lines: [ev.thread, ...many], exitCode: 0 } });
    expect((await failureOf(b.adapter.generate(b.request()))).failure.message).toContain("output_overflow");
  });

  it("an executable that cannot be started is a spawn failure with a fixed message", async () => {
    const { adapter, request, fake } = setup({});
    // Valid preflight is impossible without a runnable binary: break the shebang.
    fs.writeFileSync(fake.bin, "#!/nonexistent/interpreter\n", { mode: 0o755 });
    const f = await failureOf(adapter.generate(request()));
    expect(f.failure.code).toBe("provider_unavailable");
    expect(f.failure.message).toMatch(/\((version_unverified|spawn_failed)\)$/);
  });

  it("an unwritable scratch root is a fixed spawn failure", async () => {
    const fake = makeFakeCodex({});
    fakes.push(fake);
    const config = codexConfig(fake);
    const adapter = new CodexCliAdapter({ config, scratchRoot: "/nonexistent/scratch-root" });
    const f = await failureOf(
      adapter.generate({
        profile: CODEX_PROFILE,
        stage: "draft",
        agent: { agent_id: "a", name: "A", role: null },
        system_instructions: "",
        user_messages: [{ role: "user", content: "hi" }],
        reference_material: null,
        max_output_tokens: 2048,
        per_call_timeout_ms: 5_000,
        signal: new AbortController().signal,
        native_policy: frozenPolicy(config),
      }),
    );
    expect(f.failure.message).toBe("codex-local-cli: provider_unavailable (spawn_failed)");
  });
});

describe("timeout and cancel isolation", () => {
  it("a hung job times out, is killed with its whole tree, and its scratch dir is removed", async () => {
    const pidFile = path.join(os.tmpdir(), `pf-gc-${process.pid}-${Date.now()}.pid`);
    const { adapter, request, root } = setup({ exec: { lines: [ev.thread, ev.turn], hang: true, grandchildPidFile: pidFile } });
    const started = Date.now();
    const f = await failureOf(adapter.generate(request({ per_call_timeout_ms: 1_500 })));
    expect(f.failure).toEqual({ code: "timeout", message: "codex-local-cli: timeout" });
    expect(Date.now() - started).toBeLessThan(6_000);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    fs.rmSync(pidFile, { force: true });
    let alive = true;
    for (let i = 0; i < 50 && alive; i += 1) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 40));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("cancel mid-job kills the child, reports canceled, and a following job is unaffected", async () => {
    const { adapter, request, fake } = setup({ exec: { lines: [ev.thread, ev.turn], hang: true } });
    const ac = new AbortController();
    const p = adapter.generate(request({ signal: ac.signal }));
    // Wait until the exec child has actually started.
    for (let i = 0; i < 100 && fake.execCalls().length === 0; i += 1) await new Promise((r) => setTimeout(r, 30));
    expect(fake.execCalls()).toHaveLength(1);
    ac.abort();
    expect((await failureOf(p)).failure).toEqual({ code: "canceled", message: "codex-local-cli: canceled" });
    // Re-use the same adapter for a fresh request on a new fake: no state leaks.
    const next = setup({ exec: { lines: okTranscript("after cancel"), exitCode: 0 } });
    expect((await next.adapter.generate(next.request())).text).toBe("after cancel");
  });
});

describe("classifyNativeText and CodexTranscript units", () => {
  it("classifies only into fixed categories", () => {
    expect(classifyNativeText("Not authenticated")).toBe("authentication");
    expect(classifyNativeText("token expired")).toBe("authentication");
    expect(classifyNativeText("Quota exceeded")).toBe("rate_limited");
    expect(classifyNativeText("model not supported")).toBe("model_unavailable");
    expect(classifyNativeText("input is too long")).toBe("context_too_large");
    expect(classifyNativeText("anything else")).toBe("provider_unavailable");
  });

  it("the transcript keeps no reasoning or tool payload in any field", () => {
    const t = new CodexTranscript(MODEL, 1000);
    t.accept(ev.reasoning("PRIVATE-REASONING-MARKER"));
    t.accept(ev.message("answer"));
    t.accept(JSON.stringify({ type: "item.completed", item: { type: "todo_list", items: ["PRIVATE-PLAN"] } }));
    t.accept(JSON.stringify({ type: "item.completed", item: { type: "error", message: "PRIVATE-ITEM-ERROR" } }));
    t.accept(ev.done());
    expect(JSON.stringify(t)).not.toMatch(/PRIVATE-/);
    expect(t.answer).toBe("answer");
    expect(t.violation).toBeNull();
  });

  it("the first violation wins", () => {
    const t = new CodexTranscript(MODEL, 1000);
    expect(t.accept(ev.item("command_execution"))).toBe("kill");
    t.accept("not json");
    expect(t.violation).toBe("tool_event");
  });
});

describe("renderCodexPrompt", () => {
  it("is text-only and includes nothing but the stage input", () => {
    const { request } = setup({});
    const prompt = renderCodexPrompt(request());
    expect(prompt).toContain("[user]\nWhat is 2+2?");
    expect(prompt.startsWith("Answer the conversation below with text only.")).toBe(true);
  });
});

describe("Antigravity can only refuse", () => {
  it("never dispatches, reports unsupported, and says nothing vendor-specific", async () => {
    const adapter = new UnavailableNativeAdapter("gemini", "antigravity-local-cli");
    expect(adapter.supports()).toBe(false);
    expect(adapter.readiness()).toBe("unsupported");
    const f = await failureOf(adapter.generate());
    expect(f.failure).toEqual({ code: "provider_unavailable", message: "antigravity-local-cli: provider_unavailable (not_admitted)" });
  });

  it("the adapter table keeps native backends apart from provider API adapters", () => {
    const fake = makeFakeCodex();
    fakes.push(fake);
    const table = buildAdapters(codexConfig(fake, {}, { providerCredentials: { openaiKey: "sk-test", anthropicKey: null, googleKey: "g-test" } }));
    expect(Object.keys(table.native!).sort()).toEqual(["antigravity-local-cli", "codex-local-cli"]);
    expect(table.native!["codex-local-cli"]).toBeInstanceOf(CodexCliAdapter);
    expect(table.native!["antigravity-local-cli"]).toBeInstanceOf(UnavailableNativeAdapter);
    expect(table.adapters.openai).not.toBe(table.native!["codex-local-cli"]);
    expect(table.adapters.gemini).not.toBe(table.native!["antigravity-local-cli"]);
  });
});

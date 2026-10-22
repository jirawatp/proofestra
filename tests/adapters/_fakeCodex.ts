// Fake `codex` executable for native-adapter tests. It is a generated Node
// script (shebang = the test's own node binary) that records every invocation
// (argv, cwd, environment, stdin, scratch-dir contents) to a JSONL log and
// plays back a scripted transcript. Nothing here talks to a model, a network
// or a real login: it only exercises Proofestra's supervision of a child
// process and its interpretation of `codex exec --json` lines.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProofestraConfig } from "../../src/shared/config.js";
import type { ModelProfile, NativeVerificationRecord } from "../../src/shared/types.js";
import { freezeCodexPolicy } from "../../src/core/nativeBackends.js";
import { makeConfig } from "../integration/_server_helpers.js";

export const FIXTURE_DIR = path.join(import.meta.dirname, "..", "fixtures", "native");

/** TEST ONLY: a record claiming every control is enforced. Production never ships this. */
export const TEST_COMPLETE_VERIFICATION: NativeVerificationRecord = {
  cli_version: "0.163.0",
  controls: [{ id: "test_only_all_enforced", status: "enforced", evidence: "test double" }],
};

/** The real captured deny-override table with `unified_exec` flipped to false. */
export function cleanFeaturesText(): string {
  const real = fs.readFileSync(path.join(FIXTURE_DIR, "codex-0.163.0-features-denied.txt"), "utf8");
  return real.replace(/^(unified_exec\s+\S+\s+)true$/m, "$1false");
}

export interface FakeExecSpec {
  lines?: string[];
  exitCode?: number;
  stderr?: string;
  /** Stay alive after emitting `lines` (until killed). */
  hang?: boolean;
  /** Spawn a long-lived grandchild and record its pid in `pidFile`. */
  grandchildPidFile?: string;
  /** Do not read stdin at all (exit immediately). */
  ignoreStdin?: boolean;
  /**
   * Spawn a finite (4 s) grandchild that LEAVES the process group and inherits the
   * stdout/stderr pipes, and record its pid here. Tests must reap it.
   */
  escapeGrandchildPidFile?: string;
}

export interface FakeCodexSpec {
  versionText?: string;
  versionExit?: number;
  featuresText?: string;
  featuresExit?: number;
  /** `codex login status` output (default: the exact ChatGPT message). */
  loginText?: string;
  loginExit?: number;
  loginStream?: "stdout" | "stderr";
  /** Artificial latency of the pre-launch probes, to exercise the shared time budget. */
  featuresDelayMs?: number;
  loginDelayMs?: number;
  /** On `login status`, rewrite this fake executable (simulates replacement after preflight). */
  mutateOnLogin?: boolean;
  exec?: FakeExecSpec;
}

export interface FakeCodexCall {
  kind: "version" | "features" | "login" | "exec";
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  cwdEntries: string[];
  stdin?: string;
}

export interface FakeCodex {
  dir: string;
  bin: string;
  calls(): FakeCodexCall[];
  execCalls(): FakeCodexCall[];
  cleanup(): void;
}

export function makeFakeCodex(spec: FakeCodexSpec = {}): FakeCodex {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-fake-codex-"));
  const log = path.join(dir, "calls.jsonl");
  const bin = path.join(dir, "codex");
  const full = {
    versionText: "codex-cli 0.163.0",
    versionExit: 0,
    featuresText: cleanFeaturesText(),
    featuresExit: 0,
    loginText: "Logged in using ChatGPT\n",
    loginExit: 0,
    loginStream: "stdout",
    featuresDelayMs: 0,
    loginDelayMs: 0,
    mutateOnLogin: false,
    exec: { lines: [], exitCode: 0 },
    ...spec,
  };
  const script = `#!${process.execPath}
const fs = require("node:fs");
const cp = require("node:child_process");
const spec = ${JSON.stringify(full)};
const log = ${JSON.stringify(log)};
const argv = process.argv.slice(2);
function record(kind, extra) {
  const entry = { kind, argv, cwd: process.cwd(), env: process.env, cwdEntries: fs.readdirSync(process.cwd()), ...extra };
  fs.appendFileSync(log, JSON.stringify(entry) + "\\n");
}
if (argv[0] === "--version") {
  record("version");
  process.stdout.write(spec.versionText + "\\n");
  process.exitCode = spec.versionExit;
} else if (argv[0] === "features") {
  record("features");
  setTimeout(() => {
    process.stdout.write(spec.featuresText);
    process.exitCode = spec.featuresExit;
  }, spec.featuresDelayMs);
} else if (argv[0] === "login" && argv[1] === "status") {
  record("login");
  if (spec.mutateOnLogin) fs.appendFileSync(process.argv[1], "\\n// replaced after preflight\\n");
  setTimeout(() => {
    (spec.loginStream === "stderr" ? process.stderr : process.stdout).write(spec.loginText);
    process.exitCode = spec.loginExit;
  }, spec.loginDelayMs);
} else if (argv[0] === "exec") {
  const run = (stdin) => {
    record("exec", { stdin });
    const e = spec.exec;
    if (e.escapeGrandchildPidFile) {
      const g = cp.spawn(process.execPath, ["-e", "setTimeout(() => {}, 4000)"], { detached: true, stdio: ["ignore", 1, 2] });
      fs.writeFileSync(e.escapeGrandchildPidFile, String(g.pid));
      g.unref();
    }
    if (e.grandchildPidFile) {
      const child = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      fs.writeFileSync(e.grandchildPidFile, String(child.pid));
    }
    for (const line of e.lines || []) process.stdout.write(line + "\\n");
    if (e.stderr) process.stderr.write(e.stderr);
    if (e.hang) setInterval(() => {}, 1000);
    else process.exitCode = e.exitCode || 0;
  };
  if (spec.exec.ignoreStdin) run("");
  else {
    let stdin = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { stdin += d; });
    process.stdin.on("end", () => run(stdin));
  }
} else {
  process.exitCode = 64;
}
`;
  fs.writeFileSync(bin, script, { mode: 0o755 });
  const read = (): FakeCodexCall[] =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as FakeCodexCall)
      : [];
  return {
    dir,
    bin,
    calls: read,
    execCalls: () => read().filter((c) => c.kind === "exec"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

export const MODEL = "gpt-5.6-sol";

export const CODEX_PROFILE: ModelProfile = {
  profile_id: "codex-local-default",
  provider: "openai",
  label: "codex",
  model_id: MODEL,
  safe_input_tokens: 64_000,
  max_output_tokens: 2048,
  api_shape: "codex_exec_cli",
  readiness: "configured",
  execution_backend_id: "codex-local-cli",
  capabilities: { image: false, pdf: false, audio: false, video: false },
};

export function codexConfig(
  fake: { bin: string },
  over: Partial<NonNullable<ProofestraConfig["nativeBackends"]>["codex"]> = {},
  top: Partial<ProofestraConfig> = {},
): ProofestraConfig {
  return makeConfig(os.tmpdir(), {
    liveEnabled: true,
    nativeBackends: {
      codex: {
        enabled: true,
        model: MODEL,
        executable: fake.bin,
        codexHome: null,
        verification: TEST_COMPLETE_VERIFICATION,
        ...over,
      },
    },
    ...top,
  });
}

export function frozenPolicy(config: ProofestraConfig) {
  const policy = freezeCodexPolicy(CODEX_PROFILE, config, { max_native_job_seconds: 60 });
  if (!policy) throw new Error("test config must be configured");
  return policy;
}

/** Well-formed `codex exec --json` transcript lines (documented event shapes). */
export const ev = {
  // The pinned model is REPORTED by the (fake) CLI here; a transcript with no
  // model report at all is deliberately unconfirmed (see `ev.threadNoModel`).
  thread: JSON.stringify({ type: "thread.started", thread_id: "t-1", model: "gpt-5.6-sol" }),
  threadNoModel: JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
  turn: JSON.stringify({ type: "turn.started" }),
  reasoning: (text: string) => JSON.stringify({ type: "item.completed", item: { id: "i0", type: "reasoning", text } }),
  message: (text: string) => JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text } }),
  done: (usage: unknown = { input_tokens: 120, cached_input_tokens: 0, output_tokens: 34 }) =>
    JSON.stringify({ type: "turn.completed", usage }),
  failed: (message: string) => JSON.stringify({ type: "turn.failed", error: { message } }),
  error: (message: string) => JSON.stringify({ type: "error", message }),
  item: (type: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "item.completed", item: { id: "ix", type, ...extra } }),
};

export function okTranscript(answer = "final answer", usage?: unknown): string[] {
  return [ev.thread, ev.turn, ev.reasoning("PRIVATE-REASONING-MARKER"), ev.message(answer), ev.done(usage)];
}

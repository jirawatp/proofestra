// Native backend identity, admission policy, readiness and the pre-launch
// feature preflight. Uses captured output of the INSTALLED codex-cli 0.163.0
// (harmless, non-inference commands) plus config literals; no process is run.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_VERIFICATION,
  CODEX_AUTH_CONTROL_ID,
  CODEX_DENIED_FEATURES,
  CODEX_NEUTRAL_FEATURES,
  CODEX_VERIFICATION,
  antigravityStatus,
  buildCodexExecArgv,
  buildCodexFeaturesArgv,
  buildCodexLoginStatusArgv,
  codexOverrideArgs,
  codexStatus,
  describeNativeBackends,
  evaluateFeatureRows,
  executableIdentity,
  freezeCodexPolicy,
  interpretCodexLoginStatus,
  NATIVE_ENFORCEABLE_CONTROLS,
  nativeToolPolicyViolation,
  isNativeApiShape,
  isNativeBackendId,
  isSafeModelId,
  nativeReadinessFor,
  parseFeaturesList,
  resolveCodexExecutable,
  unprovenControlIds,
} from "../../src/core/nativeBackends.js";
import { loadProfileCatalog, readinessFor, toModelProfile } from "../../src/core/profileConfig.js";
import { loadConfig } from "../../src/shared/config.js";
import { FIXTURE_DIR, TEST_COMPLETE_VERIFICATION, cleanFeaturesText, codexConfig } from "../adapters/_fakeCodex.js";
import { makeConfig } from "../integration/_server_helpers.js";

const fixture = (name: string) => fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8");

const tmp: string[] = [];
function tempFile(mode: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-native-"));
  tmp.push(dir);
  const file = path.join(dir, "codex");
  fs.writeFileSync(file, "#!/bin/sh\n", { mode });
  return file;
}
afterEach(() => {
  for (const dir of tmp.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("feature preflight against captured codex-cli 0.163.0 output", () => {
  it("parses both real captured tables completely", () => {
    for (const name of ["codex-0.163.0-features-default.txt", "codex-0.163.0-features-denied.txt"]) {
      const rows = parseFeaturesList(fixture(name));
      expect(rows, name).not.toBeNull();
      expect(rows!.length).toBe(175);
      // A multi-word stage ("under development") is one stage, not two columns.
      expect(rows!.find((r) => r.stage === "under development")).toBeDefined();
    }
  });

  it("the unmodified defaults fail: tool-bearing features are on", () => {
    const rows = parseFeaturesList(fixture("codex-0.163.0-features-default.txt"))!;
    expect(evaluateFeatureRows(rows)).toEqual({ ok: false, reason: "denied_feature_enabled" });
  });

  it("with every deny override applied, the REAL 0.163.0 output still fails: unified_exec stays true", () => {
    const rows = parseFeaturesList(fixture("codex-0.163.0-features-denied.txt"))!;
    const unified = rows.find((r) => r.name === "unified_exec")!;
    expect(unified.enabled).toBe(true); // recorded fact, not an assumption
    // Every OTHER denied feature really was switched off by the overrides.
    for (const name of CODEX_DENIED_FEATURES.filter((n) => n !== "unified_exec")) {
      expect(rows.find((r) => r.name === name)!.enabled, name).toBe(false);
    }
    expect(evaluateFeatureRows(rows)).toEqual({ ok: false, reason: "denied_feature_enabled" });
  });

  it("passes only when unified_exec is also off (what a verified future version must show)", () => {
    expect(evaluateFeatureRows(parseFeaturesList(cleanFeaturesText())!)).toEqual({ ok: true });
  });

  it("flags a missing denied feature and an unclassified newly-enabled feature", () => {
    const rows = parseFeaturesList(cleanFeaturesText())!;
    expect(evaluateFeatureRows(rows.filter((r) => r.name !== "shell_tool"))).toEqual({
      ok: false,
      reason: "denied_feature_missing",
    });
    expect(
      evaluateFeatureRows([...rows, { name: "brand_new_tool", stage: "stable", enabled: true }]),
    ).toEqual({ ok: false, reason: "unclassified_feature_enabled" });
    // A removed, inert flag that reads true is not a drift signal.
    expect(
      evaluateFeatureRows([...rows, { name: "legacy_gone", stage: "removed", enabled: true }]),
    ).toEqual({ ok: true });
    // The neutral list is exactly what the clean real table leaves enabled.
    const enabled = rows.filter((r) => r.enabled && r.stage !== "removed").map((r) => r.name).sort();
    expect(enabled).toEqual([...CODEX_NEUTRAL_FEATURES].sort());
  });

  it.each([
    ["", "empty"],
    ["not a feature table", "prose"],
    ["apps stable maybe", "bad state"],
  ])("rejects an unparseable table (%s)", (text) => {
    expect(parseFeaturesList(text)).toBeNull();
  });
});

describe("invocation-only argv", () => {
  it("exec argv carries every isolation control and never the prompt", () => {
    const argv = buildCodexExecArgv({ model: "gpt-5.6-sol", scratchDir: "/tmp/scratch" });
    for (const flag of ["--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--json"]) {
      expect(argv).toContain(flag);
    }
    expect(argv.slice(argv.indexOf("--sandbox"), argv.indexOf("--sandbox") + 2)).toEqual(["--sandbox", "read-only"]);
    expect(argv.slice(argv.indexOf("-C"), argv.indexOf("-C") + 2)).toEqual(["-C", "/tmp/scratch"]);
    expect(argv.slice(argv.indexOf("-m"), argv.indexOf("-m") + 2)).toEqual(["-m", "gpt-5.6-sol"]);
    // Prompt comes from stdin via "-".
    expect(argv.at(-1)).toBe("-");
    // The deny overrides are the same ones the preflight verifies.
    expect(argv).toEqual(expect.arrayContaining(codexOverrideArgs()));
    expect(buildCodexFeaturesArgv()).toEqual(["features", "list", ...codexOverrideArgs()]);
    for (const feature of CODEX_DENIED_FEATURES) {
      const i = argv.indexOf(feature);
      expect(argv[i - 1], feature).toBe("--disable");
    }
    expect(argv).toContain('web_search="disabled"');
    expect(argv).toContain('approval_policy="never"');
    // Subscription-only: ask the CLI to refuse any login method but ChatGPT.
    const forced = argv.indexOf('forced_login_method="chatgpt"');
    expect(argv[forced - 1]).toBe("-c");
    expect(buildCodexFeaturesArgv()).toContain('forced_login_method="chatgpt"');
    // Never any dangerous bypass, danger-full-access, or profile layering.
    expect(argv.join(" ")).not.toMatch(/dangerously|danger-full-access|workspace-write|--profile|--oss/);
  });

  it("the login-status gate argv is the vendor status command only: no login, key or token flag", () => {
    const argv = buildCodexLoginStatusArgv();
    expect(argv.slice(0, 2)).toEqual(["login", "status"]);
    expect(argv.join(" ")).not.toMatch(/--with-api-key|--with-access-token|--device-auth|logout/);
  });

  it.each(["", "-x", "--model", "a b", "a;b", "$(id)", "x".repeat(121)])("rejects unsafe model id %j", (model) => {
    expect(isSafeModelId(model)).toBe(false);
    expect(() => buildCodexExecArgv({ model, scratchDir: "/tmp/s" })).toThrow(/unsafe model/);
  });

  it("accepts documented model id shapes", () => {
    for (const model of ["gpt-5.6-sol", "gpt-6.1-sol", "codex-auto-review", "o3:high"]) {
      expect(isSafeModelId(model)).toBe(true);
    }
    expect(isSafeModelId(null)).toBe(false);
    expect(isSafeModelId(undefined)).toBe(false);
  });
});

describe("backend identity", () => {
  it("reserves native ids and shapes", () => {
    expect(isNativeBackendId("codex-local-cli")).toBe(true);
    expect(isNativeBackendId("antigravity-local-cli")).toBe(true);
    expect(isNativeBackendId("openai-chat-completions")).toBe(false);
    expect(isNativeApiShape("codex_exec_cli")).toBe(true);
    expect(isNativeApiShape("openai_chat_completions")).toBe(false);
  });
});

describe("sanitized status and readiness", () => {
  const fake = { bin: "" };
  it("walks the fail-closed ladder with exact reason codes", () => {
    const bin = tempFile(0o755);
    fake.bin = bin;
    const base = codexConfig(fake, { verification: undefined });
    // Live off beats everything.
    expect(codexStatus({ ...base, liveEnabled: false })).toMatchObject({ readiness: "disabled", reason_code: "live_disabled" });
    const nb = base.nativeBackends!.codex;
    const withCodex = (c: Partial<typeof nb>) => ({ ...base, nativeBackends: { codex: { ...nb, ...c } } });
    expect(codexStatus(withCodex({ enabled: false }))).toMatchObject({ readiness: "disabled", reason_code: "not_enabled" });
    expect(codexStatus(withCodex({ model: null }))).toMatchObject({ readiness: "missing", reason_code: "model_not_pinned" });
    expect(codexStatus(withCodex({ model: "bad model" }))).toMatchObject({ reason_code: "model_not_pinned" });
    expect(codexStatus(withCodex({ executable: "/nonexistent/codex" }))).toMatchObject({
      readiness: "missing",
      reason_code: "executable_not_found",
    });
    // The REAL record: executable present, controls unproven => unverified, never configured.
    const real = codexStatus(withCodex({}));
    expect(real).toMatchObject({
      backend_id: "codex-local-cli",
      provider: "openai",
      kind: "native_cli",
      readiness: "unverified",
      reason_code: "tool_surface_unproven",
      credentials: "vendor_managed",
      billing: "subscription_quota_cost_unknown",
      tool_surface: "unproven",
    });
    expect(real.unproven_controls).toEqual(unprovenControlIds(CODEX_VERIFICATION));
    expect(real.unproven_controls).toEqual(
      expect.arrayContaining(["unified_exec_not_disableable", "apply_patch_not_removable", "model_catalog_tool_mode"]),
    );
    // Only an every-control-enforced record yields configured; auth is still not read.
    expect(codexStatus(withCodex({ verification: TEST_COMPLETE_VERIFICATION }))).toMatchObject({
      readiness: "configured",
      reason_code: "ready_auth_checked_per_job",
      tool_surface: "proven_off",
      unproven_controls: [],
    });
    // Tools proven off but subscription-only auth NOT proven: still unverified,
    // with its own exact reason (an API-key billing risk is not a tool-surface one).
    const authOnly = codexStatus(
      withCodex({
        verification: {
          cli_version: "0.163.0",
          controls: [
            { id: "test_tools_enforced", status: "enforced", evidence: "test double" },
            { id: CODEX_AUTH_CONTROL_ID, status: "unproven", evidence: "test double" },
          ],
        },
      }),
    );
    expect(authOnly).toMatchObject({
      readiness: "unverified",
      reason_code: "auth_mode_unproven",
      tool_surface: "proven_off",
      unproven_controls: [CODEX_AUTH_CONTROL_ID],
    });
    // A tool-surface gap outranks the auth gap in the reported reason.
    expect(real.unproven_controls).toContain(CODEX_AUTH_CONTROL_ID);
  });

  it("status carries no path, version, login state or vendor text", () => {
    const bin = tempFile(0o755);
    const statuses = describeNativeBackends(codexConfig({ bin }, { verification: undefined }));
    const json = JSON.stringify(statuses);
    expect(json).not.toContain(bin);
    expect(json).not.toContain(os.homedir());
    expect(json).not.toMatch(/0\.163|1\.1\.5|token|sk-|auth\.json/i);
    expect(statuses.map((s) => s.backend_id)).toEqual(["codex-local-cli", "antigravity-local-cli"]);
  });

  it("Antigravity is always unverified, whatever the config", () => {
    expect(antigravityStatus()).toMatchObject({
      backend_id: "antigravity-local-cli",
      provider: "gemini",
      readiness: "unverified",
      reason_code: "protocol_unverified",
      tool_surface: "unproven",
    });
    expect(unprovenControlIds(ANTIGRAVITY_VERIFICATION)).toEqual(
      expect.arrayContaining(["overage_credits_unverified", "officially_supported_use_unverified", "no_tool_deny_flags"]),
    );
    const config = codexConfig({ bin: tempFile(0o755) });
    expect(nativeReadinessFor("antigravity_cli", config)).toBe("unverified");
    expect(nativeReadinessFor("codex_exec_cli", config)).toBe("configured");
  });

  it("freezes a policy only for a configured backend and a safe model", () => {
    const bin = tempFile(0o755);
    const profile = { provider: "openai" as const, model_id: "gpt-5.6-sol" };
    const limits = { max_native_job_seconds: 90 };
    const frozen = freezeCodexPolicy(profile, codexConfig({ bin }), limits)!;
    expect(frozen).toMatchObject({
      backend_id: "codex-local-cli",
      model_id: "gpt-5.6-sol",
      policy_id: "codex-exec-notools-v1",
      tool_surface: "proven_off",
      max_native_job_seconds: 90,
      permissions: { sandbox: "read-only", approvals: "never", env: "credential_free", persistence: "ephemeral" },
      accounting: { billing: "subscription_quota_cost_unknown", internal_usage_visibility: "opaque" },
    });
    expect(freezeCodexPolicy(profile, codexConfig({ bin }, { verification: undefined }), limits)).toBeNull();
    expect(freezeCodexPolicy({ ...profile, model_id: "bad model" }, codexConfig({ bin }), limits)).toBeNull();
    expect(freezeCodexPolicy({ ...profile, model_id: null }, codexConfig({ bin }), limits)).toBeNull();
  });
});

describe("executable discovery", () => {
  it("accepts only an explicit executable regular file; never searches $PATH", () => {
    const good = tempFile(0o755);
    expect(resolveCodexExecutable(codexConfig({ bin: good }))).toBe(fs.realpathSync(good));
    expect(resolveCodexExecutable(codexConfig({ bin: tempFile(0o644) }))).toBeNull();
    expect(resolveCodexExecutable(codexConfig({ bin: path.dirname(good) }))).toBeNull();
    expect(resolveCodexExecutable(codexConfig({ bin: "/nonexistent/codex" }))).toBeNull();
    // With no explicit path and nothing at the fixed candidates, `codex` on
    // $PATH is NOT consulted (candidates are absolute and fixed).
    const saved = process.env.PATH;
    process.env.PATH = `${path.dirname(good)}:${saved ?? ""}`;
    try {
      const result = resolveCodexExecutable(codexConfig({ bin: "" }, { executable: null }));
      const realCandidates = ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"].flatMap((c) => {
        try {
          return [fs.realpathSync(c)];
        } catch {
          return [];
        }
      });
      expect(result === null || realCandidates.includes(result)).toBe(true);
      expect(result).not.toBe(fs.realpathSync(good));
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe("executable identity", () => {
  it("resolves a symlink to the REAL file, and a re-pointed symlink resolves to the new real file", () => {
    const a = tempFile(0o755);
    const b = tempFile(0o755);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-link-"));
    tmp.push(dir);
    const link = path.join(dir, "codex");
    fs.symlinkSync(a, link);
    expect(resolveCodexExecutable(codexConfig({ bin: link }))).toBe(fs.realpathSync(a));
    fs.unlinkSync(link);
    fs.symlinkSync(b, link);
    expect(resolveCodexExecutable(codexConfig({ bin: link }))).toBe(fs.realpathSync(b));
    // A dangling link is not an executable.
    fs.unlinkSync(link);
    fs.symlinkSync(path.join(dir, "missing"), link);
    expect(resolveCodexExecutable(codexConfig({ bin: link }))).toBeNull();
  });

  it("changes when the file is replaced or rewritten, and is null for a missing file or a directory", () => {
    const file = tempFile(0o755);
    const real = fs.realpathSync(file);
    const before = executableIdentity(real);
    expect(before).toMatch(/^\d+:\d+:\d+:\d+$/);
    expect(executableIdentity(real)).toBe(before);
    fs.writeFileSync(file, "#!/bin/sh\n# updated bytes\n", { mode: 0o755 });
    expect(executableIdentity(real)).not.toBe(before);
    expect(executableIdentity(path.join(path.dirname(real), "nope"))).toBeNull();
    expect(executableIdentity(path.dirname(real))).toBeNull();
  });
});

describe("profiles bound to native backends", () => {
  const live = (over = {}) => makeConfig(os.tmpdir(), { liveEnabled: true, ...over });
  const nativeProfile = (over: Record<string, unknown> = {}) => ({
    profile_id: "codex-x",
    provider: "openai",
    label: "x",
    model_id: "gpt-5.6-sol",
    safe_input_tokens: 64_000,
    max_output_tokens: 2048,
    api_shape: "codex_exec_cli",
    execution_backend_id: "codex-local-cli",
    ...over,
  });
  const catalog = (profile: unknown) => () =>
    loadProfileCatalog(live(), { fileContents: JSON.stringify({ profiles: [profile] }), filePath: "p.json" });

  it("accepts a native profile only with its own reserved backend id", () => {
    expect(catalog(nativeProfile())().profiles.some((p) => p.profile_id === "codex-x")).toBe(true);
    expect(catalog(nativeProfile({ execution_backend_id: "openai-chat-completions" }))).toThrow(/requires execution_backend_id=codex-local-cli/);
    expect(catalog(nativeProfile({ execution_backend_id: "antigravity-local-cli" }))).toThrow(/requires execution_backend_id=codex-local-cli/);
  });

  it("refuses an API profile that claims a reserved native backend id", () => {
    const api = nativeProfile({ api_shape: "openai_chat_completions", execution_backend_id: "codex-local-cli" });
    expect(catalog(api)).toThrow(/reserved for its native api_shape/);
  });

  it("refuses a native shape under the wrong provider", () => {
    expect(catalog(nativeProfile({ provider: "anthropic" }))).toThrow(/requires api_shape=anthropic_messages_v1/);
    expect(catalog(nativeProfile({ api_shape: "antigravity_cli" }))).toThrow(/requires api_shape=openai_chat_completions or codex_exec_cli/);
  });

  it("derives a codex profile only when enabled AND a model is pinned; text-only; never configured while unproven", () => {
    const bin = tempFile(0o755);
    const ids = (c: ReturnType<typeof live>) => loadProfileCatalog(c).profiles.map((p) => p.profile_id);
    expect(ids(live())).not.toContain("codex-local-default");
    expect(ids(codexConfig({ bin }, { model: null }))).not.toContain("codex-local-default");
    const config = codexConfig({ bin }, { verification: undefined });
    const entry = loadProfileCatalog(config).profiles.find((p) => p.profile_id === "codex-local-default")!;
    expect(entry).toMatchObject({ provider: "openai", api_shape: "codex_exec_cli", execution_backend_id: "codex-local-cli" });
    expect(readinessFor(entry, config)).toBe("unverified");
    const model = toModelProfile(entry, config);
    expect(model.readiness).toBe("unverified");
    expect(model.capabilities).toMatchObject({ image: false, pdf: false, audio: false, video: false });
    // An operator's profile file cannot widen native attachment capabilities.
    const widened = toModelProfile({ ...entry, capabilities: { image: true, pdf: true, video: true } }, config);
    expect(widened.capabilities).toMatchObject({ image: false, pdf: false, video: false });
    // The OpenAI API default profile remains a separate, key-based backend.
    const api = loadProfileCatalog(config).profiles.find((p) => p.profile_id === "openai-default")!;
    expect(api.execution_backend_id).toBe("openai-chat-completions");
    expect(readinessFor(api, config)).toBe("missing_auth");
  });
});

describe("loadConfig native settings", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = ["PROOFESTRA_CODEX_ENABLED", "PROOFESTRA_CODEX_MODEL", "PROOFESTRA_CODEX_BIN", "PROOFESTRA_CODEX_HOME"];
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const setEnv = (values: Record<string, string>) => {
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    Object.assign(process.env, values);
  };

  it("is off, unpinned and path-less by default", () => {
    setEnv({});
    expect(loadConfig("/x").nativeBackends).toEqual({
      codex: { enabled: false, model: null, executable: null, codexHome: null },
    });
  });

  it("reads opt-in settings and never a credential", () => {
    setEnv({
      PROOFESTRA_CODEX_ENABLED: "1",
      PROOFESTRA_CODEX_MODEL: "gpt-5.6-sol",
      PROOFESTRA_CODEX_BIN: "/opt/homebrew/bin/codex",
      PROOFESTRA_CODEX_HOME: "/Users/someone/.codex",
    });
    const codex = loadConfig("/x").nativeBackends!.codex;
    expect(codex).toEqual({
      enabled: true,
      model: "gpt-5.6-sol",
      executable: "/opt/homebrew/bin/codex",
      codexHome: "/Users/someone/.codex",
    });
    expect(Object.keys(codex)).not.toContain("verification");
  });

  it.each(["relative/codex", "./codex", "/a/../b/codex", "codex"])("rejects a non-absolute or non-normalized path %j", (bad) => {
    setEnv({ PROOFESTRA_CODEX_BIN: bad });
    expect(() => loadConfig("/x")).toThrow(/PROOFESTRA_CODEX_BIN must be an absolute normalized path/);
  });
});

describe("ChatGPT-only authentication gate", () => {
  it.each([
    ["Logged in using ChatGPT\n", "chatgpt"],
    ["  Logged in using ChatGPT  \n\n", "chatgpt"],
    ["Not logged in\n", "not_logged_in"],
    ["Logged in using an API key - sk-...abcd\n", "other"],
    ["Logged in using personal access token\n", "other"],
    ["Logged in using workload identity\n", "other"],
    ["Logged in using Amazon Bedrock API key\n", "other"],
    // Extra lines, a lookalike, an empty or a reformatted status are never trusted.
    ["Logged in using ChatGPT\nLogged in using an API key - x\n", "other"],
    ["Logged in using ChatGPT (Plus)\n", "other"],
    ["not logged in\n", "other"],
    ["", "other"],
    ["chatgpt", "other"],
  ])("interprets %j as %s", (text, kind) => {
    expect(interpretCodexLoginStatus(text)).toBe(kind);
  });

  it("the real record keeps the auth-mode control unproven, so nothing is admitted on it", () => {
    expect(unprovenControlIds(CODEX_VERIFICATION)).toContain(CODEX_AUTH_CONTROL_ID);
  });
});

describe("native admission policy (requested strict/opaque controls)", () => {
  const ok: Parameters<typeof nativeToolPolicyViolation>[0] = {
    bounds_mode: "bounded_job",
    allow_unknown_internal_usage: true,
    required_controls: [],
  };

  it("admits only an explicit bounded_job with allow_unknown_internal_usage", () => {
    expect(nativeToolPolicyViolation(ok)).toBeNull();
    // The default (strict, unknown not allowed) must not become an opaque job.
    expect(nativeToolPolicyViolation({ ...ok, bounds_mode: "strict", allow_unknown_internal_usage: false })).toMatch(
      /bounded_job.*allow_unknown_internal_usage/,
    );
    expect(nativeToolPolicyViolation({ ...ok, bounds_mode: "strict" })).not.toBeNull();
    expect(nativeToolPolicyViolation({ ...ok, allow_unknown_internal_usage: false })).not.toBeNull();
  });

  it("admits only controls a native job can enforce and never echoes user text", () => {
    expect([...NATIVE_ENFORCEABLE_CONTROLS].sort()).toEqual(["context_isolation", "deadline", "harness_invocations"]);
    expect(nativeToolPolicyViolation({ ...ok, required_controls: ["deadline", "context_isolation"] })).toBeNull();
    const refused = nativeToolPolicyViolation({
      ...ok,
      required_controls: ["deadline", "output_token_ceiling", "SECRET-CONTROL-NAME"],
    });
    expect(refused).toMatch(/cannot enforce 2 of the requested required_controls/);
    expect(refused).not.toContain("SECRET");
  });
});

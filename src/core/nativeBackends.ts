// Native (vendor-CLI) backend identity, admission policy and readiness.
//
// A native backend is a locally installed vendor CLI that owns its own
// subscription login. Proofestra never reads, stores or forwards that login;
// it only decides whether to ALLOW a supervised, bounded, no-tools job and
// reports a sanitized state. Nothing here calls a model or the network.
//
// Fail-closed contract:
//   - A native backend id never maps to an API adapter and never falls back
//     to one (see `pickAdapter` in coordinator.ts).
//   - Execution is admitted only when EVERY control in the backend's
//     verification record is `enforced`. A read-only sandbox alone is not a
//     no-tools proof, so unproven controls keep the backend `unverified`.
//   - The record below states what was actually established against the
//     installed CLI, with the evidence, and what was not.

import fs from "node:fs";
import { codexSettings, type ProofestraConfig } from "../shared/config.js";
import type {
  ModelProfile,
  NativeBackendFreeze,
  NativeBackendStatus,
  NativeReasonCode,
  NativeVerificationRecord,
  Readiness,
  RunLimits,
  ToolPolicy,
} from "../shared/types.js";

export const CODEX_BACKEND_ID = "codex-local-cli";
export const ANTIGRAVITY_BACKEND_ID = "antigravity-local-cli";
export const NATIVE_BACKEND_IDS: readonly string[] = [CODEX_BACKEND_ID, ANTIGRAVITY_BACKEND_ID];

export const NATIVE_API_SHAPES = ["codex_exec_cli", "antigravity_cli"] as const;
export type NativeApiShape = (typeof NATIVE_API_SHAPES)[number];

/** A native api shape is bound to exactly one reserved backend id. */
export const NATIVE_SHAPE_BACKEND: Record<NativeApiShape, string> = {
  codex_exec_cli: CODEX_BACKEND_ID,
  antigravity_cli: ANTIGRAVITY_BACKEND_ID,
};

export function isNativeBackendId(id: string): boolean {
  return NATIVE_BACKEND_IDS.includes(id);
}

export function isNativeApiShape(shape: string): shape is NativeApiShape {
  return (NATIVE_API_SHAPES as readonly string[]).includes(shape);
}

export const CODEX_POLICY_ID = "codex-exec-notools-v1";

/** Verification control that is about the billing/auth mode, not the tool surface. */
export const CODEX_AUTH_CONTROL_ID = "chatgpt_only_auth_unenforced";

// ---------------------------------------------------------------------------
// Verification record
// ---------------------------------------------------------------------------

export function unprovenControlIds(record: NativeVerificationRecord): string[] {
  return record.controls.filter((c) => c.status !== "enforced").map((c) => c.id);
}

/**
 * What was established against the INSTALLED codex-cli 0.163.0 with harmless,
 * non-inference commands only (`--version`, `exec --help`, `features list`
 * with overrides, `debug models --bundled`). Re-verify per CLI version.
 */
export const CODEX_VERIFICATION: NativeVerificationRecord = {
  cli_version: "0.163.0",
  controls: [
    {
      id: "unified_exec_not_disableable",
      status: "unproven",
      evidence:
        "`codex features list --disable unified_exec` still reports unified_exec=true while shell_tool=false; the shell/exec surface cannot be switched off per invocation.",
    },
    {
      id: "apply_patch_not_removable",
      status: "unproven",
      evidence:
        "Every bundled model reports apply_patch_tool_type=freeform; the apply_patch_freeform feature is `removed`, so no exec option or feature flag removes the tool.",
    },
    {
      id: "model_catalog_tool_mode",
      status: "unproven",
      evidence:
        "Bundled 5.x/6.x models report tool_mode=code_mode_only and shell_type=unified_exec as model-catalog properties; no `codex exec` option overrides them.",
    },
    {
      id: "web_search_effect_unobservable",
      status: "unproven",
      evidence:
        "web_search=\"disabled\" is a documented config key but is not an entry in `features list`, so its effective state cannot be checked before launch.",
    },
    {
      id: "mcp_surface_unenumerable",
      status: "unproven",
      evidence:
        "--ignore-user-config drops the user config, but system/managed MCP configuration cannot be enumerated without starting a session.",
    },
    {
      id: "tool_inventory_unobservable",
      status: "unproven",
      evidence:
        "No installed command lists the tools exposed to a turn without sending an inference request, which is out of scope here.",
    },
    {
      id: CODEX_AUTH_CONTROL_ID,
      status: "unproven",
      evidence:
        "Removing inherited API-key variables does not stop the CLI from using a cached API-key login (paid API billing). `forced_login_method` exists in the installed 0.163.0 config schema and `codex login status` prints fixed messages, but neither the key's effect under `codex exec` nor the status output stream was exercised, because that needs the authenticated session. Each job therefore also runs a sanitized `login status` gate that accepts only the exact ChatGPT message.",
    },
  ],
};

/**
 * Antigravity (`agy`) stays unverified: nothing here executes it. The
 * installed 1.1.5 help documents no machine-readable output, no tool-deny
 * flags and no auth/status command; the AI-credit overage setting and the
 * third-party-login terms were not established. No flag is guessed.
 */
export const ANTIGRAVITY_VERIFICATION: NativeVerificationRecord = {
  cli_version: "1.1.5",
  controls: [
    { id: "protocol_not_machine_readable", status: "unproven", evidence: "Installed help lists only -p/--print; no JSON output, input or schema flags." },
    { id: "no_tool_deny_flags", status: "unproven", evidence: "No per-run tool, hook, plugin or MCP disable controls; workspace read/write is auto-allowed." },
    { id: "no_auth_status_command", status: "unproven", evidence: "No auth/status subcommand; login state cannot be checked without a model call." },
    { id: "overage_credits_unverified", status: "unproven", evidence: "AI-credit overage (useG1Credits) state cannot be verified per run; it must never be enabled or purchased." },
    { id: "officially_supported_use_unverified", status: "unproven", evidence: "Vendor FAQ prohibits third-party software using an Antigravity login; only unmodified local use is described." },
  ],
};

// ---------------------------------------------------------------------------
// Codex invocation policy (argv + feature preflight)
// ---------------------------------------------------------------------------

/**
 * Features disabled on EVERY native invocation and re-checked (effective
 * state must be false) by the pre-launch preflight. Includes tool-bearing
 * features and ones that start background work, raise quota use or retry
 * without bound. Names are from `codex features list` of 0.163.0.
 */
export const CODEX_DENIED_FEATURES: readonly string[] = [
  "apps",
  "browser_annotation_api",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "code_mode_host",
  "code_mode_interrupt",
  "computer_use",
  "daemon_auto_start",
  "fast_mode",
  "goals",
  "guardian_approval",
  "hooks",
  "image_generation",
  "in_app_browser",
  "memories",
  "multi_agent",
  "multi_agent_v2",
  "plugin_sharing",
  "plugins",
  "realtime_conversation",
  "recommended_plugins",
  "remote_plugin",
  "shell_snapshot",
  "shell_tool",
  "skill_mcp_dependency_install",
  "skill_search",
  "sleep_tool",
  "tool_call_mcp_elicitation",
  "tool_suggest",
  "ultrafast_mode",
  "unbounded_connection_retries",
  "unified_exec",
  "unified_exec_tty",
  "view_image",
  "workspace_dependencies",
  "worktrees",
  "write_stdin_approval",
];

/**
 * Features that may remain enabled. Classified by name and stage against the
 * installed version as unrelated to the tool surface (UI gates, wire details).
 * This is a DRIFT DETECTOR, not a proof: a different feature that is enabled
 * and in neither list fails the preflight as `unclassified_feature_enabled`.
 */
export const CODEX_NEUTRAL_FEATURES: readonly string[] = [
  "api_key_cyber_access_programs",
  "api_key_model_discovery",
  "auth_elicitation",
  "cli_daybreak",
  "compaction_image_budget",
  "content_item_kinds",
  "enable_request_compression",
  "guardian_reuse_parent_compaction",
  "in_app_chat",
  "in_app_dictation",
  "in_app_local_automation",
  "in_app_updates",
  "in_app_voice",
  "instant_interrupt",
  "mentions_v2",
  "system_proxy_fallback",
];

const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

export function isSafeModelId(model: string | null | undefined): model is string {
  return typeof model === "string" && SAFE_MODEL_ID.test(model);
}

/** Overrides shared by `exec` and the preflight so both see the same policy. */
export function codexOverrideArgs(): string[] {
  const args: string[] = [];
  for (const feature of CODEX_DENIED_FEATURES) args.push("--disable", feature);
  args.push("-c", 'web_search="disabled"', "-c", 'approval_policy="never"');
  // Subscription-only: ask the CLI to refuse any login method but ChatGPT. The
  // per-job `login status` gate below is the check that does not rely on it.
  args.push("-c", 'forced_login_method="chatgpt"');
  return args;
}

export function buildCodexFeaturesArgv(): string[] {
  return ["features", "list", ...codexOverrideArgs()];
}

/** `codex login status` argv: reports the auth KIND only; never logs in or reads a token ourselves. */
export function buildCodexLoginStatusArgv(): string[] {
  return ["login", "status", "-c", 'forced_login_method="chatgpt"'];
}

export type CodexAuthKind = "chatgpt" | "not_logged_in" | "other";

/**
 * Interpret the exact fixed `codex login status` messages found in the
 * installed 0.163.0 binary. Anything else (API key, access token, cloud
 * credentials, extra lines, a changed format) is `other` and is refused.
 */
export function interpretCodexLoginStatus(text: string): CodexAuthKind {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (lines.length === 1 && lines[0] === "Logged in using ChatGPT") return "chatgpt";
  if (lines.length === 1 && lines[0] === "Not logged in") return "not_logged_in";
  return "other";
}

/**
 * `codex exec` argv. The prompt is NOT in argv (a private conversation must
 * not appear in `ps`); `-` makes the CLI read it from stdin.
 */
export function buildCodexExecArgv(opts: { model: string; scratchDir: string }): string[] {
  if (!isSafeModelId(opts.model)) throw new Error("unsafe model id");
  return [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "--json",
    "-C",
    opts.scratchDir,
    "-m",
    opts.model,
    ...codexOverrideArgs(),
    "-",
  ];
}

export interface FeatureRow {
  name: string;
  stage: string;
  enabled: boolean;
}

/** Parse `codex features list` ("name stage true|false"). Null if malformed. */
export function parseFeaturesList(text: string): FeatureRow[] | null {
  const rows: FeatureRow[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const match = /^([a-z0-9_.]+)\s+([a-z_ ]+?)\s+(true|false)$/.exec(line);
    if (!match) return null;
    rows.push({ name: match[1]!, stage: match[2]!.trim(), enabled: match[3] === "true" });
  }
  return rows.length > 0 ? rows : null;
}

export type FeatureCheck =
  | { ok: true }
  | { ok: false; reason: "denied_feature_missing" | "denied_feature_enabled" | "unclassified_feature_enabled" };

export function evaluateFeatureRows(rows: readonly FeatureRow[]): FeatureCheck {
  const byName = new Map(rows.map((r) => [r.name, r] as const));
  for (const name of CODEX_DENIED_FEATURES) {
    const row = byName.get(name);
    if (!row) return { ok: false, reason: "denied_feature_missing" };
    if (row.enabled) return { ok: false, reason: "denied_feature_enabled" };
  }
  const denied = new Set(CODEX_DENIED_FEATURES);
  const neutral = new Set(CODEX_NEUTRAL_FEATURES);
  for (const row of rows) {
    if (!row.enabled || row.stage === "removed") continue;
    if (denied.has(row.name) || neutral.has(row.name)) continue;
    return { ok: false, reason: "unclassified_feature_enabled" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Executable discovery (explicit absolute path or fixed candidates; never $PATH)
// ---------------------------------------------------------------------------

export const CODEX_EXECUTABLE_CANDIDATES: readonly string[] = [
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
];

/**
 * The REAL file behind the chosen candidate (symlinks resolved), or null. The
 * resolved path is what is fingerprinted and spawned, so a symlink that is
 * re-pointed after preflight cannot redirect a later job to a different binary.
 */
export function resolveCodexExecutable(config: Pick<ProofestraConfig, "nativeBackends">): string | null {
  const settings = codexSettings(config);
  const candidates = settings.executable ? [settings.executable] : CODEX_EXECUTABLE_CANDIDATES;
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate);
      if (!fs.statSync(real).isFile()) continue;
      fs.accessSync(real, fs.constants.X_OK);
      return real;
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Identity of the file at `realPath` right now (device, inode, size, mtime). A
 * replaced or updated binary changes it, so a cached "this version passed
 * preflight" result is never reused for different bytes. It is a change detector,
 * not a content hash or a signature check.
 */
export function executableIdentity(realPath: string): string | null {
  try {
    const st = fs.statSync(realPath, { bigint: true });
    if (!st.isFile()) return null;
    return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sanitized status (no credential, path, version string or vendor text)
// ---------------------------------------------------------------------------

function status(
  backend: { id: string; provider: "openai" | "gemini" },
  readiness: Readiness,
  reason: NativeReasonCode,
  record: NativeVerificationRecord,
): NativeBackendStatus {
  const unproven = unprovenControlIds(record);
  const toolControlsUnproven = unproven.some((id) => id !== CODEX_AUTH_CONTROL_ID);
  return {
    backend_id: backend.id,
    provider: backend.provider,
    kind: "native_cli",
    readiness,
    reason_code: reason,
    credentials: "vendor_managed",
    billing: "subscription_quota_cost_unknown",
    // Antigravity has no auth-mode control, so any unproven control is a tool-surface one.
    tool_surface: toolControlsUnproven ? "unproven" : "proven_off",
    unproven_controls: unproven,
  };
}

export function codexStatus(config: ProofestraConfig): NativeBackendStatus {
  const settings = codexSettings(config);
  const record = settings.verification ?? CODEX_VERIFICATION;
  const backend = { id: CODEX_BACKEND_ID, provider: "openai" as const };
  if (!config.liveEnabled) return status(backend, "disabled", "live_disabled", record);
  if (!settings.enabled) return status(backend, "disabled", "not_enabled", record);
  if (!isSafeModelId(settings.model)) return status(backend, "missing", "model_not_pinned", record);
  if (resolveCodexExecutable(config) === null) {
    return status(backend, "missing", "executable_not_found", record);
  }
  const unproven = unprovenControlIds(record);
  if (unproven.some((id) => id !== CODEX_AUTH_CONTROL_ID)) {
    return status(backend, "unverified", "tool_surface_unproven", record);
  }
  if (unproven.length > 0) return status(backend, "unverified", "auth_mode_unproven", record);
  // Login state is owned by the vendor CLI and is never read here. Each job is
  // gated on a sanitized `login status` that must report ChatGPT; a missing or
  // non-ChatGPT login surfaces as an `authentication` failure at dispatch.
  return status(backend, "configured", "ready_auth_checked_per_job", record);
}

export function antigravityStatus(): NativeBackendStatus {
  return status(
    { id: ANTIGRAVITY_BACKEND_ID, provider: "gemini" },
    "unverified",
    "protocol_unverified",
    ANTIGRAVITY_VERIFICATION,
  );
}

export function describeNativeBackends(config: ProofestraConfig): NativeBackendStatus[] {
  return [codexStatus(config), antigravityStatus()];
}

/** Readiness for a profile bound to a native backend (never `configured` for Antigravity). */
export function nativeReadinessFor(
  shape: NativeApiShape,
  config: ProofestraConfig,
): Readiness {
  return shape === "codex_exec_cli" ? codexStatus(config).readiness : antigravityStatus().readiness;
}

/**
 * Freeze the admission policy for a Codex-backed agent. Returns null unless
 * the backend is `configured` (every control enforced), so a frozen policy
 * can only ever describe a proven-no-tools backend.
 */
export function freezeCodexPolicy(
  profile: Pick<ModelProfile, "model_id" | "provider">,
  config: ProofestraConfig,
  limits: Pick<RunLimits, "max_native_job_seconds">,
): NativeBackendFreeze | null {
  const current = codexStatus(config);
  if (current.readiness !== "configured" || !isSafeModelId(profile.model_id)) return null;
  const record = codexSettings(config).verification ?? CODEX_VERIFICATION;
  return {
    backend_id: CODEX_BACKEND_ID,
    provider: profile.provider,
    model_id: profile.model_id,
    policy_id: CODEX_POLICY_ID,
    cli_version: record.cli_version,
    tool_surface: "proven_off",
    permissions: {
      sandbox: "read-only",
      approvals: "never",
      network_tools: "off",
      cwd: "empty_scratch",
      env: "credential_free",
      persistence: "ephemeral",
    },
    accounting: {
      billing: "subscription_quota_cost_unknown",
      usage: "vendor_reported_or_unknown",
      internal_usage_visibility: "opaque",
    },
    max_native_job_seconds: limits.max_native_job_seconds,
  };
}

// ---------------------------------------------------------------------------
// Requested-policy admission for native jobs
// ---------------------------------------------------------------------------

/**
 * Controls a native job can honestly satisfy: the harness schedules and counts
 * jobs (`harness_invocations`), each runs in an empty scratch directory with no
 * conversation state (`context_isolation`), and the supervisor enforces a
 * wallclock kill (`deadline`). Nothing else (output-token ceiling, internal
 * call or tool-operation limits) is enforceable from outside the CLI.
 */
export const NATIVE_ENFORCEABLE_CONTROLS: readonly string[] = ["context_isolation", "harness_invocations", "deadline"];

/**
 * A native job's internals are opaque and its output-token ceiling cannot be
 * enforced, so it is eligible only for an explicit `bounded_job` request with
 * `allow_unknown_internal_usage: true`, and only for controls it can enforce.
 * Returns a fixed, user-text-free reason or null when admissible.
 */
export function nativeToolPolicyViolation(
  policy: Pick<ToolPolicy, "bounds_mode" | "required_controls" | "allow_unknown_internal_usage">,
): string | null {
  if (policy.bounds_mode !== "bounded_job" || policy.allow_unknown_internal_usage !== true) {
    return "a native job has opaque internal usage and no enforceable output-token ceiling; it requires bounds_mode=bounded_job with allow_unknown_internal_usage=true";
  }
  const unsupported = policy.required_controls.filter((c) => !NATIVE_ENFORCEABLE_CONTROLS.includes(c)).length;
  if (unsupported > 0) {
    return `the native backend cannot enforce ${unsupported} of the requested required_controls`;
  }
  return null;
}

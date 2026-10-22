// Codex CLI native adapter (vendor-managed ChatGPT login).
//
// This adapter runs `codex exec` as a supervised, bounded, single-turn,
// no-tools job. It NEVER sees, reads or forwards the login: the CLI finds its
// own auth through the user's normal Codex home, and the child environment
// contains no API key, token or proxy variable. It makes no API call, falls
// back to nothing, and is only reachable through the `codex-local-cli` backend
// id (see `pickAdapter`).
//
// Defense in depth, in order:
//   1. The run carries a frozen native policy; dispatch refuses a mismatch.
//   2. The backend must currently be `configured`, which requires EVERY tool
//      surface control to be proven (src/core/nativeBackends.ts). Against the
//      installed 0.163.0 they are not, so this adapter refuses to launch.
//   3. A pre-launch preflight pins the CLI version and requires the effective
//      feature state (with the deny overrides applied) to match policy.
//   3b. Subscription-only: every job first runs a sanitized `codex login
//      status` and proceeds only on the exact ChatGPT message, so a cached
//      API-key login can never select paid API billing. The status command is
//      the vendor's own; this module never opens an auth file or token.
//   4. The job itself runs in an empty scratch directory with a minimal env.
//   5. Only allowlisted JSONL events are interpreted. Any tool/command/file/
//      MCP/web item, unknown event, or malformed line kills the job and fails
//      the step. Reasoning items are discarded unread; nothing but the final
//      answer text and usage counters leaves this module.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexSettings, type ProofestraConfig } from "../shared/config.js";
import type {
  ModelProfile,
  NativeBackendFreeze,
  NormalizedFailureCode,
  ProviderId,
} from "../shared/types.js";
import type { AdapterRequest, AdapterResult, ProviderAdapter } from "./types.js";
import { AdapterFailure } from "./types.js";
import {
  CODEX_BACKEND_ID,
  CODEX_POLICY_ID,
  CODEX_VERIFICATION,
  buildCodexExecArgv,
  buildCodexFeaturesArgv,
  buildCodexLoginStatusArgv,
  codexStatus,
  evaluateFeatureRows,
  executableIdentity,
  interpretCodexLoginStatus,
  isSafeModelId,
  parseFeaturesList,
  resolveCodexExecutable,
} from "../core/nativeBackends.js";
import { runNativeJob, type LineVerdict, type NativeJobResult } from "../core/nativeProc.js";
import { safeUsageCount } from "./_sanitize.js";
import { frameAttachmentOnlyNote, frameExtractedAttachment } from "./attachmentFraming.js";

export type NativeFailureReason =
  | "not_admitted"
  | "policy_mismatch"
  | "attachment_not_supported"
  | "executable_missing"
  | "spawn_failed"
  | "version_unverified"
  | "preflight_failed"
  | "executable_changed"
  | "model_unconfirmed"
  | "containment_unverified"
  | "not_logged_in"
  | "auth_not_chatgpt"
  | "auth_probe_failed"
  | "policy_violation"
  | "model_mismatch"
  | "answer_too_large"
  | "output_overflow"
  | "incomplete"
  | "nonzero_exit"
  | "empty_answer";

const SYSTEM_PREAMBLE =
  "Answer the conversation below with text only. You have no tools in this session: do not run commands, read or write files, browse, or call other agents or services. Reply with only your final answer.";

const PREFLIGHT_TIMEOUT_MS = 10_000;
const PREFLIGHT_MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_LINE_BYTES = 512 * 1024;
const STDERR_SAMPLE_BYTES = 4096;
// The CLI has no output-token ceiling option, so the answer is bounded by
// bytes instead (generous for Thai/other multi-byte text). An answer over the
// bound fails the step; it is never silently truncated.
const ANSWER_BYTES_PER_TOKEN = 8;

function failure(
  code: NormalizedFailureCode,
  reason?: NativeFailureReason,
  externalWork?: "unknown",
): AdapterFailure {
  return new AdapterFailure(
    {
      code,
      message: reason ? `${CODEX_BACKEND_ID}: ${code} (${reason})` : `${CODEX_BACKEND_ID}: ${code}`,
    },
    externalWork,
  );
}

/**
 * Map vendor failure text to a fixed category. The text itself is used only
 * here and is never stored or returned.
 */
export function classifyNativeText(text: string): NormalizedFailureCode {
  if (/log(?:ged)?[ -]?in|sign[ -]?in|unauthori[sz]ed|authenticat|\b401\b|token.*(?:expired|invalid|revoked)/i.test(text)) {
    return "authentication";
  }
  if (/rate[ -]?limit|\b429\b|too many requests|usage limit|quota/i.test(text)) return "rate_limited";
  if (/model.*(?:not found|unavailable|not supported|does not exist|no access|unknown)/i.test(text)) {
    return "model_unavailable";
  }
  if (/context.*(?:length|window)|too (?:long|large)/i.test(text)) return "context_too_large";
  return "provider_unavailable";
}

/**
 * Allowlist interpreter for `codex exec --json` lines. It retains only the
 * final answer text, token counters and fixed flags; reasoning content, tool
 * payloads and every other field are dropped as soon as they are parsed.
 */
export class CodexTranscript {
  sawTurnCompleted = false;
  sawTurnFailed = false;
  sawErrorEvent = false;
  violation: "tool_event" | "unknown_event" | "malformed_line" | "oversize_answer" | "multiple_turns" | null = null;
  modelMismatch = false;
  /**
   * Set only when an event actually REPORTED the pinned model. The requested
   * model is never assumed to be the executed one.
   */
  modelConfirmed = false;
  answer: string | null = null;
  usage: { input_tokens: number | null; output_tokens: number | null } | null = null;
  /** Bounded, classification-only; never emitted. */
  failureText = "";
  private turnsStarted = 0;

  constructor(
    private readonly pinnedModel: string,
    private readonly maxAnswerBytes: number,
  ) {}

  accept(line: string): LineVerdict {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return this.violate("malformed_line");
    }
    if (!isRecord(event) || typeof event.type !== "string") return this.violate("malformed_line");

    if (typeof event.model === "string") {
      if (event.model !== this.pinnedModel) return this.mismatch();
      this.modelConfirmed = true;
    }

    switch (event.type) {
      case "thread.started":
        return "continue";
      case "turn.started":
        this.turnsStarted += 1;
        return this.turnsStarted > 1 ? this.violate("multiple_turns") : "continue";
      case "item.started":
      case "item.updated":
      case "item.completed":
        return this.item(event.type, event.item);
      case "turn.completed":
        if (this.sawTurnCompleted) return this.violate("multiple_turns");
        this.sawTurnCompleted = true;
        this.usage = readUsage(event.usage);
        return "continue";
      case "turn.failed":
        this.sawTurnFailed = true;
        this.failureText = errorText(event.error);
        return "kill";
      case "error":
        // Can be a retry notice; only fatal if the turn never completes.
        this.sawErrorEvent = true;
        this.failureText = typeof event.message === "string" ? event.message.slice(0, 512) : "";
        return "continue";
      default:
        return this.violate("unknown_event");
    }
  }

  private item(kind: string, item: unknown): LineVerdict {
    if (!isRecord(item) || typeof item.type !== "string") return this.violate("malformed_line");
    if (typeof item.model === "string") {
      if (item.model !== this.pinnedModel) return this.mismatch();
      this.modelConfirmed = true;
    }
    switch (item.type) {
      case "agent_message": {
        if (kind !== "item.completed") return "continue";
        if (typeof item.text !== "string") return this.violate("malformed_line");
        if (Buffer.byteLength(item.text, "utf8") > this.maxAnswerBytes) return this.violate("oversize_answer");
        this.answer = item.text;
        return "continue";
      }
      case "reasoning":
      case "todo_list":
      case "error":
        // Private/diagnostic items: discarded unread.
        return "continue";
      default:
        // command_execution, file_change, mcp_tool_call, web_search, collab
        // calls, and anything new: tools must be off, so this is a policy
        // breach and the answer cannot be trusted.
        return this.violate("tool_event");
    }
  }

  private violate(kind: NonNullable<CodexTranscript["violation"]>): LineVerdict {
    this.violation ??= kind;
    return "kill";
  }

  private mismatch(): LineVerdict {
    this.modelMismatch = true;
    return "kill";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readUsage(value: unknown): { input_tokens: number | null; output_tokens: number | null } {
  if (!isRecord(value)) return { input_tokens: null, output_tokens: null };
  return {
    input_tokens: safeUsageCount(value.input_tokens),
    output_tokens: safeUsageCount(value.output_tokens),
  };
}

function errorText(value: unknown): string {
  if (isRecord(value) && typeof value.message === "string") return value.message.slice(0, 512);
  return "";
}

/** Render a text-only prompt; native attachment parts are refused. */
export function renderCodexPrompt(request: AdapterRequest): string {
  const blocks: string[] = [SYSTEM_PREAMBLE];
  const system = request.system_instructions.trim();
  if (system) blocks.push(`Instructions:\n${system}`);
  if (request.reference_material?.trim()) {
    blocks.push(`Reference material for this stage:\n\n${request.reference_material}`);
  }
  for (const message of request.user_messages) {
    if (!message.parts || message.parts.length === 0) {
      blocks.push(`[${message.role}]\n${message.content}`);
      continue;
    }
    const rendered: string[] = [];
    for (const part of message.parts) {
      if (part.kind === "text") {
        if (part.text) rendered.push(part.text);
      } else if (part.kind === "attachment_extracted_text") {
        rendered.push(frameExtractedAttachment(part));
      } else if (part.kind === "attachment_only") {
        rendered.push(frameAttachmentOnlyNote(part));
      } else {
        throw failure("invalid_request", "attachment_not_supported");
      }
    }
    blocks.push(`[${message.role}]\n${rendered.length > 0 ? rendered.join("\n\n") : message.content}`);
  }
  return blocks.join("\n\n");
}

function policyMatches(policy: NativeBackendFreeze | undefined, profile: ModelProfile, cliVersion: string): boolean {
  return (
    policy !== undefined &&
    policy.backend_id === CODEX_BACKEND_ID &&
    policy.policy_id === CODEX_POLICY_ID &&
    policy.tool_surface === "proven_off" &&
    policy.model_id === profile.model_id &&
    policy.cli_version === cliVersion
  );
}

export interface CodexCliAdapterOptions {
  config: ProofestraConfig;
  /** Overrides for tests; default to the real home and temp directories. */
  home?: string | undefined;
  scratchRoot?: string | undefined;
}

export class CodexCliAdapter implements ProviderAdapter {
  readonly provider = "openai" as const;
  private readonly verified = new Set<string>();

  constructor(private readonly options: CodexCliAdapterOptions) {}

  supports(profile: ModelProfile): boolean {
    return profile.api_shape === "codex_exec_cli" && profile.execution_backend_id === CODEX_BACKEND_ID;
  }

  readiness(): "configured" | "disabled" | "unsupported" {
    const readiness = codexStatus(this.options.config).readiness;
    if (readiness === "configured") return "configured";
    return readiness === "disabled" ? "disabled" : "unsupported";
  }

  async generate(request: AdapterRequest): Promise<AdapterResult> {
    const config = this.options.config;
    const settings = codexSettings(config);
    const cliVersion = (settings.verification ?? CODEX_VERIFICATION).cli_version;
    const model = request.profile.model_id;

    if (!this.supports(request.profile) || !isSafeModelId(model)) throw failure("invalid_request", "not_admitted");
    if (!policyMatches(request.native_policy, request.profile, cliVersion)) {
      throw failure("invalid_request", "policy_mismatch");
    }
    // Re-check admission at launch time, not only at run creation.
    if (codexStatus(config).readiness !== "configured") throw failure("provider_unavailable", "not_admitted");
    const executable = resolveCodexExecutable(config);
    if (executable === null) throw failure("provider_unavailable", "executable_missing");
    // Render first so an unsupported part fails before anything is spawned.
    const prompt = renderCodexPrompt(request);
    if (request.signal.aborted) throw failure("canceled");

    const identity = executableIdentity(executable);
    if (identity === null) throw failure("provider_unavailable", "executable_missing");
    // ONE budget for preflight, login gate and the job itself: the coordinator's
    // per-call limit covers all of it, so the pre-launch probes are not extra time.
    const deadline = Date.now() + request.per_call_timeout_ms;

    const scratch = this.makeScratch();
    try {
      await this.preflight(executable, identity, cliVersion, request.signal, deadline);
      await this.requireChatGptLogin(executable, scratch, request.signal, deadline);
      // The binary must still be the one that passed preflight.
      if (executableIdentity(executable) !== identity) throw failure("provider_unavailable", "executable_changed");
      return await this.run(executable, model, scratch, prompt, request, deadline);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  private makeScratch(): string {
    const root = this.options.scratchRoot ?? os.tmpdir();
    try {
      return fs.mkdtempSync(path.join(root, "pf-codex-"));
    } catch {
      throw failure("provider_unavailable", "spawn_failed");
    }
  }

  private jobEnv(codexHome: string | null): Record<string, string> {
    // Credential-free by construction: only locale, a fixed PATH, and the
    // directories the CLI itself needs to find ITS OWN login.
    const env: Record<string, string> = {
      PATH: "/usr/bin:/bin",
      LC_ALL: "C",
      HOME: this.options.home ?? os.homedir(),
    };
    if (codexHome) env.CODEX_HOME = codexHome;
    return env;
  }

  private async capture(
    executable: string,
    argv: string[],
    env: Record<string, string>,
    cwd: string,
    signal: AbortSignal,
    deadline: number,
    stderrSampleBytes = 0,
  ): Promise<{ result: NativeJobResult; lines: string[] }> {
    const remaining = deadline - Date.now();
    // Out of budget before launching anything: nothing external has started.
    if (remaining <= 0) throw failure("timeout");
    const lines: string[] = [];
    const result = await runNativeJob(executable, {
      argv,
      env,
      cwd,
      stdin: "",
      timeoutMs: Math.min(PREFLIGHT_TIMEOUT_MS, remaining),
      maxStdoutBytes: PREFLIGHT_MAX_STDOUT_BYTES,
      maxLineBytes: 4096,
      stderrSampleBytes,
      signal,
      onLine: (line) => {
        lines.push(line);
        return "continue";
      },
    });
    return { result, lines };
  }

  /** Version pin + effective-feature check, using an EMPTY scratch Codex home (no login touched). */
  private async preflight(
    executable: string,
    identity: string,
    cliVersion: string,
    signal: AbortSignal,
    deadline: number,
  ): Promise<void> {
    // Keyed by the real file's identity as well as its path and the pinned
    // version: a replaced or updated binary is never covered by an old pass.
    const cacheKey = `${executable}\n${identity}\n${cliVersion}`;
    if (this.verified.has(cacheKey)) return;
    const probeHome = this.makeScratch();
    try {
      const env = this.jobEnv(probeHome);
      const version = await this.capture(executable, ["--version"], env, probeHome, signal, deadline);
      if (version.result.aborted) throw failure("canceled");
      if (version.result.timedOut) throw failure("timeout");
      const reported = /(\d+\.\d+\.\d+)/.exec(version.lines.join("\n"))?.[1];
      if (version.result.exitCode !== 0 || reported !== cliVersion) {
        throw failure("provider_unavailable", "version_unverified");
      }

      const features = await this.capture(executable, buildCodexFeaturesArgv(), env, probeHome, signal, deadline);
      if (features.result.aborted) throw failure("canceled");
      if (features.result.timedOut) throw failure("timeout");
      const rows = features.result.exitCode === 0 ? parseFeaturesList(features.lines.join("\n")) : null;
      if (rows === null || !evaluateFeatureRows(rows).ok) throw failure("provider_unavailable", "preflight_failed");
      this.verified.add(cacheKey);
    } finally {
      fs.rmSync(probeHome, { recursive: true, force: true });
    }
  }

  /**
   * Subscription-only gate, run for EVERY job (login state can change between
   * jobs, so it is never cached). It runs the vendor's `login status` against
   * the CLI's own login home and accepts only the exact ChatGPT message; an
   * API-key, token, cloud-credential, unknown or unreadable state is refused
   * before the job is launched. Nothing from the output is stored or returned.
   */
  private async requireChatGptLogin(
    executable: string,
    scratch: string,
    signal: AbortSignal,
    deadline: number,
  ): Promise<void> {
    const settings = codexSettings(this.options.config);
    const probe = await this.capture(
      executable,
      buildCodexLoginStatusArgv(),
      this.jobEnv(settings.codexHome),
      scratch,
      signal,
      deadline,
      256,
    );
    if (probe.result.aborted) throw failure("canceled");
    if (probe.result.timedOut) throw failure("timeout");
    const text = probe.lines.length > 0 ? probe.lines.join("\n") : probe.result.stderrSample;
    const kind = interpretCodexLoginStatus(text);
    if (kind === "not_logged_in") throw failure("authentication", "not_logged_in");
    if (kind === "chatgpt" && probe.result.exitCode === 0 && !probe.result.signaled) return;
    if (kind === "other" && probe.result.exitCode === 0 && !probe.result.signaled && !probe.result.timedOut) {
      throw failure("authentication", "auth_not_chatgpt");
    }
    throw failure("provider_unavailable", "auth_probe_failed");
  }

  private async run(
    executable: string,
    model: string,
    scratch: string,
    prompt: string,
    request: AdapterRequest,
    deadline: number,
  ): Promise<AdapterResult> {
    const settings = codexSettings(this.options.config);
    const transcript = new CodexTranscript(model, request.max_output_tokens * ANSWER_BYTES_PER_TOKEN);
    const budget = deadline - Date.now();
    // The shared budget ran out in the pre-launch checks: nothing was launched.
    if (budget <= 0) throw failure("timeout");
    let launched = false;
    const job = await runNativeJob(executable, {
      argv: buildCodexExecArgv({ model, scratchDir: scratch }),
      env: this.jobEnv(settings.codexHome),
      cwd: scratch,
      stdin: prompt,
      timeoutMs: budget,
      maxStdoutBytes: MAX_STDOUT_BYTES,
      maxLineBytes: MAX_LINE_BYTES,
      stderrSampleBytes: STDERR_SAMPLE_BYTES,
      signal: request.signal,
      onChild: () => {
        launched = true;
      },
      onLine: (line) => transcript.accept(line),
    });

    // Once a job process was started its remote effects are UNKNOWN unless it
    // finished cleanly; every failure after launch says so. This never claims
    // that anything was stopped or that nothing happened.
    const external: "unknown" | undefined = launched ? "unknown" : undefined;
    // The pipes outlived the job: a descendant may still be running.
    const uncontained = job.streamsForceClosed || job.unreaped;
    const containment: NativeFailureReason | undefined = uncontained ? "containment_unverified" : undefined;

    if (job.aborted) throw failure("canceled", containment, external);
    if (job.timedOut) throw failure("timeout", containment, external);
    if (job.spawnError) throw failure("provider_unavailable", "spawn_failed");
    if (transcript.violation === "oversize_answer") throw failure("invalid_request", "answer_too_large", external);
    if (transcript.violation !== null) throw failure("invalid_request", "policy_violation", external);
    if (transcript.modelMismatch) throw failure("model_unavailable", "model_mismatch", external);
    if (job.stdoutOverflow || job.lineOverflow) throw failure("provider_unavailable", "output_overflow", external);
    if (uncontained) throw failure("provider_unavailable", "containment_unverified", external);
    if (transcript.sawTurnFailed || !transcript.sawTurnCompleted) {
      throw failure(classifyNativeText(`${transcript.failureText}\n${job.stderrSample}`), "incomplete", external);
    }
    if (job.exitCode !== 0 || job.signaled) {
      throw failure(classifyNativeText(job.stderrSample), "nonzero_exit", external);
    }
    const answer = transcript.answer;
    if (answer === null || answer.trim().length === 0) throw failure("model_unavailable", "empty_answer", external);
    // Fail closed unless the CLI itself reported the pinned model: the requested
    // ID is never assumed to be the executed one.
    if (!transcript.modelConfirmed) throw failure("model_unavailable", "model_unconfirmed", external);

    const usage = transcript.usage ?? { input_tokens: null, output_tokens: null };
    const findings: string[] = [];
    if (usage.output_tokens !== null && usage.output_tokens > request.max_output_tokens) {
      findings.push(
        "The native Codex job reported more output tokens than the requested ceiling; the CLI cannot enforce an output-token limit.",
      );
    }
    return {
      text: answer,
      findings,
      usage,
      provider: this.provider,
      // Confirmed by an event (modelConfirmed implies it equals the pinned ID).
      model_id: model,
    };
  }
}

/** Always-refusing adapter for a native backend that must never run (e.g. Antigravity). */
export class UnavailableNativeAdapter implements ProviderAdapter {
  constructor(
    readonly provider: ProviderId,
    private readonly backendId: string,
  ) {}

  supports(): boolean {
    return false;
  }

  readiness(): "unsupported" {
    return "unsupported";
  }

  async generate(): Promise<AdapterResult> {
    throw new AdapterFailure({
      code: "provider_unavailable",
      message: `${this.backendId}: provider_unavailable (not_admitted)`,
    });
  }
}
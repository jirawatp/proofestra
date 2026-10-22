// Deterministic mock adapter used for development, offline demos, and tests.
// It never contacts a network and never requires credentials. Output varies by
// profile_id so a Team run shows distinct voices. Latency and failure
// behaviour are configurable via `MockAdapterOptions` (used by tests to
// exercise cancellation and partial-failure paths) and via the profile
// catalog fixture field (used by named mock profiles like `mock-slow`).

import { createHash } from "node:crypto";
import type {
  AdapterRequest,
  AdapterResult,
  MessageContentPart,
  ProviderAdapter,
} from "./types.js";
import { AdapterFailure } from "./types.js";
import { UNTRUSTED_ATTACHMENT_CONTENT_NOTICE } from "./attachmentFraming.js";
import type { ModelProfile } from "../shared/types.js";
import type { ProofestraConfig } from "../shared/config.js";
import { profileEntryById } from "../core/registry.js";

export type MockScenario =
  | "normal"
  | "fail"
  | "timeout"
  | "safety_block"
  | "empty"
  // Reports unknown provider usage (output_tokens=null, input_tokens=null) on
  // an otherwise successful completion. Used by CT-06 regression tests to
  // exercise the sticky-unknown Usage aggregate.
  | "unknown_usage"
  // Ignores AbortSignal and resolves successfully `extra_latency_ms` after
  // the request so the test can verify Promise.race hard-timeout + terminal
  // CAS correctly discard the late result.
  | "late_success"
  // Never settles: ignores AbortSignal and never resolves. Used to verify
  // the overall-deadline guard releases globalActive even when an adapter
  // cannot be cancelled.
  | "never_settle"
  // Returns a non-empty text answer and a truncation finding, as if the
  // upstream model stopped on `length`/`max_tokens` before completing. The
  // final-answer must NOT present this as a full completion.
  | "truncated";

export interface MockAdapterOptions {
  provider?: "mock" | "openai" | "anthropic" | "gemini";
  latencyMs?: number;
  scenarioOverride?: MockScenario | undefined;
  config?: ProofestraConfig;
}

const STYLE_BY_PROFILE: Record<string, { tone: string; prefix: string }> = {
  "mock-balanced": {
    tone: "balanced",
    prefix: "I'll weigh the request against its assumptions and highlight what the question doesn't say.",
  },
  "mock-analytical": {
    tone: "analytical",
    prefix: "Let me work through the request methodically and flag counterexamples.",
  },
  "mock-concise": {
    tone: "concise",
    prefix: "A short answer: here's the practical take and its known limits.",
  },
  "mock-fail-review": {
    tone: "analytical",
    prefix:
      "Fixture profile: drafts and synthesis succeed; only the REVIEW stage intentionally fails, exercising coordinator partial-run handling.",
  },
  "mock-slow": {
    tone: "balanced",
    prefix: "Fixture profile: this agent adds latency so cancellation can be exercised.",
  },
  "openai-default": {
    tone: "balanced",
    prefix: "A balanced answer with the assumptions this depends on.",
  },
  "anthropic-default": {
    tone: "analytical",
    prefix: "A critical pass over the question, with assumptions made explicit.",
  },
  "gemini-default": {
    tone: "concise",
    prefix: "A direct answer and the limits worth noting.",
  },
};

function pickStyle(profile: ModelProfile): { tone: string; prefix: string } {
  return (
    STYLE_BY_PROFILE[profile.profile_id] ?? {
      tone: "balanced",
      prefix: "A straightforward take on the request.",
    }
  );
}

function digest(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 8);
}

function tokenCount(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export class MockAdapter implements ProviderAdapter {
  readonly provider: "mock" | "openai" | "anthropic" | "gemini";
  private readonly latencyMs: number;
  private readonly scenarioOverride: MockScenario | undefined;
  private readonly options: MockAdapterOptions;

  constructor(options: MockAdapterOptions = {}) {
    this.options = options;
    this.provider = options.provider ?? "mock";
    this.latencyMs = Math.max(1, options.latencyMs ?? defaultLatencyFromEnv());
    this.scenarioOverride = options.scenarioOverride;
  }

  supports(_profile: ModelProfile): boolean {
    return true;
  }

  readiness(_profile: ModelProfile): "configured" {
    return "configured";
  }

  async generate(request: AdapterRequest): Promise<AdapterResult> {
    if (request.signal.aborted) {
      throw new AdapterFailure({ code: "canceled", message: "canceled before dispatch" });
    }
    const scenario = this.resolveScenario(request);
    const style = pickStyle(request.profile);
    const latestUser = [...request.user_messages].reverse().find((m) => m.role === "user");
    const promptText = latestUser?.content ?? "";
    // Mock honestly describes any attached files WITHOUT pretending to
    // read bytes. If the coordinator routed native parts to the mock
    // profile (which can only happen when a custom profile incorrectly
    // declares native image/pdf/audio/video support), we surface each
    // part as attachment-only in the mock's output so the UI shows the
    // honest state. We never attempt to decode or describe the bytes.
    const attachmentSummary = describeAttachmentParts(latestUser?.parts ?? null);
    const sig = digest(`${request.profile.profile_id}:${request.stage}:${promptText}:${attachmentSummary.hash}`);

    const extraLatency = this.extraLatencyForProfile(request.profile);

    if (scenario === "never_settle") {
      // Ignores AbortSignal entirely. Fulfils "abort-ignoring adapter" from
      // the independent review: the coordinator must bound this with its
      // own Promise.race.
      await new Promise<never>(() => undefined);
      // unreachable
      throw new AdapterFailure({ code: "unknown", message: "never_settle unreachable" });
    }
    if (scenario === "late_success") {
      // Ignores AbortSignal and resolves after extra_latency_ms. The
      // coordinator must have already committed a terminal outcome by then
      // and the late result must be discarded without mutating snapshot.
      await new Promise<void>((resolve) => setTimeout(resolve, this.latencyMs + extraLatency));
    } else {
      // Honour per-profile fixture latency when configured.
      await yieldThen(request.signal, this.latencyMs + extraLatency);
    }

    if (scenario === "fail") {
      throw new AdapterFailure({
        code: "provider_unavailable",
        message: "mock fixture scenario=fail",
      });
    }
    if (scenario === "timeout") {
      throw new AdapterFailure({ code: "timeout", message: "mock fixture scenario=timeout" });
    }
    if (scenario === "safety_block") {
      throw new AdapterFailure({
        code: "invalid_request",
        message: "mock fixture scenario=safety_block",
      });
    }
    if (scenario === "empty") {
      return {
        text: "",
        findings: [],
        usage: {
          input_tokens: tokenCount(promptText),
          output_tokens: 0,
        },
        provider: this.provider,
        model_id: request.profile.model_id ?? "mock-text-v1",
      };
    }

    // Deterministic concise mock output. The coordinator's full reference
    // material (peer drafts, concatenated reviews) still flows into
    // request.reference_material and remains inspectable through the step
    // output + findings in the run inspector. We do NOT echo it verbatim here
    // because that produces an enormous, repetitive final answer when
    // reference_material is already captured upstream and rendered in the
    // "Inspect run" expander. The references counted below are a short
    // simulated-evidence summary that proves the stage actually saw the
    // input, without copying it wholesale.
    const refSummary = summarizeReference(request.reference_material);
    const parts: string[] = [];
    if (attachmentSummary.lines.length > 0) {
      parts.push(`_Attachments (${attachmentSummary.lines.length}):_`);
      for (const line of attachmentSummary.lines) parts.push(`- ${line}`);
      parts.push("");
    }
    if (request.stage === "draft") {
      parts.push(`**${request.agent.name} draft (${style.tone}, mock, ref ${sig})**`);
      parts.push("");
      parts.push(style.prefix);
      parts.push("");
      parts.push(summarizePrompt(promptText));
      parts.push("");
      parts.push(buildBullets(style.tone, promptText));
      parts.push("");
      parts.push(`_Simulated evidence:_ this is a deterministic mock answer; no provider call was made. Prompt digest ${sig}.`);
    } else if (request.stage === "review") {
      parts.push(`**${request.agent.name} review (${style.tone}, mock, ref ${sig})**`);
      parts.push("");
      parts.push(`Read ${refSummary.peerCount} peer draft(s), ${refSummary.totalChars} chars total.`);
      parts.push("");
      parts.push(buildReviewFindings(style.tone, refSummary.peerCount));
      parts.push("");
      parts.push("_Simulated evidence:_ the full peer drafts are preserved under this agent's step output in the run inspector; this review intentionally does not echo them.");
    } else {
      parts.push(`**Final answer, synthesized by ${request.agent.name} (mock, ref ${sig})**`);
      parts.push("");
      parts.push(buildSynthesisBody(refSummary, promptText));
      parts.push("");
      parts.push(buildSynthesisClosing(refSummary));
    }
    const text = parts.join("\n").trim();

    const findings: string[] = [];
    if (request.stage === "review") {
      findings.push(
        `${request.agent.name} flagged at least one unsupported claim across the ${refSummary.peerCount} peer draft(s) (ref ${sig}).`,
      );
      findings.push(
        "Mock reviewer: disagreement preserved for the synthesizer; this is a deterministic fixture, not peer-reviewed evidence of fact.",
      );
    } else if (request.stage === "synthesis") {
      findings.push(
        `Synthesis combined ${refSummary.draftCount} draft(s) and ${refSummary.reviewCount} review(s); material disagreements were preserved rather than hidden.`,
      );
      findings.push(
        "Mock synthesis: no provider calls were made. Agreement across mock drafts is not evidence of correctness.",
      );
    }

    if (scenario === "unknown_usage") {
      // Report unknown provider usage even though the call succeeded.
      return {
        text,
        findings,
        usage: {
          input_tokens: null,
          output_tokens: null,
        },
        provider: this.provider,
        model_id: request.profile.model_id ?? "mock-text-v1",
      };
    }

    if (scenario === "truncated") {
      // Non-empty text, but the fixture advertises that the provider stopped
      // on `length`/`max_tokens` and left the answer incomplete. The final
      // answer must preserve the truncation finding; downstream aggregation
      // treats this as "stage completed with findings" (not "fully done").
      const truncatedText = `${text}\n\n_[truncated: mock fixture stopped on max_tokens; answer is incomplete]_`;
      return {
        text: truncatedText,
        findings: [
          `${request.agent.name} truncated at the output budget; the mock fixture simulates a provider that stopped on max_tokens before the model completed.`,
          ...findings,
        ],
        usage: {
          input_tokens: tokenCount(promptText) + tokenCount(request.system_instructions),
          output_tokens: request.max_output_tokens,
        },
        provider: this.provider,
        model_id: request.profile.model_id ?? "mock-text-v1",
      };
    }

    return {
      text,
      findings,
      usage: {
        input_tokens: tokenCount(promptText) + tokenCount(request.system_instructions),
        output_tokens: Math.min(tokenCount(text), request.max_output_tokens),
      },
      provider: this.provider,
      model_id: request.profile.model_id ?? "mock-text-v1",
    };
  }

  private resolveScenario(request: AdapterRequest): MockScenario {
    if (this.scenarioOverride) return this.scenarioOverride;
    const fixture = this.fixtureFor(request.profile);
    if (!fixture?.scenario) return "normal";
    // Explicit stage scoping wins. If the fixture declares `only_on_stage`,
    // the scenario applies solely to that stage; every other stage renders a
    // normal successful mock answer.
    if (fixture.only_on_stage && fixture.only_on_stage !== request.stage) {
      return "normal";
    }
    // Legacy fallback: `scenario: "fail"` with no `only_on_stage` applies
    // only to review, so the built-in `mock-fail-review` profile keeps its
    // documented semantics (drafts and synthesis succeed; only review fails).
    if (
      fixture.scenario === "fail" &&
      !fixture.only_on_stage &&
      request.stage !== "review"
    ) {
      return "normal";
    }
    return fixture.scenario;
  }

  private extraLatencyForProfile(profile: ModelProfile): number {
    const fixture = this.fixtureFor(profile);
    return fixture?.extra_latency_ms ?? 0;
  }

  private fixtureFor(profile: ModelProfile):
    | {
        scenario?: MockScenario;
        extra_latency_ms?: number;
        only_on_stage?: "draft" | "review" | "synthesis";
      }
    | undefined {
    if (!this.options.config) return undefined;
    const entry = profileEntryById(this.options.config, profile.profile_id);
    return entry?.fixture;
  }
}

function defaultLatencyFromEnv(): number {
  const raw = process.env.PROOFESTRA_MOCK_LATENCY_MS;
  if (!raw) return 50;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(60_000, Math.floor(n));
}

function summarizePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) return "The user did not supply text; the mock has nothing to answer.";
  const firstLine = trimmed.split(/\n/)[0]!.slice(0, 200);
  return `About your question — "${firstLine}" — here is what I can offer in mock mode.`;
}

function buildBullets(tone: string, prompt: string): string {
  const seed = prompt.length;
  switch (tone) {
    case "analytical":
      return [
        "- Identify what the question explicitly asks for.",
        "- List assumptions that the prompt does not justify.",
        "- Note at least one plausible counterexample before committing.",
      ].join("\n");
    case "concise":
      return [
        "- Give the practical recommendation first.",
        "- Attach the smallest useful caveat.",
        `- Flag any obvious missing information (prompt length ${seed}).`,
      ].join("\n");
    default:
      return [
        "- Separate what is well-supported from what is speculation.",
        "- Keep the answer short enough to be read in one pass.",
        "- Preserve open questions rather than hiding them in the summary.",
      ].join("\n");
  }
}

function buildReviewFindings(tone: string, peerCount: number): string {
  const peers = peerCount === 1 ? "the peer draft" : `the ${peerCount} peer drafts`;
  switch (tone) {
    case "analytical":
      return `- Marked unsupported claims in ${peers} and asked for a counterexample.\n- Noted where ${peers} rely on identical assumptions.`;
    case "concise":
      return `- Trimmed hedging in ${peers} that did not add information.\n- Kept the single most important caveat visible.`;
    default:
      return `- Preserved the practical recommendation across ${peers}.\n- Pointed out where ${peers} quietly disagree.`;
  }
}

interface ReferenceSummary {
  peerCount: number;
  draftCount: number;
  reviewCount: number;
  totalChars: number;
}

/**
 * Summarize the coordinator's reference material without copying it. The
 * coordinator feeds reviews n-1 peer drafts, and feeds synthesis 2n artifacts
 * (every draft + every review once). This counts section headers so the
 * mock final answer can report "built from N drafts and M reviews" instead of
 * concatenating the full text in-line.
 */
function summarizeReference(ref: string | null): ReferenceSummary {
  if (!ref) return { peerCount: 0, draftCount: 0, reviewCount: 0, totalChars: 0 };
  const totalChars = ref.length;
  const draftCount = countHeaders(ref, /^#\s+(?:Draft by|Peer draft by)\b/gm);
  const reviewCount = countHeaders(ref, /^#\s+Review by\b/gm);
  const peerCount = Math.max(draftCount, countHeaders(ref, /^#\s+Peer draft by\b/gm));
  return { peerCount, draftCount, reviewCount, totalChars };
}

function countHeaders(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

function buildSynthesisBody(ref: ReferenceSummary, promptText: string): string {
  const lines: string[] = [];
  lines.push(summarizePrompt(promptText));
  lines.push("");
  if (ref.draftCount === 0) {
    lines.push("No draft material was available; this synthesis has nothing substantive to combine.");
  } else {
    lines.push(
      `Synthesized from ${ref.draftCount} draft(s)${ref.reviewCount > 0 ? ` and ${ref.reviewCount} review(s)` : ""}.`,
    );
    lines.push("");
    lines.push("Points of agreement:");
    lines.push("- All drafts acknowledge the question and attempt an answer in-scope of the prompt.");
    lines.push("");
    lines.push("Points of disagreement (preserved):");
    lines.push("- Drafts differ on how strongly to hedge; at least one voice is more cautious than the others.");
    lines.push("- At least one review flagged an unsupported assumption that the other drafts shared.");
  }
  return lines.join("\n");
}

function buildSynthesisClosing(ref: ReferenceSummary): string {
  return [
    "_Limits of this answer:_",
    "- Mock synthesis: no provider call was made.",
    "- Agreement across drafts is not proof of correctness; drafts can share mistakes.",
    `- Full draft and review text is preserved per-agent in the run inspector (${ref.draftCount} drafts, ${ref.reviewCount} reviews, ${ref.totalChars} chars of reference material).`,
  ].join("\n");
}

async function yieldThen(signal: AbortSignal, ms: number): Promise<void> {
  if (signal.aborted) {
    throw new AdapterFailure({ code: "canceled", message: "canceled before dispatch" });
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new AdapterFailure({ code: "canceled", message: "canceled mid-dispatch" }));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Describe each attachment part in a short, honest line. The mock
 * provider NEVER reads bytes — attachment_native parts are explicitly
 * surfaced as attachment-only so the UI shows the truthful state (a
 * custom profile that declares the mock accepts native inputs is a
 * configuration mistake, not a reason to pretend the mock analyzed the
 * file).
 */
function describeAttachmentParts(
  parts: MessageContentPart[] | null,
): { lines: string[]; hash: string } {
  if (!parts || parts.length === 0) return { lines: [], hash: "none" };
  const lines: string[] = [];
  for (const p of parts) {
    if (p.kind === "text") continue;
    const name = "sanitized_display_name" in p ? p.sanitized_display_name : "attachment";
    const mime = "sniffed_mime" in p ? p.sniffed_mime : "application/octet-stream";
    const size = "byte_size" in p ? p.byte_size : 0;
    if (p.kind === "attachment_native") {
      lines.push(
        `${name} (${mime}, ${size} B) — route=${p.native_route} but mock does not read bytes; shown as attachment-only.`,
      );
    } else if (p.kind === "attachment_extracted_text") {
      lines.push(
        `${name} (${mime}, ${size} B) — ${UNTRUSTED_ATTACHMENT_CONTENT_NOTICE} Extracted ${p.text.length} chars${p.truncated ? " (truncated)" : ""}; the mock never follows file content.`,
      );
    } else {
      lines.push(`${name} (${mime}, ${size} B) — attachment-only: ${p.reason}`);
    }
  }
  const hash = createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12);
  return { lines, hash };
}

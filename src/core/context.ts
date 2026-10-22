// Freezes `all_history_v1` context: every visible user turn plus every
// final-assistant turn, in order, together with the new user prompt. This
// file does not call providers; it only prepares the deterministic view that
// each agent will see at drafting and later stages. It also exposes helpers
// for enforcing per-profile capacity bounds against the actual inputs that
// each stage will dispatch.
//
// Admission-time token estimation is a conservative heuristic, NOT a
// mathematical guarantee. The three supported provider families each ship
// their own tokenizer:
//   - OpenAI: o200k_base / cl100k_base BPE
//     (https://platform.openai.com/tokenizer)
//   - Anthropic: proprietary; the API exposes a count endpoint
//     (https://platform.claude.com/docs/en/counting-tokens)
//   - Google Gemini: SentencePiece
//     (https://ai.google.dev/gemini-api/docs/tokens)
// None of these publishes a stable minimum bytes-per-token ratio across
// arbitrary inputs. Long punctuation runs, control sequences, non-text
// payloads, and vendor-side chat framing (role headers, start/stop tokens,
// trailing primer) can all tokenize to more than one byte per token.
//
// To stay honest, this estimator uses the stricter worst case
// "1 token per UTF-8 byte AND 1 token per character" and then adds an
// explicit per-message / per-reply framing allowance. The result is an
// upper-bound ADMISSION estimate — it rejects a prompt that any mainstream
// tokenizer would also fail. It is NOT a replacement for calling the
// provider's own tokenizer or count endpoint when exact accounting matters,
// and provider-side `context_too_large` errors remain the authoritative
// final check at dispatch.

import type { ContextSnapshot, Message, ModelProfile } from "../shared/types.js";

export interface FreezeInput {
  history: Message[];
  newUserMessageId: string;
  // Optional immutable attachment refs and per-agent coverage projection.
  // Both are stored on the context snapshot so every stage (draft, review,
  // synthesis) sees the exact same set of files and the exact same honest
  // routing decision the user saw at send time.
  attachments?: NonNullable<ContextSnapshot["attachments"]>;
  attachment_coverage?: NonNullable<ContextSnapshot["attachment_coverage"]>;
}

const MAX_PROMPT_CHARACTERS = 16_000;
const MAX_TOTAL_HISTORY_CHARACTERS = 180_000;

// Honest worst case: 1 token per UTF-8 byte and 1 token per character. See
// the file header for why this is the only cross-vendor bound we are willing
// to assert without reaching for each vendor's own tokenizer. Taking the
// maximum of the two preserves safety for both wide-encoded input (Thai /
// CJK / emoji) and single-byte ASCII with high token density (symbols,
// digits).
const BYTES_PER_TOKEN_WORST_CASE = 1;
const CHARS_PER_TOKEN_WORST_CASE = 1;
const UTF8_ENCODER = new TextEncoder();

// Flat per-message framing allowance. Provider chat framing (role tokens,
// turn delimiters, system-prompt wrappers, JSON object keys, trailing
// primer) is not documented in a stable, cross-vendor way, and is NOT
// included in the per-text estimator above. OpenAI's cookbook documents
// `tokens_per_message = 3` plus `+3` for the reply; Anthropic adds similar
// `Human:` / `Assistant:` turn framing; Gemini wraps `contents[]` with role
// metadata. We pick a value strictly larger than any of these so admission
// does not under-count prompts with many short messages.
const TOKENS_PER_MESSAGE_FRAMING = 8;

// Trailing framing added by the provider to begin the assistant's reply.
// OpenAI documents `+3`; others are comparable. Deliberately larger for
// safety; cheap to overestimate at admission.
const TOKENS_FOR_REPLY_FRAMING = 8;

/**
 * Admission-time token estimate. Returns a conservative upper-bound heuristic
 * on how many tokens a given text would cost at a provider, taken as the
 * stricter of `ceil(utf8_bytes / 1)` and `ceil(chars / 1)` so neither
 * byte-dense nor character-dense input can slip past admission.
 *
 * This is NOT an exact tokenizer and NOT a bound that provably holds for
 * every provider's internal chat framing. Because it is a conservative
 * overestimate, admission can REJECT valid inputs that the real tokenizer
 * would have accepted — the cost of that false rejection is a message to
 * the user, which is strictly safer than silently truncating a billed
 * provider call. Conversely, we cannot guarantee that vendor-side framing
 * (role headers, tool-call wrappers, trailing primer) stays within budget
 * at the exact byte level; that is why the per-stage dispatch check and
 * the provider's own `context_too_large` error are the authoritative final
 * bounds.
 *
 * Use each vendor's own tokenizer / count endpoint when exact accounting is
 * required (OpenAI tokenizer, Anthropic `count_tokens`, Gemini
 * `countTokens`). Those endpoints are out of scope for this admission
 * heuristic.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chars = text.length;
  const bytes = UTF8_ENCODER.encode(text).length;
  const byByte = Math.ceil(bytes / BYTES_PER_TOKEN_WORST_CASE);
  const byChar = Math.ceil(chars / CHARS_PER_TOKEN_WORST_CASE);
  return Math.max(1, byByte, byChar);
}

export function freezeContext(input: FreezeInput): ContextSnapshot {
  const totalCharacters = input.history.reduce((acc, m) => acc + m.text.length, 0);
  if (totalCharacters > MAX_TOTAL_HISTORY_CHARACTERS) {
    const err = new Error(
      `history too large (${totalCharacters} characters > ${MAX_TOTAL_HISTORY_CHARACTERS}); start a new conversation`,
    );
    (err as { code?: string }).code = "context_too_large";
    throw err;
  }
  const messageIds = input.history.map((m) => m.id).concat(input.newUserMessageId);
  const snapshot: ContextSnapshot = {
    policy: "all_history_v1",
    message_ids: messageIds,
    input_fit_status: "accepted",
    notice:
      input.history.length === 0
        ? "No prior history; this is the first turn in the conversation."
        : undefined,
  };
  if (input.attachments && input.attachments.length > 0) {
    snapshot.attachments = input.attachments.map((a) => ({ ...a }));
  }
  if (input.attachment_coverage && input.attachment_coverage.length > 0) {
    snapshot.attachment_coverage = input.attachment_coverage.map((c) => ({ ...c }));
  }
  return snapshot;
}

export function assertPromptWithinLimit(prompt: string): void {
  if (prompt.length > MAX_PROMPT_CHARACTERS) {
    const err = new Error(
      `prompt is ${prompt.length} characters; limit ${MAX_PROMPT_CHARACTERS}`,
    );
    (err as { code?: string }).code = "context_too_large";
    throw err;
  }
}

export interface CapacityInputs {
  // Full conversation seen by the stage. The user prompt for this turn is
  // included in this history exactly once (as the last user message); do not
  // pass it as `prompt` as well.
  history: Message[];
  systemInstructions: string;
  referenceMaterial: string | null;
  // Optional override for the reference-material contribution. When provided
  // we skip estimating the string and use this token count instead. This lets
  // the admission check inject the planner's worst-case reference size
  // directly (`worstCaseReferenceTokens`) without reifying it as a synthetic
  // string and then round-tripping it through the per-byte estimator, which
  // double-charges byte/char overhead and makes normal Team-3 admission fail.
  referenceMaterialTokens?: number;
  outputReserveTokens: number;
  // Pre-computed token reserve for the frozen attachment projection this
  // agent will see. Includes extracted-text byte count AND the
  // conservative native-byte/image reserve. Zero when the agent has no
  // attachments. The admission block in the coordinator builds this via
  // `nativeImageTokenReserve` / `extractedTextTokenReserve` so the
  // capacity check charges the EXACT normalized projection (not the raw
  // `m.text` only, which would under-count every extracted-text wrapper
  // and every native payload).
  attachmentTokens?: number;
}

export interface CapacityResult {
  fits: boolean;
  estimatedInputTokens: number;
  worstCaseTokens: number;
  safeInputTokens: number;
  reason?: string;
}

export function evaluateCapacity(
  profile: ModelProfile,
  inputs: CapacityInputs,
): CapacityResult {
  const historyTokens = inputs.history.reduce((acc, m) => acc + estimateTokens(m.text), 0);
  const systemTokens = estimateTokens(inputs.systemInstructions);
  const referenceTokens =
    typeof inputs.referenceMaterialTokens === "number"
      ? Math.max(0, inputs.referenceMaterialTokens)
      : estimateTokens(inputs.referenceMaterial ?? "");

  // Message framing: history + system (1 message) + reference material (1
  // user message when present) + the pending assistant reply.
  const historyMessageCount = inputs.history.length;
  const systemMessageCount = inputs.systemInstructions ? 1 : 0;
  const hasReference =
    (inputs.referenceMaterial !== null && inputs.referenceMaterial !== "") ||
    (typeof inputs.referenceMaterialTokens === "number" && inputs.referenceMaterialTokens > 0);
  const referenceMessageCount = hasReference ? 1 : 0;
  const framingTokens =
    (historyMessageCount + systemMessageCount + referenceMessageCount) *
      TOKENS_PER_MESSAGE_FRAMING +
    TOKENS_FOR_REPLY_FRAMING;

  const attachmentTokens = Math.max(0, Math.floor(inputs.attachmentTokens ?? 0));
  const estimatedInputTokens =
    historyTokens + systemTokens + referenceTokens + framingTokens + attachmentTokens;
  const worstCaseTokens = estimatedInputTokens + Math.max(0, inputs.outputReserveTokens);
  if (worstCaseTokens > profile.safe_input_tokens) {
    return {
      fits: false,
      estimatedInputTokens,
      worstCaseTokens,
      safeInputTokens: profile.safe_input_tokens,
      reason:
        `estimated ${worstCaseTokens} tokens ` +
        `(history ${historyTokens} + system ${systemTokens} + reference ${referenceTokens} ` +
        `+ framing ${framingTokens} + attachments ${attachmentTokens} + reserve ${inputs.outputReserveTokens}) ` +
        `exceeds profile ${profile.profile_id} capacity ${profile.safe_input_tokens}`,
    };
  }
  return {
    fits: true,
    estimatedInputTokens,
    worstCaseTokens,
    safeInputTokens: profile.safe_input_tokens,
  };
}

/**
 * Worst-case reference-material size in TOKENS for a given stage and base
 * plan. Reviews see every peer draft once (n-1 artifacts). Synthesis sees
 * every draft once and every review once (2n artifacts) — reviews are NOT
 * repeated per draft, which would be n^2.
 *
 * This is a token count, not a character count. Pass the returned number to
 * `evaluateCapacity` via `referenceMaterialTokens`; do not inflate it into a
 * synthetic string and feed that back through `estimateTokens`, which would
 * double-charge byte/char overhead and reject normal plans.
 */
export function worstCaseReferenceTokens(
  stage: "draft" | "review" | "synthesis",
  agentCount: number,
  maxOutputTokensPerCall: number,
): number {
  if (stage === "draft") return 0;
  if (stage === "review") return Math.max(0, agentCount - 1) * maxOutputTokensPerCall;
  // Synthesis: one draft per agent + one review per agent (reviews are
  // concatenated once each, not duplicated per draft).
  return 2 * agentCount * maxOutputTokensPerCall;
}

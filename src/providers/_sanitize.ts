// Shared adapter sanitization helpers. Every adapter error message is a fixed
// string composed from provider name, HTTP status, and the normalized failure
// code. Upstream bodies and thrown Error.message strings are discarded.
// Stop/finish/block reasons are included only if they are present in a
// hard-coded allowlist of documented enum values.

import type { NormalizedFailureCode, ProviderId } from "../shared/types.js";

const ALLOWED_OPENAI_FINISH = new Set([
  "stop",
  "length",
  "content_filter",
  "tool_calls",
  "function_call",
]);

const ALLOWED_ANTHROPIC_STOP = new Set([
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use",
  "pause_turn",
  "refusal",
  "model_context_window_exceeded",
]);

const ALLOWED_GEMINI_FINISH = new Set([
  "STOP",
  "MAX_TOKENS",
  "SAFETY",
  "RECITATION",
  "LANGUAGE",
  "OTHER",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "MALFORMED_FUNCTION_CALL",
  "IMAGE_SAFETY",
  "UNEXPECTED_TOOL_CALL",
]);

const ALLOWED_GEMINI_BLOCK = new Set([
  "SAFETY",
  "OTHER",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
]);

export function safeFinish(provider: ProviderId, raw: string | null | undefined): string | null {
  if (!raw) return null;
  const allow =
    provider === "openai"
      ? ALLOWED_OPENAI_FINISH
      : provider === "anthropic"
      ? ALLOWED_ANTHROPIC_STOP
      : provider === "gemini"
      ? ALLOWED_GEMINI_FINISH
      : null;
  if (!allow) return null;
  return allow.has(raw) ? raw : "other";
}

export function safeGeminiBlock(raw: string | null | undefined): string {
  if (!raw) return "other";
  return ALLOWED_GEMINI_BLOCK.has(raw) ? raw : "other";
}

/**
 * Build a safe adapter message. Only the arguments listed are used; the
 * message never contains upstream text, caught Error.message, API keys, or
 * free-form server responses. Callers that want to surface truncation or
 * stop-reason detail must pass `safeFinish()`-filtered values.
 */
export function safeMessage(
  provider: ProviderId,
  code: NormalizedFailureCode,
  details?: { status?: number; stopReason?: string | null },
): string {
  const parts: string[] = [`${providerLabel(provider)}: ${code}`];
  if (typeof details?.status === "number") {
    parts.push(`http=${details.status}`);
  }
  if (details?.stopReason) {
    parts.push(`stop=${details.stopReason}`);
  }
  return parts.join(" ");
}

function providerLabel(provider: ProviderId): string {
  switch (provider) {
    case "openai":
      return "openai";
    case "anthropic":
      return "anthropic";
    case "gemini":
      return "gemini";
    case "mock":
      return "mock";
  }
}

/**
 * Normalize an exception into a NormalizedFailureCode without inspecting
 * .message or .stack. Only runtime type (AbortError, timing out, signal) is
 * considered; otherwise we classify as unknown.
 */
export function classifyUnknownError(err: unknown, signal: AbortSignal): NormalizedFailureCode {
  const name = (err as { name?: string } | null)?.name;
  if (name === "AbortError") {
    return signal.aborted ? "canceled" : "timeout";
  }
  return "provider_unavailable";
}

/**
 * Honest provider-usage counter validation. A token count is only accepted
 * when it is a finite, non-negative, safe integer. Any missing / NaN /
 * negative / fractional / unsafe-integer value becomes `null` so the
 * coordinator's sticky-unknown aggregation stays truthful and the
 * conservative output-token ledger falls back to charging the full
 * reservation. Floating-point tokens, "0.5", "-1", `NaN`, strings, and
 * values beyond `Number.MAX_SAFE_INTEGER` are all rejected.
 */
export function safeUsageCount(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  if (!Number.isSafeInteger(value)) return null;
  if (value < 0) return null;
  return value;
}

/**
 * Safe non-negative integer addition. Returns `null` whenever any operand is
 * missing or the arithmetic sum would exceed `Number.MAX_SAFE_INTEGER`. This
 * prevents vendor-reported usage counters from silently inflating past the
 * JS safe-integer range.
 */
export function safeUsageSum(...operands: Array<number | null>): number | null {
  let acc = 0;
  for (const op of operands) {
    if (op === null) return null;
    const next = acc + op;
    if (!Number.isSafeInteger(next)) return null;
    acc = next;
  }
  return acc;
}

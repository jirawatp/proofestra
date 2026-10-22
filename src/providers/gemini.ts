// Gemini generateContent adapter. Live calls require a configured
// GOOGLE_API_KEY and an explicit `execution_mode: "live"` per run. Vendor
// payload shapes come from https://ai.google.dev/api/generate-content checked
// 2026-10-21.
//
// Thought parts (`thought: true`) and thought signatures are internal
// reasoning; this adapter discards them and never renders, persists, or
// exports them. All failures carry a fixed, upstream-text-free message:
// response bodies, error messages, and finishReason strings are only emitted
// through the allowlisted-enum sanitizer.

import fs from "node:fs";
import {
  frameAttachmentOnlyNote,
  frameExtractedAttachment,
  frameNativeAttachmentNotice,
} from "./attachmentFraming.js";
import type { AdapterRequest, AdapterResult, ProviderAdapter } from "./types.js";
import { AdapterFailure } from "./types.js";
import type { ModelProfile } from "../shared/types.js";
import {
  classifyUnknownError,
  safeFinish,
  safeGeminiBlock,
  safeMessage,
  safeUsageCount,
  safeUsageSum,
} from "./_sanitize.js";

export interface GeminiAdapterOptions {
  apiKey: string | null;
  endpointBase?: string | undefined;
  apiVersion?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export class GeminiAdapter implements ProviderAdapter {
  readonly provider = "gemini" as const;
  private readonly endpointBase: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GeminiAdapterOptions) {
    this.endpointBase = options.endpointBase ?? "https://generativelanguage.googleapis.com";
    this.apiVersion = options.apiVersion ?? "v1beta";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  supports(profile: ModelProfile): boolean {
    return profile.provider === "gemini";
  }

  readiness(profile: ModelProfile): "configured" | "missing_auth" | "disabled" {
    if (!this.options.apiKey) return "missing_auth";
    if (profile.readiness === "disabled") return "disabled";
    return "configured";
  }

  async generate(request: AdapterRequest): Promise<AdapterResult> {
    const key = this.options.apiKey;
    if (!key) {
      throw new AdapterFailure({
        code: "authentication",
        message: safeMessage("gemini", "authentication"),
      });
    }
    const model = request.profile.model_id;
    if (!model) {
      throw new AdapterFailure({
        code: "model_unavailable",
        message: safeMessage("gemini", "model_unavailable"),
      });
    }
    const url = `${this.endpointBase}/${this.apiVersion}/models/${encodeURIComponent(model)}:generateContent`;
    // Gemini v1beta generateContent: each content turn is `{ role, parts }`
    // where a part can be `{ text }` or `{ inlineData: { mimeType, data }}`.
    // Verified against https://ai.google.dev/gemini-api/docs/generate-content/audio
    // and video-understanding. Only inline recognized image/PDF/audio/
    // video are passed; no Files API uploads from this scope.
    type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };
    const parts: { role: "user" | "model"; parts: GeminiPart[] }[] = [];
    if (request.reference_material?.trim()) {
      parts.push({
        role: "user",
        parts: [{ text: `Reference material for this stage:\n\n${request.reference_material}` }],
      });
    }
    for (const message of request.user_messages) {
      if (!message.parts || message.parts.length === 0) {
        parts.push({
          role: message.role === "assistant" ? "model" : "user",
          parts: [{ text: message.content }],
        });
        continue;
      }
      const turn: GeminiPart[] = [];
      for (const p of message.parts) {
        if (p.kind === "text") {
          if (p.text) turn.push({ text: p.text });
        } else if (
          p.kind === "attachment_native" &&
          (p.native_route === "native_image" ||
            p.native_route === "native_pdf" ||
            p.native_route === "native_audio" ||
            p.native_route === "native_video")
        ) {
          const data = readAttachmentBase64(p.blob_path);
          turn.push({ text: frameNativeAttachmentNotice(p) });
          turn.push({ inlineData: { mimeType: p.wire_mime, data } });
        } else if (p.kind === "attachment_extracted_text") {
          turn.push({ text: frameExtractedAttachment(p) });
        } else {
          const name = "sanitized_display_name" in p ? p.sanitized_display_name : "attachment";
          const mime = "sniffed_mime" in p ? p.sniffed_mime : "application/octet-stream";
          const size = "byte_size" in p ? p.byte_size : 0;
          const reason =
            p.kind === "attachment_only"
              ? p.reason
              : "not natively supported by this profile";
          turn.push({
            text: frameAttachmentOnlyNote({
              sanitized_display_name: name,
              sniffed_mime: mime,
              byte_size: size,
              reason,
            }),
          });
        }
      }
      parts.push({
        role: message.role === "assistant" ? "model" : "user",
        parts: turn.length > 0 ? turn : [{ text: message.content }],
      });
    }
    const body = {
      systemInstruction: request.system_instructions
        ? { parts: [{ text: request.system_instructions }] }
        : undefined,
      contents: parts,
      generationConfig: {
        maxOutputTokens: request.max_output_tokens,
        temperature: 0.2,
      },
    };
    const controller = new AbortController();
    const linked = linkSignals(request.signal, controller.signal);
    const timeout = setTimeout(() => controller.abort(), request.per_call_timeout_ms);
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": key,
          "x-proofestra-client": "proofestra-local/0.1.0",
        },
        body: JSON.stringify(body),
        signal: linked,
      });
      if (response.status === 401 || response.status === 403) {
        throw new AdapterFailure({
          code: "authentication",
          message: safeMessage("gemini", "authentication", { status: response.status }),
        });
      }
      if (response.status === 429) {
        throw new AdapterFailure({
          code: "rate_limited",
          message: safeMessage("gemini", "rate_limited", { status: response.status }),
        });
      }
      if (response.status >= 500) {
        throw new AdapterFailure({
          code: "provider_unavailable",
          message: safeMessage("gemini", "provider_unavailable", { status: response.status }),
        });
      }
      if (!response.ok) {
        throw new AdapterFailure({
          code: "invalid_request",
          message: safeMessage("gemini", "invalid_request", { status: response.status }),
        });
      }
      let data: GeminiResponse;
      try {
        data = (await response.json()) as GeminiResponse;
      } catch {
        throw new AdapterFailure({
          code: "provider_unavailable",
          message: safeMessage("gemini", "provider_unavailable", { status: response.status }),
        });
      }
      // Prompt-level block from safety filters comes with no candidates. Only
      // allowlisted block-reason enums reach the message.
      if (data.promptFeedback?.blockReason) {
        throw new AdapterFailure({
          code: "model_unavailable",
          message: safeMessage("gemini", "model_unavailable", {
            status: response.status,
            stopReason: safeGeminiBlock(data.promptFeedback.blockReason),
          }),
        });
      }
      const candidate = data.candidates?.[0];
      if (!candidate) {
        throw new AdapterFailure({
          code: "model_unavailable",
          message: safeMessage("gemini", "model_unavailable", { status: response.status }),
        });
      }
      // thought:true parts are internal reasoning; never render or persist
      // them. Thought signatures are internal continuation state and are
      // discarded here. Only text parts without thought flag are presentable.
      const contentParts = candidate.content?.parts ?? [];
      const text = contentParts
        .filter((p) => typeof p.text === "string" && p.thought !== true)
        .map((p) => p.text ?? "")
        .join("\n")
        .trim();
      const finish = safeFinish("gemini", candidate.finishReason ?? null);
      if (finish && finish !== "STOP" && finish !== "MAX_TOKENS") {
        throw new AdapterFailure({
          code: "model_unavailable",
          message: safeMessage("gemini", "model_unavailable", {
            status: response.status,
            stopReason: finish,
          }),
        });
      }
      if (!text) {
        throw new AdapterFailure({
          code: "model_unavailable",
          message: safeMessage("gemini", "model_unavailable", { status: response.status }),
        });
      }
      const output =
        finish === "MAX_TOKENS"
          ? `${text}\n\n_[truncated: Gemini stopped on MAX_TOKENS]_`
          : text;
      // Gemini bills generated tokens as BOTH the visible candidate text and
      // any internal thinking tokens (`thoughtsTokenCount`). The
      // `maxOutputTokens` cap applies to the combined total per
      // https://ai.google.dev/gemini-api/docs/generate-content/thinking , so
      // reporting only `candidatesTokenCount` under-counts billed output and
      // leaves the user with a misleading `output_tokens` value.
      //
      // Preference order (all counters must be safe non-negative integers):
      //   1. candidates + thoughts (any thoughts value including 0)
      //      — adopts the user-visible billed total.
      //   2. totalTokenCount - promptTokenCount, when the delta is a safe
      //      non-negative integer AND thoughtsTokenCount is absent — covers
      //      text-only requests on non-thinking models whose response omits
      //      the field entirely. We require strict validation of BOTH
      //      counters so a malformed total/prompt cannot be laundered into
      //      a bogus derived number.
      //   3. `null` in every other case — the coordinator's conservative
      //      ledger then charges the full per-call reservation and the
      //      sticky-unknown aggregate collapses to `null` for the rest of
      //      the run. Candidates-only is NOT treated as a complete count,
      //      because a missing / malformed thoughts counter means we cannot
      //      prove the model skipped thinking.
      // We never store thought text or thoughtSignature values; the parts
      // loop above already drops them.
      const generatedTokens = combineGeminiOutput(data.usageMetadata);
      return {
        text: output,
        findings:
          finish === "MAX_TOKENS"
            ? ["Gemini stopped on MAX_TOKENS: output was truncated before the model completed."]
            : [],
        usage: {
          input_tokens: safeUsageCount(data.usageMetadata?.promptTokenCount),
          output_tokens: generatedTokens,
        },
        provider: this.provider,
        model_id: model,
      };
    } catch (err) {
      if (err instanceof AdapterFailure) throw err;
      const code = classifyUnknownError(err, request.signal);
      throw new AdapterFailure({
        code,
        message: safeMessage("gemini", code),
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean; thoughtSignature?: string }[] };
    finishReason?: string | null;
    safetyRatings?: { category: string; probability: string; blocked?: boolean }[];
  }[];
  promptFeedback?: { blockReason?: string | null };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    // Internal reasoning tokens billed by Gemini thinking models. Documented
    // at https://ai.google.dev/gemini-api/docs/generate-content/thinking .
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
}

/**
 * Compute Gemini's generated-token total, which is the sum of visible
 * candidate tokens AND billed internal thinking tokens. See
 * https://ai.google.dev/gemini-api/docs/generate-content/thinking .
 *
 * Returns `null` whenever the input cannot be converted to a provably
 * complete safe non-negative integer total. The coordinator then falls back
 * to its conservative full-reservation ledger charge, which is the honest
 * behaviour: we would rather under-report a known number than invent one.
 *
 * This function also guards against arithmetic overflow past
 * `Number.MAX_SAFE_INTEGER` via `safeUsageSum`.
 */
export function combineGeminiOutput(
  usage:
    | {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
        totalTokenCount?: number;
      }
    | undefined,
): number | null {
  if (!usage) return null;
  const candidates = safeUsageCount(usage.candidatesTokenCount);
  // Preferred path: candidates + thoughts. Only trusted when BOTH counters
  // are safe non-negative integers. A missing / malformed thoughts counter
  // is NOT treated as "zero thoughts" because we cannot verify the model
  // skipped thinking from a missing field.
  if (candidates !== null) {
    const thoughts = safeUsageCount(usage.thoughtsTokenCount);
    if (thoughts !== null) {
      return safeUsageSum(candidates, thoughts);
    }
  }
  // Secondary path: totalTokenCount - promptTokenCount, strictly validated.
  // We take max(candidates, derived) when both are present so a provider
  // category we did not model (future tokens we have no name for) is
  // reflected in the ledger. Both inputs must be safe non-negative integers
  // AND the subtraction must yield a safe non-negative integer; otherwise
  // we return null.
  const prompt = safeUsageCount(usage.promptTokenCount);
  const total = safeUsageCount(usage.totalTokenCount);
  if (prompt !== null && total !== null && total >= prompt) {
    const derived = total - prompt;
    if (!Number.isSafeInteger(derived) || derived < 0) return null;
    if (candidates !== null) {
      return derived >= candidates ? derived : candidates;
    }
    return derived;
  }
  return null;
}

function linkSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const controller = new AbortController();
  const onA = (): void => controller.abort(a.reason);
  const onB = (): void => controller.abort(b.reason);
  a.addEventListener("abort", onA, { once: true });
  b.addEventListener("abort", onB, { once: true });
  return controller.signal;
}

/**
 * Read an attachment blob and return base64, collapsing any filesystem
 * error (ENOENT / EACCES / EIO / EISDIR / ENOSPC …) into a sanitized
 * AdapterFailure so the raw absolute path never leaks into the run
 * snapshot, SSE frames, or exports.
 */
function readAttachmentBase64(path: string): string {
  try {
    return fs.readFileSync(path).toString("base64");
  } catch {
    throw new AdapterFailure({
      code: "attachment_unreadable",
      message: safeMessage("gemini", "attachment_unreadable"),
    });
  }
}

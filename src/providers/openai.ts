// OpenAI chat-completions adapter. Only called when the user both enables
// Live globally (`PROOFESTRA_LIVE_ENABLED=1`) and submits a run with
// `execution_mode: "live"`. Requests always carry an AbortSignal and a
// bounded max_completion_tokens. Vendor payload shapes come from
// https://developers.openai.com/api/reference/chat as of 2026-10-21.
//
// All adapter failures carry a fixed, upstream-text-free message. Error
// bodies, response.text(), caught Error.message strings and any identifying
// token substrings are discarded; the normalized `code` conveys the
// classification and `message` contains only provider, http status and the
// allowlisted stop reason enum (if any).

import fs from "node:fs";
import type { AdapterRequest, AdapterResult, ProviderAdapter } from "./types.js";
import { AdapterFailure } from "./types.js";
import type { ModelProfile } from "../shared/types.js";
import {
  frameAttachmentOnlyNote,
  frameExtractedAttachment,
  frameNativeAttachmentNotice,
} from "./attachmentFraming.js";
import {
  classifyUnknownError,
  safeFinish,
  safeMessage,
  safeUsageCount,
} from "./_sanitize.js";

export interface OpenAiAdapterOptions {
  apiKey: string | null;
  endpoint?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export class OpenAiAdapter implements ProviderAdapter {
  readonly provider = "openai" as const;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAiAdapterOptions) {
    this.endpoint = options.endpoint ?? "https://api.openai.com/v1/chat/completions";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  supports(profile: ModelProfile): boolean {
    return profile.provider === "openai";
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
        message: safeMessage("openai", "authentication"),
      });
    }
    const model = request.profile.model_id;
    if (!model) {
      throw new AdapterFailure({
        code: "model_unavailable",
        message: safeMessage("openai", "model_unavailable"),
      });
    }
    // Reasoning-family models (gpt-5.x and later) reject the legacy
    // `max_tokens` field and `temperature`/`top_p` sampling controls on Chat
    // Completions; they require `max_completion_tokens` and ignore sampling
    // overrides. See
    // https://developers.openai.com/api/docs/guides/latest-model and
    // https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create .
    const body: Record<string, unknown> = {
      model,
      messages: toMessages(request),
      max_completion_tokens: request.max_output_tokens,
    };
    const controller = new AbortController();
    const linked = linkSignals(request.signal, controller.signal);
    const timeout = setTimeout(() => controller.abort(), request.per_call_timeout_ms);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          "X-Proofestra-Client": "proofestra-local/0.1.0",
        },
        body: JSON.stringify(body),
        signal: linked,
      });
      if (response.status === 401) {
        throw new AdapterFailure({
          code: "authentication",
          message: safeMessage("openai", "authentication", { status: response.status }),
        });
      }
      if (response.status === 429) {
        throw new AdapterFailure({
          code: "rate_limited",
          message: safeMessage("openai", "rate_limited", { status: response.status }),
        });
      }
      if (response.status >= 500) {
        throw new AdapterFailure({
          code: "provider_unavailable",
          message: safeMessage("openai", "provider_unavailable", { status: response.status }),
        });
      }
      if (!response.ok) {
        // Drop the body entirely; the status + fixed code are all we expose.
        throw new AdapterFailure({
          code: "invalid_request",
          message: safeMessage("openai", "invalid_request", { status: response.status }),
        });
      }
      let data: OpenAiResponse;
      try {
        data = (await response.json()) as OpenAiResponse;
      } catch {
        throw new AdapterFailure({
          code: "provider_unavailable",
          message: safeMessage("openai", "provider_unavailable", { status: response.status }),
        });
      }
      const choice = data.choices?.[0];
      const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
      const finish = safeFinish("openai", choice?.finish_reason ?? null);
      if (finish && finish !== "stop" && finish !== "length") {
        throw new AdapterFailure({
          code: "model_unavailable",
          message: safeMessage("openai", "model_unavailable", {
            status: response.status,
            stopReason: finish,
          }),
        });
      }
      if (!text.trim()) {
        throw new AdapterFailure({
          code: "model_unavailable",
          message: safeMessage("openai", "model_unavailable", { status: response.status }),
        });
      }
      const output =
        finish === "length"
          ? `${text}\n\n_[truncated: OpenAI reached the output budget before completing]_`
          : text;
      return {
        text: output,
        findings:
          finish === "length"
            ? ["OpenAI stopped on length: output was truncated before the model completed."]
            : [],
        usage: {
          // Honest provider-reported counters. Any missing / fractional /
          // negative / NaN / unsafe-integer value becomes `null` so the
          // coordinator's sticky-unknown aggregate collapses and the
          // conservative ledger charges the full reservation instead of a
          // bogus "0" or a reduced value from a malformed response.
          input_tokens: safeUsageCount(data.usage?.prompt_tokens),
          output_tokens: safeUsageCount(data.usage?.completion_tokens),
        },
        provider: this.provider,
        model_id: typeof data.model === "string" ? data.model : model,
      };
    } catch (err) {
      if (err instanceof AdapterFailure) throw err;
      const code = classifyUnknownError(err, request.signal);
      throw new AdapterFailure({
        code,
        message: safeMessage("openai", code),
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

interface OpenAiResponse {
  model?: string;
  choices?: {
    message?: { content?: string };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * OpenAI ChatCompletions content shapes. Verified against
 * https://developers.openai.com/api/docs/guides/images-vision (image_url)
 * and https://developers.openai.com/api/docs/guides/file-inputs (file).
 * Both use inline data URLs / base64 — we never upload to the Files API
 * from this scope.
 */
type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

type OpenAIMessageContent = string | OpenAIContentPart[];

function toMessages(
  request: AdapterRequest,
): { role: "system" | "user" | "assistant"; content: OpenAIMessageContent }[] {
  const messages: { role: "system" | "user" | "assistant"; content: OpenAIMessageContent }[] = [];
  const sys = request.system_instructions.trim();
  if (sys) messages.push({ role: "system", content: sys });
  if (request.reference_material && request.reference_material.trim()) {
    messages.push({
      role: "user",
      content: `Reference material for this stage:\n\n${request.reference_material}`,
    });
  }
  for (const message of request.user_messages) {
    if (!message.parts || message.parts.length === 0) {
      messages.push({ role: message.role, content: message.content });
      continue;
    }
    const parts: OpenAIContentPart[] = [];
    for (const p of message.parts) {
      if (p.kind === "text") {
        if (p.text) parts.push({ type: "text", text: p.text });
      } else if (p.kind === "attachment_native" && p.native_route === "native_image") {
        parts.push({ type: "text", text: frameNativeAttachmentNotice(p) });
        const dataUrl = inlineDataUrl(p.wire_mime, p.blob_path);
        parts.push({ type: "image_url", image_url: { url: dataUrl } });
      } else if (p.kind === "attachment_native" && p.native_route === "native_pdf") {
        const base64 = inlineBase64(p.blob_path);
        parts.push({ type: "text", text: frameNativeAttachmentNotice(p) });
        parts.push({
          type: "file",
          file: {
            filename: p.sanitized_display_name,
            file_data: `data:${p.wire_mime};base64,${base64}`,
          },
        });
      } else if (p.kind === "attachment_extracted_text") {
        parts.push({ type: "text", text: frameExtractedAttachment(p) });
      } else if (p.kind === "attachment_only") {
        parts.push({
          type: "text",
          text: frameAttachmentOnlyNote(p),
        });
      } else if (p.kind === "attachment_native") {
        // native_audio / native_video — OpenAI ChatCompletions in this
        // scope does not accept them natively. Fall through to an honest
        // attachment-only text note (route decision earlier should have
        // mapped these to attachment_only; this branch is defensive).
        parts.push({
          type: "text",
          text: frameAttachmentOnlyNote({
            ...p,
            reason: `native ${p.native_route.replace("native_", "")} is not supported for openai in this app`,
          }),
        });
      }
    }
    messages.push({ role: message.role, content: parts.length > 0 ? parts : message.content });
  }
  return messages;
}

function inlineDataUrl(mime: string, path: string): string {
  return `data:${mime};base64,${inlineBase64(path)}`;
}

function inlineBase64(path: string): string {
  // Any filesystem error here (ENOENT, EACCES, ENOSPC, EISDIR, …) carries
  // an absolute path in `err.message`. The coordinator's `toFailure` path
  // would otherwise leak that path into the run snapshot, the SSE
  // frames, and the export. Collapse the error to a fixed sanitized
  // AdapterFailure that the sanitizer already allows through verbatim.
  try {
    return fs.readFileSync(path).toString("base64");
  } catch {
    throw new AdapterFailure({
      code: "attachment_unreadable",
      message: safeMessage("openai", "attachment_unreadable"),
    });
  }
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

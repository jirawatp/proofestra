// Anthropic Messages API adapter. Live calls require a configured
// ANTHROPIC_API_KEY and an explicit per-request `execution_mode: "live"`.
// Vendor payload shapes match
// https://platform.claude.com/docs/en/api/messages as checked 2026-10-21.
//
// All adapter failures carry a fixed, upstream-text-free message. Error
// bodies, response.text(), caught Error.message strings and any identifying
// token substrings are discarded.

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
  safeMessage,
  safeUsageCount,
} from "./_sanitize.js";

export interface AnthropicAdapterOptions {
  apiKey: string | null;
  endpoint?: string | undefined;
  version?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly provider = "anthropic" as const;
  private readonly endpoint: string;
  private readonly version: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AnthropicAdapterOptions) {
    this.endpoint = options.endpoint ?? "https://api.anthropic.com/v1/messages";
    this.version = options.version ?? "2023-06-01";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  supports(profile: ModelProfile): boolean {
    return profile.provider === "anthropic";
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
        message: safeMessage("anthropic", "authentication"),
      });
    }
    const model = request.profile.model_id;
    if (!model) {
      throw new AdapterFailure({
        code: "model_unavailable",
        message: safeMessage("anthropic", "model_unavailable"),
      });
    }
    // Anthropic Messages API: content is EITHER a plain string OR an
    // array of typed blocks. Image blocks use base64-source; PDF uses
    // document with base64-source. Verified against
    // https://platform.claude.com/docs/en/build-with-claude/vision and
    // the Messages API reference. Audio/video are not accepted here.
    const content: AnthropicMessage[] = [];
    if (request.reference_material?.trim()) {
      content.push({
        role: "user",
        content: `Reference material for this stage:\n\n${request.reference_material}`,
      });
    }
    for (const message of request.user_messages) {
      if (!message.parts || message.parts.length === 0) {
        content.push({ role: message.role, content: message.content });
        continue;
      }
      const blocks: AnthropicContentBlock[] = [];
      for (const p of message.parts) {
        if (p.kind === "text") {
          if (p.text) blocks.push({ type: "text", text: p.text });
        } else if (p.kind === "attachment_native" && p.native_route === "native_image") {
          const data = readAttachmentBase64(p.blob_path);
          blocks.push({ type: "text", text: frameNativeAttachmentNotice(p) });
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: p.wire_mime, data },
          });
        } else if (p.kind === "attachment_native" && p.native_route === "native_pdf") {
          const data = readAttachmentBase64(p.blob_path);
          blocks.push({ type: "text", text: frameNativeAttachmentNotice(p) });
          blocks.push({
            type: "document",
            source: { type: "base64", media_type: p.wire_mime, data },
          });
        } else if (p.kind === "attachment_extracted_text") {
          blocks.push({ type: "text", text: frameExtractedAttachment(p) });
        } else if (p.kind === "attachment_only" || p.kind === "attachment_native") {
          const name = "sanitized_display_name" in p ? p.sanitized_display_name : "attachment";
          const mime = "sniffed_mime" in p ? p.sniffed_mime : "application/octet-stream";
          const size = "byte_size" in p ? p.byte_size : 0;
          const reason =
            p.kind === "attachment_only"
              ? p.reason
              : `native ${p.native_route.replace("native_", "")} is not supported for anthropic in this app`;
          blocks.push({
            type: "text",
            text: frameAttachmentOnlyNote({
              sanitized_display_name: name,
              sniffed_mime: mime,
              byte_size: size,
              reason,
            }),
          });
        }
      }
      content.push({
        role: message.role,
        content: blocks.length > 0 ? blocks : message.content,
      });
    }
    const body = {
      model,
      system: request.system_instructions || undefined,
      max_tokens: request.max_output_tokens,
      temperature: 0.2,
      messages: content.length > 0 ? content : [{ role: "user", content: "(empty prompt)" }],
    };
    const controller = new AbortController();
    const linked = linkSignals(request.signal, controller.signal);
    const timeout = setTimeout(() => controller.abort(), request.per_call_timeout_ms);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": this.version,
          "x-proofestra-client": "proofestra-local/0.1.0",
        },
        body: JSON.stringify(body),
        signal: linked,
      });
      if (response.status === 401 || response.status === 403) {
        throw new AdapterFailure({
          code: "authentication",
          message: safeMessage("anthropic", "authentication", { status: response.status }),
        });
      }
      if (response.status === 429) {
        throw new AdapterFailure({
          code: "rate_limited",
          message: safeMessage("anthropic", "rate_limited", { status: response.status }),
        });
      }
      if (response.status >= 500) {
        throw new AdapterFailure({
          code: "provider_unavailable",
          message: safeMessage("anthropic", "provider_unavailable", { status: response.status }),
        });
      }
      if (!response.ok) {
        throw new AdapterFailure({
          code: "invalid_request",
          message: safeMessage("anthropic", "invalid_request", { status: response.status }),
        });
      }
      let data: AnthropicResponse;
      try {
        data = (await response.json()) as AnthropicResponse;
      } catch {
        throw new AdapterFailure({
          code: "provider_unavailable",
          message: safeMessage("anthropic", "provider_unavailable", { status: response.status }),
        });
      }
      // Only text blocks are presentable; tool_use / thinking blocks are
      // dropped (they contain internal state or follow-up actions, not an
      // answer we can render honestly).
      const text = (data.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => (typeof block.text === "string" ? block.text : ""))
        .join("\n")
        .trim();
      const stop = safeFinish("anthropic", data.stop_reason ?? null);
      if (stop && stop !== "end_turn" && stop !== "max_tokens" && stop !== "stop_sequence") {
        throw new AdapterFailure({
          code: "model_unavailable",
          message: safeMessage("anthropic", "model_unavailable", {
            status: response.status,
            stopReason: stop,
          }),
        });
      }
      if (!text) {
        throw new AdapterFailure({
          code: "model_unavailable",
          message: safeMessage("anthropic", "model_unavailable", { status: response.status }),
        });
      }
      const output =
        stop === "max_tokens"
          ? `${text}\n\n_[truncated: Anthropic stopped on max_tokens]_`
          : text;
      return {
        text: output,
        findings:
          stop === "max_tokens"
            ? ["Anthropic stopped on max_tokens: output was truncated before the model completed."]
            : [],
        usage: {
          // Honest provider-reported counters; any missing / fractional /
          // negative / unsafe-integer value becomes `null` so the sticky-
          // unknown aggregate collapses and the conservative ledger charges
          // the full reservation.
          input_tokens: safeUsageCount(data.usage?.input_tokens),
          output_tokens: safeUsageCount(data.usage?.output_tokens),
        },
        provider: this.provider,
        model_id: typeof data.model === "string" ? data.model : model,
      };
    } catch (err) {
      if (err instanceof AdapterFailure) throw err;
      const code = classifyUnknownError(err, request.signal);
      throw new AdapterFailure({
        code,
        message: safeMessage("anthropic", code),
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

interface AnthropicResponse {
  model?: string;
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string | null;
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
      message: safeMessage("anthropic", "attachment_unreadable"),
    });
  }
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }
  | {
      type: "document";
      source: { type: "base64"; media_type: string; data: string };
    };

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

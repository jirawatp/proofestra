// Normalized provider adapter interface. Every adapter receives a frozen,
// deterministic request and returns text, concise findings, usage, and typed
// errors. Adapters never touch persistence directly and never return raw
// vendor payloads: those stay inside the adapter.

import type {
  ModelProfile,
  NativeBackendFreeze,
  NormalizedFailure,
  ProviderId,
  Usage,
} from "../shared/types.js";

export type AdapterStage = "draft" | "review" | "synthesis";

/**
 * Typed content parts for a normalized user message. The adapter is the
 * ONLY place where raw bytes materialize — the coordinator passes
 * references (storage key + hash + sniffed mime + extraction coverage)
 * and the adapter reads them from disk inside its own request builder.
 * This keeps raw bytes out of SSE snapshots, run JSON, and default
 * exports by construction.
 *
 * Parts never embed external URLs; the only input source is a locally
 * stored attachment the user uploaded through our own authenticated
 * route. No provider Files API uploads or remote artifacts.
 */
export type MessageContentPart =
  | { kind: "text"; text: string }
  | {
      kind: "attachment_native";
      native_route: "native_image" | "native_pdf" | "native_audio" | "native_video";
      attachment_id: string;
      sniffed_mime: string;
      /**
       * MIME for the provider wire. Equals `sniffed_mime` for image/PDF; for
       * audio/video it is the probe-normalized MIME (`video/quicktime`
       * becomes `video/mov` only after validation).
       */
      wire_mime: string;
      byte_size: number;
      sanitized_display_name: string;
      /**
       * Absolute path to the on-disk blob. Only read inside the adapter
       * at dispatch time, never serialized anywhere else.
       */
      blob_path: string;
    }
  | {
      kind: "attachment_extracted_text";
      attachment_id: string;
      sanitized_display_name: string;
      sniffed_mime: string;
      byte_size: number;
      // Bounded text extracted from the attachment, wrapped as untrusted
      // reference material. The coordinator decides whether to include
      // this (via `routeNativeAttachment` returning `extracted_text`).
      text: string;
      truncated: boolean;
    }
  | {
      kind: "attachment_only";
      attachment_id: string;
      sanitized_display_name: string;
      sniffed_mime: string;
      byte_size: number;
      // Short, honest label explaining why this attachment is NOT being
      // sent as model input (e.g. "profile does not accept pdf",
      // "duration unknown; refusing native audio routing"). The adapter
      // may surface this in-prompt as an advisory text part so the model
      // knows the file exists but was not analyzed.
      reason: string;
    };

export interface NormalizedMessage {
  role: "user" | "assistant";
  // Legacy string content for assistant history and plain text turns.
  content: string;
  // Optional typed parts for user messages that carry attachments. The
  // adapter uses `parts` when present; a null/absent `parts` means the
  // message is text-only and `content` is authoritative.
  parts?: MessageContentPart[] | null;
}

export interface AdapterRequest {
  profile: ModelProfile;
  stage: AdapterStage;
  agent: {
    agent_id: string;
    name: string;
    role: string | null;
  };
  system_instructions: string;
  user_messages: NormalizedMessage[];
  reference_material: string | null;
  max_output_tokens: number;
  per_call_timeout_ms: number;
  signal: AbortSignal;
  // The frozen admission policy for a native (CLI) backend agent. API
  // adapters ignore it; a native adapter refuses to run without a match.
  native_policy?: NativeBackendFreeze | undefined;
}

export interface AdapterResult {
  text: string;
  findings: string[];
  usage: Pick<Usage, "input_tokens" | "output_tokens">;
  provider: ProviderId;
  model_id: string;
}

export interface ProviderAdapter {
  readonly provider: ProviderId;
  readonly supports: (profile: ModelProfile) => boolean;
  readonly readiness: (profile: ModelProfile) => "configured" | "missing_auth" | "disabled" | "unsupported";
  generate(request: AdapterRequest): Promise<AdapterResult>;
}

export class AdapterFailure extends Error {
  constructor(
    public readonly failure: NormalizedFailure,
    /**
     * `"unknown"` when work may have been started outside this process (a native
     * CLI job was launched and did not finish cleanly). Never set it to claim the
     * external work is known to be zero or stopped.
     */
    public readonly externalWork?: "unknown",
  ) {
    super(failure.message);
    this.name = "AdapterFailure";
  }
}

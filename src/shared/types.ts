// Shared domain types used by server, client, tests, and adapters.
// Field names mirror docs/openapi.yaml where practical; this file is the
// contract between the mock implementation and the UI for v1.

export type RunMode = "quick" | "team";
export type ExecutionMode = "mock" | "live";
export type ReviewTopology = "all_peers";
export type ProviderId = "openai" | "anthropic" | "gemini" | "mock";
// `provider_api` is a metered HTTP API adapter. `native_cli` is a locally
// installed vendor CLI that owns its own (subscription) login; Proofestra never
// reads or forwards that credential. The two never share an adapter or fall
// back to each other.
export type BackendKind = "provider_api" | "native_cli";

export type Readiness = "configured" | "missing" | "missing_auth" | "disabled" | "unsupported" | "unverified";

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_for_tool"
  | "awaiting_approval"
  | "waiting_for_children"
  | "completed"
  | "partial"
  | "failed"
  | "canceled"
  | "interrupted";

export type TerminalStatus = Extract<
  RunStatus,
  "completed" | "partial" | "failed" | "canceled" | "interrupted"
>;

export type StepStage = "draft" | "review" | "synthesis" | "helper";

export type StepStatus =
  | "queued"
  | "running"
  | "waiting_for_children"
  | "waiting_for_tool"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "skipped"
  | "timed_out"
  | "canceled"
  | "interrupted";

export type PresentationKind = "none" | "quick_unreviewed" | "team_synthesis" | "draft_fallback";

export interface AgentDefinition {
  agent_id: string;
  name: string;
  profile_id: string;
  role?: string | null;
}

export interface ModelProfile {
  profile_id: string;
  provider: ProviderId;
  label: string;
  model_id: string | null;
  safe_input_tokens: number;
  max_output_tokens: number;
  api_shape:
    | "mock"
    | "openai_chat_completions"
    | "anthropic_messages_v1"
    | "gemini_generate_content"
    | "codex_exec_cli"
    | "antigravity_cli";
  readiness: Readiness;
  execution_backend_id: string;
  // Optional per-profile native-attachment capability override. When
  // omitted, the server falls back to `defaultProviderCapabilities(provider)`
  // in `src/core/attachments.ts`. The override is CLAMPED against the
  // provider defaults so a profile can be MORE conservative (e.g. "this
  // text-only variant does not accept images") but can never silently
  // widen the vendor-documented inline media caps. The field is included
  // in the catalog version digest so a change rotates the version.
  capabilities?: {
    image?: boolean;
    image_mime_whitelist?: string[];
    pdf?: boolean;
    audio?: boolean;
    video?: boolean;
    max_native_image_bytes?: number;
    max_native_aggregate_bytes?: number;
    max_native_inline_media_bytes?: number;
    // Numeric caps and codec allowlists can only TIGHTEN the provider
    // default (`min()` / intersection in `effectiveCapabilitiesFor`).
    max_native_audio_seconds?: number;
    max_native_video_seconds?: number;
    max_native_media_aggregate_seconds?: number;
    max_native_media_aggregate_bytes?: number;
    max_native_pdf_pages?: number;
    audio_codec_whitelist?: string[];
    video_codec_whitelist?: string[];
  };
}

export interface ProviderConfig {
  provider: ProviderId;
  label: string;
  adapter_manifest_version: string;
  profiles: ModelProfile[];
}

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  run_id: string;
  role: "user" | "assistant";
  text: string;
  sequence: number;
  created_at: string;
  // Ordered attachment metadata snapshot — the ids/hashes/sanitized names
  // frozen onto this message at admission. Empty array for messages sent
  // without any attachments (the overwhelming common case). Never contains
  // raw bytes, base64, extracted text, local paths, or provider file IDs.
  attachments?: AttachmentRef[];
}

/**
 * Attachment metadata as it appears inside a persisted/exported Message.
 * Byte-level content and extracted text are never embedded here; the
 * download/preview routes serve them separately with authentication.
 */
export interface AttachmentRef {
  id: string;
  sanitized_display_name: string;
  sniffed_mime: string;
  kind: AttachmentKind;
  byte_size: number;
  content_sha256: string;
  extraction_status: AttachmentExtractionStatus;
  extraction_coverage: AttachmentExtractionCoverage;
  // Header-sniffed image dimensions, when the format is one of the
  // supported magic-byte-readable formats (PNG / GIF / WebP). `null` for
  // images whose dimensions could not be read from the 64-byte head slice
  // (JPEG), and for every non-image kind. The routing code refuses the
  // native-image path when the file IS an image but its dimensions are
  // `null`, because we have no bound on pixel area without them.
  sniffed_width?: number | null;
  sniffed_height?: number | null;
  // Validated page count returned by the Poppler extractor. Null for
  // non-PDFs, encrypted PDFs, malformed PDFs, and installs without
  // Poppler. The routing code refuses `native_pdf` whenever this is
  // null, because there is no bound on the per-page token cost.
  sniffed_pdf_pages?: number | null;
  // Validated audio/video duration (ms) from a bounded ffprobe probe.
  // Null for non-media files, media the probe refused (unsupported
  // demuxer / no ffprobe install), and probe timeouts. The routing
  // code refuses `native_audio` / `native_video` whenever this is
  // null.
  sniffed_media_duration_ms?: number | null;
  // Bounded JSON summary of the probed streams (`codec_type`,
  // `codec_name`, and when relevant `width` / `height` / `channels` /
  // `sample_rate`). Up to 8 streams; strings and integers only. Used
  // for codec-whitelist checks before admitting native audio/video.
  sniffed_media_streams_json?: string | null;
  // ffprobe `format_name` (sanitized) of a structurally validated media
  // file, e.g. `mov,mp4,m4a,3gp,3g2,mj2`. Null when not validated.
  validated_media_format?: string | null;
  // Media MIME normalized for provider wire use, set only after a
  // successful probe (`video/quicktime` becomes `video/mov` only for a
  // confirmed `mov` family). Distinct from `sniffed_mime`, which stays
  // the original magic-byte result. Null when not validated.
  normalized_media_mime?: string | null;
}

export type AttachmentKind =
  | "image"
  | "pdf"
  | "audio"
  | "video"
  | "text"
  | "archive"
  | "document"
  | "binary";

export type AttachmentState = "uploading" | "ready" | "failed" | "bound";

export type AttachmentExtractionStatus =
  | "none"
  | "pending"
  | "text_extracted"
  | "truncated"
  | "encrypted"
  | "unsupported"
  | "failed";

/**
 * Honest per-attachment coverage summary surfaced to the UI and the
 * synthesis prompt. These do NOT imply the file was understood by the
 * model; they describe what the server was willing / able to extract and
 * what the attachment is advertised as to the selected profile.
 */
export interface AttachmentExtractionCoverage {
  // Characters of UTF-8 text extracted and sent as a quoted "untrusted
  // data" block. 0 for binary files that were not text-extracted.
  extracted_chars: number;
  // True when the file was larger / had more pages than the server-side
  // caps allowed and the extraction stopped early.
  truncated: boolean;
  // Short honest label used in the UI badge; e.g. "text (truncated)",
  // "encrypted PDF", "ZIP inventory only", "attachment-only (unsupported
  // by selected provider)". Never a guarantee of model understanding.
  label: string;
}

/**
 * Full attachment DTO returned by the attachments list / detail routes.
 * Still metadata-only: raw bytes are only served by preview / download
 * routes with authentication and sandbox CSP headers.
 */
export interface AttachmentDto extends AttachmentRef {
  conversation_id: string;
  state: AttachmentState;
  created_at: string;
  bound_at: string | null;
  failure: { code: string; message: string } | null;
}

export interface Finding {
  agent_id: string;
  step_id: string;
  text: string;
}

export type NormalizedFailureCode =
  | "authentication"
  | "rate_limited"
  | "model_unavailable"
  | "invalid_request"
  | "provider_unavailable"
  | "timeout"
  | "context_too_large"
  | "budget_exhausted"
  | "canceled"
  | "interrupted"
  // Attachment byte-read failure inside an adapter (ENOENT / EACCES /
  // EIO / EISDIR / ENOSPC …). Collapsed to a fixed label so the raw
  // filesystem errno + absolute path never leak into the run snapshot,
  // the SSE frames, or the export. See `src/providers/_sanitize.ts`.
  | "attachment_unreadable"
  | "unknown";

export interface NormalizedFailure {
  code: NormalizedFailureCode;
  message: string;
}

export interface Usage {
  harness_invocations: number;
  tool_operations_observed: number;
  native_jobs_started: number;
  internal_usage_visibility: "complete" | "partial" | "opaque" | "unknown";
  internal_model_invocations: number | null;
  internal_tool_operations: number | null;
  // Provider-reported sums with sticky-unknown semantics:
  //   - start at 0 (no dispatches yet contribute)
  //   - each known contribution is added to the sum
  //   - once ANY dispatched invocation reports an unknown value, the aggregate
  //     becomes `null` and stays `null` for the rest of the run.
  // Downstream renderers must display `null` as "unknown", never zero. This
  // preserves CT-06 (honest unknown usage) across invocation, step and run
  // snapshots.
  input_tokens: number | null;
  output_tokens: number | null;
  // Separate conservative numeric ledger used by the admission + per-call
  // output-budget math. Always numeric. Grows by the reported output tokens
  // when the invocation reported a number, otherwise by the full per-call
  // reservation (ambiguous consumption treated as if the model used the full
  // reserve).
  consumed_output_tokens: number;
  reserved_output_tokens: number;
  token_scope: "harness_only" | "whole_tree" | "partial" | "unknown" | "simulated";
  accounting: "reported" | "conservative" | "unknown" | "simulated";
  estimated_cost_usd: number | null;
  cost_scope: "reported_total" | "observed_only" | "partial" | "unknown" | "simulated";
  pricing_version: string | null;
}

export interface InvocationSnapshot {
  invocation_id: string;
  kind: "initial" | "continuation" | "retry";
  status: "queued" | "running" | "completed" | "failed" | "timed_out" | "canceled" | "interrupted";
  started_at: string | null;
  finished_at: string | null;
  usage: Usage;
  failure: NormalizedFailure | null;
  retry_of_invocation_id: string | null;
  resumes_after_invocation_id: string | null;
  execution_backend_id: string;
  deadline_at: string;
}

export interface StepSnapshot {
  step_id: string;
  agent_id: string;
  stage: StepStage;
  provider: ProviderId;
  status: StepStatus;
  attempts: number;
  invocations: InvocationSnapshot[];
  output: string | null;
  findings: Finding[];
  usage: Usage;
  failure: NormalizedFailure | null;
}

export interface AgentSnapshot {
  agent_id: string;
  name: string;
  profile_id: string;
  provider: ProviderId;
  model_id: string;
  role: string | null;
  safe_input_tokens: number;
  parent_agent_id: string | null;
  root_agent_id: string;
  depth: number;
  task: string | null;
  child_agent_ids: string[];
  status: "queued" | "running" | "waiting_for_children" | "waiting_for_tool" | "awaiting_approval" | "completed" | "failed" | "canceled" | "interrupted";
  execution_backend_id: string;
}

export interface ContextSnapshot {
  policy: "all_history_v1";
  message_ids: string[];
  input_fit_status: "accepted";
  notice?: string | undefined;
  // Frozen metadata-only attachment projection for every stage. Each entry
  // is the exact ordered attachment ref that the user message carries;
  // the coordinator never re-reads this from the live attachments table
  // (that would risk mutation under a long-running Team run).
  attachments?: AttachmentRef[];
  // Per-root per-attachment routing decision at admission time; the UI
  // reads this to show accurate "native image" / "extracted text" /
  // "attachment-only (unsupported by selected profile)" badges per agent.
  attachment_coverage?: Array<{
    agent_id: string;
    profile_id: string;
    provider: ProviderId;
    routes: Array<{
      attachment_id: string;
      route:
        | "native_image"
        | "native_pdf"
        | "native_audio"
        | "native_video"
        | "extracted_text"
        | "attachment_only";
      reason: string;
    }>;
    aggregate_note: string;
  }>;
}

export interface DelegationPolicy {
  enabled: boolean;
  allowed_profile_ids: string[];
}

export interface ToolPolicy {
  mode: "off" | "auto";
  allowed_tool_ids: string[];
  allowed_backend_ids: string[];
  allowed_profile_ids: string[];
  grant_refs: string[];
  missing_grant: "pause" | "block";
  bounds_mode: "strict" | "bounded_job";
  required_controls: string[];
  allow_unknown_internal_usage: boolean;
}

export interface RunLimits {
  max_harness_invocations: number;
  max_tool_operations: number;
  max_native_jobs: number;
  concurrency: number;
  per_provider_concurrency: number;
  overall_timeout_seconds: number;
  per_call_timeout_seconds: number;
  max_native_job_seconds: number;
  max_output_tokens_per_call: number;
  total_output_tokens: number;
  max_retries_per_step: number;
  max_root_agents: number;
  max_total_agents: number;
  max_spawned_agents: number;
  max_children_per_agent: number;
  max_depth: number;
}

export interface RunSnapshot {
  id: string;
  conversation_id: string;
  user_message_id: string;
  mode: RunMode;
  execution_mode: ExecutionMode;
  status: RunStatus;
  root_agent_ids: string[];
  agents: AgentSnapshot[];
  synthesizer_agent_id: string | null;
  delegation: DelegationPolicy;
  context: ContextSnapshot;
  prompt_version: string;
  limits: RunLimits;
  base_planned_calls: number;
  steps: StepSnapshot[];
  final_answer: string | null;
  presentation: PresentationKind;
  limitations: string[];
  usage: Usage;
  created_at: string;
  finished_at: string | null;
  last_event_sequence: number;
  review_topology: ReviewTopology;
  runtime_policy_version: string;
  catalog_version: string;
  tool_policy: ToolPolicy;
  external_work_status: "none" | "settled" | "unknown" | "orphaned";
  // Present only when at least one agent runs on a native (CLI) backend.
  // Frozen at admission; dispatch refuses to run if the live policy no longer
  // matches it. Contains no paths, credentials, versions of other software or
  // vendor text.
  native_backends?: NativeBackendFreeze[];
}

export interface ToolSurfaceControl {
  /** Stable identifier; exposed to the UI. Never contains paths or versions. */
  id: string;
  /** `enforced` = a switch exists AND its effective state is checked before launch. */
  status: "enforced" | "unproven";
  /** Maintainer-facing evidence (kept in source/docs; not sent to the browser). */
  evidence: string;
}

export interface NativeVerificationRecord {
  cli_version: string;
  controls: readonly ToolSurfaceControl[];
}

/** Why a native backend is or is not admitted; fixed, vendor-text-free codes. */
export type NativeReasonCode =
  | "live_disabled"
  | "not_enabled"
  | "model_not_pinned"
  | "executable_not_found"
  | "tool_surface_unproven"
  | "protocol_unverified"
  | "auth_mode_unproven"
  | "ready_auth_checked_per_job";

/** Public, sanitized native backend state (GET /providers). */
export interface NativeBackendStatus {
  backend_id: string;
  provider: ProviderId;
  kind: "native_cli";
  readiness: Readiness;
  reason_code: NativeReasonCode;
  // Proofestra never reads, stores or forwards the vendor login.
  credentials: "vendor_managed";
  // Subscription quota is not API credit; cost is never reported as $0.
  billing: "subscription_quota_cost_unknown";
  tool_surface: "proven_off" | "unproven";
  // Stable ids of controls that could not be proven (never paths/versions).
  unproven_controls: string[];
}

/** Policy frozen into a run for one native backend. */
export interface NativeBackendFreeze {
  backend_id: string;
  provider: ProviderId;
  model_id: string;
  policy_id: string;
  cli_version: string;
  tool_surface: "proven_off";
  permissions: {
    sandbox: "read-only";
    approvals: "never";
    network_tools: "off";
    cwd: "empty_scratch";
    env: "credential_free";
    persistence: "ephemeral";
  };
  accounting: {
    billing: "subscription_quota_cost_unknown";
    usage: "vendor_reported_or_unknown";
    internal_usage_visibility: "opaque";
  };
  max_native_job_seconds: number;
}

export type EventType =
  | "run.created"
  | "run.updated"
  | "run.terminal"
  | "step.started"
  | "step.updated"
  | "step.completed"
  | "step.failed"
  | "stage.started"
  | "stage.completed"
  | "message.created";

export interface EventEnvelope<T = unknown> {
  run_id: string;
  sequence: number;
  type: EventType;
  at: string;
  data: T;
}

export interface Session {
  csrf_token: string;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export interface RuntimePolicySnapshot {
  policy_version: string;
  updated_at: string;
  defaults: RunLimits;
  deployment_ceilings: RunLimits;
  default_tool_modes: { quick: "off" | "auto"; team: "off" | "auto" };
  default_delegation: { quick: boolean; team: boolean };
  review_topologies: ReviewTopology[];
  required_controls: string[];
  live_enabled: boolean;
  implementation_notes: string[];
}

export interface ConversationExport {
  export_version: 1;
  exported_at: string;
  conversation: Conversation;
  messages: Message[];
  runs: RunSnapshot[];
}

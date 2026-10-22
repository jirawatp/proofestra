// Thin API client used by the React UI. All mutations attach the CSRF token
// returned by GET /api/v1/session; the HttpOnly cookie is sent automatically.
// Session bootstrap is retried with bounded exponential backoff so a brief
// startup hiccup does not kill the whole app.

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
  // Metadata-only attachment refs frozen onto this message at admission.
  // Raw bytes are never embedded here; the preview/download routes serve
  // them separately with authentication.
  attachments?: Array<{
    id: string;
    sanitized_display_name: string;
    sniffed_mime: string;
    kind: AttachmentKind;
    byte_size: number;
    content_sha256: string;
    extraction_status: AttachmentExtractionStatus;
    extraction_coverage: AttachmentExtractionCoverage;
    // Server-validated metadata the history label depends on (JPEG, whose
    // dimensions are never sniffed, must not read as natively sent).
    sniffed_width?: number | null;
    sniffed_height?: number | null;
    sniffed_pdf_pages?: number | null;
    sniffed_media_duration_ms?: number | null;
    sniffed_media_streams_json?: string | null;
    validated_media_format?: string | null;
    normalized_media_mime?: string | null;
  }>;
}

export interface AgentSnapshot {
  agent_id: string;
  name: string;
  profile_id: string;
  provider: "openai" | "anthropic" | "gemini" | "mock";
  model_id: string;
  role: string | null;
  execution_backend_id: string;
  status: string;
}

export interface InvocationSnapshot {
  invocation_id: string;
  kind: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  execution_backend_id: string;
  failure: { code: string; message: string } | null;
}

export interface StepSnapshot {
  step_id: string;
  agent_id: string;
  stage: "draft" | "review" | "synthesis" | "helper";
  provider: string;
  status: string;
  attempts: number;
  invocations: InvocationSnapshot[];
  output: string | null;
  findings: { agent_id: string; step_id: string; text: string }[];
  failure: { code: string; message: string } | null;
}

export type AttachmentRoute =
  | "native_image"
  | "native_pdf"
  | "native_audio"
  | "native_video"
  | "extracted_text"
  | "attachment_only";

export interface RunAttachmentCoverage {
  agent_id: string;
  profile_id: string;
  provider: string;
  routes: Array<{ attachment_id: string; route: AttachmentRoute; reason: string }>;
  aggregate_note: string;
}

export interface RunSnapshot {
  id: string;
  conversation_id: string;
  user_message_id: string;
  mode: "quick" | "team";
  execution_mode: "mock" | "live";
  status: string;
  presentation: "none" | "quick_unreviewed" | "team_synthesis" | "draft_fallback";
  final_answer: string | null;
  base_planned_calls: number;
  limitations: string[];
  agents: AgentSnapshot[];
  steps: StepSnapshot[];
  synthesizer_agent_id: string | null;
  created_at: string;
  finished_at: string | null;
  last_event_sequence: number;
  catalog_version: string;
  runtime_policy_version: string;
  // Frozen per-agent routing for every attachment (history + current).
  context?: {
    attachments?: Array<{ id: string; sanitized_display_name: string }>;
    attachment_coverage?: RunAttachmentCoverage[];
  };
  usage: {
    harness_invocations: number;
    // Provider-reported sums with sticky-unknown semantics (CT-06): starts
    // at 0, becomes null once any dispatched invocation reports unknown.
    // Render null as "unknown", never zero.
    input_tokens: number | null;
    output_tokens: number | null;
    // Conservative numeric ledger (always a number). Charges full reserve
    // for ambiguous outcomes so the budget bookkeeping is monotonic.
    consumed_output_tokens: number;
    reserved_output_tokens: number;
    token_scope: string;
    accounting: string;
    estimated_cost_usd: number | null;
  };
}

export interface ProviderConfig {
  provider: "openai" | "anthropic" | "gemini" | "mock";
  label: string;
  profiles: {
    profile_id: string;
    model_id: string | null;
    readiness: string;
    label: string;
    provider: string;
    safe_input_tokens: number;
    max_output_tokens: number;
    api_shape: string;
    execution_backend_id: string;
  }[];
}

export interface ProviderList {
  live_enabled: boolean;
  // Booleans only: whether bounded local parsers are installed.
  capabilities?: { pdf_text_extraction: boolean; media_metadata_probe: boolean };
  catalog_version: string;
  items: ProviderConfig[];
}

export interface RuntimePolicySnapshot {
  policy_version: string;
  defaults: RunLimits;
  deployment_ceilings: RunLimits;
  default_tool_modes: { quick: "off" | "auto"; team: "off" | "auto" };
  default_delegation: { quick: boolean; team: boolean };
  live_enabled: boolean;
  implementation_notes: string[];
}

let csrfToken: string | null = null;
let bootPromise: Promise<void> | null = null;

async function boot(): Promise<void> {
  if (csrfToken) return;
  if (!bootPromise) {
    bootPromise = bootWithRetry().catch((err) => {
      bootPromise = null;
      throw err;
    });
  }
  await bootPromise;
}

async function bootWithRetry(): Promise<void> {
  const delays = [250, 500, 1000, 2000];
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await fetch("/api/v1/session", { credentials: "include" });
      if (!res.ok) throw new Error(`session bootstrap failed (${res.status})`);
      const body = (await res.json()) as { csrf_token: string };
      csrfToken = body.csrf_token;
      return;
    } catch (err) {
      lastErr = err as Error;
      if (attempt < delays.length) {
        await delay(delays[attempt]!);
      }
    }
  }
  throw lastErr ?? new Error("session bootstrap failed");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resetAuthForTests(): void {
  csrfToken = null;
  bootPromise = null;
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  await boot();
  const headers = new Headers(init.headers ?? {});
  headers.set("accept", "application/json");
  const method = (init.method ?? "GET").toUpperCase();
  const mutating = method !== "GET" && method !== "HEAD";
  if (mutating && csrfToken) {
    headers.set("x-csrf-token", csrfToken);
  }
  if (
    init.body &&
    !headers.has("content-type") &&
    // FormData bodies MUST get the browser-generated multipart boundary;
    // overwriting with application/json would break the multipart parser.
    !(typeof FormData !== "undefined" && init.body instanceof FormData) &&
    // Blob/File bodies carry their own type; preserve it so download
    // routes see the correct content.
    !(typeof Blob !== "undefined" && init.body instanceof Blob)
  ) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(url, { ...init, headers, credentials: "include" });
  if (response.status === 401) {
    // Session expired or invalidated: drop the cached token so the next call
    // re-bootstraps.
    csrfToken = null;
    bootPromise = null;
  }
  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`invalid JSON from ${url}`);
  }
  if (!response.ok) {
    const envelope = json as { error?: { code: string; message: string } };
    const message = envelope?.error?.message ?? `${method} ${url} failed (${response.status})`;
    const err = new Error(message) as Error & { code?: string; status?: number };
    if (envelope?.error?.code) err.code = envelope.error.code;
    err.status = response.status;
    throw err;
  }
  return json as T;
}

export async function listConversations(): Promise<{ items: Conversation[]; next_cursor: string | null }> {
  return request("/api/v1/conversations");
}

export async function createConversation(title: string): Promise<Conversation> {
  return request("/api/v1/conversations", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
}

export async function deleteConversation(id: string): Promise<void> {
  await request(`/api/v1/conversations/${id}`, { method: "DELETE" });
}

/**
 * Fetch a single conversation by id. Returns `null` on 404 — this is how the
 * UI distinguishes "the stored conversation was deleted" from "the stored
 * conversation is valid but on a later history page the first list did not
 * return". The second case must NOT clear the selection.
 */
export async function getConversation(id: string): Promise<Conversation | null> {
  try {
    return (await request(`/api/v1/conversations/${id}`)) as Conversation;
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

export async function getMessages(id: string): Promise<{ items: Message[] }> {
  return request(`/api/v1/conversations/${id}/messages`);
}

export async function getConversationRuns(
  id: string,
): Promise<{ items: RunSnapshot[]; active_run_id: string | null }> {
  return request(`/api/v1/conversations/${id}/runs`);
}

export async function getProviders(): Promise<ProviderList> {
  return request("/api/v1/providers");
}

export async function getRuntimePolicy(): Promise<RuntimePolicySnapshot> {
  return request("/api/v1/runtime-policy");
}

export interface CreateRunInput {
  conversationId: string;
  prompt: string;
  mode: "quick" | "team";
  executionMode: "mock" | "live";
  agents: { agent_id: string; name: string; profile_id: string; role?: string }[];
  synthesizerAgentId: string | null;
  idempotencyKey: string;
  expectedCatalogVersion: string;
  expectedRuntimePolicyVersion: string;
  // Ordered list of attachment ids the composer confirmed are `ready`.
  // The server re-validates ownership + state and binds them atomically
  // to the user message; the ordered list is also folded into the
  // idempotency digest so the same prompt with a different file set does
  // not collide with a cached submission.
  attachmentIds?: string[];
}

export async function createRun(input: CreateRunInput): Promise<RunSnapshot> {
  return request(`/api/v1/conversations/${input.conversationId}/runs`, {
    method: "POST",
    headers: { "idempotency-key": input.idempotencyKey },
    body: JSON.stringify({
      prompt: input.prompt,
      mode: input.mode,
      execution_mode: input.executionMode,
      agents: input.agents,
      synthesizer_agent_id: input.synthesizerAgentId,
      // Explicit: this v1 does not implement helpers or tools; the server
      // rejects anything else. Pin versions so stale UIs cannot submit
      // against a changed catalog/policy without reload.
      tool_policy: { mode: "off" },
      delegation: { enabled: false },
      expected_catalog_version: input.expectedCatalogVersion,
      expected_runtime_policy_version: input.expectedRuntimePolicyVersion,
      ...(input.attachmentIds && input.attachmentIds.length > 0
        ? { attachment_ids: input.attachmentIds }
        : {}),
    }),
  });
}

export async function cancelRun(runId: string): Promise<RunSnapshot> {
  return request(`/api/v1/runs/${runId}/cancellation`, { method: "PUT" });
}

export async function getRun(runId: string): Promise<RunSnapshot> {
  return request(`/api/v1/runs/${runId}`);
}

export async function exportConversation(id: string): Promise<unknown> {
  return request(`/api/v1/conversations/${id}/export`);
}

export type RunEventPayload = {
  type: string;
  run_id: string;
  sequence: number;
  at: string;
  data: unknown;
};

export interface RunEventSubscription {
  close(): void;
}

/**
 * Subscribe to live run events over SSE. Automatically reconnects with the
 * last-seen sequence id after transient errors, and surfaces terminal events
 * so callers can trigger a snapshot refresh instead of relying on the socket.
 */
export function subscribeRunEvents(
  runId: string,
  onEvent: (event: RunEventPayload) => void,
  onFallback?: () => void,
): RunEventSubscription {
  let source: EventSource | null = null;
  let lastSeen = 0;
  let closed = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const open = (): void => {
    if (closed) return;
    source = new EventSource(`/api/v1/runs/${runId}/events`, { withCredentials: true });

    const handle = (event: MessageEvent): void => {
      try {
        const payload = JSON.parse(event.data) as RunEventPayload;
        if (payload.sequence <= lastSeen) return;
        lastSeen = payload.sequence;
        reconnectAttempt = 0;
        onEvent(payload);
      } catch {
        // Ignore malformed; a snapshot refresh will catch up.
      }
    };

    source.onmessage = handle;
    for (const type of [
      "run.created",
      "run.updated",
      "run.terminal",
      "step.started",
      "step.updated",
      "step.completed",
      "step.failed",
      "stage.started",
      "stage.completed",
    ]) {
      source.addEventListener(type, handle as EventListener);
    }

    source.onerror = () => {
      if (closed) return;
      source?.close();
      source = null;
      // Signal the caller to refresh snapshot while we back off.
      onFallback?.();
      if (reconnectAttempt > 5) {
        // Give up live tail after 5 attempts; snapshot fallback remains.
        closed = true;
        return;
      }
      const backoffMs = Math.min(5_000, 300 * 2 ** reconnectAttempt);
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(open, backoffMs);
    };
  };

  open();

  return {
    close(): void {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.close();
      source = null;
    },
  };
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const hex = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  hex[6] = (hex[6]! & 0x0f) | 0x40;
  hex[8] = (hex[8]! & 0x3f) | 0x80;
  const str = hex.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${str.slice(0, 8)}-${str.slice(8, 12)}-${str.slice(12, 16)}-${str.slice(16, 20)}-${str.slice(20)}`;
}

// --- attachments ---------------------------------------------------------

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

export interface AttachmentExtractionCoverage {
  extracted_chars: number;
  truncated: boolean;
  label: string;
}

export interface AttachmentDto {
  id: string;
  conversation_id: string;
  sanitized_display_name: string;
  sniffed_mime: string;
  kind: AttachmentKind;
  byte_size: number;
  content_sha256: string;
  extraction_status: AttachmentExtractionStatus;
  extraction_coverage: AttachmentExtractionCoverage;
  state: AttachmentState;
  created_at: string;
  bound_at: string | null;
  failure: { code: string; message: string } | null;
  // Persisted sniffed raster dimensions (PNG / GIF / WebP only; JPEG
  // leaves them null because our 32-byte head sniff never reaches
  // the SOF marker). The composer uses these to decide whether an
  // `<img>` preview is safe. The server's `/preview` endpoint
  // enforces the same bound: unknown or oversize dimensions on a
  // raster image return `422 preview_unavailable` with no bytes.
  sniffed_width?: number | null;
  sniffed_height?: number | null;
  // Server-validated metadata. The composer mirrors the server's preview
  // guard with these: no media element is created without a persisted
  // duration + normalized MIME (+ a bounded video stream for video).
  sniffed_pdf_pages?: number | null;
  sniffed_media_duration_ms?: number | null;
  sniffed_media_streams_json?: string | null;
  validated_media_format?: string | null;
  normalized_media_mime?: string | null;
}

export interface AttachmentPolicy {
  max_files_per_turn: number;
  max_file_bytes: number;
  max_composer_bytes: number;
  max_store_bytes: number;
  max_native_image_bytes: number;
  max_native_aggregate_bytes: number;
  max_gemini_inline_media_bytes: number;
  max_extracted_chars: number;
  max_preview_image_dim: number;
}

export async function getAttachmentPolicy(): Promise<{ policy: AttachmentPolicy }> {
  return request("/api/v1/attachments/policy");
}

export async function listAttachments(
  conversationId: string,
): Promise<{ items: AttachmentDto[] }> {
  return request(`/api/v1/conversations/${conversationId}/attachments`);
}

export async function deleteAttachment(id: string): Promise<void> {
  await request(`/api/v1/attachments/${id}`, { method: "DELETE" });
}

/**
 * Upload one file with real progress and cancel support via XMLHttpRequest.
 * fetch() in current browsers does not surface upload-progress events.
 */
export function uploadAttachment(
  conversationId: string,
  file: File,
  handlers: {
    onProgress?: (loaded: number, total: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<AttachmentDto> {
  return new Promise<AttachmentDto>((resolve, reject) => {
    // Short-circuit an already-aborted signal BEFORE touching XHR or boot.
    if (handlers.signal?.aborted) {
      reject(new Error("upload canceled"));
      return;
    }

    const form = new FormData();
    form.append("file", file, file.name);
    const xhr = new XMLHttpRequest();

    // Keep every listener/handler we add on the XHR + signal so we can
    // detach them in one place. XHR duplicates no header values if the
    // same `setRequestHeader` is called twice, but we historically did
    // call it twice (pre-boot + post-boot) which XHR concatenates into
    // "token,token" — some proxies and our safeEqual check see that as a
    // mismatch and 403. The fix: set the CSRF header EXACTLY ONCE, after
    // boot resolves, before send().
    const onProgress = (ev: ProgressEvent): void => {
      if (ev.lengthComputable && handlers.onProgress) {
        handlers.onProgress(ev.loaded, ev.total);
      }
    };
    const onLoad = (): void => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const body = JSON.parse(xhr.responseText) as { attachment: AttachmentDto };
          resolve(body.attachment);
        } catch {
          reject(new Error("invalid JSON from upload"));
        }
      } else {
        // Mirror the generic `request()` 401 handling: invalidate the
        // cached boot/session so the next upload (or any mutation) will
        // re-bootstrap from scratch instead of reusing a dead token. We
        // do NOT auto-resubmit the upload: a POST that reached the server
        // may have had side effects, and even if it did not, the user
        // is better served by a visible retry button than a silent
        // double-send.
        if (xhr.status === 401) {
          csrfToken = null;
          bootPromise = null;
        }
        let message = `upload failed (${xhr.status})`;
        let code = "upload_failed";
        try {
          const envelope = JSON.parse(xhr.responseText) as {
            error?: { code: string; message: string };
          };
          if (envelope?.error?.message) message = envelope.error.message;
          if (envelope?.error?.code) code = envelope.error.code;
        } catch {
          // keep default message
        }
        const err = new Error(message) as Error & { code?: string; status?: number };
        err.code = code;
        err.status = xhr.status;
        reject(err);
      }
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("network error"));
    };
    const onAbort = (): void => {
      cleanup();
      reject(new Error("upload canceled"));
    };
    // True once xhr.open() has run. Before that (session bootstrap still in
    // flight, possibly retrying for seconds) there is no request to abort, so
    // cancel must settle the promise immediately instead of waiting for boot.
    let opened = false;
    const onSignalAbort = (): void => {
      if (!opened) {
        cleanup();
        reject(new Error("upload canceled"));
        return;
      }
      try {
        xhr.abort();
      } catch {
        // ignore
      }
    };
    const cleanup = (): void => {
      xhr.upload.removeEventListener("progress", onProgress);
      xhr.removeEventListener("load", onLoad);
      xhr.removeEventListener("error", onError);
      xhr.removeEventListener("abort", onAbort);
      handlers.signal?.removeEventListener("abort", onSignalAbort);
    };

    xhr.upload.addEventListener("progress", onProgress);
    xhr.addEventListener("load", onLoad);
    xhr.addEventListener("error", onError);
    xhr.addEventListener("abort", onAbort);
    handlers.signal?.addEventListener("abort", onSignalAbort, { once: true });

    boot()
      .then(() => {
        // Signal may have fired while awaiting boot.
        if (handlers.signal?.aborted) {
          cleanup();
          reject(new Error("upload canceled"));
          return;
        }
        if (!csrfToken) {
          cleanup();
          reject(new Error("session not ready; csrf token missing"));
          return;
        }
        opened = true;
        xhr.open("POST", `/api/v1/conversations/${conversationId}/attachments`, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader("accept", "application/json");
        xhr.setRequestHeader("x-csrf-token", csrfToken);
        // Deliberately do NOT log the token or echo it anywhere.
        xhr.send(form);
      })
      .catch((err: Error) => {
        cleanup();
        reject(new Error(`session bootstrap failed: ${err.message}`));
      });
  });
}

/**
 * Preview URL for a ready attachment. Returns a same-origin authenticated
 * URL that the server serves inline with sandbox CSP + nosniff + no-store.
 */
export function attachmentPreviewUrl(id: string): string {
  return `/api/v1/attachments/${id}/preview`;
}

export function attachmentDownloadUrl(id: string): string {
  return `/api/v1/attachments/${id}/download`;
}

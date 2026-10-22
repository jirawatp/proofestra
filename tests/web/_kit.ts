// Shared fixtures + fake-API wiring for the React App component tests.
// The App is exercised against a mocked `src/web/api.ts` module (an
// intercepted-wire seam): no network, no server, no live provider.

import { vi, type Mock } from "vitest";
import type {
  AttachmentDto,
  AttachmentPolicy,
  Conversation,
  Message,
  ProviderList,
  RunSnapshot,
  RuntimePolicySnapshot,
} from "../../src/web/api.js";

// Structural view of a vitest mock; the hoisted per-file `vi.fn()` objects
// satisfy it regardless of vitest's generic Mock signature.
export interface MockLike {
  mockReset(): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockImplementation(fn: (...args: any[]) => unknown): unknown;
}
export type ApiMocks = Record<string, MockLike>;

export function hoistedApiNames(): string[] {
  return [
    "attachmentDownloadUrl",
    "attachmentPreviewUrl",
    "newIdempotencyKey",
    "cancelRun",
    "createConversation",
    "createRun",
    "deleteAttachment",
    "deleteConversation",
    "exportConversation",
    "getAttachmentPolicy",
    "getConversation",
    "getConversationRuns",
    "getMessages",
    "getProviders",
    "getRun",
    "getRuntimePolicy",
    "listAttachments",
    "listConversations",
    "subscribeRunEvents",
    "uploadAttachment",
  ];
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const CONV_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const CONV_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const CONV_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

export function conv(id: string, title: string): Conversation {
  return { id, title, created_at: "2026-10-21T10:00:00.000Z", updated_at: "2026-10-21T10:00:00.000Z" };
}

export function providers(liveEnabled = false): ProviderList {
  return {
    live_enabled: liveEnabled,
    catalog_version: "cat-v1",
    items: [
      {
        provider: "mock",
        label: "Mock",
        profiles: [
          {
            profile_id: "mock-balanced",
            model_id: "mock-model",
            readiness: "ready",
            label: "Balanced",
            provider: "mock",
            safe_input_tokens: 1000,
            max_output_tokens: 500,
            api_shape: "mock",
            execution_backend_id: "mock-backend",
          },
          {
            profile_id: "mock-fast",
            model_id: null,
            readiness: "needs_key",
            label: "Fast",
            provider: "mock",
            safe_input_tokens: 1000,
            max_output_tokens: 500,
            api_shape: "mock",
            execution_backend_id: "mock-backend",
          },
        ],
      },
    ],
  };
}

export function runtimePolicy(): RuntimePolicySnapshot {
  const limits = {
    max_harness_invocations: 20,
    max_tool_operations: 0,
    max_native_jobs: 0,
    concurrency: 4,
    per_provider_concurrency: 2,
    overall_timeout_seconds: 120,
    per_call_timeout_seconds: 30,
    max_native_job_seconds: 0,
    max_output_tokens_per_call: 1000,
    total_output_tokens: 8000,
    max_retries_per_step: 0,
    max_root_agents: 6,
    max_total_agents: 6,
    max_spawned_agents: 0,
    max_children_per_agent: 0,
    max_depth: 0,
  };
  return {
    policy_version: "pol-v1",
    defaults: limits,
    deployment_ceilings: limits,
    default_tool_modes: { quick: "off", team: "off" },
    default_delegation: { quick: false, team: false },
    live_enabled: false,
    implementation_notes: ["Tools are not implemented in v1."],
  };
}

export function attachmentPolicy(overrides: Partial<AttachmentPolicy> = {}): AttachmentPolicy {
  return {
    max_files_per_turn: 8,
    max_file_bytes: 25 * 1024 * 1024,
    max_composer_bytes: 100 * 1024 * 1024,
    max_store_bytes: 1024 * 1024 * 1024,
    max_native_image_bytes: 1024 * 1024,
    max_native_aggregate_bytes: 4 * 1024 * 1024,
    max_gemini_inline_media_bytes: 1024 * 1024,
    max_extracted_chars: 100_000,
    max_preview_image_dim: 4096,
    ...overrides,
  };
}

export function attachment(overrides: Partial<AttachmentDto> & { id: string }): AttachmentDto {
  return {
    conversation_id: CONV_A,
    sanitized_display_name: `${overrides.id}.txt`,
    sniffed_mime: "text/plain",
    kind: "text",
    byte_size: 12,
    content_sha256: `sha-${overrides.id}`,
    extraction_status: "text_extracted",
    extraction_coverage: { extracted_chars: 12, truncated: false, label: "Full text" },
    state: "ready",
    created_at: "2026-10-21T10:00:00.000Z",
    bound_at: null,
    failure: null,
    ...overrides,
  };
}

export function run(overrides: Partial<RunSnapshot> & { id: string; conversation_id: string }): RunSnapshot {
  return {
    user_message_id: "um-1",
    mode: "team",
    execution_mode: "mock",
    status: "running",
    presentation: "none",
    final_answer: null,
    base_planned_calls: 7,
    limitations: [],
    agents: [
      {
        agent_id: "ag-1",
        name: "Writer",
        profile_id: "mock-balanced",
        provider: "mock",
        model_id: "mock-model",
        role: null,
        execution_backend_id: "mock-backend",
        status: "running",
      },
    ],
    steps: [
      {
        step_id: "st-1",
        agent_id: "ag-1",
        stage: "draft",
        provider: "mock",
        status: "running",
        attempts: 1,
        invocations: [],
        output: null,
        findings: [],
        failure: null,
      },
    ],
    synthesizer_agent_id: "ag-1",
    created_at: "2026-10-21T10:00:00.000Z",
    finished_at: null,
    last_event_sequence: 1,
    catalog_version: "cat-v1",
    runtime_policy_version: "pol-v1",
    usage: {
      harness_invocations: 1,
      input_tokens: null,
      output_tokens: 12,
      consumed_output_tokens: 12,
      reserved_output_tokens: 0,
      token_scope: "run",
      accounting: "native",
      estimated_cost_usd: null,
    },
    ...overrides,
  };
}

export function message(
  overrides: Partial<Message> & { id: string; conversation_id: string; role: "user" | "assistant" },
): Message {
  return {
    run_id: "run-1",
    text: "hello",
    sequence: 1,
    created_at: "2026-10-21T10:00:00.000Z",
    ...overrides,
  };
}

export interface Sub {
  runId: string;
  onEvent: () => void;
  onFallback: (() => void) | undefined;
  close: Mock;
}

export interface World {
  convs: Conversation[];
  messagesByConv: Record<string, Message[]>;
  runsByConv: Record<string, { items: RunSnapshot[]; active_run_id: string | null }>;
  attachmentsByConv: Record<string, AttachmentDto[]>;
  runById: Record<string, RunSnapshot>;
  subs: Sub[];
  live: boolean;
  attachmentPolicy: AttachmentPolicy;
}

export function newWorld(): World {
  return {
    convs: [],
    messagesByConv: {},
    runsByConv: {},
    attachmentsByConv: {},
    runById: {},
    subs: [],
    live: false,
    attachmentPolicy: attachmentPolicy(),
  };
}

let uuidCounter = 0;

/** Wire sensible default behavior onto every API mock, backed by `world`. */
export function wireApi(api: ApiMocks, world: World): void {
  for (const fn of Object.values(api)) fn.mockReset();
  uuidCounter = 0;
  const nextUuid = (): string => {
    uuidCounter += 1;
    return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
  };
  api.newIdempotencyKey!.mockImplementation(nextUuid);
  api.attachmentPreviewUrl!.mockImplementation((id: string) => `/api/v1/attachments/${id}/preview`);
  api.attachmentDownloadUrl!.mockImplementation((id: string) => `/api/v1/attachments/${id}/download`);
  api.getProviders!.mockImplementation(async () => providers(world.live));
  api.getRuntimePolicy!.mockImplementation(async () => runtimePolicy());
  api.getAttachmentPolicy!.mockImplementation(async () => ({ policy: world.attachmentPolicy }));
  api.listConversations!.mockImplementation(async () => ({ items: [...world.convs], next_cursor: null }));
  api.getConversation!.mockImplementation(async (id: string) => world.convs.find((c) => c.id === id) ?? null);
  api.getMessages!.mockImplementation(async (id: string) => ({ items: world.messagesByConv[id] ?? [] }));
  api.getConversationRuns!.mockImplementation(async (id: string) => world.runsByConv[id] ?? { items: [], active_run_id: null });
  api.getRun!.mockImplementation(async (id: string) => {
    const r = world.runById[id];
    if (!r) throw new Error(`run ${id} not found`);
    return r;
  });
  api.listAttachments!.mockImplementation(async (id: string) => ({ items: [...(world.attachmentsByConv[id] ?? [])] }));
  api.deleteAttachment!.mockImplementation(async () => undefined);
  api.deleteConversation!.mockImplementation(async () => undefined);
  api.exportConversation!.mockImplementation(async (id: string) => ({ conversation_id: id }));
  api.createConversation!.mockImplementation(async (title: string) => {
    const c = conv(nextUuid(), title);
    world.convs = [c, ...world.convs];
    return c;
  });
  api.subscribeRunEvents!.mockImplementation(
    (runId: string, onEvent: () => void, onFallback?: () => void) => {
      const sub: Sub = { runId, onEvent, onFallback, close: vi.fn() };
      world.subs.push(sub);
      return { close: sub.close };
    },
  );
}

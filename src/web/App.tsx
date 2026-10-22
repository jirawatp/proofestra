import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  attachmentDownloadUrl,
  attachmentPreviewUrl,
  cancelRun,
  createConversation,
  createRun,
  deleteAttachment,
  deleteConversation,
  exportConversation,
  getAttachmentPolicy,
  getConversation,
  getConversationRuns,
  getMessages,
  getProviders,
  getRun,
  getRuntimePolicy,
  listAttachments,
  listConversations,
  newIdempotencyKey,
  subscribeRunEvents,
  uploadAttachment,
  type AttachmentDto,
  type AttachmentPolicy,
  type Conversation,
  type Message,
  type ProviderList,
  type RunSnapshot,
  type RuntimePolicySnapshot,
  type StepSnapshot,
} from "./api.js";
import {
  agentRouteRows,
  attachmentCoverageLabel,
  composerUploadLabel,
  isMediaPreviewValidatedClient,
  splitCancelledUploads,
} from "./attachmentUi.js";
import { Markdown } from "./components/Markdown.js";
import {
  readComposerOrder,
  writeComposerOrder,
  orderServerListByLocal,
  settleUploadSuccess,
  shouldPersistComposerOrder,
} from "./composerOrder.js";

interface AgentForm {
  id: string;
  name: string;
  profileId: string;
  enabled: boolean;
}

const INITIAL_TEAM: AgentForm[] = [
  { id: makeAgentId(), name: "OpenAI Writer", profileId: "openai-default", enabled: true },
  { id: makeAgentId(), name: "Anthropic Reviewer", profileId: "anthropic-default", enabled: true },
  { id: makeAgentId(), name: "Gemini Challenger", profileId: "gemini-default", enabled: true },
];

const DISCLOSURE_LIVE =
  "Live: the selected providers each receive the frozen visible history and the new prompt. In Team mode each root agent drafts independently (no peer visibility), then every successful root reviews the other successful drafts, and the chosen synthesizer composes the final answer. Nothing is sent until you press Send.";
const DISCLOSURE_MOCK =
  "Mock mode: no provider calls are made. Output is deterministic. Review completed never means correctness is guaranteed.";
const EXPORT_NOTICE =
  "Export is a plain JSON snapshot of this conversation. It never includes credentials, session cookies, or server-side keys. Prior visible history and provider identities are included.";

// localStorage key for the last selected conversation id. We only persist the
// opaque id — never the title, prompt, run id, or any provider identity. The
// server remains the source of truth; if the stored id is missing from
// /conversations on reload (deleted, DB reset, different account) we clear it
// and fall through to the normal "no selection" state.
const SELECTED_CONVERSATION_STORAGE_KEY = "proofestra:selected-conversation-id:v1";
// Composer-order helpers live in a sibling module so the pure logic
// (localStorage reads/writes, order merging, the hydration-aware
// write gate) can be unit-tested without a DOM harness.
// See `src/web/composerOrder.ts` for the full documentation.

function readSelectedConversationId(): string | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const raw = window.localStorage.getItem(SELECTED_CONVERSATION_STORAGE_KEY);
    if (!raw) return null;
    // UUID shape only; anything else is treated as absent.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
      window.localStorage.removeItem(SELECTED_CONVERSATION_STORAGE_KEY);
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

function writeSelectedConversationId(id: string | null): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    if (id) window.localStorage.setItem(SELECTED_CONVERSATION_STORAGE_KEY, id);
    else window.localStorage.removeItem(SELECTED_CONVERSATION_STORAGE_KEY);
  } catch {
    // Private browsing / quota exceeded / disabled storage — degrade silently
    // so the UI still works without persistence.
  }
}

function makeAgentId(): string {
  return newIdempotencyKey();
}

type Mode = "quick" | "team";
type ExecutionMode = "mock" | "live";

interface PendingSubmit {
  idempotencyKey: string;
  conversationId: string;
  payloadDigest: string;
}

/**
 * Full-payload digest. The pending submit is reused ONLY when every
 * admission-relevant field matches: prompt, mode, execution mode, the
 * ordered agent list (id + profile), the synthesizer, AND the ordered
 * ready-attachment refs (id + content hash). Any of these differing
 * means it is a NEW submission and must mint a fresh idempotency key.
 */
function fullPayloadDigest(input: {
  prompt: string;
  mode: Mode;
  executionMode: ExecutionMode;
  agents: AgentForm[];
  synthesizerId: string | null;
  attachments: ComposerAttachment[];
}): string {
  // Include the display `name` because the server payload binds it on
  // the agent snapshot and the UI shows it in the step list. Changing an
  // agent's name without changing its id/profile would otherwise collapse
  // onto an earlier pending key and the server would never see the new
  // name. The attachment digest uses content_sha256 so two files with the
  // same bytes but different ids still deduplicate correctly.
  const agents = input.agents
    .map((a) => `${a.id}:${a.name}:${a.profileId}`)
    .join(",");
  const attachments = input.attachments
    .filter((a) => a.state === "ready" && a.serverDto)
    .map((a) => `${a.serverId}:${a.serverDto!.content_sha256}`)
    .join(",");
  return [
    input.prompt,
    input.mode,
    input.executionMode,
    agents,
    input.synthesizerId ?? "",
    attachments,
  ].join("|");
}

/**
 * Rows the server kept after a cancelled upload (`client_closed_request`) are
 * hidden from the composer and deleted best-effort, so a cancel never returns
 * after a chat switch or reload as a "Failed" row that blocks Send.
 */
function dropCancelledUploads(items: AttachmentDto[]): AttachmentDto[] {
  const { visible, cancelled } = splitCancelledUploads(items);
  for (const dto of cancelled) void deleteAttachment(dto.id).catch(() => undefined);
  return visible;
}

/**
 * Merge the server's authoritative draft-attachment list for a
 * conversation with the composer's in-memory state. In-flight rows
 * (uploading in THIS tab, identifiable by a non-null `controller` or a
 * non-null `fileHandle`) preserve their `localId`, `fileHandle`,
 * `controller`, and `progress` so cancel/remove continue to work; only
 * the server-side DTO snapshot refreshes. Rows the server knows about
 * but the composer does not are appended with `localId = serverId` and
 * `fileHandle = null` (reloaded draft; retry requires re-select). Rows
 * the composer has but the server does not (e.g. a draft just deleted
 * on another tab) are dropped unless they are still in-flight in THIS
 * tab — a race between a local upload's response and the list fetch
 * must never silently drop the local row.
 */
function mergeComposerWithServer(
  prev: ComposerAttachment[],
  serverItems: AttachmentDto[],
  conversationId: string,
): ComposerAttachment[] {
  const serverById = new Map<string, AttachmentDto>();
  for (const dto of serverItems) serverById.set(dto.id, dto);
  const merged: ComposerAttachment[] = [];
  const seenServerIds = new Set<string>();
  for (const existing of prev) {
    if (existing.conversationId !== conversationId) continue;
    const dto = existing.serverId ? serverById.get(existing.serverId) : undefined;
    if (dto) {
      seenServerIds.add(dto.id);
      merged.push({
        ...existing,
        displayName: dto.sanitized_display_name,
        state:
          dto.state === "ready" ? "ready" : dto.state === "failed" ? "failed" : "uploading",
        progress: dto.state === "ready" ? 1 : existing.progress,
        serverDto: dto,
        error: dto.failure?.message ?? existing.error,
      });
    } else if (existing.controller || existing.fileHandle) {
      // Still in-flight in this tab; keep it.
      merged.push(existing);
    }
  }
  for (const dto of serverItems) {
    if (seenServerIds.has(dto.id)) continue;
    merged.push({
      localId: dto.id,
      conversationId,
      displayName: dto.sanitized_display_name,
      // Reloaded draft; the browser dropped the original File bytes at
      // the previous page unload, so retry requires re-select.
      fileHandle: null,
      state: dto.state === "ready" ? "ready" : dto.state === "failed" ? "failed" : "uploading",
      progress: dto.state === "ready" ? 1 : 0,
      serverId: dto.id,
      serverDto: dto,
      controller: null,
      error: dto.failure?.message ?? null,
    });
  }
  return merged;
}

/**
 * Local-only composer entry for an attachment the user is uploading or
 * has uploaded. `serverId` is set once the server-side `attachments` row
 * is `ready`. Pre-ready and failed entries are retained so the user can
 * retry or remove them, but they cannot be sent as inputs — see
 * `canSend` and `attachment_ids` plumbing in the `send` handler.
 *
 * `fileHandle` is nullable: it is `null` for drafts rehydrated from the
 * server after a reload (we never persist File objects across sessions),
 * which means those drafts can be removed but not retried in-place — a
 * failed reloaded draft requires the user to re-select the file.
 */
interface ComposerAttachment {
  localId: string;
  conversationId: string;
  displayName: string;
  fileHandle: File | null;
  state: "uploading" | "ready" | "failed";
  progress: number; // 0..1
  serverId: string | null;
  serverDto: AttachmentDto | null;
  controller: AbortController | null;
  error: string | null;
}

/**
 * Pre-send composer preview. We only render inline media the server has
 * agreed to serve as `inline` on the preview route (see
 * `isSafePreviewMime` in `src/server/routes/attachments.ts`): PNG / JPEG /
 * WebP / GIF images, selected audio and video formats, and `text/*` files.
 * Everything else (PDF, docx, zip, binary) falls back to a plain
 * "Download only" badge; the `<a>` in the actions row already provides
 * the download link. The media elements are same-origin and carry the
 * session cookie automatically; we never fetch bytes into JavaScript for
 * these previews — the browser streams them through its native `<img>`
 * / `<audio>` / `<video>` pipelines so no raw payload crosses the JS
 * boundary. For `text/*` we fetch at most 8 KiB and render as plain
 * text inside a sandboxed `<pre>`; HTML / SVG / XML / office content is
 * NEVER rendered as active content.
 */
// Client-side mirror of `isImagePreviewDimensionsSafe` in
// `src/core/attachments.ts`. The server is the authoritative guard —
// an image row whose persisted sniffed dimensions are unknown, invalid,
// or exceed caps will be served as `application/octet-stream` +
// `Content-Disposition: attachment` even if the preview URL is hit.
// This client-side check keeps the UI tidy: it skips the `<img>` tag
// entirely for those rows so no broken-raster icon appears and the
// user sees the explicit download-only fallback instead. The caps
// MUST stay in sync with the server (`max_native_image_side_px`,
// `max_native_image_pixels` in `ATTACHMENT_POLICY`).
const MAX_PREVIEW_IMAGE_SIDE_PX = 4096;
const MAX_PREVIEW_IMAGE_PIXELS = 16_000_000;

function isPreviewImageDimensionsSafeClient(
  width: number | null | undefined,
  height: number | null | undefined,
): boolean {
  if (width == null || height == null) return false;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return false;
  if (width <= 0 || height <= 0) return false;
  if (width > MAX_PREVIEW_IMAGE_SIDE_PX || height > MAX_PREVIEW_IMAGE_SIDE_PX) return false;
  if (width * height > MAX_PREVIEW_IMAGE_PIXELS) return false;
  return true;
}

function ComposerAttachmentPreview(props: {
  id: string;
  dto: AttachmentDto;
}): JSX.Element | null {
  const { id, dto } = props;
  const mime = dto.sniffed_mime;
  const kind = dto.kind;
  const url = attachmentPreviewUrl(id);
  // Images: let the browser stream the bytes; no JS allocation.
  // Dimension-safety: if persisted sniffed dimensions are unknown
  // (e.g. JPEG — our 32-byte sniff never reads the SOF marker) or
  // exceed the safe caps (e.g. a 69-byte PNG declaring 100000×100000),
  // we skip inline rendering entirely. The authenticated download
  // link in the actions row remains available.
  if (
    kind === "image" &&
    (mime === "image/png" || mime === "image/jpeg" || mime === "image/webp" || mime === "image/gif")
  ) {
    if (!isPreviewImageDimensionsSafeClient(dto.sniffed_width, dto.sniffed_height)) {
      return (
        <p className="composer-attachment-preview composer-attachment-preview-fallback">
          No inline preview — image dimensions unavailable or exceed safe
          bounds. Use Download to open this file.
        </p>
      );
    }
    return (
      <div className="composer-attachment-preview composer-attachment-preview-image">
        <img
          src={url}
          alt={dto.sanitized_display_name}
          loading="lazy"
          decoding="async"
        />
      </div>
    );
  }
  if ((kind === "audio" || kind === "video") && !isMediaPreviewValidatedClient(dto)) {
    // Same condition the server enforces: unvalidated or hostile media is
    // never handed to the browser's decoder; download-only.
    return (
      <p className="composer-attachment-preview composer-attachment-preview-fallback">
        No inline preview — this media was not validated. Use Download to open this file.
      </p>
    );
  }
  if (kind === "audio") {
    return (
      <div className="composer-attachment-preview composer-attachment-preview-audio">
        <audio controls preload="none" src={url} />
      </div>
    );
  }
  if (kind === "video") {
    return (
      <div className="composer-attachment-preview composer-attachment-preview-video">
        <video controls preload="metadata" src={url} />
      </div>
    );
  }
  if (kind === "text" && mime.startsWith("text/")) {
    return <ComposerTextPreview url={url} />;
  }
  // PDF / docx / zip / binary: no inline render; the Download action in
  // the actions row remains the only way to open bytes. A tiny label
  // makes the fallback explicit so the user understands why no preview
  // appears above.
  return (
    <p className="composer-attachment-preview composer-attachment-preview-fallback">
      No inline preview for {mime}. Use Download to open this file.
    </p>
  );
}

/**
 * Bounded `text/*` preview. Fetches at most 8 KiB of the preview URL,
 * renders inside a plain `<pre>` so no HTML / SVG / XML / office content
 * can run as active content. The fetch runs same-origin with cookies and
 * carries the CSRF token; the preview route's own CSP already blocks
 * script execution if the server bytes were somehow mislabeled.
 */
function ComposerTextPreview(props: { url: string }): JSX.Element {
  const [text, setText] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const resp = await fetch(props.url, { credentials: "include" });
        if (!resp.ok) throw new Error(`preview ${resp.status}`);
        const reader = resp.body?.getReader();
        if (!reader) {
          const t = await resp.text();
          if (!cancelled) setText(t.slice(0, 8 * 1024));
          return;
        }
        const chunks: Uint8Array[] = [];
        let read = 0;
        while (read < 8 * 1024) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          read += value.byteLength;
        }
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        const merged = new Uint8Array(read);
        let o = 0;
        for (const c of chunks) {
          merged.set(c.subarray(0, Math.min(c.byteLength, 8 * 1024 - o)), o);
          o += c.byteLength;
          if (o >= 8 * 1024) break;
        }
        const decoded = new TextDecoder("utf-8", { fatal: false }).decode(
          merged.subarray(0, Math.min(o, 8 * 1024)),
        );
        if (!cancelled) setText(decoded);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.url]);
  if (error) {
    return (
      <p className="composer-attachment-preview composer-attachment-preview-fallback">
        Preview unavailable.
      </p>
    );
  }
  return (
    <pre className="composer-attachment-preview composer-attachment-preview-text">
      {text}
    </pre>
  );
}

export function App(): JSX.Element {
  const [providers, setProviders] = useState<ProviderList | null>(null);
  const [policy, setPolicy] = useState<RuntimePolicySnapshot | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  // Lazy init: read the stored conversation id synchronously from
  // localStorage on first render. If we used a plain `useState(null)` here,
  // the persistence effect below would run on the first render with
  // activeId=null and overwrite the stored value BEFORE the async boot
  // effect read it, which stops conversation selection from surviving a
  // page reload (observed in Chrome). The hydration gate on the
  // persistence effect is a belt-and-braces guard for the same race.
  const [activeId, setActiveId] = useState<string | null>(() => readSelectedConversationId());
  const [hydrated, setHydrated] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [runs, setRuns] = useState<RunSnapshot[]>([]);
  const [activeRun, setActiveRun] = useState<RunSnapshot | null>(null);
  const [mode, setMode] = useState<Mode>("team");
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("mock");
  const [agents, setAgents] = useState<AgentForm[]>(INITIAL_TEAM);
  const [synthesizerAgentId, setSynthesizerAgentId] = useState<string>(INITIAL_TEAM[0]!.id);
  const [prompt, setPrompt] = useState<string>("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  // Composer attachments live per-conversation. Switching chats shows a
  // fresh composer; the previous chat's drafts stay on the server (and
  // we rehydrate them on return from the authoritative GET /attachments).
  const [composerAttachments, setComposerAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentPolicy, setAttachmentPolicy] = useState<AttachmentPolicy | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  // Guards against stale async responses populating the wrong conversation
  // (eg. user switches chats while a prior load is still in flight).
  const activeIdRef = useRef<string | null>(null);
  // Set to the conversation id whose composer rehydration has completed.
  // The order-write effect refuses to persist while this is `null` or
  // not equal to `activeId`, which prevents the initial empty composer
  // from clobbering a previously-saved opaque-ready-id order.
  const composerHydratedForRef = useRef<string | null>(null);
  // Preserves the idempotency key across network-retried sends so a failed
  // request does not create a duplicate run when retried.
  const pendingSubmitRef = useRef<PendingSubmit | null>(null);
  // The current SSE subscription; closed when the active run or chat changes.
  const subscriptionRef = useRef<{ close(): void } | null>(null);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  // Initial load: providers, policy, conversations. The stored conversation
  // id (if any) has already been hydrated into `activeId` via the lazy
  // useState initialiser so the per-conversation load effect below can start
  // fetching messages while this boot resolves in parallel. The validation
  // policy is deliberate: `listConversations()` only returns the first page
  // of the sidebar, so a valid older conversation sitting on page 2+ would
  // be WRONGLY treated as deleted if we judged absence from the first page
  // as deletion. Instead we call `getConversation(id)` which returns `null`
  // ONLY on a server 404. On success we also splice the row into
  // `conversations` so the sidebar can render the selected chat even
  // though pagination has not reached it yet.
  useEffect(() => {
    void (async () => {
      try {
        const [p, pol, list] = await Promise.all([
          getProviders(),
          getRuntimePolicy(),
          listConversations(),
        ]);
        setProviders(p);
        setPolicy(pol);
        setConversations(list.items);
        const current = activeIdRef.current;
        if (current && !list.items.some((c) => c.id === current)) {
          try {
            const stored = await getConversation(current);
            if (stored === null) {
              // Confirmed server-side deletion.
              setActiveId(null);
            } else {
              setConversations((prev) =>
                prev.some((c) => c.id === stored.id) ? prev : [stored, ...prev],
              );
            }
          } catch {
            // Transient failure: leave the selection alone; per-conversation
            // loads will retry.
          }
        }
      } catch (err) {
        setBootError((err as Error).message);
      } finally {
        setHydrated(true);
      }
    })();
    // Deliberately runs once at mount; activeIdRef is a ref and does not
    // belong in the dependency list.
  }, []);

  // Persist selection changes AFTER hydration. The hydration gate stops the
  // first-render null from clobbering the stored id before the lazy
  // initialiser has read it (Chrome reload regression). Writes still fire
  // for programmatic clears (e.g. after delete) because those happen after
  // hydration.
  useEffect(() => {
    if (!hydrated) return;
    writeSelectedConversationId(activeId);
  }, [activeId, hydrated]);

  const closeSubscription = useCallback(() => {
    subscriptionRef.current?.close();
    subscriptionRef.current = null;
  }, []);

  const refreshActiveRun = useCallback(
    async (runId: string, conversationId: string) => {
      try {
        const snap = await getRun(runId);
        // Guard: if the user switched chats, drop this response.
        if (activeIdRef.current !== conversationId) return;
        setActiveRun((prev) =>
          prev && prev.id === runId && prev.last_event_sequence >= snap.last_event_sequence
            ? prev
            : snap,
        );
        if (isTerminal(snap.status)) {
          const [msgs, runList] = await Promise.all([
            getMessages(conversationId),
            getConversationRuns(conversationId),
          ]);
          if (activeIdRef.current !== conversationId) return;
          setMessages(msgs.items);
          setRuns(runList.items);
        }
      } catch {
        // Transient network error; next event or user action will try again.
      }
    },
    [],
  );

  const subscribeTo = useCallback(
    (runId: string, conversationId: string) => {
      closeSubscription();
      subscriptionRef.current = subscribeRunEvents(
        runId,
        () => {
          void refreshActiveRun(runId, conversationId);
        },
        () => {
          // Fallback: live tail dropped out, pull the authoritative snapshot.
          void refreshActiveRun(runId, conversationId);
        },
      );
    },
    [closeSubscription, refreshActiveRun],
  );

  // Load messages + runs when the active conversation changes. Guards against
  // responses arriving after the user switched conversations.
  useEffect(() => {
    closeSubscription();
    setActiveRun(null);
    setRuns([]);
    if (!activeId) {
      setMessages([]);
      return;
    }
    const targetId = activeId;
    void (async () => {
      try {
        const [msgs, runList] = await Promise.all([
          getMessages(targetId),
          getConversationRuns(targetId),
        ]);
        if (activeIdRef.current !== targetId) return;
        setMessages(msgs.items);
        setRuns(runList.items);
        if (runList.active_run_id) {
          // Recover the active run so Stop and progress are visible after a
          // page reload or chat switch.
          try {
            const run = await getRun(runList.active_run_id);
            if (activeIdRef.current !== targetId) return;
            setActiveRun(run);
            if (!isTerminal(run.status)) {
              subscribeTo(run.id, targetId);
            }
          } catch {
            // Ignore; snapshot refresh will catch up when the user interacts.
          }
        }
      } catch (err) {
        if (activeIdRef.current !== targetId) return;
        // 404 means the conversation disappeared out from under us (deleted
        // on another tab, DB reset, server data-dir change). Clear the
        // selection and persisted id so the UI returns to the empty state.
        const status = (err as { status?: number }).status;
        if (status === 404) {
          setActiveId(null);
          setConversations((prev) => prev.filter((c) => c.id !== targetId));
        } else {
          setError((err as Error).message);
        }
      }
    })();
    return () => {
      closeSubscription();
    };
  }, [activeId, closeSubscription, subscribeTo]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun?.last_event_sequence, activeRun?.status]);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId],
  );

  const availableProfiles = useMemo(() => {
    if (!providers) return [] as {
      profile_id: string;
      label: string;
      provider: string;
      readiness: string;
      model_id: string | null;
      execution_backend_id: string;
    }[];
    return providers.items.flatMap((p) =>
      p.profiles.map((profile) => ({
        profile_id: profile.profile_id,
        label: profile.label,
        provider: p.label,
        readiness: profile.readiness,
        model_id: profile.model_id,
        execution_backend_id: profile.execution_backend_id,
      })),
    );
  }, [providers]);

  const enabledAgents = useMemo(() => agents.filter((a) => a.enabled), [agents]);
  const canSend = mode === "team" ? enabledAgents.length >= 2 : enabledAgents.length === 1;

  const handleModeChange = useCallback((next: Mode) => {
    setMode(next);
    setAgents((prev) => {
      if (next === "quick") {
        // Quick mode: enforce exactly one enabled root.
        const first = prev.find((a) => a.enabled) ?? prev[0];
        if (!first) return prev;
        return prev.map((a) => ({ ...a, enabled: a.id === first.id }));
      }
      // Team mode: enable all configured agents.
      return prev.map((a) => ({ ...a, enabled: true }));
    });
  }, []);

  const newChat = useCallback(async () => {
    try {
      const created = await createConversation("New conversation");
      setConversations((prev) => [created, ...prev]);
      setActiveId(created.id);
      setMessages([]);
      setRuns([]);
      setActiveRun(null);
      promptRef.current?.focus();
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const ensureConversation = useCallback(async (): Promise<string> => {
    if (activeId) return activeId;
    const created = await createConversation("New conversation");
    setConversations((prev) => [created, ...prev]);
    setActiveId(created.id);
    return created.id;
  }, [activeId]);

  const send = useCallback(async () => {
    // Readiness gate: at least a prompt OR a ready attachment, no file
    // still uploading / failed. The server also enforces this (and
    // rejects pending/failed refs with a typed error) but blocking
    // locally gives a snappy UX.
    const snap = composerAttachmentsRef.current;
    const readyAttachments = snap.filter((a) => a.state === "ready" && a.serverId);
    const pendingAttachments = snap.filter((a) => a.state === "uploading");
    const failedAttachments = snap.filter((a) => a.state === "failed");
    const trimmedPrompt = prompt.trim();
    const promptEmpty = trimmedPrompt.length === 0;
    if (!canSend) return;
    if (activeRun && !isTerminal(activeRun.status)) return;
    if (pendingAttachments.length > 0) {
      setError("Wait for all attachments to finish uploading before sending.");
      return;
    }
    if (failedAttachments.length > 0) {
      setError("Remove or retry failed attachments before sending.");
      return;
    }
    if (promptEmpty && readyAttachments.length === 0) return;
    const trimmed = trimmedPrompt;
    const synthesizerId =
      mode === "team"
        ? enabledAgents.some((a) => a.id === synthesizerAgentId)
          ? synthesizerAgentId
          : enabledAgents[0]?.id ?? null
        : null;
    if (mode === "team" && !synthesizerId) {
      setError("Select a synthesizer agent (choose Final answer by…)");
      return;
    }
    if (!providers || !policy) {
      setError("Server metadata unavailable; try reloading");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const conversationId = await ensureConversation();
      // Full-payload idempotency. The pending-submit key is reused ONLY
      // when every admission-relevant field matches — prompt + mode +
      // execution_mode + ordered agents + synthesizer + ordered ready
      // attachment refs. A changed agent list, a different synthesizer,
      // or a different file set are all distinct submissions and MUST
      // mint a fresh idempotency key so the server does not alias them.
      const payloadDigest = fullPayloadDigest({
        prompt: trimmed,
        mode,
        executionMode,
        agents: enabledAgents,
        synthesizerId,
        attachments: composerAttachmentsRef.current,
      });
      let idempotencyKey: string;
      if (
        pendingSubmitRef.current &&
        pendingSubmitRef.current.conversationId === conversationId &&
        pendingSubmitRef.current.payloadDigest === payloadDigest
      ) {
        // Reuse the key: a prior network attempt may have reached the server.
        idempotencyKey = pendingSubmitRef.current.idempotencyKey;
      } else {
        idempotencyKey = newIdempotencyKey();
        pendingSubmitRef.current = {
          idempotencyKey,
          conversationId,
          payloadDigest,
        };
      }
      const attachmentIds = readyAttachments.map((a) => a.serverId!);
      const createInput: Parameters<typeof createRun>[0] = {
        conversationId,
        prompt: trimmed,
        mode,
        executionMode,
        agents: enabledAgents.map((a) => ({
          agent_id: a.id,
          name: a.name,
          profile_id: a.profileId,
        })),
        synthesizerAgentId: synthesizerId,
        idempotencyKey,
        expectedCatalogVersion: providers.catalog_version,
        expectedRuntimePolicyVersion: policy.policy_version,
      };
      if (attachmentIds.length > 0) createInput.attachmentIds = attachmentIds;
      // Freeze the submitted-refs set so settlement below can prove the
      // composer still has exactly these rows and nothing new. If the user
      // added or removed a draft while the POST was in flight, we leave
      // the extra rows alone (never silently delete them) and we do not
      // clear the prompt — the UI is still composing something new.
      const submittedRefIds = new Set(attachmentIds);
      const originConversationId = conversationId;
      const snapshot = await createRun(createInput);
      pendingSubmitRef.current = null;
      // Scope the activeRun update to the originating conversation. If
      // the user switched chats during the POST, we still mergeRun() so
      // the list of saved runs reflects truth, but we do not override
      // the activeRun of the chat they are now viewing.
      // `runs` and the SSE subscription belong to the VISIBLE conversation;
      // a late response for a chat the user has left must touch neither.
      // The run is recovered from the server (active_run_id) when the user
      // returns to that chat.
      const stillViewing = activeIdRef.current === originConversationId;
      if (stillViewing) {
        setActiveRun(snapshot);
        setRuns((prev) => mergeRun(prev, snapshot));
        setPrompt("");
        // Only drop the composer rows we actually submitted; preserve any
        // rows the user added during the POST. The submitted rows are now
        // `bound` on the server and will render in history. New rows (not
        // in the submitted set) stay in the composer for the next turn.
        setComposerAttachments((prev) => prev.filter((a) => !submittedRefIds.has(a.serverId ?? "")));
      }
      if (!isTerminal(snapshot.status)) {
        if (stillViewing) subscribeTo(snapshot.id, originConversationId);
      } else {
        const msgs = await getMessages(originConversationId);
        if (activeIdRef.current === originConversationId) {
          setMessages(msgs.items);
        }
      }
      const list = await listConversations();
      setConversations(list.items);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }, [
    canSend,
    prompt,
    mode,
    executionMode,
    enabledAgents,
    synthesizerAgentId,
    activeRun,
    providers,
    policy,
    ensureConversation,
    subscribeTo,
  ]);

  const stop = useCallback(async () => {
    if (!activeRun) return;
    const runId = activeRun.id;
    const conversationId = activeRun.conversation_id;
    try {
      const snap = await cancelRun(runId);
      // The user may have switched chats while the cancel was in flight;
      // never write this run into another conversation's view.
      if (activeIdRef.current !== conversationId) return;
      setActiveRun(snap);
      setRuns((prev) => mergeRun(prev, snap));
      const msgs = await getMessages(conversationId);
      if (activeIdRef.current === conversationId) setMessages(msgs.items);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [activeRun]);

  const removeConversation = useCallback(
    async (id: string) => {
      try {
        await deleteConversation(id);
        setConversations((prev) => prev.filter((c) => c.id !== id));
        // Decide against the CURRENT selection, not the one captured when
        // the delete started: switching chats mid-delete must neither kick
        // the user out of the chat they moved to nor leave a deleted chat
        // selected.
        if (activeIdRef.current === id) {
          closeSubscription();
          setActiveId(null);
          setMessages([]);
          setRuns([]);
          setActiveRun(null);
        }
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [closeSubscription],
  );

  const addAgent = useCallback(() => {
    const defaultProfile = availableProfiles[0]?.profile_id ?? "mock-balanced";
    setAgents((prev) => [
      ...prev,
      { id: makeAgentId(), name: `Agent ${prev.length + 1}`, profileId: defaultProfile, enabled: true },
    ]);
  }, [availableProfiles]);

  const updateAgent = useCallback((id: string, patch: Partial<AgentForm>) => {
    setAgents((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }, []);

  const removeAgent = useCallback(
    (id: string) => {
      setAgents((prev) => prev.filter((a) => a.id !== id));
      if (synthesizerAgentId === id) {
        const next = agents.find((a) => a.id !== id);
        setSynthesizerAgentId(next?.id ?? "");
      }
    },
    [agents, synthesizerAgentId],
  );

  // Fetch the current attachment policy once at boot so the composer can
  // show the exact caps and reject over-cap files locally before even
  // starting an upload.
  useEffect(() => {
    void (async () => {
      try {
        const resp = await getAttachmentPolicy();
        setAttachmentPolicy(resp.policy);
      } catch {
        // Non-fatal: the server will still enforce the caps on upload.
      }
    })();
  }, []);

  // Rehydrate the composer with any draft attachments the server already
  // has for this conversation. Switching chats always shows server truth
  // AS A MERGE on top of what the UI already knows about: an upload we
  // started in this tab for this conversation keeps its `localId`,
  // `fileHandle`, `controller`, and `progress` so cancel/remove still
  // work, and a bounded poll resolves any rows the server still shows
  // as `uploading` after we switch away and back. Guarded against chat
  // switches so a slow response for conversation A cannot overwrite the
  // composer after the user moves to conversation B.
  useEffect(() => {
    if (!activeId) {
      composerHydratedForRef.current = null;
      setComposerAttachments([]);
      return;
    }
    const target = activeId;
    // Mark this conversation as NOT YET hydrated. The order-write
    // effect checks this ref before persisting; without the guard the
    // initial empty composer would race ahead of the async fetch and
    // overwrite the saved ready-id order with []. The same hydration
    // clobber pattern was already fixed for the selected-conversation
    // storage; this is the attachment-order equivalent.
    composerHydratedForRef.current = null;
    // Drop any rows left over from a different conversation so a
    // slow server response for a prior chat cannot bleed its order
    // into this chat's localStorage slot. An upload still in flight
    // for the CURRENT target keeps its row (its `conversationId`
    // already matches `target`).
    setComposerAttachments((prev) => prev.filter((a) => a.conversationId === target));
    let cancelled = false;
    void (async () => {
      try {
        const resp = await listAttachments(target);
        if (cancelled || activeIdRef.current !== target) return;
        const orders = readComposerOrder();
        const orderedItems = orderServerListByLocal(dropCancelledUploads(resp.items), orders[target]);
        setComposerAttachments((prev) => mergeComposerWithServer(prev, orderedItems, target));
      } catch {
        // Non-fatal: the composer keeps whatever state we already have
        // in-memory if the list request fails.
      } finally {
        // Mark hydration complete so subsequent order-writes are
        // allowed, even if the fetch failed (we've exhausted our
        // chance to read authoritative server order for this cycle
        // and don't want to permanently block writes).
        if (!cancelled && activeIdRef.current === target) {
          composerHydratedForRef.current = target;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  // Bounded refetch for any composer row the server still shows as
  // `uploading` after a chat switch. The upload itself keeps running on
  // the server (and the originating tab still owns the XHR for its own
  // completion); this loop just keeps the merged state fresh so the
  // user sees the row flip to `ready` without a manual reload.
  useEffect(() => {
    if (!activeId) return;
    const target = activeId;
    let cancelled = false;
    const tick = async (attempt: number): Promise<void> => {
      if (cancelled || activeIdRef.current !== target) return;
      const pending = composerAttachmentsRef.current.some(
        (a) => a.state === "uploading" && a.serverId && !a.controller,
      );
      if (!pending) return;
      try {
        const resp = await listAttachments(target);
        if (cancelled || activeIdRef.current !== target) return;
        setComposerAttachments((prev) =>
          mergeComposerWithServer(prev, dropCancelledUploads(resp.items), target),
        );
      } catch {
        // ignore and let the next tick retry
      }
      // Capped exponential: 1s, 2s, 4s, 8s, 15s, 15s, …
      const delayMs = Math.min(15000, 1000 * Math.pow(2, attempt));
      setTimeout(() => void tick(attempt + 1), delayMs);
    };
    const first = setTimeout(() => void tick(0), 1000);
    return () => {
      cancelled = true;
      clearTimeout(first);
    };
  }, [activeId]);

  // Set of local ids whose upload has already been kicked off. StrictMode
  // double-invokes handlers in dev, so a naive implementation of
  // addComposerFiles would start two uploads per file (same bytes, two
  // UUIDs) and both would succeed as distinct server rows. The ref is a
  // simple deduper keyed by localId; it is NEVER read inside a render.
  const uploadStartedRef = useRef<Set<string>>(new Set());

  const addComposerFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      let conversationId: string;
      try {
        conversationId = await ensureConversation();
      } catch (err) {
        setError((err as Error).message);
        return;
      }
      // Snapshot the live composer state ONCE here, outside the setter.
      // Capacity decisions are made against this snapshot; the setter
      // call below is pure (no side effects) so StrictMode's duplicate
      // render pass cannot re-trigger the uploads.
      const snapshot = composerAttachmentsRef.current;
      const policy = attachmentPolicy;
      const perFile = policy?.max_file_bytes ?? 25 * 1024 * 1024;
      const composerCap = policy?.max_composer_bytes ?? 100 * 1024 * 1024;
      const perTurn = policy?.max_files_per_turn ?? 8;

      const draftCount = snapshot.filter((a) => a.state !== "failed").length;
      const draftBytes = snapshot
        .filter((a) => a.state === "ready" && a.serverDto)
        .reduce((acc, a) => acc + (a.serverDto!.byte_size || 0), 0);
      const additions: ComposerAttachment[] = [];
      let runningBytes = draftBytes;
      let runningCount = draftCount;
      for (const file of files) {
        if (runningCount >= perTurn) {
          setError(`Maximum ${perTurn} files per turn — remove one before adding more.`);
          break;
        }
        if (file.size > perFile) {
          setError(
            `"${file.name}" is larger than the ${Math.round(perFile / 1024 / 1024)} MiB per-file cap.`,
          );
          continue;
        }
        if (runningBytes + file.size > composerCap) {
          setError(
            `Adding "${file.name}" would exceed the ${Math.round(composerCap / 1024 / 1024)} MiB composer total.`,
          );
          break;
        }
        runningCount += 1;
        runningBytes += file.size;
        additions.push({
          localId: newIdempotencyKey(),
          conversationId,
          displayName: file.name,
          fileHandle: file,
          state: "uploading",
          progress: 0,
          serverId: null,
          serverDto: null,
          controller: new AbortController(),
          error: null,
        });
      }
      if (additions.length === 0) return;

      // Commit the new rows (pure state transition). The setter runs
      // once in production and twice in StrictMode dev; both runs produce
      // the same post-state because `additions` is deterministic.
      setComposerAttachments((prev) => [...prev, ...additions]);

      // Kick off network work OUTSIDE the setter. The dedupe ref ensures
      // StrictMode's second render does not start duplicate uploads.
      for (const add of additions) {
        if (uploadStartedRef.current.has(add.localId)) continue;
        uploadStartedRef.current.add(add.localId);
        void (async (): Promise<void> => {
          try {
            const dto = await uploadAttachment(add.conversationId, add.fileHandle!, {
              onProgress: (loaded, total) => {
                if (!total) return;
                // Only update if the row still exists AND is still
                // uploading in the current conversation.
                setComposerAttachments((cur) =>
                  cur.map((item) =>
                    item.localId === add.localId &&
                    item.state === "uploading" &&
                    item.conversationId === add.conversationId
                      ? { ...item, progress: loaded / total }
                      : item,
                  ),
                );
              },
              signal: add.controller!.signal,
            });
            // Hydration may already have added the still-`uploading` server row
            // as a second card; drop it so exactly one ready card remains.
            setComposerAttachments((cur) =>
              settleUploadSuccess(cur, add.localId, dto.id, (item) => ({
                ...item,
                state: "ready" as const,
                progress: 1,
                serverId: dto.id,
                serverDto: dto,
                controller: null,
              })),
            );
          } catch (err) {
            setComposerAttachments((cur) =>
              cur.map((item) =>
                item.localId === add.localId
                  ? {
                      ...item,
                      state: "failed",
                      error: (err as Error).message,
                      controller: null,
                    }
                  : item,
              ),
            );
          }
        })();
      }
    },
    [attachmentPolicy, ensureConversation],
  );

  const composerAttachmentsRef = useRef(composerAttachments);
  useEffect(() => {
    composerAttachmentsRef.current = composerAttachments;
    if (!shouldPersistComposerOrder(activeId, composerHydratedForRef.current)) return;
    // `shouldPersistComposerOrder` guarantees activeId is non-null when it
    // returns true, but it's not a TS type predicate; narrow explicitly.
    const conversationId = activeId;
    if (conversationId === null) return;
    // Cross-chat defense: only persist ready rows that actually
    // belong to the active conversation. A slow mid-flight merge
    // from a different conversation's `listAttachments` cannot
    // leak its ids under the wrong key even if the hydration ref
    // flipped between its queue scheduling and its invocation.
    const readyIds = composerAttachments
      .filter(
        (a) =>
          a.state === "ready" &&
          a.serverId !== null &&
          a.conversationId === conversationId,
      )
      .map((a) => a.serverId!);
    writeComposerOrder(conversationId, readyIds);
  }, [composerAttachments, activeId]);

  const removeComposerAttachment = useCallback(
    async (localId: string) => {
      const target = composerAttachmentsRef.current.find((a) => a.localId === localId);
      if (!target) return;
      // Cancel an in-flight upload before removing the row — the
      // AbortController is wired into both the XHR and the fetch helper.
      target.controller?.abort();
      uploadStartedRef.current.delete(localId);
      setComposerAttachments((prev) => prev.filter((a) => a.localId !== localId));
      if (target.serverId) {
        try {
          await deleteAttachment(target.serverId);
        } catch {
          // The attachment may have been bound by a parallel send; the
          // DELETE then returns 409 and we leave the server-side record
          // alone (it belongs to the sent message now).
        }
      }
    },
    [],
  );

  const retryComposerAttachment = useCallback(
    async (localId: string) => {
      const target = composerAttachmentsRef.current.find((a) => a.localId === localId);
      if (!target || target.state !== "failed") return;
      if (!target.fileHandle) {
        // Reloaded failed draft: the browser dropped the original File
        // bytes at the previous page unload. We cannot retry in place.
        setError(
          `"${target.displayName}" was lost on reload — remove it and re-select the file to retry.`,
        );
        return;
      }
      const fileHandle = target.fileHandle;
      await removeComposerAttachment(localId);
      await addComposerFiles([fileHandle]);
    },
    [removeComposerAttachment, addComposerFiles],
  );

  const doExport = useCallback(async () => {
    if (!activeId) return;
    try {
      const payload = await exportConversation(activeId);
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `proofestra-${activeId}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [activeId]);

  const isRunning = !!activeRun && !isTerminal(activeRun.status);
  // Build a map of run_id → run snapshot so the saved assistant message can
  // render alongside its originating run details without duplicating the
  // final answer bubble.
  const runsById = useMemo(() => {
    const map = new Map<string, RunSnapshot>();
    for (const r of runs) map.set(r.id, r);
    if (activeRun) map.set(activeRun.id, activeRun);
    return map;
  }, [runs, activeRun]);

  // Attachment names for the per-agent route list: every file ever sent in
  // this conversation (history refs) plus anything still in the composer.
  const attachmentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of messages) {
      for (const a of m.attachments ?? []) map.set(a.id, a.sanitized_display_name);
    }
    for (const c of composerAttachments) {
      if (c.serverId) map.set(c.serverId, c.serverDto?.sanitized_display_name ?? c.displayName);
    }
    return map;
  }, [messages, composerAttachments]);

  const liveRunMessageIds = useMemo(() => {
    // When a run has already written an assistant message to the DB, we hide
    // the live RunView's duplicate final-answer bubble.
    const ids = new Set<string>();
    for (const m of messages) {
      if (m.role === "assistant") ids.add(m.run_id);
    }
    return ids;
  }, [messages]);

  return (
    <div className="app" aria-label="Proofestra workspace">
      <aside className="sidebar">
        <div className="brand">
          <span className="mark" aria-hidden>
            <i /><i /><i />
          </span>
          <span>Proofestra</span>
        </div>
        <button className="new-chat" onClick={newChat} type="button">
          New chat <span aria-hidden>+</span>
        </button>
        <nav aria-label="Saved conversations" className="history-list">
          <p className="nav-label">Conversations</p>
          {conversations.length === 0 ? (
            <p className="hint">No saved chats yet.</p>
          ) : (
            conversations.map((c) => (
              <div className={`history ${activeId === c.id ? "active" : ""}`} key={c.id}>
                <button
                  type="button"
                  onClick={() => setActiveId(c.id)}
                  aria-current={activeId === c.id ? "true" : undefined}
                >
                  <span className="history-title">{c.title}</span>
                  <small>{new Date(c.updated_at).toLocaleString()}</small>
                </button>
                <button
                  className="history-del"
                  type="button"
                  aria-label={`Delete conversation ${c.title}`}
                  onClick={() => void removeConversation(c.id)}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </nav>
        <div className="sidebar-bottom">
          <strong>Local v1</strong>
          <small>
            Live mode {providers?.live_enabled ? "available" : "disabled"} · catalog{" "}
            {providers?.catalog_version ?? "–"}
          </small>
          <small>Open-source core · Apache License 2.0</small>
        </div>
      </aside>

      <div className="shell">
        <header className="topbar">
          <div>
            <h1>Personal workspace</h1>
            <p>One chat, a few considered perspectives.</p>
          </div>
          <div className="topbar-actions">
            {activeConversation ? (
              <button
                type="button"
                className="export-btn"
                onClick={() => void doExport()}
                title={EXPORT_NOTICE}
              >
                Export JSON
              </button>
            ) : null}
            <div className="design-label">
              Local v1 · {executionMode === "mock" ? "Mock mode" : "Live mode (opt-in)"}
            </div>
          </div>
        </header>

        <div className="workspace">
          <main className="main">
            <div className="mode-row">
              <div className="segmented" role="group" aria-label="Response mode">
                <button
                  type="button"
                  aria-pressed={mode === "quick"}
                  onClick={() => handleModeChange("quick")}
                >
                  Quick
                </button>
                <button
                  type="button"
                  aria-pressed={mode === "team"}
                  onClick={() => handleModeChange("team")}
                >
                  Team
                </button>
              </div>
              <span className="mode-caption">
                {mode === "team"
                  ? "Independent drafts, cross-review, synthesis"
                  : "One agent, no peer review"}
              </span>
              {providers?.live_enabled ? (
                <label className="live-toggle">
                  <input
                    type="checkbox"
                    checked={executionMode === "live"}
                    onChange={(e) => setExecutionMode(e.target.checked ? "live" : "mock")}
                  />
                  <span>Live mode</span>
                </label>
              ) : (
                <span
                  className="live-disabled"
                  title="Set PROOFESTRA_LIVE_ENABLED=1 and provider keys to enable Live"
                >
                  Live disabled on server
                </span>
              )}
            </div>

            {bootError ? (
              <div className="banner error">Could not reach the local API: {bootError}</div>
            ) : null}

            {!activeConversation && messages.length === 0 && !activeRun ? (
              <section className="empty" aria-labelledby="welcome">
                <div className="empty-symbol" aria-hidden>
                  <i /><i /><i />
                </div>
                <h2 id="welcome">
                  Room for another
                  <br />
                  point of view.
                </h2>
                <p>
                  Ask your agents to draft separately, compare their answers, and make the open
                  questions clear.
                </p>
              </section>
            ) : (
              <section className="conversation" aria-label="Current conversation">
                {messages.map((m) => (
                  <article key={m.id} className={`turn turn-${m.role}`}>
                    {m.role === "user" ? (
                      <div className="user-message">
                        {m.text ? <div>{m.text}</div> : null}
                        {m.attachments && m.attachments.length > 0 ? (
                          <ul className="sent-attachments" aria-label="Sent attachments">
                            {m.attachments.map((att) => (
                              <li key={att.id} className="sent-attachment">
                                <a
                                  href={attachmentDownloadUrl(att.id)}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {att.sanitized_display_name}
                                </a>
                                <span className="sent-attachment-meta">
                                  {" · "}
                                  {att.sniffed_mime} · {humanBytes(att.byte_size)}
                                  {" · "}
                                  <span title={att.extraction_coverage?.label ?? ""}>
                                    {attachmentCoverageLabel(att)}
                                  </span>
                                </span>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    ) : (
                      <div className="assistant">
                        <div className="answer-heading">
                          <span className="mark" aria-hidden>
                            <i /><i /><i />
                          </span>
                          <strong>Proofestra</strong>
                        </div>
                        <Markdown text={m.text} />
                        {runsById.get(m.run_id) ? (
                          <RunDetails run={runsById.get(m.run_id)!} attachmentNames={attachmentNameById} />
                        ) : null}
                      </div>
                    )}
                  </article>
                ))}
                {activeRun && !liveRunMessageIds.has(activeRun.id) ? (
                  <RunView run={activeRun} attachmentNames={attachmentNameById} />
                ) : null}
                <div ref={bottomRef} />
              </section>
            )}

            <div className="composer-area">
              {error ? (
                <div className="error-message" role="alert">
                  {error}
                </div>
              ) : null}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (isRunning) void stop();
                  else void send();
                }}
                onDragOver={(e) => {
                  if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) {
                    e.preventDefault();
                    setDragOver(true);
                  }
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  if (!e.dataTransfer) return;
                  const files = Array.from(e.dataTransfer.files);
                  if (files.length === 0) return;
                  e.preventDefault();
                  setDragOver(false);
                  void addComposerFiles(files);
                }}
              >
                <div className={`composer${dragOver ? " drag-over" : ""}`}>
                  <label className="sr-only" htmlFor="prompt">
                    Message your team
                  </label>
                  {composerAttachments.length > 0 ? (
                    <ul className="composer-attachments" aria-label="Attachments">
                      {composerAttachments.map((att) => (
                        <li
                          key={att.localId}
                          className={`composer-attachment composer-attachment-${att.state}`}
                        >
                          <div className="composer-attachment-name">
                            {att.serverDto?.sanitized_display_name ?? att.displayName}
                          </div>
                          <div className="composer-attachment-meta" aria-live="polite">
                            {att.state === "uploading"
                              ? composerUploadLabel(att.state, att.progress, att.controller !== null)
                              : att.state === "failed"
                                ? `Failed: ${att.error ?? "unknown error"}`
                                : att.serverDto
                                  ? `${att.serverDto.sniffed_mime} · ${humanBytes(att.serverDto.byte_size)}`
                                  : "Ready"}
                            {att.state === "ready" && att.serverDto ? (
                              <span
                                className="composer-attachment-label"
                                title={att.serverDto.extraction_coverage?.label ?? ""}
                              >
                                {" · "}
                                {attachmentCoverageLabel(att.serverDto)}
                              </span>
                            ) : null}
                          </div>
                          {att.state === "ready" && att.serverId && att.serverDto ? (
                            <ComposerAttachmentPreview
                              id={att.serverId}
                              dto={att.serverDto}
                            />
                          ) : null}
                          <div className="composer-attachment-actions">
                            {att.state === "ready" && att.serverId ? (
                              <a
                                href={attachmentDownloadUrl(att.serverId)}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Download
                              </a>
                            ) : null}
                            {att.state === "failed" && att.fileHandle ? (
                              <button
                                type="button"
                                onClick={() => void retryComposerAttachment(att.localId)}
                              >
                                Retry
                              </button>
                            ) : null}
                            {att.state === "failed" && !att.fileHandle ? (
                              <span
                                className="composer-attachment-reselect"
                                title="File bytes were lost on reload; remove and re-select to retry"
                              >
                                Re-select to retry
                              </span>
                            ) : null}
                            <button
                              type="button"
                              onClick={() => void removeComposerAttachment(att.localId)}
                            >
                              Remove
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <textarea
                    id="prompt"
                    ref={promptRef}
                    placeholder={mode === "team" ? "Ask your team…" : "Ask one agent…"}
                    rows={2}
                    maxLength={16000}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    disabled={sending || isRunning}
                    onPaste={(e) => {
                      // Only hijack when the clipboard carries image items.
                      // Ordinary text pastes fall through to the default
                      // handler so Cmd/Ctrl-V remains a normal paste.
                      if (!e.clipboardData) return;
                      const items = Array.from(e.clipboardData.items);
                      const imageFiles: File[] = [];
                      for (const item of items) {
                        if (item.kind === "file") {
                          const file = item.getAsFile();
                          if (file) imageFiles.push(file);
                        }
                      }
                      if (imageFiles.length > 0) {
                        e.preventDefault();
                        void addComposerFiles(imageFiles);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        if (!isRunning && !sending) void send();
                      }
                    }}
                  />
                  <div className="composer-footer">
                    <span className="composer-hint">
                      {mode === "team"
                        ? `${enabledAgents.length} agents · base plan ${2 * enabledAgents.length + 1}`
                        : "1 agent · base plan 1"}
                    </span>
                    <label className="composer-attach-btn">
                      Attach files
                      <input
                        type="file"
                        multiple
                        hidden
                        onChange={(e) => {
                          const files = e.target.files ? Array.from(e.target.files) : [];
                          if (files.length > 0) void addComposerFiles(files);
                          e.target.value = "";
                        }}
                      />
                    </label>
                    <button
                      type="submit"
                      className={`send ${isRunning ? "stop" : ""}`}
                      disabled={
                        !isRunning &&
                        (!canSend ||
                          sending ||
                          composerAttachments.some(
                            (a) => a.state === "uploading" || a.state === "failed",
                          ) ||
                          (prompt.trim().length === 0 &&
                            composerAttachments.every((a) => a.state !== "ready")))
                      }
                    >
                      {isRunning ? "Stop" : sending ? "Sending…" : "Send"}
                    </button>
                  </div>
                </div>
                <p className="disclosure">
                  {executionMode === "live" ? DISCLOSURE_LIVE : DISCLOSURE_MOCK}
                </p>
              </form>
            </div>
          </main>

          <aside className="rail" aria-label="Team configuration">
            <h2>Your agents</h2>
            <p className="rail-intro">
              {mode === "team" ? `${enabledAgents.length} enabled roots` : "One selected root"}
            </p>

            <div className="agent-list">
              {agents.map((agent) => {
                const profile = availableProfiles.find((p) => p.profile_id === agent.profileId);
                const readiness = profile?.readiness ?? "unknown";
                return (
                  <section className="agent-entry" key={agent.id}>
                    <div className="agent-top">
                      <label>
                        <input
                          type="checkbox"
                          checked={agent.enabled}
                          onChange={(e) => {
                            if (mode === "quick") {
                              // Quick: exactly one enabled root.
                              setAgents((prev) =>
                                prev.map((a) => ({
                                  ...a,
                                  enabled: a.id === agent.id ? e.target.checked : false,
                                })),
                              );
                            } else {
                              updateAgent(agent.id, { enabled: e.target.checked });
                            }
                          }}
                          aria-label={`Enable ${agent.name}`}
                        />
                        <input
                          className="agent-name"
                          value={agent.name}
                          maxLength={80}
                          onChange={(e) => updateAgent(agent.id, { name: e.target.value })}
                        />
                      </label>
                      <button
                        type="button"
                        className="remove-agent"
                        onClick={() => removeAgent(agent.id)}
                        aria-label={`Remove ${agent.name}`}
                      >
                        ×
                      </button>
                    </div>
                    <select
                      value={agent.profileId}
                      onChange={(e) => updateAgent(agent.id, { profileId: e.target.value })}
                      aria-label={`Profile for ${agent.name}`}
                    >
                      {availableProfiles.map((p) => (
                        <option key={p.profile_id} value={p.profile_id}>
                          {p.provider} — {p.label}
                        </option>
                      ))}
                    </select>
                    <p className={`agent-meta readiness-${readiness}`}>
                      {profile
                        ? `${profile.provider} · model ${profile.model_id ?? "unset"} · ${readiness}`
                        : "profile unavailable"}
                    </p>
                  </section>
                );
              })}
            </div>
            <button type="button" className="add-agent" onClick={addAgent}>
              + Add agent
            </button>

            {mode === "team" ? (
              <label className="synth-label">
                Final answer by
                <select
                  value={synthesizerAgentId}
                  onChange={(e) => setSynthesizerAgentId(e.target.value)}
                >
                  {enabledAgents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            {policy ? (
              <details className="policy">
                <summary>Runtime policy</summary>
                <ul>
                  <li>Harness invocations: {policy.defaults.max_harness_invocations}</li>
                  <li>
                    Concurrency: {policy.defaults.concurrency} global /{" "}
                    {policy.defaults.per_provider_concurrency} per provider
                  </li>
                  <li>Overall deadline: {policy.defaults.overall_timeout_seconds}s</li>
                  <li>Output per call: {policy.defaults.max_output_tokens_per_call} tokens</li>
                  <li>Total output budget: {policy.defaults.total_output_tokens} tokens</li>
                </ul>
                <ul>
                  {policy.implementation_notes.map((note, i) => (
                    <li key={i} className="muted">
                      {note}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            <details className="policy">
              <summary>Export notice</summary>
              <p className="muted">{EXPORT_NOTICE}</p>
            </details>
          </aside>
        </div>
      </div>
    </div>
  );
}

function mergeRun(list: RunSnapshot[], snap: RunSnapshot): RunSnapshot[] {
  const idx = list.findIndex((r) => r.id === snap.id);
  if (idx === -1) return [...list, snap];
  const copy = list.slice();
  copy[idx] = snap;
  return copy;
}

function RunView({
  run,
  attachmentNames,
}: {
  run: RunSnapshot;
  attachmentNames: ReadonlyMap<string, string>;
}): JSX.Element {
  return (
    <article className="assistant run-active">
      <div className="answer-heading">
        <span className="mark" aria-hidden>
          <i /><i /><i />
        </span>
        <strong>Proofestra</strong>
        <span className={`status-pill ${run.status}`}>{humanStatus(run.status)}</span>
      </div>
      <div className="run-log">
        <div className="run-title">
          <span>
            {run.mode === "team" ? "Your team is considering the question" : "Working"}
          </span>
          <span>
            {run.usage.harness_invocations} / base {run.base_planned_calls}
          </span>
        </div>
        <ul className="steps">
          {run.steps.map((step) => (
            <li key={step.step_id} className={`step step-${step.status}`}>
              <span>{step.stage}</span>
              <span>
                {run.agents.find((a) => a.agent_id === step.agent_id)?.name ?? step.agent_id}
              </span>
              <span>{humanStatus(step.status)}</span>
            </li>
          ))}
        </ul>
      </div>
      {run.final_answer ? (
        <div className={`final ${run.presentation}`}>
          <Markdown text={run.final_answer} />
          {run.presentation === "draft_fallback" ? (
            <div className="callout warning">
              Synthesis failed; this is a draft fallback. Treat it as partial.
            </div>
          ) : run.presentation === "quick_unreviewed" ? (
            <div className="callout">Quick: no peer review was performed.</div>
          ) : null}
        </div>
      ) : null}
      {run.limitations.length > 0 ? (
        <details className="limitations">
          <summary>Limitations ({run.limitations.length})</summary>
          <ul>
            {run.limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <RunDetails run={run} attachmentNames={attachmentNames} />
    </article>
  );
}

function RunDetails({
  run,
  attachmentNames,
}: {
  run: RunSnapshot;
  attachmentNames: ReadonlyMap<string, string>;
}): JSX.Element {
  const grouped = useMemo(() => {
    const byAgent = new Map<string, { agent: RunSnapshot["agents"][number]; steps: StepSnapshot[] }>();
    for (const agent of run.agents) {
      byAgent.set(agent.agent_id, { agent, steps: [] });
    }
    for (const step of run.steps) {
      byAgent.get(step.agent_id)?.steps.push(step);
    }
    return [...byAgent.values()];
  }, [run]);

  const routeRows = useMemo(() => agentRouteRows(run, attachmentNames), [run, attachmentNames]);

  return (
    <details className="run-details">
      <summary>
        Inspect run · {run.mode} · {run.steps.length} steps · {humanStatus(run.status)}
      </summary>
      <div className="run-details-meta">
        <small>Mode: {run.mode}</small>
        <small>Execution: {run.execution_mode}</small>
        <small>Catalog: {run.catalog_version}</small>
        <small>Policy: {run.runtime_policy_version}</small>
        <small>
          Usage: {run.usage.harness_invocations} invocations · reported in{" "}
          {run.usage.input_tokens == null ? "unknown" : run.usage.input_tokens} · reported out{" "}
          {run.usage.output_tokens == null ? "unknown" : run.usage.output_tokens} · conservative
          consumed out {run.usage.consumed_output_tokens} ({run.usage.token_scope})
        </small>
      </div>
      {routeRows.length > 0 ? (
        <section className="attachment-routes" aria-label="How each agent received the attachments">
          <h4>Attachments by agent</h4>
          {routeRows.map((row) => (
            <div key={row.agentId} className="attachment-route-agent">
              <strong>{row.agentName}</strong>
              <ul>
                {row.files.map((f) => (
                  <li key={f.attachmentId} className={`route-${f.label.toLowerCase().replace(/\s+/g, "-")}`}>
                    <span className="route-file">{f.name}</span>
                    {" — "}
                    <span className="route-label">{f.label}</span>
                    {f.reason ? <span className="route-reason muted"> · {f.reason}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ) : null}
      {grouped.map(({ agent, steps }) => (
        <section key={agent.agent_id} className="agent-detail">
          <h4>
            {agent.name}{" "}
            <small className="muted">
              {agent.provider} · model {agent.model_id} · profile {agent.profile_id} · backend{" "}
              {agent.execution_backend_id}
            </small>
          </h4>
          {steps.map((step) => (
            <details key={step.step_id} className="step-detail">
              <summary>
                {step.stage} — {humanStatus(step.status)}
                {step.failure ? ` — ${step.failure.code}` : ""}
              </summary>
              {step.output ? (
                <div className="step-output">
                  <Markdown text={step.output} />
                </div>
              ) : (
                <p className="muted">No output.</p>
              )}
              {step.findings.length > 0 ? (
                <ul className="findings">
                  {step.findings.map((f, i) => (
                    <li key={i}>{f.text}</li>
                  ))}
                </ul>
              ) : null}
              {step.failure ? (
                <p className="failure">
                  <strong>Failure:</strong> {step.failure.code} — {step.failure.message}
                </p>
              ) : null}
            </details>
          ))}
        </section>
      ))}
    </details>
  );
}

function humanStatus(status: string): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "completed":
      return "Done";
    case "partial":
      return "Partial";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
    case "interrupted":
      return "Interrupted";
    case "skipped":
      return "Skipped";
    case "timed_out":
      return "Timed out";
    default:
      return status;
  }
}

function humanBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "0 B";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MiB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function isTerminal(status: string): boolean {
  return (
    status === "completed" ||
    status === "partial" ||
    status === "failed" ||
    status === "canceled" ||
    status === "interrupted"
  );
}

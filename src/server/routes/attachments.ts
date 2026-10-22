// Attachment HTTP routes. Streaming multipart upload with pre-write auth,
// MIME-magic sniffing after the full write, bounded preview/download
// serving with sandbox CSP + nosniff + no-store + attachment Content-
// Disposition, and draft deletion that unlinks the blob under the same
// SQLite transaction as the row.
//
// Important: multipart body size is bounded via `@fastify/multipart` at
// registration time. The global 128 KiB JSON `bodyLimit` on the app
// instance stays unchanged — only this one route group is scoped to large
// bodies.

import fs from "node:fs";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import multipart from "@fastify/multipart";
import type { ProofestraConfig } from "../../shared/config.js";
import type {
  AttachmentRepo,
  ConversationRepo,
} from "../../storage/repos.js";
import type { AttachmentKind } from "../../shared/types.js";
import { errorBody } from "../security.js";
import {
  ATTACHMENT_POLICY,
  BlobStore,
  makeSha256Streamer,
  sanitizeDisplayName,
  sniffImageDimensions,
  sniffMime,
  getAttachmentPolicy,
  isConsistentMimePair,
  isImagePreviewDimensionsSafe,
} from "../../core/attachments.js";
import { extractAttachment } from "../../core/attachmentExtraction.js";
import { UuidSchema } from "../../shared/schema.js";
import {
  isMediaPreviewValidated,
  sanitizePersistedDurationMs,
  sanitizePersistedMediaFormat,
  sanitizePersistedMediaMime,
  sanitizePersistedPageCount,
  sanitizePersistedStreamsJson,
} from "../../shared/attachmentMetadata.js";

export interface AttachmentRouteDeps {
  config: ProofestraConfig;
  conversations: ConversationRepo;
  attachments: AttachmentRepo;
  blobStore: BlobStore;
  // Production uses `extractAttachment`; tests inject a slow extractor to
  // prove that a disconnect during parsing aborts it and never marks ready.
  extractAttachmentImpl?: typeof extractAttachment;
}

const PREFIX = "/api/v1";

/**
 * Store-wide upload admission.
 *
 * Quota concerns:
 *   - `draftByteTotal(conversationId)` is per-conversation,
 *   - `totalByteSum()` is store-wide.
 * A per-conversation gate still races the store-wide total across
 * conversations: two uploads to different conversations would each
 * snapshot the same `totalByteSum` and both admit. We therefore use ONE
 * store-wide gate with concurrency 1, a bounded waiting queue (reject
 * 429 when exceeded), a per-upload deadline, and disconnect cleanup so a
 * client that walks away cannot pin the gate forever.
 *
 * The in-memory single-process assumption matches the rest of this
 * server; a future multi-worker deployment would move this to an SQLite
 * advisory lock. The previous per-conversation implementation also had
 * a reference-identity bug (`prev.then(() => next)` is a brand-new
 * Promise object each time it is evaluated, so the `===` delete check
 * never matched) which this rewrite eliminates by storing the exact
 * promise handle we check against.
 */
const UPLOAD_GATE = {
  busy: false,
  queue: [] as Array<{ resolve: () => void; reject: (err: Error) => void }>,
  maxWaiting: 32,
  deadlineMs: 120_000,
};

export function _resetUploadGateForTests(): void {
  UPLOAD_GATE.busy = false;
  UPLOAD_GATE.queue.length = 0;
}

class GateFullError extends Error {
  constructor() {
    super("too many concurrent uploads; retry shortly");
    this.name = "GateFullError";
  }
}
class GateTimeoutError extends Error {
  constructor() {
    super("upload exceeded its deadline");
    this.name = "GateTimeoutError";
  }
}
class AttachmentRemovedError extends Error {
  constructor() {
    super("attachment was removed while it was being processed");
    this.name = "AttachmentRemovedError";
  }
}

/**
 * In-flight uploads by attachment id. A DELETE of a row that is still
 * `uploading` aborts its parse through this registry (the child/worker is
 * terminated and awaited), then waits for the upload handler to settle.
 */
const IN_FLIGHT_UPLOADS = new Map<
  string,
  { conversationId: string; abort: () => void; settled: Promise<void> }
>();

/**
 * Abort every in-flight upload of one conversation and wait (bounded) for each
 * upload handler to settle: the child/worker is terminated, the partial blob
 * removed, and each original request ends `409 attachment_removed`. Called by
 * conversation DELETE BEFORE it collects blob keys and cascades the rows.
 */
export async function abortConversationUploads(conversationId: string): Promise<void> {
  const pending: Promise<unknown>[] = [];
  for (const entry of IN_FLIGHT_UPLOADS.values()) {
    if (entry.conversationId !== conversationId) continue;
    entry.abort();
    pending.push(Promise.race([entry.settled, new Promise((r) => setTimeout(r, 10_000))]));
  }
  await Promise.all(pending);
}

class ClientDisconnectError extends Error {
  constructor() {
    super("client disconnected before upload completed");
    this.name = "ClientDisconnectError";
  }
}

async function acquireUploadSlot(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<() => void> {
  if (UPLOAD_GATE.queue.length >= UPLOAD_GATE.maxWaiting) {
    throw new GateFullError();
  }
  if (!UPLOAD_GATE.busy) {
    UPLOAD_GATE.busy = true;
  } else {
    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const waiter = {
        resolve: (): void => {
          if (timer) clearTimeout(timer);
          request.raw.off("close", onClose);
          reply.raw.off("close", onReplyClose);
          resolve();
        },
        reject: (err: Error): void => {
          if (timer) clearTimeout(timer);
          request.raw.off("close", onClose);
          reply.raw.off("close", onReplyClose);
          reject(err);
        },
      };
      UPLOAD_GATE.queue.push(waiter);
      // If the client went away while queued, drop the waiter. A SMALL body is
      // already `complete` in memory while still queued (nothing reads it), so
      // the request `close` alone cannot tell a finished upload from a gone
      // client; the RESPONSE closing before anything was written can.
      const dropWaiter = (): void => {
        const idx = UPLOAD_GATE.queue.indexOf(waiter);
        if (idx >= 0) UPLOAD_GATE.queue.splice(idx, 1);
        waiter.reject(new ClientDisconnectError());
      };
      const onClose = (): void => {
        if (request.raw.complete) return;
        dropWaiter();
      };
      const onReplyClose = (): void => dropWaiter();
      request.raw.once("close", onClose);
      reply.raw.once("close", onReplyClose);
      timer = setTimeout(() => {
        const idx = UPLOAD_GATE.queue.indexOf(waiter);
        if (idx >= 0) UPLOAD_GATE.queue.splice(idx, 1);
        waiter.reject(new GateTimeoutError());
      }, UPLOAD_GATE.deadlineMs);
    });
  }
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    const next = UPLOAD_GATE.queue.shift();
    if (next) {
      next.resolve();
    } else {
      UPLOAD_GATE.busy = false;
    }
  };
}

/**
 * Hold the slot for exactly one upload. The deadline:
 *   - is a timer whose callback aborts the handler's AbortSignal, which
 *     is the ONLY cross-cutting cancellation path (no Promise.race),
 *   - is cleared in every exit branch,
 *   - never releases the slot while the handler is still writing;
 *     the finally awaits the handler to actually settle, and only THEN
 *     releases, so no concurrent upload can race the leaked writer.
 *
 * Client disconnect also aborts the signal, in two cases: the request
 * closes before its body completed, OR the response closes before it was
 * fully written (the XHR/socket went away after the body reached EOF
 * while the bounded parser was still running). The handler notices,
 * the parser child/worker is terminated, the partial blob is cleaned up,
 * and only then does the finally's `release()` run.
 */
async function withUploadSlot<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const release = await acquireUploadSlot(request, reply);
  // The client may have gone while this request waited for (or was handed)
  // the slot, before any listener below existed. Never start parsing a
  // request whose socket is already gone: that parse could never settle and
  // would pin the store-wide gate until the deadline.
  if (reply.raw.destroyed || request.raw.socket?.destroyed) {
    release();
    throw new ClientDisconnectError();
  }
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => {
    controller.abort(new GateTimeoutError());
  }, UPLOAD_GATE.deadlineMs);
  const onClose = (): void => {
    if (!request.raw.complete) controller.abort(new ClientDisconnectError());
  };
  const onResponseClose = (): void => {
    if (!reply.raw.writableFinished) controller.abort(new ClientDisconnectError());
  };
  request.raw.once("close", onClose);
  reply.raw.once("close", onResponseClose);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(deadlineTimer);
    request.raw.off("close", onClose);
    reply.raw.off("close", onResponseClose);
    release();
  }
}

export async function registerAttachmentRoutes(
  app: FastifyInstance,
  deps: AttachmentRouteDeps,
): Promise<void> {
  // Register multipart ONLY for the attachment upload route scope. Keep
  // the global 128 KiB JSON body limit for every other route.
  await app.register(multipart, {
    limits: {
      // Hard bytes-per-file cap, enforced BEFORE our streaming cap kicks
      // in. The streaming code also tracks and rejects per-conversation
      // and per-store quotas with its own error codes.
      fileSize: ATTACHMENT_POLICY.max_file_bytes,
      // One file per request keeps the state machine simple; the UI
      // batches by issuing one request per file so progress is per-file.
      files: 1,
      // No URL-encoded form fields; multipart is used only for the file.
      fields: 0,
      headerPairs: 32,
    },
    attachFieldsToBody: false,
  });

  /** GET /api/v1/attachments/policy — advertises the current caps to the UI. */
  app.get("/api/v1/attachments/policy", async () => ({
    policy: getAttachmentPolicy(),
  }));

  /** POST /api/v1/conversations/:id/attachments — streamed upload. */
  app.post<{ Params: { id: string } }>(
    `${PREFIX}/conversations/:id/attachments`,
    async (request, reply) => {
      const parsedId = UuidSchema.safeParse(request.params.id);
      if (!parsedId.success) {
        return reply.status(400).send({
          error: errorBody("validation_failed", "invalid conversation id", request.id),
        });
      }
      const conversationId = parsedId.data;
      // IDOR check BEFORE multipart write. Session + Host + Origin + CSRF
      // already enforced by `registerSecurity`'s preHandler hook which runs
      // ahead of this route; here we add the per-resource authorization.
      const conversation = deps.conversations.get(conversationId);
      if (!conversation) {
        return reply.status(404).send({
          error: errorBody("not_found", "conversation not found", request.id),
        });
      }
      // Admit under a store-wide gate so concurrent uploads across BOTH
      // the same conversation (per-draft cap) AND different conversations
      // (store-wide quota) can never both snapshot the same uncommitted
      // totals. Bounded waiting + per-upload deadline + disconnect
      // cleanup keep the gate from being pinned by a dead client.
      try {
        return await withUploadSlot(request, reply, (signal) =>
          handleOneUpload(reply, request, deps, conversationId, signal),
        );
      } catch (err) {
        if (err instanceof GateFullError) {
          return reply.status(429).send({
            error: errorBody("upload_busy", err.message, request.id),
          });
        }
        if (err instanceof GateTimeoutError) {
          return reply.status(504).send({
            error: errorBody("upload_timeout", err.message, request.id),
          });
        }
        if (err instanceof AttachmentRemovedError) {
          return reply.status(409).send({
            error: errorBody("attachment_removed", err.message, request.id),
          });
        }
        if (err instanceof ClientDisconnectError) {
          // Client is gone; the socket is already closed, but return a
          // well-formed response for any still-listening observer (tests).
          return reply.status(499).send({
            error: errorBody("client_closed_request", err.message, request.id),
          });
        }
        if (err instanceof MultipartMalformedError) {
          return reply.status(400).send({
            error: errorBody("multipart_malformed", err.message, request.id),
          });
        }
        if (err instanceof UploadRejectError) {
          return reply.status(err.httpStatus).send({
            error: errorBody(err.code, err.message, request.id),
          });
        }
        if (err instanceof UploadLimitError) {
          return reply.status(413).send({
            error: errorBody("attachment_limit", err.message, request.id),
          });
        }
        throw err;
      }
    },
  );

  /** GET /api/v1/conversations/:id/attachments — list ready/uploading/failed drafts. */
  app.get<{ Params: { id: string } }>(
    `${PREFIX}/conversations/:id/attachments`,
    async (request, reply) => {
      const parsedId = UuidSchema.safeParse(request.params.id);
      if (!parsedId.success) {
        return reply.status(400).send({
          error: errorBody("validation_failed", "invalid conversation id", request.id),
        });
      }
      const conversation = deps.conversations.get(parsedId.data);
      if (!conversation) {
        return reply.status(404).send({
          error: errorBody("not_found", "conversation not found", request.id),
        });
      }
      const rows = deps.attachments.listDraftByConversation(parsedId.data);
      return { items: rows.map((r) => deps.attachments.toDto(r)) };
    },
  );

  /** DELETE /api/v1/attachments/:id — only valid for draft (not bound) rows. */
  app.delete<{ Params: { id: string } }>(
    `${PREFIX}/attachments/:id`,
    async (request, reply) => {
      const parsed = UuidSchema.safeParse(request.params.id);
      if (!parsed.success) {
        return reply.status(400).send({
          error: errorBody("validation_failed", "invalid attachment id", request.id),
        });
      }
      const row = deps.attachments.get(parsed.data);
      if (!row) return reply.status(404).send({ error: errorBody("not_found", "attachment not found", request.id) });
      if (row.state === "bound") {
        return reply.status(409).send({
          error: errorBody(
            "attachment_bound",
            "attachment is bound to a sent message; delete the conversation to remove it",
            request.id,
          ),
        });
      }
      if (row.state === "uploading") {
        // Still being processed: abort the parse (child/worker terminated and
        // awaited by the upload handler), wait for it to settle, then remove
        // the row. The original request ends with a clean 409.
        const inFlight = IN_FLIGHT_UPLOADS.get(row.id);
        if (inFlight) {
          inFlight.abort();
          await Promise.race([inFlight.settled, new Promise((r) => setTimeout(r, 10_000))]);
        }
      }
      const ok = deps.attachments.deleteDraft(row.id);
      if (!ok) {
        return reply.status(409).send({
          error: errorBody("attachment_bound", "attachment is no longer deletable", request.id),
        });
      }
      await deps.blobStore.unlinkSafely(row.storage_key).catch(() => {});
      return reply.status(204).send();
    },
  );

  /** GET /api/v1/attachments/:id/preview — same-origin authenticated inline. */
  app.get<{ Params: { id: string } }>(
    `${PREFIX}/attachments/:id/preview`,
    async (request, reply) => servePreview(reply, request, deps, false),
  );

  /** GET /api/v1/attachments/:id/download — safe attachment download. */
  app.get<{ Params: { id: string } }>(
    `${PREFIX}/attachments/:id/download`,
    async (request, reply) => servePreview(reply, request, deps, true),
  );
}

class UploadLimitError extends Error {
  constructor(kind: string) {
    super(`${kind} exceeded`);
    this.name = "UploadLimitError";
  }
}

class UploadRejectError extends Error {
  constructor(public readonly httpStatus: number, public readonly code: string, msg: string) {
    super(msg);
    this.name = "UploadRejectError";
  }
}

class MultipartMalformedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "MultipartMalformedError";
  }
}

async function handleOneUpload(
  reply: FastifyReply,
  request: FastifyRequest<{ Params: { id: string } }>,
  deps: AttachmentRouteDeps,
  conversationId: string,
  slotSignal: AbortSignal,
): Promise<FastifyReply> {
  // The slot's deadline/disconnect signal, plus an explicit removal signal
  // (DELETE of this still-uploading row).
  const removal = new AbortController();
  const signal = AbortSignal.any([slotSignal, removal.signal]);
  let markSettled: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    markSettled = resolve;
  });
  // Multipart file streams emit `error` out-of-band when busboy's dicer
  // detects a malformed body. If no listener is attached, Node 22 crashes
  // the process. Even with @fastify/multipart 9.4.0 (which includes the
  // upstream fix for issue #594), we attach a bounded error listener on
  // every file stream and on `request.raw` as a defense-in-depth guard
  // so this handler can never leak an unhandled 'error' event.
  const partErrors: Error[] = [];
  const captureError = (err: unknown): void => {
    const e = err instanceof Error ? err : new Error(String(err));
    partErrors.push(e);
  };
  request.raw.on("error", captureError);
  // Abort cleanup: destroy the incoming request stream when the deadline
  // or disconnect fires, which makes the parts iterator throw on its
  // next read instead of hanging.
  const onAbort = (): void => {
    try {
      request.raw.destroy(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    } catch {
      // ignore
    }
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  // Pre-check against the committed totals under the gate. These are
  // authoritative because the store-wide gate serializes all uploads; no
  // other upload can commit between these reads and `markReady`.
  if (deps.attachments.draftCount(conversationId) >= ATTACHMENT_POLICY.max_files_per_turn) {
    return reply.status(409).send({
      error: errorBody(
        "attachment_limit",
        `max ${ATTACHMENT_POLICY.max_files_per_turn} draft attachments per conversation`,
        request.id,
      ),
    });
  }
  if (deps.attachments.totalByteSum() >= ATTACHMENT_POLICY.max_store_bytes) {
    return reply.status(507).send({
      error: errorBody(
        "attachment_quota",
        "local attachment store quota reached",
        request.id,
      ),
    });
  }

  // Scratch state for the (possibly single) file part. We hold hash,
  // byte count, and the head slice LOCALLY so markReady is only called
  // after full multipart EOF — a trailing invalid part or extra file
  // part would otherwise expose a `ready` row that another tab could
  // bind before our catch block ran.
  let storageKey: string | null = null;
  let attachmentId: string | null = null;
  let diskPath: string | null = null;
  let fileSeen = false;
  let pending: null | {
    declaredMime: string;
    sanitizedDisplayName: string;
    byteCount: number;
    sha256: string;
    headSlice: Buffer;
  } = null;

  try {
    // Every await on the parser races the abort signal, so a destroyed or
    // stalled request can never keep this handler (and the upload gate) alive.
    const aborted = new Promise<never>((_, reject) => {
      const fire = (): void =>
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      if (signal.aborted) fire();
      else signal.addEventListener("abort", fire, { once: true });
    });
    aborted.catch(() => undefined);
    const parts = request.parts()[Symbol.asyncIterator]();
    for (;;) {
      const nextPart = await Promise.race([parts.next(), aborted]);
      if (nextPart.done) break;
      const part = nextPart.value;
      if (part.type !== "file") {
        // Ignore non-file parts; the limits config disallows named fields
        // but a stray `field` can still appear from a buggy client.
        continue;
      }
      // Always attach an error listener BEFORE for-await consumption.
      // Even on 9.4.0 we keep this defensively — a late error on the
      // stream after we have moved past it must not become an unhandled
      // 'error' event. We also mirror the error into `partErrors` so the
      // outer catch can see it even if the for-await loop already exited.
      part.file.on("error", captureError);
      if (fileSeen) {
        // The caller sent more than one file. Reject the whole upload.
        // Resume + drain this part so busboy doesn't stall.
        part.file.resume();
        throw new UploadRejectError(400, "validation_failed", "only one file per upload");
      }
      fileSeen = true;

      const declaredMime =
        typeof part.mimetype === "string" ? part.mimetype.slice(0, 160) : "application/octet-stream";
      const sanitizedDisplayName = sanitizeDisplayName(
        typeof part.filename === "string" ? part.filename : "",
        declaredMime,
      );
      // The conversation may have been deleted since the route checked it.
      if (!deps.conversations.get(conversationId)) throw new AttachmentRemovedError();
      storageKey = deps.blobStore.mintStorageKey();
      diskPath = deps.blobStore.pathFor(storageKey);
      attachmentId = deps.attachments.insertUploading({
        conversationId,
        storageKey,
        sanitizedDisplayName,
        declaredMime,
        createdAt: new Date().toISOString(),
      });
      IN_FLIGHT_UPLOADS.set(attachmentId, {
        conversationId,
        abort: () => removal.abort(new AttachmentRemovedError()),
        settled,
      });

      const hasher = makeSha256Streamer();
      let byteCount = 0;
      const perFileCap = ATTACHMENT_POLICY.max_file_bytes;
      const draftTotalCommitted = deps.attachments.draftByteTotal(conversationId);
      const storeTotalCommitted = deps.attachments.totalByteSum();
      const composerBudget = ATTACHMENT_POLICY.max_composer_bytes - draftTotalCommitted;
      const storeBudget = ATTACHMENT_POLICY.max_store_bytes - storeTotalCommitted;
      const effectiveCap = Math.max(0, Math.min(perFileCap, composerBudget, storeBudget));
      // 64 bytes is enough for PNG (24), GIF (10), WebP VP8/VP8L/VP8X
      // (up to 30), the UTF-8 BOM, and every magic prefix we sniff.
      const headSlice = Buffer.alloc(64);
      let headLen = 0;

      const fh = await fs.promises.open(diskPath, "wx", 0o600);
      try {
        const chunks = part.file[Symbol.asyncIterator]();
        for (;;) {
          const nextChunk = await Promise.race([chunks.next(), aborted]);
          if (nextChunk.done) break;
          const buf = nextChunk.value as Buffer;
          byteCount += buf.length;
          if (byteCount > effectiveCap) {
            throw new UploadLimitError(
              effectiveCap === composerBudget
                ? "composer limit"
                : effectiveCap === storeBudget
                  ? "store quota"
                  : "file size",
            );
          }
          hasher.update(buf);
          if (headLen < headSlice.length) {
            const take = Math.min(headSlice.length - headLen, buf.length);
            buf.copy(headSlice, headLen, 0, take);
            headLen += take;
          }
          await fh.write(buf);
        }
      } finally {
        await fh.close();
        if (signal.aborted) part.file.destroy();
      }

      // @fastify/multipart surfaces its own fileSize-limit by setting
      // `part.file.truncated = true` on the stream after it stopped
      // forwarding bytes.
      if ((part.file as { truncated?: boolean }).truncated) {
        throw new UploadLimitError("file size");
      }

      pending = {
        declaredMime,
        sanitizedDisplayName,
        byteCount,
        sha256: hasher.digest(),
        headSlice: headSlice.subarray(0, headLen),
      };
      // Do NOT call markReady here — keep looping so (a) the multipart
      // parser can raise its own trailing fileSize-limit on the next
      // iteration, and (b) any trailing extra file part triggers our
      // "only one file per upload" rejection BEFORE the row becomes
      // visible as `ready` to any peer tab.
    }

    if (!fileSeen || !pending || !attachmentId || !diskPath) {
      throw new UploadRejectError(400, "validation_failed", "no file part in multipart body");
    }

    // Everything about the multipart body has been validated. NOW it is
    // safe to run extraction and publish `ready`.
    const sniffed = sniffMime(pending.headSlice);
    if (!isConsistentMimePair(pending.declaredMime, pending.sanitizedDisplayName, sniffed.mime)) {
      throw new UploadRejectError(
        415,
        "mime_mismatch",
        `declared ${pending.declaredMime} does not match sniffed ${sniffed.mime}`,
      );
    }
    const extract = deps.extractAttachmentImpl ?? extractAttachment;
    const extraction = await extract({
      kind: sniffed.kind,
      sniffed_mime: sniffed.mime,
      byte_size: pending.byteCount,
      blob_path: diskPath,
      sanitized_display_name: pending.sanitizedDisplayName,
      signal,
    });
    // Honour cancellation re-check: if the gate's deadline fired or the
    // client disconnected while the bounded extractor was running, do
    // NOT publish `ready`. The outer catch block will route into the
    // cleanupPartialBlob path with the correct error class.
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
    }
    // Sniff image dimensions from the 64-byte head slice for formats that
    // store them in a fixed header (PNG / GIF / WebP). JPEG stores
    // dimensions in a later SOF marker and returns null here; the
    // byte-size cap still bounds them. Non-image kinds return null.
    const imageDims = sniffImageDimensions(pending.headSlice, sniffed.mime);
    // Persist only validated metadata: every value re-passes the shared
    // sanitizers, and duration is stored as integer milliseconds.
    const probedDurationMs = sanitizePersistedDurationMs(
      typeof extraction.media_duration_seconds === "number" &&
        Number.isFinite(extraction.media_duration_seconds)
        ? Math.round(extraction.media_duration_seconds * 1000)
        : null,
    );
    deps.attachments.markReady({
      id: attachmentId,
      sniffedMime: sniffed.mime,
      kind: sniffed.kind,
      byteSize: pending.byteCount,
      contentSha256: pending.sha256,
      extractionStatus: extraction.status,
      extractionCoverage: extraction.coverage,
      extractedText: extraction.extractedText,
      sniffedWidth: imageDims?.width ?? null,
      sniffedHeight: imageDims?.height ?? null,
      sniffedPdfPages: sanitizePersistedPageCount(extraction.pdf_pages ?? null),
      sniffedMediaDurationMs: probedDurationMs,
      sniffedMediaStreamsJson: sanitizePersistedStreamsJson(extraction.media_streams_json ?? null),
      validatedMediaFormat: sanitizePersistedMediaFormat(extraction.validated_media_format ?? null),
      normalizedMediaMime: sanitizePersistedMediaMime(extraction.normalized_media_mime ?? null),
    });
    // A DELETE can land between the abort re-check and here; it is handled as
    // a clean 409 `attachment_removed` by the catch below (not a 500).
    const row = deps.attachments.get(attachmentId);
    if (!row || row.state !== "ready") throw new AttachmentRemovedError();
    return reply.status(201).send({ attachment: deps.attachments.toDto(row) });
  } catch (err) {
    // If the client disconnected or the deadline fired, surface that so
    // the outer `withUploadSlot` catch maps it to the correct status.
    if (signal.aborted) {
      await cleanupPartialBlob(deps, attachmentId, storageKey, signal.reason);
      throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));
    }
    // The row (or its whole conversation) vanished without an abort signal:
    // clean the partial blob and surface the clean 409, never a 500.
    if (err instanceof AttachmentRemovedError) {
      await cleanupPartialBlob(deps, attachmentId, storageKey, err);
      throw err;
    }
    // Classify known upstream parser errors into 4xx. The @fastify/multipart
    // 10.1.4 release surfaces several typed errors:
    //   - FST_FILES_LIMIT         → caller sent more file parts than our
    //                               `limits.files` cap (we admit exactly 1).
    //   - FST_REQ_FILE_TOO_LARGE  → a file part exceeded the fileSize cap.
    //   - FST_FIELDS_LIMIT, FST_PARTS_LIMIT, FST_PROTO_VIOLATION — all
    //     malformed-body conditions.
    // The @fastify/busboy transport also raises ERR_STREAM_PREMATURE_CLOSE
    // and "Part terminated early" when the client aborts/truncates mid
    // body. All of these are the client's fault, not a server fault, so
    // they must NOT return 500 upload_failed.
    const rootErr = err as Error & { code?: string };
    const parserCode =
      typeof rootErr?.code === "string" ? rootErr.code.toUpperCase() : "";
    const parserMsg = typeof rootErr?.message === "string" ? rootErr.message : "";
    const isFilesLimit =
      parserCode === "FST_FILES_LIMIT" || /files limit|too many files/i.test(parserMsg);
    const isSizeLimit =
      parserCode === "FST_REQ_FILE_TOO_LARGE" ||
      /file size|request file too large|file too large/i.test(parserMsg);
    const isMalformed =
      parserCode === "ERR_STREAM_PREMATURE_CLOSE" ||
      parserCode === "FST_PARTS_LIMIT" ||
      parserCode === "FST_FIELDS_LIMIT" ||
      parserCode === "FST_PROTO_VIOLATION" ||
      /Part terminated early|Unexpected end of multipart|Malformed|premature close/i.test(parserMsg);
    if (parserCode === "FST_INVALID_MULTIPART_CONTENT_TYPE") {
      // The client did not send multipart/form-data at all: its fault, not a
      // server error.
      await cleanupPartialBlob(deps, attachmentId, storageKey, rootErr);
      throw new UploadRejectError(415, "unsupported_media_type", "upload must be multipart/form-data");
    }
    if (isFilesLimit) {
      await cleanupPartialBlob(deps, attachmentId, storageKey, rootErr);
      throw new UploadRejectError(400, "too_many_files", "only one file per upload");
    }
    if (isSizeLimit) {
      await cleanupPartialBlob(deps, attachmentId, storageKey, rootErr);
      throw new UploadLimitError("file size");
    }
    if (isMalformed) {
      await cleanupPartialBlob(deps, attachmentId, storageKey, rootErr);
      throw new MultipartMalformedError(parserMsg || "malformed multipart body");
    }
    await cleanupPartialBlob(deps, attachmentId, storageKey, rootErr);
    const status =
      err instanceof UploadRejectError
        ? err.httpStatus
        : err instanceof UploadLimitError
          ? 413
          : 500;
    const code =
      err instanceof UploadRejectError
        ? err.code
        : err instanceof UploadLimitError
          ? "attachment_limit"
          : "upload_failed";
    const msg =
      err instanceof UploadRejectError
        ? err.message
        : err instanceof UploadLimitError
          ? err.message
          : "upload failed";
    return reply.status(status).send({
      error: errorBody(code, msg, request.id),
    });
  } finally {
    if (attachmentId) IN_FLIGHT_UPLOADS.delete(attachmentId);
    markSettled();
    // Detach the request-level error listener. Per-part listeners live
    // as long as the stream itself, which is fine — they are bounded
    // one-per-part and the stream is garbage-collected after use.
    request.raw.off("error", captureError);
    if (!signal.aborted) signal.removeEventListener("abort", onAbort);
    // Surface any out-of-band file-stream error that fired AFTER we
    // thought we were done. This cannot promote a 201 to a 400 (the
    // response has already been sent), but it DOES ensure the error
    // event never bubbles up to Node's process-level handler.
    if (partErrors.length > 0 && !reply.sent) {
      // Already handled via the catch above in normal cases.
    }
  }
}

async function cleanupPartialBlob(
  deps: AttachmentRouteDeps,
  attachmentId: string | null,
  storageKey: string | null,
  err: unknown,
): Promise<void> {
  if (attachmentId) {
    try {
      const code =
        err instanceof UploadRejectError
          ? err.code
          : err instanceof UploadLimitError
            ? "attachment_limit"
            : err instanceof MultipartMalformedError
              ? "multipart_malformed"
              : err instanceof GateTimeoutError
                ? "upload_timeout"
                : err instanceof ClientDisconnectError
                  ? "client_closed_request"
                  : err instanceof AttachmentRemovedError
                    ? "attachment_removed"
                    : "upload_failed";
      const msg =
        err instanceof Error ? err.message : "upload failed";
      deps.attachments.markFailed({ id: attachmentId, code, message: msg });
    } catch {
      // ignore secondary failure
    }
  }
  if (storageKey && attachmentId) {
    const now = deps.attachments.get(attachmentId);
    // Only unlink if the row is NOT in a committed/bound state. In the
    // current ordering this is always true (we throw before markReady),
    // but the explicit check guards against future refactors.
    if (!now || (now.state !== "ready" && now.state !== "bound")) {
      await deps.blobStore.unlinkSafely(storageKey).catch(() => {});
    }
  }
}

async function servePreview(
  reply: FastifyReply,
  request: FastifyRequest<{ Params: { id: string } }>,
  deps: AttachmentRouteDeps,
  forceDownload: boolean,
): Promise<FastifyReply> {
  const parsed = UuidSchema.safeParse(request.params.id);
  if (!parsed.success) {
    return reply.status(400).send({
      error: errorBody("validation_failed", "invalid attachment id", request.id),
    });
  }
  const row = deps.attachments.get(parsed.data);
  if (!row || row.state === "uploading" || row.state === "failed") {
    return reply.status(404).send({
      error: errorBody("not_found", "attachment not available", request.id),
    });
  }
  const diskPath = deps.blobStore.pathFor(row.storage_key);
  if (!fs.existsSync(diskPath)) {
    return reply.status(404).send({
      error: errorBody("not_found", "attachment blob missing", request.id),
    });
  }
  const inlineAllowed = isSafePreviewMime(row.sniffed_mime, row.kind);
  // Dimension-safety guard for raster images on the PREVIEW path. The
  // `/preview` endpoint only serves bytes inline when the persisted
  // sniffed dimensions are within the same per-side / pixel-area
  // bounds that `routeNativeAttachment` enforces. A 69-byte PNG that
  // declares 100000×100000, a JPEG whose dimensions we never sniffed,
  // or a GIF/WebP header that over-declares a canvas MUST NOT return
  // image bytes on this surface — the browser would OOM, decode a
  // huge raster, or (worse) be used as an authenticated
  // raster-decoder oracle. We return 422 `preview_unavailable` with
  // NO bytes so an inline `<img src=".../preview">` tag fails cleanly
  // and the UI falls back to the explicit download-only card. The
  // `/download` endpoint (`forceDownload === true`) continues to
  // serve the same bytes as an authenticated `application/octet-stream`
  // attachment: user-initiated download remains possible, but
  // eager inline embedding never triggers a download.
  if (
    !forceDownload &&
    inlineAllowed &&
    row.kind === "image" &&
    !isImagePreviewDimensionsSafe(row.sniffed_width, row.sniffed_height)
  ) {
    return reply.status(422).send({
      error: errorBody(
        "preview_unavailable",
        "image dimensions unavailable or exceed preview bounds; use the download path",
        request.id,
      ),
    });
  }
  // Media guard: audio/video bytes are only handed to the browser's media
  // decoder when the server persisted a structural validation (finite
  // duration + normalized MIME, and for video a positive bounded video
  // stream). A hostile header such as 65535x65535 or an unprobed legacy
  // upload gets a JSON 422 and zero file bytes; `/download` is unchanged.
  if (
    !forceDownload &&
    inlineAllowed &&
    (row.kind === "audio" || row.kind === "video") &&
    !isMediaPreviewValidated(row)
  ) {
    return reply.status(422).send({
      error: errorBody(
        "preview_unavailable",
        "media is not validated for preview (hostile, unprobed, or uploaded before metadata probing); download instead",
        request.id,
      ),
    });
  }
  const disposition = forceDownload || !inlineAllowed ? "attachment" : "inline";
  reply
    .header("content-type", inlineAllowed ? row.sniffed_mime : "application/octet-stream")
    .header("content-length", String(row.byte_size))
    .header(
      "content-disposition",
      buildContentDisposition(disposition, row.sanitized_display_name),
    )
    .header("cache-control", "private, no-store")
    .header("x-content-type-options", "nosniff")
    .header("x-frame-options", "DENY")
    .header(
      "content-security-policy",
      // Preview surface: no scripts, no frames, no plugins. Media/images
      // are the only things we ever want the browser to render.
      "default-src 'none'; img-src 'self' data:; media-src 'self'; sandbox; frame-ancestors 'none'",
    );
  return reply.send(fs.createReadStream(diskPath));
}

/**
 * Build an RFC 5987 compliant Content-Disposition header. Node's HTTP
 * writer refuses header values with high bytes, so a filename containing
 * non-ASCII characters (e.g. a Thai filename) would raise
 * `ERR_INVALID_CHAR` without the `filename*` variant. We always emit both:
 *   - `filename=` with a safe ASCII fallback (quotes/backslashes stripped,
 *     non-ASCII replaced with `_`),
 *   - `filename*=UTF-8''...` with the original percent-encoded display
 *     name so modern browsers render the correct label.
 */
function buildContentDisposition(disposition: "inline" | "attachment", name: string): string {
  const asciiFallback = name
    .replace(/[\u0000-\u001f\u007f-\uffff]/g, "_")
    .replace(/["\\]/g, "_");
  // RFC 5987 percent-encodes everything except the "attr-char" set.
  const utf8 = Array.from(Buffer.from(name, "utf-8"))
    .map((byte) => {
      // attr-char: ALPHA / DIGIT / "!" "#" "$" "&" "+" "-" "." "^" "_" "`" "|" "~"
      if (
        (byte >= 0x30 && byte <= 0x39) || // 0-9
        (byte >= 0x41 && byte <= 0x5a) || // A-Z
        (byte >= 0x61 && byte <= 0x7a) || // a-z
        byte === 0x21 ||
        byte === 0x23 ||
        byte === 0x24 ||
        byte === 0x26 ||
        byte === 0x2b ||
        byte === 0x2d ||
        byte === 0x2e ||
        byte === 0x5e ||
        byte === 0x5f ||
        byte === 0x60 ||
        byte === 0x7c ||
        byte === 0x7e
      ) {
        return String.fromCharCode(byte);
      }
      return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${utf8}`;
}

/**
 * Returns true for mime/kind pairs we are willing to serve `inline` so
 * the UI can embed a preview. HTML / SVG / XML / office docs are NEVER
 * previewed inline — the download path serves them with
 * `application/octet-stream` instead, so no browser can ever execute them
 * as active content via this surface.
 */
function isSafePreviewMime(mime: string, kind: AttachmentKind): boolean {
  if (kind === "image") {
    return mime === "image/png" || mime === "image/jpeg" || mime === "image/webp" || mime === "image/gif";
  }
  if (kind === "audio") {
    return (
      mime === "audio/wav" ||
      mime === "audio/mpeg" ||
      mime === "audio/mp3" ||
      mime === "audio/ogg" ||
      mime === "audio/flac"
    );
  }
  if (kind === "video") {
    return mime === "video/mp4" || mime === "video/webm" || mime === "video/quicktime";
  }
  if (kind === "text") return mime.startsWith("text/");
  // PDF, zip, docx, binary: download only.
  return false;
}

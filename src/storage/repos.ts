// Repository helpers that encapsulate SQLite access and keep callers in the
// business layer free of raw SQL. Snapshots are stored as JSON blobs so the
// run coordinator can round-trip the in-memory shape without an N-way join.

import type { DbHandle } from "./db.js";
import type {
  AttachmentDto,
  AttachmentExtractionCoverage,
  AttachmentExtractionStatus,
  AttachmentKind,
  AttachmentRef,
  AttachmentState,
  Conversation,
  Message,
  RunSnapshot,
  EventEnvelope,
  Page,
} from "../shared/types.js";
import { newUuid } from "../shared/ids.js";
import {
  parseExtractionCoverage,
  sanitizePersistedImageDimension,
  sanitizePersistedDurationMs,
  sanitizePersistedMediaFormat,
  sanitizePersistedMediaMime,
  sanitizePersistedPageCount,
  sanitizePersistedStreamsJson,
} from "../shared/attachmentMetadata.js";

export interface ConversationRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface RunRow {
  id: string;
  conversation_id: string;
  user_message_id: string;
  idempotency_key: string;
  request_digest: string;
  snapshot_json: string;
  status: string;
  mode: string;
  execution_mode: string;
  created_at: string;
  finished_at: string | null;
  last_event_sequence: number;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  run_id: string;
  role: "user" | "assistant";
  text: string;
  sequence: number;
  created_at: string;
}

export class ConversationRepo {
  constructor(private readonly handle: DbHandle) {}

  create(title: string): Conversation {
    const now = new Date().toISOString();
    const id = newUuid();
    this.handle
      .prepare(
        "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(id, title, now, now);
    return { id, title, created_at: now, updated_at: now };
  }

  get(id: string): Conversation | null {
    const row = this.handle
      .prepare("SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?")
      .get(id) as ConversationRow | undefined;
    return row ?? null;
  }

  list(limit: number, cursor: string | null): Page<Conversation> {
    const rows = this.handle
      .prepare(
        `SELECT id, title, created_at, updated_at
         FROM conversations
         WHERE (? IS NULL)
            OR (updated_at < ?)
            OR (updated_at = ? AND id < ?)
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`,
      )
      .all(
        cursor,
        cursor ? decodeCursorUpdatedAt(cursor) : "",
        cursor ? decodeCursorUpdatedAt(cursor) : "",
        cursor ? decodeCursorId(cursor) : "",
        limit + 1,
      ) as unknown as ConversationRow[];
    const items = rows.slice(0, limit);
    const next =
      rows.length > limit && items.length > 0
        ? encodeCursor(items[items.length - 1]!.updated_at, items[items.length - 1]!.id)
        : null;
    return { items, next_cursor: next };
  }

  delete(id: string): void {
    // The declared FKs are:
    //   messages.conversation_id        → conversations.id ON DELETE CASCADE
    //   attachments.conversation_id     → conversations.id ON DELETE CASCADE
    //   message_attachments.message_id  → messages.id      ON DELETE CASCADE
    //   message_attachments.attachment_id → attachments.id ON DELETE RESTRICT
    //
    // A plain DELETE FROM conversations fires both cascades (messages +
    // attachments) simultaneously. SQLite does not guarantee that the
    // messages cascade runs first, so the attachments-side cascade can
    // trip the message_attachments RESTRICT before message_attachments
    // rows have been cascaded away. Fix: run the cascade in explicit
    // safe order inside one transaction.
    this.handle.transaction(() => {
      this.handle
        .prepare(
          `DELETE FROM message_attachments
           WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)`,
        )
        .run(id);
      this.handle.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
      this.handle.prepare("DELETE FROM attachments WHERE conversation_id = ?").run(id);
      this.handle.prepare("DELETE FROM conversations WHERE id = ?").run(id);
    });
  }

  touch(id: string): void {
    this.handle
      .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  hasActiveRun(conversationId: string): boolean {
    const row = this.handle
      .prepare(
        `SELECT 1 FROM runs
         WHERE conversation_id = ?
           AND status IN ('queued','running','waiting_for_tool','awaiting_approval','waiting_for_children')
         LIMIT 1`,
      )
      .get(conversationId) as { 1: number } | undefined;
    return row != null;
  }

  renameFromFirstMessage(conversationId: string, text: string): void {
    const current = this.get(conversationId);
    if (!current) return;
    if (current.title !== "New conversation") return;
    const title = text.trim().split(/\s+/).slice(0, 8).join(" ").slice(0, 100) || "New conversation";
    this.handle
      .prepare("UPDATE conversations SET title = ? WHERE id = ? AND title = 'New conversation'")
      .run(title, conversationId);
  }
}

export class MessageRepo {
  constructor(private readonly handle: DbHandle) {}

  nextSequence(conversationId: string): number {
    const row = this.handle
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) AS seq FROM messages WHERE conversation_id = ?",
      )
      .get(conversationId) as { seq: number };
    return Number(row.seq) + 1;
  }

  insert(message: Message): void {
    this.handle
      .prepare(
        `INSERT INTO messages (id, conversation_id, run_id, role, text, sequence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.conversation_id,
        message.run_id,
        message.role,
        message.text,
        message.sequence,
        message.created_at,
      );
  }

  list(conversationId: string): Message[] {
    const rows = this.handle
      .prepare(
        `SELECT id, conversation_id, run_id, role, text, sequence, created_at
         FROM messages WHERE conversation_id = ? ORDER BY sequence ASC`,
      )
      .all(conversationId) as unknown as Message[];
    // Backfill per-message attachment refs in a second query. Separate from
    // the first query so a conversation without any attachments pays zero
    // join cost on the common path.
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return rows;
    const placeholders = ids.map(() => "?").join(",");
    const attachmentRows = this.handle
      .prepare(
        `SELECT ma.message_id AS message_id, ma.position AS position,
                a.id AS id, a.sanitized_display_name AS sanitized_display_name,
                a.sniffed_mime AS sniffed_mime, a.kind AS kind,
                a.byte_size AS byte_size, a.content_sha256 AS content_sha256,
                a.extraction_status AS extraction_status,
                a.extraction_json AS extraction_json,
                a.sniffed_width AS sniffed_width,
                a.sniffed_height AS sniffed_height,
                a.sniffed_pdf_pages AS sniffed_pdf_pages,
                a.sniffed_media_duration_ms AS sniffed_media_duration_ms,
                a.sniffed_media_streams_json AS sniffed_media_streams_json,
                a.validated_media_format AS validated_media_format,
                a.normalized_media_mime AS normalized_media_mime
         FROM message_attachments ma
         JOIN attachments a ON a.id = ma.attachment_id
         WHERE ma.message_id IN (${placeholders})
         ORDER BY ma.message_id, ma.position ASC`,
      )
      .all(...ids) as Array<{
      message_id: string;
      position: number;
      id: string;
      sanitized_display_name: string;
      sniffed_mime: string;
      kind: AttachmentKind;
      byte_size: number;
      content_sha256: string;
      extraction_status: AttachmentExtractionStatus;
      extraction_json: string;
      sniffed_width: number | null;
      sniffed_height: number | null;
      sniffed_pdf_pages: number | null;
      sniffed_media_duration_ms: number | null;
      sniffed_media_streams_json: string | null;
      validated_media_format: string | null;
      normalized_media_mime: string | null;
    }>;
    const byMessage = new Map<string, AttachmentRef[]>();
    for (const row of attachmentRows) {
      let list = byMessage.get(row.message_id);
      if (!list) {
        list = [];
        byMessage.set(row.message_id, list);
      }
      list.push({
        id: row.id,
        sanitized_display_name: row.sanitized_display_name,
        sniffed_mime: row.sniffed_mime,
        kind: row.kind,
        byte_size: row.byte_size,
        content_sha256: row.content_sha256,
        extraction_status: row.extraction_status,
        extraction_coverage: parseExtractionCoverage(row.extraction_json, row.extraction_status),
        sniffed_width: sanitizePersistedImageDimension(row.sniffed_width),
        sniffed_height: sanitizePersistedImageDimension(row.sniffed_height),
        sniffed_pdf_pages: sanitizePersistedPageCount(row.sniffed_pdf_pages),
        sniffed_media_duration_ms: sanitizePersistedDurationMs(row.sniffed_media_duration_ms),
        sniffed_media_streams_json: sanitizePersistedStreamsJson(row.sniffed_media_streams_json),
        validated_media_format: sanitizePersistedMediaFormat(row.validated_media_format),
        normalized_media_mime: sanitizePersistedMediaMime(row.normalized_media_mime),
      });
    }
    for (const message of rows) {
      const attachments = byMessage.get(message.id);
      if (attachments && attachments.length > 0) {
        message.attachments = attachments;
      }
    }
    return rows;
  }
}

/**
 * Scrub a candidate failure message so it never leaks absolute filesystem
 * paths, provider-body text, errno numerals from Node's filesystem layer,
 * or control bytes into the DTO/export. Known-safe labels (short, ASCII-
 * only, control-byte-free, path-separator-free, errno-free) pass through
 * unchanged; anything else collapses to the fixed label
 * `"attachment unavailable"`.
 *
 * This is defense in depth. The HTTP routes already pass fixed labels
 * (`upload_failed`, `blob_missing`, `attachment_limit`, …) but we repeat
 * the check at the storage boundary so a future caller cannot leak a raw
 * `err.message` through this column.
 */
export function sanitizeFailureMessage(candidate: string): string {
  if (typeof candidate !== "string" || candidate.length === 0) {
    return "attachment unavailable";
  }
  if (candidate.length > 160) return "attachment unavailable";
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return "attachment unavailable";
  if (candidate.includes("/") || candidate.includes("\\")) {
    return "attachment unavailable";
  }
  if (/E[A-Z]{3,}|errno/i.test(candidate)) {
    return "attachment unavailable";
  }
  return candidate;
}


export interface AttachmentRow {
  id: string;
  conversation_id: string;
  state: AttachmentState;
  storage_key: string;
  sanitized_display_name: string;
  declared_mime: string;
  sniffed_mime: string;
  kind: AttachmentKind;
  byte_size: number;
  content_sha256: string;
  extraction_status: AttachmentExtractionStatus;
  extraction_json: string;
  extracted_text: string | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: string;
  bound_at: string | null;
  sniffed_width: number | null;
  sniffed_height: number | null;
  sniffed_pdf_pages: number | null;
  sniffed_media_duration_ms: number | null;
  sniffed_media_streams_json: string | null;
  validated_media_format: string | null;
  normalized_media_mime: string | null;
}

/**
 * Attachments live under one conversation. The HTTP layer enforces IDOR
 * (attachment.conversation_id must equal the path's conversation id).
 */
export class AttachmentRepo {
  constructor(private readonly handle: DbHandle) {}

  insertUploading(input: {
    conversationId: string;
    storageKey: string;
    sanitizedDisplayName: string;
    declaredMime: string;
    createdAt: string;
  }): string {
    const id = newUuid();
    this.handle
      .prepare(
        `INSERT INTO attachments
         (id, conversation_id, state, storage_key, sanitized_display_name,
          declared_mime, sniffed_mime, kind, byte_size, content_sha256,
          extraction_status, extraction_json, extracted_text,
          failure_code, failure_message, created_at, bound_at)
         VALUES (?, ?, 'uploading', ?, ?, ?, '', 'binary', 0, '', 'none',
                 '{}', NULL, NULL, NULL, ?, NULL)`,
      )
      .run(
        id,
        input.conversationId,
        input.storageKey,
        input.sanitizedDisplayName,
        input.declaredMime,
        input.createdAt,
      );
    return id;
  }

  markReady(input: {
    id: string;
    sniffedMime: string;
    kind: AttachmentKind;
    byteSize: number;
    contentSha256: string;
    extractionStatus: AttachmentExtractionStatus;
    extractionCoverage: AttachmentExtractionCoverage;
    extractedText: string | null;
    // Validated image dimensions from the magic-byte sniff. Null for
    // non-images and for formats whose dimensions cannot be read from the
    // 64-byte head slice (JPEG; the byte-size cap still bounds those).
    // Non-null values are already bounded by `sniffImageDimensions`.
    sniffedWidth: number | null;
    sniffedHeight: number | null;
    // Validated PDF page count from the bounded Poppler extractor. Null
    // for non-PDFs, encrypted PDFs, malformed PDFs, and installs without
    // Poppler. The routing path refuses `native_pdf` whenever this is
    // null.
    sniffedPdfPages: number | null;
    // Validated media duration (ms) from the bounded ffprobe probe.
    // Null for non-media files, media the probe refused, missing
    // ffprobe install, or probe timeout.
    sniffedMediaDurationMs: number | null;
    // Bounded JSON summary of ffprobe-sanitized streams, or null when
    // the probe refused / failed.
    sniffedMediaStreamsJson: string | null;
    // Probe-validated container format and wire-normalized media MIME.
    validatedMediaFormat: string | null;
    normalizedMediaMime: string | null;
  }): void {
    this.handle
      .prepare(
        `UPDATE attachments
         SET state = 'ready', sniffed_mime = ?, kind = ?, byte_size = ?,
             content_sha256 = ?, extraction_status = ?, extraction_json = ?,
             extracted_text = ?,
             sniffed_width = ?, sniffed_height = ?,
             sniffed_pdf_pages = ?,
             sniffed_media_duration_ms = ?,
             sniffed_media_streams_json = ?,
             validated_media_format = ?,
             normalized_media_mime = ?
         WHERE id = ? AND state = 'uploading'`,
      )
      .run(
        input.sniffedMime,
        input.kind,
        input.byteSize,
        input.contentSha256,
        input.extractionStatus,
        JSON.stringify(input.extractionCoverage),
        input.extractedText,
        input.sniffedWidth,
        input.sniffedHeight,
        input.sniffedPdfPages,
        input.sniffedMediaDurationMs,
        input.sniffedMediaStreamsJson,
        input.validatedMediaFormat,
        input.normalizedMediaMime,
        input.id,
      );
  }

  markFailed(input: { id: string; code: string; message: string }): void {
    // Both the code and the message are stored verbatim and later surface
    // in the attachment DTO (which the UI shows). CALLERS MUST sanitize
    // these values before passing them in — never pass the raw
    // `err.message` from a parser/filesystem/adapter error here, because
    // the DTO is readable by the client and the failure column is
    // included in exports via the DTO. The HTTP routes already route
    // every error through fixed labels (`upload_failed`, `blob_missing`,
    // etc.) and discard upstream text; this invariant repeats the
    // guarantee at the storage boundary so a future caller cannot
    // accidentally leak an absolute path or vendor body through this
    // column.
    this.handle
      .prepare(
        `UPDATE attachments
         SET state = 'failed', failure_code = ?, failure_message = ?
         WHERE id = ? AND state = 'uploading'`,
      )
      .run(input.code, sanitizeFailureMessage(input.message), input.id);
  }

  bindToMessage(messageId: string, attachmentIds: string[]): void {
    // Caller is responsible for wrapping this in a transaction alongside
    // the message insert; the admission path does exactly that.
    const insert = this.handle.prepare(
      `INSERT INTO message_attachments (message_id, attachment_id, position)
       VALUES (?, ?, ?)`,
    );
    const update = this.handle.prepare(
      `UPDATE attachments SET state = 'bound', bound_at = ? WHERE id = ?`,
    );
    const now = new Date().toISOString();
    for (let i = 0; i < attachmentIds.length; i += 1) {
      insert.run(messageId, attachmentIds[i]!, i);
      update.run(now, attachmentIds[i]!);
    }
  }

  get(id: string): AttachmentRow | null {
    const row = this.handle
      .prepare(`SELECT * FROM attachments WHERE id = ?`)
      .get(id) as unknown as AttachmentRow | undefined;
    return row ?? null;
  }

  getIfOwned(conversationId: string, id: string): AttachmentRow | null {
    const row = this.get(id);
    if (!row) return null;
    if (row.conversation_id !== conversationId) return null;
    return row;
  }

  /**
   * List attachments the UI is still allowed to interact with for a
   * conversation. Hides `bound` rows (those render inside their frozen
   * message history, not inside the composer).
   */
  listDraftByConversation(conversationId: string): AttachmentRow[] {
    return this.handle
      .prepare(
        `SELECT * FROM attachments
         WHERE conversation_id = ? AND state IN ('uploading','ready','failed')
         ORDER BY created_at ASC`,
      )
      .all(conversationId) as unknown as AttachmentRow[];
  }

  /**
   * Delete a draft attachment (not bound to any sent message). The caller
   * must also unlink the on-disk blob under the same transaction so the
   * two cannot drift.
   */
  deleteDraft(id: string): boolean {
    const info = this.handle
      .prepare(
        `DELETE FROM attachments WHERE id = ? AND state IN ('uploading','ready','failed')`,
      )
      .run(id);
    return (info as { changes?: number }).changes === 1;
  }

  /**
   * Total persisted bytes across every ready-or-uploading attachment in
   * one conversation. Used for the composer-level 100 MiB cap. 'bound'
   * rows do NOT count against the composer total; they count against the
   * global per-conversation quota.
   */
  draftByteTotal(conversationId: string): number {
    const row = this.handle
      .prepare(
        `SELECT COALESCE(SUM(byte_size), 0) AS total FROM attachments
         WHERE conversation_id = ? AND state IN ('uploading','ready')`,
      )
      .get(conversationId) as { total: number };
    return Number(row.total);
  }

  /**
   * Total persisted bytes across ALL rows (incl. 'bound') for the whole
   * data directory. Used for the 1 GiB global quota.
   */
  totalByteSum(): number {
    const row = this.handle
      .prepare(`SELECT COALESCE(SUM(byte_size), 0) AS total FROM attachments`)
      .get() as { total: number };
    return Number(row.total);
  }

  draftCount(conversationId: string): number {
    const row = this.handle
      .prepare(
        `SELECT COUNT(*) AS c FROM attachments
         WHERE conversation_id = ? AND state IN ('uploading','ready')`,
      )
      .get(conversationId) as { c: number };
    return Number(row.c);
  }

  listAllStorageKeys(): Array<{ id: string; storage_key: string; state: AttachmentState }> {
    return this.handle
      .prepare(`SELECT id, storage_key, state FROM attachments`)
      .all() as unknown as Array<{ id: string; storage_key: string; state: AttachmentState }>;
  }

  /**
   * Attachment rows left in `uploading` state when the server died
   * mid-stream. Startup reconciliation marks these failed so the UI does
   * not treat them as "still uploading forever".
   */
  listInterruptedUploads(): AttachmentRow[] {
    return this.handle
      .prepare(`SELECT * FROM attachments WHERE state = 'uploading'`)
      .all() as unknown as AttachmentRow[];
  }

  /**
   * Promote an uploading row to failed with a startup-specific code.
   * Separate from `markFailed()` so an in-flight upload cannot be
   * promoted by racing with startup.
   */
  markInterruptedOnStartup(id: string): void {
    this.handle
      .prepare(
        `UPDATE attachments
         SET state = 'failed', failure_code = 'upload_interrupted',
             failure_message = 'server restarted while this upload was in progress'
         WHERE id = ? AND state = 'uploading'`,
      )
      .run(id);
  }

  /**
   * Promote a `ready` row to failed because its on-disk blob was removed
   * out-of-band (manual rm, disk crash, admin cleanup). Only valid for
   * UNBOUND rows: a bound ready row with a missing blob is a persistent
   * data corruption we flag but do not auto-mutate.
   */
  markReadyBlobMissing(id: string): boolean {
    const info = this.handle
      .prepare(
        `UPDATE attachments
         SET state = 'failed', failure_code = 'blob_missing',
             failure_message = 'attachment blob is missing from the data directory'
         WHERE id = ? AND state = 'ready'`,
      )
      .run(id);
    return (info as { changes?: number }).changes === 1;
  }

  storageKeysForConversation(conversationId: string): string[] {
    const rows = this.handle
      .prepare(
        `SELECT storage_key FROM attachments WHERE conversation_id = ?`,
      )
      .all(conversationId) as Array<{ storage_key: string }>;
    return rows.map((r) => r.storage_key);
  }

  toDto(row: AttachmentRow): AttachmentDto {
    return {
      id: row.id,
      conversation_id: row.conversation_id,
      sanitized_display_name: row.sanitized_display_name,
      sniffed_mime: row.sniffed_mime,
      kind: row.kind,
      byte_size: row.byte_size,
      content_sha256: row.content_sha256,
      extraction_status: row.extraction_status,
      extraction_coverage: parseExtractionCoverage(row.extraction_json, row.extraction_status),
      sniffed_width: sanitizePersistedImageDimension(row.sniffed_width),
      sniffed_height: sanitizePersistedImageDimension(row.sniffed_height),
      sniffed_pdf_pages: sanitizePersistedPageCount(row.sniffed_pdf_pages),
      sniffed_media_duration_ms: sanitizePersistedDurationMs(row.sniffed_media_duration_ms),
      sniffed_media_streams_json: sanitizePersistedStreamsJson(row.sniffed_media_streams_json),
      validated_media_format: sanitizePersistedMediaFormat(row.validated_media_format),
      normalized_media_mime: sanitizePersistedMediaMime(row.normalized_media_mime),
      state: row.state,
      created_at: row.created_at,
      bound_at: row.bound_at,
      failure:
        row.failure_code && row.failure_message
          ? { code: row.failure_code, message: row.failure_message }
          : null,
    };
  }
}

export class RunRepo {
  constructor(private readonly handle: DbHandle) {}

  insert(
    snapshot: RunSnapshot,
    opts: { idempotencyKey: string; requestDigest: string },
  ): void {
    this.handle
      .prepare(
        `INSERT INTO runs
         (id, conversation_id, user_message_id, idempotency_key, request_digest,
          snapshot_json, status, mode, execution_mode, created_at, finished_at, last_event_sequence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.id,
        snapshot.conversation_id,
        snapshot.user_message_id,
        opts.idempotencyKey,
        opts.requestDigest,
        JSON.stringify(snapshot),
        snapshot.status,
        snapshot.mode,
        snapshot.execution_mode,
        snapshot.created_at,
        snapshot.finished_at,
        snapshot.last_event_sequence,
      );
  }

  updateSnapshot(snapshot: RunSnapshot): void {
    this.handle
      .prepare(
        `UPDATE runs SET snapshot_json = ?, status = ?, finished_at = ?, last_event_sequence = ? WHERE id = ?`,
      )
      .run(
        JSON.stringify(snapshot),
        snapshot.status,
        snapshot.finished_at,
        snapshot.last_event_sequence,
        snapshot.id,
      );
  }

  get(runId: string): RunSnapshot | null {
    const row = this.handle
      .prepare("SELECT snapshot_json FROM runs WHERE id = ?")
      .get(runId) as { snapshot_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.snapshot_json) as RunSnapshot;
  }

  findByIdempotency(conversationId: string, key: string): RunRow | null {
    const row = this.handle
      .prepare(
        `SELECT id, conversation_id, user_message_id, idempotency_key, request_digest,
                snapshot_json, status, mode, execution_mode, created_at, finished_at, last_event_sequence
         FROM runs WHERE conversation_id = ? AND idempotency_key = ?`,
      )
      .get(conversationId, key) as RunRow | undefined;
    return row ?? null;
  }

  listByConversation(conversationId: string): RunSnapshot[] {
    const rows = this.handle
      .prepare(
        `SELECT snapshot_json FROM runs WHERE conversation_id = ? ORDER BY created_at ASC`,
      )
      .all(conversationId) as { snapshot_json: string }[];
    return rows.map((r) => JSON.parse(r.snapshot_json) as RunSnapshot);
  }

  activeRunIds(): string[] {
    const rows = this.handle
      .prepare(
        `SELECT id FROM runs WHERE status IN ('queued','running','waiting_for_tool','awaiting_approval','waiting_for_children')`,
      )
      .all() as { id: string }[];
    return rows.map((r) => r.id);
  }

  countActive(): number {
    const row = this.handle
      .prepare(
        `SELECT COUNT(*) AS c FROM runs WHERE status IN ('queued','running','waiting_for_tool','awaiting_approval','waiting_for_children')`,
      )
      .get() as { c: number };
    return Number(row.c);
  }
}

export class EventRepo {
  constructor(private readonly handle: DbHandle) {}

  append(event: EventEnvelope): void {
    this.handle
      .prepare(
        `INSERT INTO run_events (run_id, sequence, type, at, data_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(event.run_id, event.sequence, event.type, event.at, JSON.stringify(event.data));
  }

  listAfter(runId: string, afterSequence: number): EventEnvelope[] {
    const rows = this.handle
      .prepare(
        `SELECT run_id, sequence, type, at, data_json FROM run_events
         WHERE run_id = ? AND sequence > ?
         ORDER BY sequence ASC`,
      )
      .all(runId, afterSequence) as {
      run_id: string;
      sequence: number;
      type: string;
      at: string;
      data_json: string;
    }[];
    return rows.map((row) => ({
      run_id: row.run_id,
      sequence: Number(row.sequence),
      type: row.type as EventEnvelope["type"],
      at: row.at,
      data: JSON.parse(row.data_json),
    }));
  }

  maxSequence(runId: string): number {
    const row = this.handle
      .prepare(`SELECT COALESCE(MAX(sequence), 0) AS seq FROM run_events WHERE run_id = ?`)
      .get(runId) as { seq: number };
    return Number(row.seq);
  }
}

export class SessionRepo {
  constructor(private readonly handle: DbHandle) {}

  create(id: string, csrfToken: string): void {
    const now = new Date().toISOString();
    this.handle
      .prepare(
        `INSERT INTO sessions (id, csrf_token, created_at, last_used_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, csrfToken, now, now);
  }

  get(id: string): { id: string; csrf_token: string } | null {
    const row = this.handle
      .prepare("SELECT id, csrf_token FROM sessions WHERE id = ?")
      .get(id) as { id: string; csrf_token: string } | undefined;
    return row ?? null;
  }

  touch(id: string): void {
    this.handle
      .prepare("UPDATE sessions SET last_used_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }
}

function encodeCursor(updatedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ u: updatedAt, i: id }), "utf8").toString("base64url");
}

/** Thrown when a client-supplied pagination cursor cannot be decoded. */
export class InvalidCursorError extends Error {
  constructor() {
    super("cursor is not valid");
    this.name = "InvalidCursorError";
  }
}

function decodeCursor(cursor: string): { u: string; i: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError();
  }
  const candidate = parsed as { u?: unknown; i?: unknown } | null;
  if (!candidate || typeof candidate.u !== "string" || typeof candidate.i !== "string") {
    throw new InvalidCursorError();
  }
  return { u: candidate.u, i: candidate.i };
}

function decodeCursorUpdatedAt(cursor: string): string {
  return decodeCursor(cursor).u;
}

function decodeCursorId(cursor: string): string {
  return decodeCursor(cursor).i;
}

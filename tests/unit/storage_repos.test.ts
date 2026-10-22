// Repository behaviour against a real (in-memory) SQLite: conversation
// pagination, attachment lifecycle transitions, quotas, and the failure-message
// sanitizer that guards the DTO/export boundary.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DbHandle } from "../../src/storage/db.js";
import {
  AttachmentRepo,
  ConversationRepo,
  EventRepo,
  MessageRepo,
  RunRepo,
  SessionRepo,
  sanitizeFailureMessage,
} from "../../src/storage/repos.js";
import type { AttachmentExtractionCoverage, RunSnapshot } from "../../src/shared/types.js";

let db: DbHandle;
let convs: ConversationRepo;
let msgs: MessageRepo;
let atts: AttachmentRepo;
beforeEach(() => {
  db = openDatabase(":memory:");
  convs = new ConversationRepo(db);
  msgs = new MessageRepo(db);
  atts = new AttachmentRepo(db);
});
afterEach(() => db.close());

const coverage = (): AttachmentExtractionCoverage =>
  ({ status: "text_extracted", chars: 5 }) as unknown as AttachmentExtractionCoverage;

function upload(conversationId: string, name = "a.txt", key: string = crypto.randomUUID()): string {
  return atts.insertUploading({
    conversationId,
    storageKey: key,
    sanitizedDisplayName: name,
    declaredMime: "text/plain",
    createdAt: new Date().toISOString(),
  });
}
function ready(id: string, bytes = 10): void {
  atts.markReady({
    id,
    sniffedMime: "text/plain",
    kind: "text",
    byteSize: bytes,
    contentSha256: "a".repeat(64),
    extractionStatus: "text_extracted",
    extractionCoverage: coverage(),
    extractedText: "hello",
    sniffedWidth: null,
    sniffedHeight: null,
    sniffedPdfPages: null,
    sniffedMediaDurationMs: null,
    sniffedMediaStreamsJson: null,
    validatedMediaFormat: null,
    normalizedMediaMime: null,
  });
}
function userMessage(conversationId: string, text = "hi") {
  const m = {
    id: crypto.randomUUID(),
    conversation_id: conversationId,
    run_id: crypto.randomUUID(),
    role: "user" as const,
    text,
    sequence: msgs.nextSequence(conversationId),
    created_at: new Date().toISOString(),
  };
  msgs.insert(m);
  return m;
}

describe("ConversationRepo", () => {
  it("lists newest-updated first with a stable keyset cursor and no duplicates across pages", () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const c = convs.create(`c${i}`);
      db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(`2026-01-01T00:00:0${i}.000Z`, c.id);
      ids.push(c.id);
    }
    const p1 = convs.list(2, null);
    expect(p1.items.map((c) => c.id)).toEqual([ids[4], ids[3]]);
    expect(p1.next_cursor).toBeTruthy();
    const p2 = convs.list(2, p1.next_cursor);
    expect(p2.items.map((c) => c.id)).toEqual([ids[2], ids[1]]);
    const p3 = convs.list(2, p2.next_cursor);
    expect(p3.items.map((c) => c.id)).toEqual([ids[0]]);
    expect(p3.next_cursor).toBeNull();
  });

  it("breaks updated_at ties by id so pages never skip or repeat", () => {
    const a = convs.create("a");
    const b = convs.create("b");
    const c = convs.create("c");
    db.prepare("UPDATE conversations SET updated_at = '2026-02-02T00:00:00.000Z'").run();
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = convs.list(1, cursor);
      seen.push(...page.items.map((x) => x.id));
      cursor = page.next_cursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(3);
    expect(seen).toEqual([a.id, b.id, c.id].sort().reverse());
  });

  it("returns null for an unknown conversation and renames only a default title once", () => {
    expect(convs.get("nope")).toBeNull();
    const c = convs.create("New conversation");
    convs.renameFromFirstMessage(c.id, "   alpha   beta gamma delta epsilon zeta eta theta iota kappa  ");
    expect(convs.get(c.id)!.title).toBe("alpha beta gamma delta epsilon zeta eta theta");
    convs.renameFromFirstMessage(c.id, "second prompt");
    expect(convs.get(c.id)!.title).toBe("alpha beta gamma delta epsilon zeta eta theta");
    convs.renameFromFirstMessage("missing", "x"); // no throw
  });

  it("keeps the default title for a whitespace-only first message", () => {
    const c = convs.create("New conversation");
    convs.renameFromFirstMessage(c.id, "   \n ");
    expect(convs.get(c.id)!.title).toBe("New conversation");
  });

  it("deletes a conversation that has messages and BOUND attachments without an FK error", () => {
    const c = convs.create("x");
    const id = upload(c.id);
    ready(id);
    const m = userMessage(c.id);
    atts.bindToMessage(m.id, [id]);
    expect(atts.get(id)!.state).toBe("bound");
    convs.delete(c.id);
    expect(convs.get(c.id)).toBeNull();
    expect(atts.get(id)).toBeNull();
    expect(msgs.list(c.id)).toEqual([]);
  });

  it("hasActiveRun reflects only non-terminal runs for that conversation", () => {
    const c = convs.create("x");
    expect(convs.hasActiveRun(c.id)).toBe(false);
    const runs = new RunRepo(db);
    const m = userMessage(c.id);
    const snap = { id: m.run_id, conversation_id: c.id, user_message_id: m.id, mode: "quick", execution_mode: "mock", status: "running", created_at: "t", finished_at: null, last_event_sequence: 1 } as unknown as RunSnapshot;
    runs.insert(snap, { idempotencyKey: "k", requestDigest: "d" });
    expect(convs.hasActiveRun(c.id)).toBe(true);
    expect(runs.countActive()).toBe(1);
    expect(runs.activeRunIds()).toEqual([snap.id]);
    snap.status = "completed";
    snap.finished_at = "t2";
    runs.updateSnapshot(snap);
    expect(convs.hasActiveRun(c.id)).toBe(false);
    expect(runs.countActive()).toBe(0);
    expect(runs.findByIdempotency(c.id, "k")!.status).toBe("completed");
    expect(runs.findByIdempotency(c.id, "other")).toBeNull();
    expect(runs.get("missing")).toBeNull();
    expect(runs.listByConversation(c.id).map((r) => r.id)).toEqual([snap.id]);
  });
});

describe("MessageRepo", () => {
  it("numbers messages per conversation and returns them in order", () => {
    const c1 = convs.create("a");
    const c2 = convs.create("b");
    expect(msgs.nextSequence(c1.id)).toBe(1);
    userMessage(c1.id, "one");
    userMessage(c1.id, "two");
    userMessage(c2.id, "other");
    expect(msgs.nextSequence(c1.id)).toBe(3);
    expect(msgs.list(c1.id).map((m) => m.text)).toEqual(["one", "two"]);
    expect(msgs.list("empty")).toEqual([]);
  });

  it("attaches ordered attachment refs only to the message they were bound to", () => {
    const c = convs.create("a");
    const a1 = upload(c.id, "first.txt");
    const a2 = upload(c.id, "second.txt");
    ready(a1);
    ready(a2);
    const withFiles = userMessage(c.id, "with");
    const without = userMessage(c.id, "without");
    atts.bindToMessage(withFiles.id, [a2, a1]);
    const listed = msgs.list(c.id);
    expect(listed.find((m) => m.id === withFiles.id)!.attachments!.map((r) => r.sanitized_display_name)).toEqual([
      "second.txt",
      "first.txt",
    ]);
    expect(listed.find((m) => m.id === without.id)!.attachments).toBeUndefined();
  });
});

describe("AttachmentRepo lifecycle", () => {
  it("moves uploading -> ready and exposes a DTO without internal storage fields", () => {
    const c = convs.create("a");
    const id = upload(c.id, "doc.txt", "key-1");
    expect(atts.get(id)!.state).toBe("uploading");
    ready(id, 123);
    const dto = atts.toDto(atts.get(id)!);
    expect(dto).toMatchObject({ id, conversation_id: c.id, state: "ready", kind: "text", byte_size: 123, failure: null });
    expect(JSON.stringify(dto)).not.toContain("key-1");
    expect(dto).not.toHaveProperty("storage_key");
    expect(dto).not.toHaveProperty("extracted_text");
  });

  it("markFailed only affects uploading rows and sanitizes unsafe messages", () => {
    const c = convs.create("a");
    const id = upload(c.id);
    atts.markFailed({ id, code: "upload_failed", message: "ENOENT: /Users/me/secret/file" });
    const row = atts.get(id)!;
    expect(row.state).toBe("failed");
    expect(row.failure_code).toBe("upload_failed");
    expect(row.failure_message).toBe("attachment unavailable");
    expect(atts.toDto(row).failure).toEqual({ code: "upload_failed", message: "attachment unavailable" });

    const okId = upload(c.id);
    ready(okId);
    atts.markFailed({ id: okId, code: "late", message: "late" });
    expect(atts.get(okId)!.state).toBe("ready");
    ready(id); // markReady on a failed row is a no-op
    expect(atts.get(id)!.state).toBe("failed");
  });

  it("getIfOwned enforces the conversation boundary (IDOR)", () => {
    const a = convs.create("a");
    const b = convs.create("b");
    const id = upload(a.id);
    expect(atts.getIfOwned(a.id, id)!.id).toBe(id);
    expect(atts.getIfOwned(b.id, id)).toBeNull();
    expect(atts.getIfOwned(a.id, "missing")).toBeNull();
  });

  it("lists drafts (not bound), counts, sums bytes and tracks the global total", () => {
    const a = convs.create("a");
    const b = convs.create("b");
    const r1 = upload(a.id);
    ready(r1, 100);
    const up = upload(a.id);
    const failed = upload(a.id);
    atts.markFailed({ id: failed, code: "x", message: "failed" });
    const bound = upload(a.id);
    ready(bound, 50);
    atts.bindToMessage(userMessage(a.id).id, [bound]);
    const other = upload(b.id);
    ready(other, 7);

    expect(atts.listDraftByConversation(a.id).map((r) => r.id).sort()).toEqual([r1, up, failed].sort());
    expect(atts.draftCount(a.id)).toBe(2); // ready + uploading
    expect(atts.draftByteTotal(a.id)).toBe(100); // uploading row has 0 bytes; bound excluded
    expect(atts.totalByteSum()).toBe(157); // includes bound + other conversation
    expect(atts.draftByteTotal("empty")).toBe(0);
    expect(atts.storageKeysForConversation(a.id)).toHaveLength(4);
    expect(atts.listAllStorageKeys().map((r) => r.state).sort()).toEqual(["bound", "failed", "ready", "ready", "uploading"]);
  });

  it("deleteDraft removes uploading/ready/failed rows but never bound rows", () => {
    const c = convs.create("a");
    const r = upload(c.id);
    ready(r);
    expect(atts.deleteDraft(r)).toBe(true);
    expect(atts.deleteDraft(r)).toBe(false);
    const b = upload(c.id);
    ready(b);
    atts.bindToMessage(userMessage(c.id).id, [b]);
    expect(atts.deleteDraft(b)).toBe(false);
    expect(atts.get(b)!.state).toBe("bound");
  });

  it("an attachment can be bound to only one message", () => {
    const c = convs.create("a");
    const id = upload(c.id);
    ready(id);
    atts.bindToMessage(userMessage(c.id).id, [id]);
    expect(() => atts.bindToMessage(userMessage(c.id).id, [id])).toThrow();
  });

  it("startup reconciliation helpers: interrupted uploads and missing-blob ready rows", () => {
    const c = convs.create("a");
    const uploading = upload(c.id);
    const rdy = upload(c.id);
    ready(rdy);
    const bnd = upload(c.id);
    ready(bnd);
    atts.bindToMessage(userMessage(c.id).id, [bnd]);

    expect(atts.listInterruptedUploads().map((r) => r.id)).toEqual([uploading]);
    atts.markInterruptedOnStartup(uploading);
    const row = atts.get(uploading)!;
    expect(row.state).toBe("failed");
    expect(row.failure_code).toBe("upload_interrupted");
    atts.markInterruptedOnStartup(rdy); // only uploading rows are touched
    expect(atts.get(rdy)!.state).toBe("ready");

    expect(atts.markReadyBlobMissing(rdy)).toBe(true);
    expect(atts.get(rdy)!.failure_code).toBe("blob_missing");
    expect(atts.markReadyBlobMissing(rdy)).toBe(false);
    expect(atts.markReadyBlobMissing(bnd)).toBe(false); // bound rows are never auto-mutated
    expect(atts.get(bnd)!.state).toBe("bound");
  });
});

describe("sanitizeFailureMessage", () => {
  it.each([
    ["", "attachment unavailable"],
    ["x".repeat(161), "attachment unavailable"],
    ["bad\u0007bell", "attachment unavailable"],
    ["path /etc/passwd", "attachment unavailable"],
    ["C:\\Users\\me", "attachment unavailable"],
    ["ENOENT happened", "attachment unavailable"],
    ["errno 13", "attachment unavailable"],
    ["too large", "too large"],
    ["x".repeat(160), "x".repeat(160)],
  ])("%j -> %j", (input, expected) => {
    expect(sanitizeFailureMessage(input)).toBe(expected);
  });

  it("rejects non-string input", () => {
    expect(sanitizeFailureMessage(undefined as unknown as string)).toBe("attachment unavailable");
  });
});

describe("EventRepo and SessionRepo", () => {
  it("returns events strictly after a sequence in order with parsed data and reports the max", () => {
    const c = convs.create("a");
    const m = userMessage(c.id);
    const runs = new RunRepo(db);
    runs.insert({ id: m.run_id, conversation_id: c.id, user_message_id: m.id, mode: "quick", execution_mode: "mock", status: "queued", created_at: "t", finished_at: null, last_event_sequence: 1 } as unknown as RunSnapshot, { idempotencyKey: "k", requestDigest: "d" });
    const events = new EventRepo(db);
    expect(events.maxSequence(m.run_id)).toBe(0);
    for (const seq of [1, 2, 3]) {
      events.append({ run_id: m.run_id, sequence: seq, type: "run.updated", at: "t", data: { seq } } as never);
    }
    expect(events.listAfter(m.run_id, 1).map((e) => [e.sequence, e.data])).toEqual([
      [2, { seq: 2 }],
      [3, { seq: 3 }],
    ]);
    expect(events.listAfter(m.run_id, 3)).toEqual([]);
    expect(events.maxSequence(m.run_id)).toBe(3);
    expect(() => events.append({ run_id: m.run_id, sequence: 3, type: "run.updated", at: "t", data: {} } as never)).toThrow();
  });

  it("stores sessions and returns null for unknown ids", () => {
    const s = new SessionRepo(db);
    s.create("sid", "csrf");
    expect(s.get("sid")).toEqual({ id: "sid", csrf_token: "csrf" });
    expect(s.get("other")).toBeNull();
    s.touch("sid");
    s.touch("other");
  });
});

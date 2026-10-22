// Attachment HTTP routes through fastify.inject: upload validation and
// admission control, the store-wide upload gate, draft listing/deletion,
// and the preview/download surface for every attachment kind. Rows and blobs
// for the serving tests are seeded directly (no real parser/ffprobe), so
// these tests exercise the ROUTE contract rather than the parsers.

import fs from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConversation, makeServer, waitFor, type ServerCtx } from "./_server_helpers.js";
import { _resetUploadGateForTests } from "../../src/server/routes/attachments.js";
import { ATTACHMENT_POLICY } from "../../src/core/attachments.js";
import type { extractAttachment } from "../../src/core/attachmentExtraction.js";
import type { AttachmentKind } from "../../src/shared/types.js";

type Extractor = typeof extractAttachment;

let ctx: ServerCtx | null = null;
beforeEach(() => _resetUploadGateForTests());
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await ctx?.cleanup();
  ctx = null;
  _resetUploadGateForTests();
});

const BOUNDARY = "----proofestra-srv-boundary";

function multipart(
  parts: Array<{ name?: string; filename?: string; mime?: string; body: Buffer | string; field?: boolean }>,
): { payload: Buffer; headers: Record<string, string> } {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const disposition = p.field
      ? `Content-Disposition: form-data; name="${p.name ?? "field"}"\r\n\r\n`
      : `Content-Disposition: form-data; name="${p.name ?? "file"}"; filename="${p.filename ?? "f.txt"}"\r\n` +
        `Content-Type: ${p.mime ?? "text/plain"}\r\n\r\n`;
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n${disposition}`), Buffer.from(p.body), Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` } };
}

function pngBytes(width = 1, height = 1): Buffer {
  const base = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154" +
      "78da63fcffff3f000500010191a1b1a60000000049454e44ae426082".replace(/\s/g, ""),
    "hex",
  );
  base.writeUInt32BE(width, 16);
  base.writeUInt32BE(height, 20);
  return base;
}

function upload(c: ServerCtx, convId: string, mp: { payload: Buffer; headers: Record<string, string> }) {
  return c.app.inject({
    method: "POST",
    url: `/api/v1/conversations/${convId}/attachments`,
    headers: c.headers(mp.headers),
    payload: mp.payload,
  });
}

function uploadText(c: ServerCtx, convId: string, filename = "notes.txt", body = "hello attachment") {
  return upload(c, convId, multipart([{ filename, mime: "text/plain", body }]));
}

function err(resp: { json(): unknown }): { code: string; message: string; request_id: string } {
  return (resp.json() as { error: { code: string; message: string; request_id: string } }).error;
}

interface SeedOptions {
  kind: AttachmentKind;
  mime: string;
  name?: string;
  bytes?: Buffer;
  state?: "ready" | "failed" | "uploading" | "bound";
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  streamsJson?: string | null;
  normalizedMime?: string | null;
  byteSizeOverride?: number;
  writeBlob?: boolean;
}

// Insert an attachment row (and optionally its blob) without any parser.
function seed(c: ServerCtx, conversationId: string, o: SeedOptions): { id: string; key: string; file: string } {
  const bytes = o.bytes ?? Buffer.from("seeded");
  const key = c.bundle.blobStore.mintStorageKey();
  const file = c.bundle.blobStore.pathFor(key);
  if (o.writeBlob !== false) fs.writeFileSync(file, bytes);
  const id = c.bundle.attachments.insertUploading({
    conversationId,
    storageKey: key,
    sanitizedDisplayName: o.name ?? "seed.bin",
    declaredMime: o.mime,
    createdAt: new Date().toISOString(),
  });
  const state = o.state ?? "ready";
  if (state === "uploading") return { id, key, file };
  c.bundle.attachments.markReady({
    id,
    sniffedMime: o.mime,
    kind: o.kind,
    byteSize: o.byteSizeOverride ?? bytes.length,
    contentSha256: "b".repeat(64),
    extractionStatus: "none",
    extractionCoverage: { extracted_chars: 0, truncated: false, label: "attachment-only" },
    extractedText: null,
    sniffedWidth: o.width ?? null,
    sniffedHeight: o.height ?? null,
    sniffedPdfPages: null,
    sniffedMediaDurationMs: o.durationMs ?? null,
    sniffedMediaStreamsJson: o.streamsJson ?? null,
    validatedMediaFormat: null,
    normalizedMediaMime: o.normalizedMime ?? null,
  });
  if (state === "failed") {
    c.bundle.db.prepare("UPDATE attachments SET state='failed' WHERE id=?").run(id);
  } else if (state === "bound") {
    const m = {
      id: crypto.randomUUID(),
      conversation_id: conversationId,
      run_id: crypto.randomUUID(),
      role: "user" as const,
      text: "bound",
      sequence: c.bundle.messages.nextSequence(conversationId),
      created_at: new Date().toISOString(),
    };
    c.bundle.messages.insert(m);
    c.bundle.attachments.bindToMessage(m.id, [id]);
  }
  return { id, key, file };
}

const get = (c: ServerCtx, url: string) => c.app.inject({ method: "GET", url, headers: c.headers() });

describe("upload validation", () => {
  it("rejects a malformed conversation id (400) and an unknown conversation (404) before reading the body", async () => {
    ctx = await makeServer();
    const bad = await upload(ctx, "not-a-uuid", multipart([{ body: "x" }]));
    expect(bad.statusCode).toBe(400);
    expect(err(bad).code).toBe("validation_failed");
    const missing = await upload(ctx, crypto.randomUUID(), multipart([{ body: "x" }]));
    expect(missing.statusCode).toBe(404);
    expect(err(missing).code).toBe("not_found");
    expect(fs.readdirSync(path.join(ctx.dataDir, "attachments"))).toEqual([]);
  });

  it("a successful text upload returns a ready DTO, stores exactly one 0600 blob and hides storage internals", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const r = await uploadText(ctx, id, "notes.txt", "hello attachment ก");
    expect(r.statusCode).toBe(201);
    const dto = (r.json() as { attachment: Record<string, unknown> }).attachment;
    expect(dto).toMatchObject({ conversation_id: id, state: "ready", kind: "text", sniffed_mime: "text/plain", sanitized_display_name: "notes.txt" });
    expect(dto.byte_size).toBe(Buffer.byteLength("hello attachment ก"));
    expect(String(dto.content_sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(dto)).not.toContain("storage_key");
    const files = fs.readdirSync(path.join(ctx.dataDir, "attachments"));
    expect(files).toHaveLength(1);
    expect(fs.statSync(path.join(ctx.dataDir, "attachments", files[0]!)).mode & 0o777).toBe(0o600);
  });

  it("returns 400 'no file part' for a multipart body with zero parts", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const r = await upload(ctx, id, { payload: Buffer.from(`--${BOUNDARY}--\r\n`), headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` } });
    expect(r.statusCode).toBe(400);
    expect(err(r).code).toBe("validation_failed");
    expect(err(r).message).toContain("no file part");
  });

  it("a stray non-file field is ignored; a body with only a field has no file part", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const r = await upload(ctx, id, multipart([{ field: true, name: "note", body: "x" }]));
    expect(r.statusCode).toBe(400);
    expect(ctx.bundle.attachments.listDraftByConversation(id)).toEqual([]);
  });

  it("a non-multipart content type is 415 unsupported_media_type (never a 500) and creates no row or blob", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const r = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/conversations/${id}/attachments`,
      headers: ctx.headers({ "content-type": "application/json" }),
      payload: { hello: "world" },
    });
    expect(r.statusCode).toBe(415);
    expect(err(r).code).toBe("unsupported_media_type");
    expect(ctx.bundle.attachments.listDraftByConversation(id)).toEqual([]);
    expect(fs.readdirSync(path.join(ctx.dataDir, "attachments"))).toEqual([]);
  });

  it("a second file part rejects the WHOLE upload and leaves no ready row or blob", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const r = await upload(ctx, id, multipart([{ filename: "a.txt", body: "one" }, { filename: "b.txt", body: "two" }]));
    expect(r.statusCode).toBe(400);
    expect(["too_many_files", "validation_failed"]).toContain(err(r).code);
    expect(ctx.bundle.attachments.listDraftByConversation(id).filter((a) => a.state === "ready")).toEqual([]);
    expect(fs.readdirSync(path.join(ctx.dataDir, "attachments"))).toEqual([]);
  });

  it("a truncated multipart body is a 400 multipart_malformed and removes the partial blob", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const head = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\npartial bytes`;
    const r = await upload(ctx, id, { payload: Buffer.from(head), headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` } });
    expect(r.statusCode).toBe(400);
    expect(err(r).code).toBe("multipart_malformed");
    expect(fs.readdirSync(path.join(ctx.dataDir, "attachments"))).toEqual([]);
    const rows = ctx.bundle.attachments.listDraftByConversation(id);
    expect(rows.every((x) => x.state === "failed")).toBe(true);
  });

  it("rejects a declared type that contradicts the sniffed content (415 mime_mismatch) and removes the blob", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const r = await upload(ctx, id, multipart([{ filename: "pic.png", mime: "image/png", body: "just plain text, not a png" }]));
    expect(r.statusCode).toBe(415);
    expect(err(r).code).toBe("mime_mismatch");
    expect(fs.readdirSync(path.join(ctx.dataDir, "attachments"))).toEqual([]);
    expect(ctx.bundle.attachments.listDraftByConversation(id)[0]!.state).toBe("failed");
  });

  it("an oversize file (> 25 MiB) is 413 attachment_limit, the row is failed and the partial blob is gone", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const big = Buffer.alloc(ATTACHMENT_POLICY.max_file_bytes + 1, 0x61);
    const r = await upload(ctx, id, multipart([{ filename: "big.txt", body: big }]));
    expect(r.statusCode).toBe(413);
    expect(err(r).code).toBe("attachment_limit");
    expect(fs.readdirSync(path.join(ctx.dataDir, "attachments"))).toEqual([]);
    expect(ctx.bundle.attachments.listDraftByConversation(id).map((a) => a.state)).toEqual(["failed"]);
  });

  it("a name that is unsafe is sanitized before storage (no separators or control bytes)", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const r = await upload(ctx, id, multipart([{ filename: "../../etc/pass\u0007wd.txt", body: "x" }]));
    expect(r.statusCode).toBe(201);
    const name = (r.json() as { attachment: { sanitized_display_name: string } }).attachment.sanitized_display_name;
    expect(name).not.toMatch(/[\\/\u0000-\u001f]/);
    expect(name.startsWith(".")).toBe(false);
  });
});

describe("admission caps", () => {
  it("refuses a 9th draft attachment per conversation with 409 attachment_limit", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    for (let i = 0; i < ATTACHMENT_POLICY.max_files_per_turn; i += 1) {
      seed(ctx, id, { kind: "text", mime: "text/plain", name: `d${i}.txt` });
    }
    const r = await uploadText(ctx, id);
    expect(r.statusCode).toBe(409);
    expect(err(r).code).toBe("attachment_limit");
    // The cap is per conversation: another conversation still accepts uploads.
    const other = await createConversation(ctx);
    expect((await uploadText(ctx, other)).statusCode).toBe(201);
  });

  it("returns 507 attachment_quota when the store-wide byte quota is already reached", async () => {
    ctx = await makeServer();
    const a = await createConversation(ctx);
    const b = await createConversation(ctx);
    seed(ctx, a, { kind: "binary", mime: "application/octet-stream", byteSizeOverride: ATTACHMENT_POLICY.max_store_bytes, writeBlob: false });
    const r = await uploadText(ctx, b);
    expect(r.statusCode).toBe(507);
    expect(err(r).code).toBe("attachment_quota");
  });

  it("enforces the composer byte budget mid-stream (413) and keeps the earlier draft", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const keep = seed(ctx, id, { kind: "binary", mime: "application/octet-stream", byteSizeOverride: ATTACHMENT_POLICY.max_composer_bytes - 10, writeBlob: false });
    const r = await uploadText(ctx, id, "x.txt", "this is more than ten bytes");
    expect(r.statusCode).toBe(413);
    expect(err(r).message).toContain("composer limit");
    expect(ctx.bundle.attachments.get(keep.id)!.state).toBe("ready");
    expect(fs.readdirSync(path.join(ctx.dataDir, "attachments"))).toEqual([]);
  });

  it("enforces the store byte budget mid-stream (413) when other conversations used almost all of it", async () => {
    ctx = await makeServer();
    const a = await createConversation(ctx);
    const b = await createConversation(ctx);
    seed(ctx, a, { kind: "binary", mime: "application/octet-stream", state: "bound", byteSizeOverride: ATTACHMENT_POLICY.max_store_bytes - 10, writeBlob: false });
    const r = await uploadText(ctx, b, "x.txt", "this is more than ten bytes");
    expect(r.statusCode).toBe(413);
    expect(err(r).message).toContain("store quota");
  });
});

describe("upload failures after the body is accepted", () => {
  it("a throwing extractor yields 500 upload_failed with no leaked detail; the row is failed and the blob removed", async () => {
    const extractor: Extractor = async () => {
      throw new Error("parser exploded at /Users/secret/work/file.bin (ENOENT)");
    };
    ctx = await makeServer({ buildOptions: { extractAttachmentImpl: extractor } });
    const id = await createConversation(ctx);
    const r = await uploadText(ctx, id);
    expect(r.statusCode).toBe(500);
    expect(err(r).code).toBe("upload_failed");
    expect(r.payload).not.toContain("secret");
    expect(r.payload).not.toContain("ENOENT");
    const row = ctx.bundle.attachments.listDraftByConversation(id)[0]!;
    expect(row.state).toBe("failed");
    expect(row.failure_code).toBe("upload_failed");
    expect(row.failure_message).toBe("attachment unavailable");
    expect(fs.readdirSync(path.join(ctx.dataDir, "attachments"))).toEqual([]);
    // The gate was released: the next upload (with the same failing extractor) still reaches the handler.
    expect((await uploadText(ctx, id)).statusCode).toBe(500);
  });

  it("persists validated extractor metadata (pdf pages, media duration/streams/format) and drops invalid values", async () => {
    const extractor: Extractor = async () => ({
      status: "text_extracted",
      coverage: { extracted_chars: 3, truncated: false, label: "text" },
      extractedText: "abc",
      pdf_pages: 3,
      media_duration_seconds: 1.5,
      media_streams_json: JSON.stringify([{ codec_type: "audio", codec_name: "pcm_s16le" }]),
      validated_media_format: "wav",
      normalized_media_mime: "audio/wav",
    });
    ctx = await makeServer({ buildOptions: { extractAttachmentImpl: extractor } });
    const id = await createConversation(ctx);
    const r = await uploadText(ctx, id);
    expect(r.statusCode).toBe(201);
    const dto = (r.json() as { attachment: Record<string, unknown> }).attachment;
    expect(dto.sniffed_pdf_pages).toBe(3);
    expect(dto.sniffed_media_duration_ms).toBe(1500);
    expect(dto.validated_media_format).toBe("wav");
    expect(dto.normalized_media_mime).toBe("audio/wav");
    expect(String(dto.sniffed_media_streams_json)).toContain("pcm_s16le");

    const bad: Extractor = async () => ({
      status: "none",
      coverage: { extracted_chars: 0, truncated: false, label: "x" },
      extractedText: null,
      pdf_pages: -4,
      media_duration_seconds: Number.NaN,
      media_streams_json: "{not json",
    });
    await ctx.cleanup();
    ctx = await makeServer({ buildOptions: { extractAttachmentImpl: bad } });
    const id2 = await createConversation(ctx);
    const r2 = await uploadText(ctx, id2);
    expect(r2.statusCode).toBe(201);
    const dto2 = (r2.json() as { attachment: Record<string, unknown> }).attachment;
    expect(dto2.sniffed_pdf_pages).toBeNull();
    expect(dto2.sniffed_media_duration_ms).toBeNull();
    expect(dto2.sniffed_media_streams_json).toBeNull();
  });

  it("an extractor that is still running when the slot deadline passes gets 504 upload_timeout; the gate frees for the next upload", async () => {
    // Fake only timers so inject's I/O keeps working.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let release!: () => void;
    const hang: Extractor = (input) =>
      new Promise((resolve) => {
        release = () => resolve({ status: "none", coverage: { extracted_chars: 0, truncated: false, label: "x" }, extractedText: null });
        input.signal?.addEventListener("abort", () => resolve({ status: "none", coverage: { extracted_chars: 0, truncated: false, label: "x" }, extractedText: null }));
      });
    ctx = await makeServer({ buildOptions: { extractAttachmentImpl: hang } });
    const id = await createConversation(ctx);
    const pending = uploadText(ctx, id);
    await vi.waitFor(() => expect(ctx!.bundle.attachments.listDraftByConversation(id).length).toBe(1));
    await vi.advanceTimersByTimeAsync(120_001);
    const r = await pending;
    expect(r.statusCode).toBe(504);
    expect(err(r).code).toBe("upload_timeout");
    expect(ctx.bundle.attachments.listDraftByConversation(id)[0]!.state).toBe("failed");
    expect(ctx.bundle.attachments.listDraftByConversation(id)[0]!.failure_code).toBe("upload_timeout");
    expect(fs.readdirSync(path.join(ctx.dataDir, "attachments"))).toEqual([]);
    void release;
  });
});

describe("upload gate", () => {
  it("serializes uploads and answers 429 upload_busy when the waiting queue is full, then drains in order", async () => {
    let release!: () => void;
    const gateHeld = new Promise<void>((r) => (release = r));
    let started = 0;
    const slow: Extractor = async () => {
      started += 1;
      if (started === 1) await gateHeld;
      return { status: "text_extracted", coverage: { extracted_chars: 1, truncated: false, label: "text" }, extractedText: "x" };
    };
    ctx = await makeServer({ buildOptions: { extractAttachmentImpl: slow } });
    const convs: string[] = [];
    for (let i = 0; i < 34; i += 1) convs.push(await createConversation(ctx));

    const first = uploadText(ctx, convs[0]!);
    await waitFor(() => started === 1);
    // 32 waiters fill the queue (maxWaiting = 32).
    const waiters = convs.slice(1, 33).map((c) => uploadText(ctx!, c));
    // Let every waiter reach the gate before the overflow request.
    await new Promise((r) => setTimeout(r, 300));
    const overflow = await uploadText(ctx, convs[33]!);
    expect(overflow.statusCode).toBe(429);
    expect(err(overflow).code).toBe("upload_busy");
    expect(started).toBe(1); // nobody ran concurrently with the holder

    release();
    const results = await Promise.all([first, ...waiters]);
    expect(results.map((r) => r.statusCode)).toEqual(Array(33).fill(201));
    // Gate is idle again.
    expect((await uploadText(ctx, convs[33]!)).statusCode).toBe(201);
  }, 30_000);

  it("a queued upload that exceeds the gate deadline gets 504 upload_timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let started = 0;
    const hang: Extractor = (input) =>
      new Promise((resolve) => {
        started += 1;
        input.signal?.addEventListener("abort", () => resolve({ status: "none", coverage: { extracted_chars: 0, truncated: false, label: "x" }, extractedText: null }));
      });
    ctx = await makeServer({ buildOptions: { extractAttachmentImpl: hang } });
    const a = await createConversation(ctx);
    const b = await createConversation(ctx);
    const holder = uploadText(ctx, a);
    await vi.waitFor(() => expect(started).toBe(1));
    const queued = uploadText(ctx, b);
    // Give the queued request time to reach the gate (real I/O still runs).
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(120_001);
    const [h, q] = await Promise.all([holder, queued]);
    expect(h.statusCode).toBe(504);
    expect(q.statusCode).toBe(504);
    expect(started).toBe(1);
    expect(ctx.bundle.attachments.listDraftByConversation(b)).toEqual([]);
  });
});

describe("list, policy and deletion", () => {
  it("serves the attachment policy", async () => {
    ctx = await makeServer();
    const r = await get(ctx, "/api/v1/attachments/policy");
    expect(r.statusCode).toBe(200);
    const policy = (r.json() as { policy: Record<string, unknown> }).policy;
    expect(policy.max_files_per_turn ?? policy.maxFilesPerTurn).toBe(ATTACHMENT_POLICY.max_files_per_turn);
  });

  it("lists drafts of one conversation only (uploading/ready/failed, not bound) and validates ids", async () => {
    ctx = await makeServer();
    const a = await createConversation(ctx);
    const b = await createConversation(ctx);
    const ready = seed(ctx, a, { kind: "text", mime: "text/plain" });
    const failed = seed(ctx, a, { kind: "text", mime: "text/plain", state: "failed" });
    seed(ctx, a, { kind: "text", mime: "text/plain", state: "bound" });
    seed(ctx, b, { kind: "text", mime: "text/plain" });
    const listed = (await get(ctx, `/api/v1/conversations/${a}/attachments`)).json() as { items: { id: string; state: string }[] };
    expect(listed.items.map((i) => i.id).sort()).toEqual([ready.id, failed.id].sort());
    expect((await get(ctx, "/api/v1/conversations/nope/attachments")).statusCode).toBe(400);
    expect((await get(ctx, `/api/v1/conversations/${crypto.randomUUID()}/attachments`)).statusCode).toBe(404);
  });

  it("deletes a ready draft (204) and removes its blob; unknown id 404; malformed id 400", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const s = seed(ctx, id, { kind: "text", mime: "text/plain" });
    const del = await ctx.app.inject({ method: "DELETE", url: `/api/v1/attachments/${s.id}`, headers: ctx.bodyless() });
    expect(del.statusCode).toBe(204);
    expect(ctx.bundle.attachments.get(s.id)).toBeNull();
    expect(fs.existsSync(s.file)).toBe(false);
    const again = await ctx.app.inject({ method: "DELETE", url: `/api/v1/attachments/${s.id}`, headers: ctx.bodyless() });
    expect(again.statusCode).toBe(404);
    const bad = await ctx.app.inject({ method: "DELETE", url: "/api/v1/attachments/xyz", headers: ctx.bodyless() });
    expect(bad.statusCode).toBe(400);
  });

  it("refuses to delete a bound attachment (409 attachment_bound) and keeps blob and row", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const s = seed(ctx, id, { kind: "text", mime: "text/plain", state: "bound" });
    const del = await ctx.app.inject({ method: "DELETE", url: `/api/v1/attachments/${s.id}`, headers: ctx.bodyless() });
    expect(del.statusCode).toBe(409);
    expect(err(del).code).toBe("attachment_bound");
    expect(ctx.bundle.attachments.get(s.id)!.state).toBe("bound");
    expect(fs.existsSync(s.file)).toBe(true);
  });

  it("deleting a still-uploading row (no in-flight handler, e.g. orphaned) simply removes it", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const s = seed(ctx, id, { kind: "text", mime: "text/plain", state: "uploading" });
    const del = await ctx.app.inject({ method: "DELETE", url: `/api/v1/attachments/${s.id}`, headers: ctx.bodyless() });
    expect(del.statusCode).toBe(204);
    expect(ctx.bundle.attachments.get(s.id)).toBeNull();
  });

  it("DELETE of an in-flight upload aborts it: the upload ends 409 attachment_removed, nothing is left behind, the gate is free", async () => {
    let aborted = false;
    let started = 0;
    const hang: Extractor = (input) =>
      new Promise((resolve) => {
        started += 1;
        input.signal?.addEventListener("abort", () => {
          aborted = true;
          resolve({ status: "none", coverage: { extracted_chars: 0, truncated: false, label: "x" }, extractedText: null });
        });
      });
    ctx = await makeServer({ buildOptions: { extractAttachmentImpl: hang } });
    const id = await createConversation(ctx);
    const pending = uploadText(ctx, id);
    await waitFor(() => started === 1);
    const row = ctx.bundle.attachments.listDraftByConversation(id)[0]!;
    expect(row.state).toBe("uploading");
    const del = await ctx.app.inject({ method: "DELETE", url: `/api/v1/attachments/${row.id}`, headers: ctx.bodyless() });
    expect(del.statusCode).toBe(204);
    const r = await pending;
    expect(aborted).toBe(true);
    expect(r.statusCode).toBe(409);
    expect(err(r).code).toBe("attachment_removed");
    expect(ctx.bundle.attachments.get(row.id)).toBeNull();
    expect(fs.readdirSync(path.join(ctx.dataDir, "attachments"))).toEqual([]);
  });

  it("DELETE of the CONVERSATION aborts its in-flight upload (409 attachment_removed) and cascades cleanly", async () => {
    let started = 0;
    const hang: Extractor = (input) =>
      new Promise((resolve) => {
        started += 1;
        input.signal?.addEventListener("abort", () =>
          resolve({ status: "none", coverage: { extracted_chars: 0, truncated: false, label: "x" }, extractedText: null }),
        );
      });
    ctx = await makeServer({ buildOptions: { extractAttachmentImpl: hang } });
    const id = await createConversation(ctx);
    const ready = seed(ctx, id, { kind: "text", mime: "text/plain" });
    const pending = uploadText(ctx, id);
    await waitFor(() => started === 1);
    const del = await ctx.app.inject({ method: "DELETE", url: `/api/v1/conversations/${id}`, headers: ctx.bodyless() });
    expect(del.statusCode).toBe(204);
    const r = await pending;
    expect(r.statusCode).toBe(409);
    expect(err(r).code).toBe("attachment_removed");
    expect(ctx.bundle.conversations.get(id)).toBeNull();
    expect(fs.existsSync(ready.file)).toBe(false);
    expect(fs.readdirSync(path.join(ctx.dataDir, "attachments"))).toEqual([]);
  });
});

describe("preview and download", () => {
  const HOSTILE_NAME = 'we"ird\\na\u0001me ก.png';

  it("serves a safe PNG inline with a sandbox CSP, nosniff, private no-store and a sanitized Content-Disposition", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const png = pngBytes(8, 8);
    const s = seed(ctx, id, { kind: "image", mime: "image/png", name: HOSTILE_NAME, bytes: png, width: 8, height: 8 });
    const r = await get(ctx, `/api/v1/attachments/${s.id}/preview`);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png");
    expect(r.headers["content-length"]).toBe(String(png.length));
    expect(r.headers["cache-control"]).toBe("private, no-store");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(String(r.headers["content-security-policy"])).toContain("default-src 'none'");
    expect(String(r.headers["content-security-policy"])).toContain("sandbox");
    const cd = String(r.headers["content-disposition"]);
    expect(cd.startsWith("inline; filename=\"")).toBe(true);
    const ascii = /filename="([^"]*)"/.exec(cd)![1]!;
    expect(ascii).not.toMatch(/["\\\u0000-\u001f]/);
    expect(cd).toContain("filename*=UTF-8''");
    expect(cd).toContain("%E0%B8%81"); // ก percent-encoded
    expect(Buffer.compare(r.rawPayload, png)).toBe(0);
  });

  it("the same image via /download is an attachment disposition", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const s = seed(ctx, id, { kind: "image", mime: "image/png", name: "p.png", bytes: pngBytes(8, 8), width: 8, height: 8 });
    const r = await get(ctx, `/api/v1/attachments/${s.id}/download`);
    expect(r.statusCode).toBe(200);
    expect(String(r.headers["content-disposition"]).startsWith("attachment;")).toBe(true);
  });

  it.each([
    ["excessive declared dimensions", 100_000, 100_000],
    ["unknown dimensions (e.g. JPEG)", null, null],
    ["one missing side", 100, null],
  ])("refuses to preview a raster image with %s (422, no bytes) but still allows download", async (_label, w, h) => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const bytes = Buffer.from("\u00ff\u00d8\u00ffRASTER-BYTES", "latin1");
    const s = seed(ctx, id, { kind: "image", mime: "image/jpeg", name: "x.jpg", bytes, width: w, height: h });
    const preview = await get(ctx, `/api/v1/attachments/${s.id}/preview`);
    expect(preview.statusCode).toBe(422);
    expect(err(preview).code).toBe("preview_unavailable");
    expect(preview.payload).not.toContain("RASTER-BYTES");
    const dl = await get(ctx, `/api/v1/attachments/${s.id}/download`);
    expect(dl.statusCode).toBe(200);
    expect(Buffer.compare(dl.rawPayload, bytes)).toBe(0);
  });

  it("serves text inline as text/plain but never as HTML, and forces download-only kinds to octet-stream attachment", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const text = seed(ctx, id, { kind: "text", mime: "text/plain", name: "page.html", bytes: Buffer.from("<script>alert(1)</script>") });
    const t = await get(ctx, `/api/v1/attachments/${text.id}/preview`);
    expect(t.statusCode).toBe(200);
    expect(t.headers["content-type"]).toBe("text/plain");
    expect(String(t.headers["content-disposition"]).startsWith("inline;")).toBe(true);
    expect(String(t.headers["content-security-policy"])).toContain("default-src 'none'");

    for (const [kind, mime, name] of [
      ["pdf", "application/pdf", "doc.pdf"],
      ["archive", "application/zip", "bundle.zip"],
      ["binary", "application/xml", "vector.svg"],
      ["document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx"],
    ] as const) {
      const s = seed(ctx, id, { kind, mime, name, bytes: Buffer.from("<svg onload=alert(1)/>") });
      for (const mode of ["preview", "download"]) {
        const r = await get(ctx, `/api/v1/attachments/${s.id}/${mode}`);
        expect(r.statusCode, `${kind} ${mode}`).toBe(200);
        expect(r.headers["content-type"], `${kind} ${mode}`).toBe("application/octet-stream");
        expect(String(r.headers["content-disposition"]).startsWith("attachment;"), `${kind} ${mode}`).toBe(true);
        expect(r.headers["x-content-type-options"]).toBe("nosniff");
      }
    }
  });

  const AUDIO_STREAMS = JSON.stringify([{ codec_type: "audio", codec_name: "pcm_s16le" }]);
  const VIDEO_STREAMS = JSON.stringify([{ codec_type: "video", codec_name: "h264", width: 320, height: 240 }]);

  it("serves validated audio and video inline and withholds unvalidated or hostile media (422 preview_unavailable)", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const audio = seed(ctx, id, { kind: "audio", mime: "audio/wav", name: "tone.wav", bytes: Buffer.from("RIFFxxxxWAVE"), durationMs: 1000, streamsJson: AUDIO_STREAMS, normalizedMime: "audio/wav" });
    const video = seed(ctx, id, { kind: "video", mime: "video/mp4", name: "clip.mp4", bytes: Buffer.from("....ftypisom"), durationMs: 1000, streamsJson: VIDEO_STREAMS, normalizedMime: "video/mp4" });
    for (const [s, mime] of [[audio, "audio/wav"], [video, "video/mp4"]] as const) {
      const r = await get(ctx, `/api/v1/attachments/${s.id}/preview`);
      expect(r.statusCode).toBe(200);
      expect(r.headers["content-type"]).toBe(mime);
      expect(String(r.headers["content-disposition"]).startsWith("inline;")).toBe(true);
    }

    const noMeta = seed(ctx, id, { kind: "audio", mime: "audio/wav", name: "old.wav" });
    const noDuration = seed(ctx, id, { kind: "audio", mime: "audio/wav", name: "nodur.wav", streamsJson: AUDIO_STREAMS, normalizedMime: "audio/wav" });
    const hostileVideo = seed(ctx, id, {
      kind: "video",
      mime: "video/mp4",
      name: "huge.mp4",
      durationMs: 1000,
      streamsJson: JSON.stringify([{ codec_type: "video", codec_name: "h264", width: 65_535, height: 65_535 }]),
      normalizedMime: "video/mp4",
    });
    for (const s of [noMeta, noDuration, hostileVideo]) {
      const preview = await get(ctx, `/api/v1/attachments/${s.id}/preview`);
      expect(preview.statusCode).toBe(422);
      expect(err(preview).code).toBe("preview_unavailable");
      expect((await get(ctx, `/api/v1/attachments/${s.id}/download`)).statusCode).toBe(200);
    }
  });

  it("404s uploading/failed/unknown attachments and a row whose blob vanished; 400s a malformed id", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const uploading = seed(ctx, id, { kind: "text", mime: "text/plain", state: "uploading" });
    const failed = seed(ctx, id, { kind: "text", mime: "text/plain", state: "failed" });
    const gone = seed(ctx, id, { kind: "text", mime: "text/plain", writeBlob: false });
    for (const s of [uploading, failed, gone]) {
      for (const mode of ["preview", "download"]) {
        const r = await get(ctx, `/api/v1/attachments/${s.id}/${mode}`);
        expect(r.statusCode).toBe(404);
        expect(err(r).code).toBe("not_found");
      }
    }
    expect((await get(ctx, `/api/v1/attachments/${crypto.randomUUID()}/preview`)).statusCode).toBe(404);
    expect((await get(ctx, "/api/v1/attachments/zzz/preview")).statusCode).toBe(400);
    expect((await get(ctx, "/api/v1/attachments/zzz/download")).statusCode).toBe(400);
  });

  it("serves bound attachments (frozen history stays viewable)", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const s = seed(ctx, id, { kind: "text", mime: "text/plain", state: "bound", bytes: Buffer.from("frozen") });
    const r = await get(ctx, `/api/v1/attachments/${s.id}/preview`);
    expect(r.statusCode).toBe(200);
    expect(r.payload).toBe("frozen");
  });

  it("an uploaded text file round-trips byte-for-byte through download", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const body = "round trip ก\nline two";
    const up = (await uploadText(ctx, id, "rt.txt", body)).json() as { attachment: { id: string } };
    const dl = await get(ctx, `/api/v1/attachments/${up.attachment.id}/download`);
    expect(dl.payload).toBe(body);
  });
});

describe("more upload/serve edge cases", () => {
  it("a large multi-chunk upload is hashed and stored byte-for-byte", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const body = Buffer.alloc(300 * 1024);
    for (let i = 0; i < body.length; i += 1) body[i] = 0x61 + (i % 26);
    const r = await uploadText(ctx, id, "big.txt", body.toString("latin1"));
    expect(r.statusCode).toBe(201);
    const dto = (r.json() as { attachment: { id: string; byte_size: number; content_sha256: string } }).attachment;
    expect(dto.byte_size).toBe(body.length);
    const { createHash } = await import("node:crypto");
    expect(dto.content_sha256).toBe(createHash("sha256").update(body).digest("hex"));
    const dl = await get(ctx, `/api/v1/attachments/${dto.id}/download`);
    expect(Buffer.compare(dl.rawPayload, body)).toBe(0);
  });

  it("an upload that arrives in several network chunks (head sniff spanning chunks) is stored intact", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const head = Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="chunks.txt"\r\nContent-Type: text/plain\r\n\r\n`);
    const file = Buffer.alloc(150);
    for (let i = 0; i < file.length; i += 1) file[i] = 0x41 + (i % 26);
    async function* chunks(): AsyncGenerator<Buffer> {
      yield Buffer.concat([head, file.subarray(0, 40)]);
      await new Promise((r) => setTimeout(r, 15));
      yield file.subarray(40, 100);
      await new Promise((r) => setTimeout(r, 15));
      yield Buffer.concat([file.subarray(100), Buffer.from(`\r\n--${BOUNDARY}--\r\n`)]);
    }
    const r = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/conversations/${id}/attachments`,
      headers: ctx.headers({ "content-type": `multipart/form-data; boundary=${BOUNDARY}` }),
      payload: Readable.from(chunks()),
    });
    expect(r.statusCode).toBe(201);
    const dto = (r.json() as { attachment: { id: string; byte_size: number; kind: string } }).attachment;
    expect(dto).toMatchObject({ byte_size: 150, kind: "text" });
    expect((await get(ctx, `/api/v1/attachments/${dto.id}/download`)).payload).toBe(file.toString("latin1"));
  });

  it.each([
    ["image", "image/jpeg"],
    ["image", "image/webp"],
    ["image", "image/gif"],
  ] as const)("previews a safe-dimension %s (%s) inline", async (kind, mime) => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const s = seed(ctx, id, { kind, mime, width: 16, height: 16, bytes: Buffer.from("raster") });
    const r = await get(ctx, `/api/v1/attachments/${s.id}/preview`);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe(mime);
  });

  it.each([
    ["audio", "audio/mpeg"],
    ["audio", "audio/mp3"],
    ["audio", "audio/ogg"],
    ["audio", "audio/flac"],
    ["video", "video/webm"],
    ["video", "video/quicktime"],
  ] as const)("previews validated %s (%s) inline", async (kind, mime) => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const streams =
      kind === "audio"
        ? JSON.stringify([{ codec_type: "audio", codec_name: "mp3" }])
        : JSON.stringify([{ codec_type: "video", codec_name: "h264", width: 64, height: 48 }]);
    const s = seed(ctx, id, { kind, mime, durationMs: 1500, streamsJson: streams, normalizedMime: ({ "audio/mp3": "audio/mpeg", "video/quicktime": "video/mov" } as Record<string, string>)[mime] ?? mime });
    const r = await get(ctx, `/api/v1/attachments/${s.id}/preview`);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe(mime);
    expect(String(r.headers["content-disposition"]).startsWith("inline;")).toBe(true);
  });

  it("an unlisted audio/video/image MIME is never previewed inline (served as an attachment)", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    for (const [kind, mime] of [["audio", "audio/x-evil"], ["video", "video/x-evil"], ["image", "image/svg+xml"], ["text", "application/json"]] as const) {
      const s = seed(ctx, id, { kind, mime, width: 8, height: 8, durationMs: 1000, streamsJson: "[]", normalizedMime: mime });
      const r = await get(ctx, `/api/v1/attachments/${s.id}/preview`);
      expect(r.statusCode).toBe(200);
      expect(r.headers["content-type"]).toBe("application/octet-stream");
      expect(String(r.headers["content-disposition"]).startsWith("attachment;")).toBe(true);
    }
  });

  it("DELETE of an unrelated conversation never aborts another conversation's in-flight upload", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = 0;
    const slow: Extractor = async () => {
      started += 1;
      await gate;
      return { status: "none", coverage: { extracted_chars: 0, truncated: false, label: "x" }, extractedText: null };
    };
    ctx = await makeServer({ buildOptions: { extractAttachmentImpl: slow } });
    const a = await createConversation(ctx);
    const b = await createConversation(ctx);
    const pending = uploadText(ctx, a);
    await waitFor(() => started === 1);
    expect((await ctx.app.inject({ method: "DELETE", url: `/api/v1/conversations/${b}`, headers: ctx.bodyless() })).statusCode).toBe(204);
    release();
    const r = await pending;
    expect(r.statusCode).toBe(201);
    expect(ctx.bundle.attachments.get((r.json() as { attachment: { id: string } }).attachment.id)!.state).toBe("ready");
  });

  it("a conversation deleted between admission and the first file part ends 409 attachment_removed with nothing left behind", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const real = ctx.bundle.conversations.get.bind(ctx.bundle.conversations);
    vi.spyOn(ctx.bundle.conversations, "get").mockImplementationOnce(real).mockReturnValueOnce(null);
    const r = await uploadText(ctx, id);
    expect(r.statusCode).toBe(409);
    expect(err(r).code).toBe("attachment_removed");
    expect(fs.readdirSync(path.join(ctx.dataDir, "attachments"))).toEqual([]);
    expect(ctx.bundle.attachments.listDraftByConversation(id)).toEqual([]);
  });

  it("DELETE reports 409 attachment_bound if the row stopped being deletable concurrently", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const s = seed(ctx, id, { kind: "text", mime: "text/plain" });
    vi.spyOn(ctx.bundle.attachments, "deleteDraft").mockReturnValue(false);
    const r = await ctx.app.inject({ method: "DELETE", url: `/api/v1/attachments/${s.id}`, headers: ctx.bodyless() });
    expect(r.statusCode).toBe(409);
    expect(err(r).code).toBe("attachment_bound");
    expect(fs.existsSync(s.file)).toBe(true);
  });

  it("a blob that cannot be unlinked does not fail an attachment or conversation delete (orphans are pruned at next start)", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const s = seed(ctx, id, { kind: "text", mime: "text/plain" });
    vi.spyOn(ctx.bundle.blobStore, "unlinkSafely").mockRejectedValue(new Error("EACCES /root/secret"));
    const del = await ctx.app.inject({ method: "DELETE", url: `/api/v1/attachments/${s.id}`, headers: ctx.bodyless() });
    expect(del.statusCode).toBe(204);
    expect(del.payload).not.toContain("EACCES");
    const s2 = seed(ctx, id, { kind: "text", mime: "text/plain" });
    const delConv = await ctx.app.inject({ method: "DELETE", url: `/api/v1/conversations/${id}`, headers: ctx.bodyless() });
    expect(delConv.statusCode).toBe(204);
    expect(ctx.bundle.attachments.get(s2.id)).toBeNull();
  });

  it("an empty file is stored as a zero-byte binary attachment (sniffs as unknown, so the declared text type is not contradicted)", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const r = await upload(ctx, id, multipart([{ filename: "empty.txt", mime: "text/plain", body: "" }]));
    expect(r.statusCode).toBe(201);
    const dto = (r.json() as { attachment: { byte_size: number; kind: string; sniffed_mime: string; state: string } }).attachment;
    expect(dto).toMatchObject({ byte_size: 0, kind: "binary", sniffed_mime: "application/octet-stream", state: "ready" });
  });
});

describe("client disconnect mid-body (real loopback socket on port 0)", () => {
  it("a client that vanishes halfway through the body leaves no row, blob or held upload slot, and the next upload succeeds", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    await ctx.app.listen({ host: "127.0.0.1", port: 0 });
    const port = (ctx.app.server.address() as import("node:net").AddressInfo).port;
    const http = await import("node:http");
    const head = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="cut.txt"\r\nContent-Type: text/plain\r\n\r\n`;
    await new Promise<void>((resolve) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: `/api/v1/conversations/${id}/attachments`,
          headers: {
            host: ctx!.hostHeader,
            cookie: ctx!.cookie,
            origin: ctx!.config.origin,
            "x-csrf-token": ctx!.csrf,
            "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
            // Promise far more bytes than will ever be sent.
            "content-length": "100000",
            connection: "close",
          },
        },
        () => undefined,
      );
      req.on("error", () => undefined);
      req.write(head + "x".repeat(200));
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 100);
    });
    await waitFor(() => {
      const rows = ctx!.bundle.attachments.listDraftByConversation(id);
      return rows.length === 1 && rows[0]!.state === "failed";
    });
    const row = ctx.bundle.attachments.listDraftByConversation(id)[0]!;
    expect(row.failure_code).toBe("client_closed_request");
    await waitFor(() => fs.readdirSync(path.join(ctx!.dataDir, "attachments")).length === 0);
    // The store-wide upload gate is free again.
    const next = await uploadText(ctx, id);
    expect(next.statusCode).toBe(201);
  });
});

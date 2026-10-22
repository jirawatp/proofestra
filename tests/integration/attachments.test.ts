// Integration tests for the attachment HTTP surface. These run against a
// real socket (not fastify.inject) because the regressions we care about
// involve stream backpressure, multipart error propagation on real sockets,
// and the connection-close path of fastify-multipart 9.4.0 (which fixed the
// upstream uncaught FileStream "Part terminated early" crash).
//
// Isolation: each test gets its own temp dataDir on an ephemeral port.
// Nothing touches the user's running npm start on 3000.

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { makeTestApp, type TestApp, type TestAppOptions } from "./_helpers.js";
import { extractAttachment, type ExtractionInput, type ExtractionResult } from "../../src/core/attachmentExtraction.js";
import { Worker } from "node:worker_threads";
import { runAttachmentWorker, type WorkerFactory, type WorkerLike } from "../../src/core/workerExtraction.js";
import { describeBinaryToolCapabilities } from "../../src/core/parsers/binaryTools.js";

interface Listening {
  ctx: TestApp;
  port: number;
  conversationId: string;
  csrf: string;
  cookie: string;
  origin: string;
  dataDir: string;
}

async function startListening(options: TestAppOptions = {}): Promise<Listening> {
  const ctx = await makeTestApp(options);
  await ctx.app.listen({ host: "127.0.0.1", port: 0 });
  const address = ctx.app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind test server");
  }
  const port = address.port;
  // Create a conversation to attach into.
  const createResp = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/conversations",
    headers: {
      host: `127.0.0.1:${ctx.config.port}`,
      cookie: ctx.sessionCookie,
      origin: ctx.origin,
      "x-csrf-token": ctx.csrf,
      "content-type": "application/json",
    },
    payload: { title: "attachments test" },
  });
  expect(createResp.statusCode).toBe(201);
  const conversationId = (createResp.json() as { id: string }).id;
  return {
    ctx,
    port,
    conversationId,
    csrf: ctx.csrf,
    cookie: ctx.sessionCookie,
    origin: ctx.origin,
    dataDir: ctx.config.dataDir,
  };
}

function buildMultipart(
  filename: string,
  mime: string,
  body: Buffer,
  boundary = "----proofestra-test-boundary",
): { body: Buffer; headers: Record<string, string> } {
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const payload = Buffer.concat([head, body, tail]);
  return {
    body: payload,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(payload.length),
    },
  };
}

/** Build a multipart body that terminates in the middle of the file part. */
function buildMalformedMultipart(
  filename: string,
  mime: string,
  partialBody: Buffer,
  boundary = "----proofestra-test-boundary",
): { body: Buffer; headers: Record<string, string> } {
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
  );
  const payload = Buffer.concat([head, partialBody]);
  return {
    body: payload,
    headers: {
      // Declare the length WITHOUT the closing boundary. The connection
      // completes but busboy sees Part terminated early.
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(payload.length),
    },
  };
}

async function doRequest(
  listening: Listening,
  method: "POST" | "DELETE" | "GET",
  pathAndQuery: string,
  payload: Buffer | string | null,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const base: Record<string, string> = {
    // Server validates the Host header against the configured port (3000
    // in tests), independent of the actual TCP port we bind to (0 ->
    // ephemeral).
    host: `127.0.0.1:${listening.ctx.config.port}`,
    cookie: listening.cookie,
    origin: `http://127.0.0.1:${listening.ctx.config.port}`,
    "x-csrf-token": listening.csrf,
    // Avoid idle keep-alive sockets: `app.close()` in afterEach otherwise
    // intermittently waits out Node's 5 s keep-alive timeout.
    connection: "close",
    ...extraHeaders,
  };
  if (payload != null && !("content-length" in base)) {
    base["content-length"] = String(Buffer.byteLength(payload as never));
  }
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: listening.port,
        method,
        path: pathAndQuery,
        headers: base,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

function pngOnePixel(): Buffer {
  // 1×1 white PNG, 68 bytes.
  return Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f00050" +
      "0010191a1b1a60000000049454e44ae426082",
    "hex",
  );
}

/**
 * Produce a byte-tiny PNG whose IHDR declares the given width/height.
 * The CRC bytes are left as the 1×1 original's (invalid), which is
 * exactly the point: this is a malicious head that a real decoder
 * would refuse to render, but which the server's cheap 64-byte head
 * sniff accepts as `image/png` with those declared dimensions. We use
 * it to prove the preview-dimension guard refuses raster inline
 * disposition no matter how trusted-looking the sniffed mime is.
 */
function pngWithDeclaredDimensions(widthPx: number, heightPx: number): Buffer {
  const base = Buffer.from(pngOnePixel());
  base.writeUInt32BE(widthPx, 16);
  base.writeUInt32BE(heightPx, 20);
  return base;
}

/**
 * Minimal `image/jpeg` fixture whose SOI marker satisfies the server
 * mime sniff but whose SOF marker lives past the 64-byte head slice
 * (we don't bother to include one). This is exactly the "dimensions
 * unknown" case for the preview guard: the server has no persisted
 * `sniffed_width` / `sniffed_height` and MUST refuse inline raster
 * disposition.
 */
function jpegUnknownDimensions(): Buffer {
  // SOI (ff d8) + APP0/JFIF (ff e0 00 10 "JFIF\0" 01 01 00 00 01 00 01 00 00) + EOI (ff d9).
  // Total 22 bytes; no SOF marker, so dimensions never resolve.
  return Buffer.from(
    "ffd8ffe000104a46494600010100000100010000ffd9",
    "hex",
  );
}

describe("attachments HTTP surface", () => {
  let listening: Listening | null = null;

  beforeEach(async () => {
    listening = await startListening();
  });
  afterEach(async () => {
    if (listening) {
      await listening.ctx.app.close();
      await listening.ctx.cleanup();
      listening = null;
    }
  });

  it("accepts a valid PNG upload and persists exactly one blob", async () => {
    const l = listening!;
    const png = pngOnePixel();
    const mp = buildMultipart("pixel.png", "image/png", png);
    const resp = await doRequest(
      l,
      "POST",
      `/api/v1/conversations/${l.conversationId}/attachments`,
      mp.body,
      mp.headers,
    );
    expect(resp.status).toBe(201);
    const body = JSON.parse(resp.body.toString("utf-8")) as {
      attachment: { id: string; sniffed_mime: string; byte_size: number; state: string };
    };
    expect(body.attachment.sniffed_mime).toBe("image/png");
    expect(body.attachment.state).toBe("ready");
    expect(body.attachment.byte_size).toBe(png.length);
    // Exactly one blob under the attachments directory.
    const attachmentsDir = path.join(l.dataDir, "attachments");
    const files = fs.readdirSync(attachmentsDir);
    expect(files.length).toBe(1);
  });

  it("rejects a malformed multipart body WITHOUT crashing the process, and still accepts a valid upload after it", async () => {
    const l = listening!;
    // Malformed: declare 1 KiB of PNG body but drop the closing boundary.
    const png = pngOnePixel();
    const bad = buildMalformedMultipart("broken.png", "image/png", png);
    const r1 = await doRequest(
      l,
      "POST",
      `/api/v1/conversations/${l.conversationId}/attachments`,
      bad.body,
      bad.headers,
    );
    // Malformed-body MUST map to a 4xx; a 500 would indicate the server
    // leaked a parser-side exception as an opaque "upload_failed".
    expect([400, 413]).toContain(r1.status);
    // No successful attachment was persisted.
    const attachmentsDir = path.join(l.dataDir, "attachments");
    const afterBad = fs.existsSync(attachmentsDir) ? fs.readdirSync(attachmentsDir) : [];
    expect(afterBad.length).toBe(0);

    // The server MUST still be responsive. Issue a valid upload and
    // verify it succeeds.
    const good = buildMultipart("good.png", "image/png", png);
    const r2 = await doRequest(
      l,
      "POST",
      `/api/v1/conversations/${l.conversationId}/attachments`,
      good.body,
      good.headers,
    );
    expect(r2.status).toBe(201);
    const files = fs.readdirSync(attachmentsDir);
    expect(files.length).toBe(1);
  });

  it("rejects a second file part in the same multipart body", async () => {
    const l = listening!;
    const boundary = "----proofestra-two-files";
    const png = pngOnePixel();
    const two = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="a.png"\r\n`),
      Buffer.from(`Content-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="b.png"\r\n`),
      Buffer.from(`Content-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const resp = await doRequest(
      l,
      "POST",
      `/api/v1/conversations/${l.conversationId}/attachments`,
      two,
      {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(two.length),
      },
    );
    // Must map to a 4xx. 500 would indicate the FST_FILES_LIMIT exception
    // leaked as an opaque "upload_failed" instead of a classified reject.
    expect([400, 413]).toContain(resp.status);
  });

  it("rejects when a Thai-named plain-text upload declares image/png (MIME spoof) but still accepts a Thai-named text/plain upload", async () => {
    const l = listening!;
    // UTF-8 bytes for "สวัสดี.txt" encoded in the filename field.
    const thai = "สวัสดี.txt";
    const body = Buffer.from("สวัสดีจากการทดสอบ\n", "utf-8");
    // Spoofed: declare image/png but body is text.
    const spoof = buildMultipart(thai, "image/png", body);
    const r1 = await doRequest(
      l,
      "POST",
      `/api/v1/conversations/${l.conversationId}/attachments`,
      spoof.body,
      spoof.headers,
    );
    expect(r1.status).toBe(415);
    // Honest: text/plain.
    const honest = buildMultipart(thai, "text/plain", body);
    const r2 = await doRequest(
      l,
      "POST",
      `/api/v1/conversations/${l.conversationId}/attachments`,
      honest.body,
      honest.headers,
    );
    expect(r2.status).toBe(201);
    const parsed = JSON.parse(r2.body.toString("utf-8")) as {
      attachment: { sniffed_mime: string; sanitized_display_name: string; extraction_status: string };
    };
    expect(parsed.attachment.sniffed_mime).toBe("text/plain");
    expect(parsed.attachment.extraction_status).toBe("text_extracted");
    // The display name should still carry non-ASCII; the ASCII fallback
    // is only used on the download path's Content-Disposition.
    expect(parsed.attachment.sanitized_display_name.includes("สวัสดี")).toBe(true);
  });

  it("persists sniffed image dimensions in the ready DTO (PNG head-sniff)", async () => {
    const l = listening!;
    const png = pngOnePixel();
    const mp = buildMultipart("pixel.png", "image/png", png);
    const resp = await doRequest(
      l,
      "POST",
      `/api/v1/conversations/${l.conversationId}/attachments`,
      mp.body,
      mp.headers,
    );
    expect(resp.status).toBe(201);
    const dto = (JSON.parse(resp.body.toString("utf-8")) as {
      attachment: { sniffed_width: number | null; sniffed_height: number | null };
    }).attachment;
    expect(dto.sniffed_width).toBe(1);
    expect(dto.sniffed_height).toBe(1);
  });

  it("GET /preview refuses raster images with excessive declared dimensions (422 preview_unavailable, no bytes); /download still serves authenticated attachment", async () => {
    // Craft a byte-tiny PNG whose IHDR declares 100000×100000. The
    // server's 64-byte head sniff accepts it as `image/png` with those
    // dimensions. A real decoder would reject the broken CRC, but the
    // preview surface MUST not even attempt to serve inline bytes
    // because the browser would OOM / decode an enormous raster.
    const l = listening!;
    const png = pngWithDeclaredDimensions(100_000, 100_000);
    const up = await doRequest(
      l,
      "POST",
      `/api/v1/conversations/${l.conversationId}/attachments`,
      buildMultipart("huge.png", "image/png", png).body,
      buildMultipart("huge.png", "image/png", png).headers,
    );
    expect(up.status).toBe(201);
    const dto = (JSON.parse(up.body.toString("utf-8")) as {
      attachment: {
        id: string;
        sniffed_mime: string;
        sniffed_width: number | null;
        sniffed_height: number | null;
      };
    }).attachment;
    expect(dto.sniffed_mime).toBe("image/png");
    // Persisted dimensions reflect the declared header; the server
    // refuses to render them inline, but keeps them so the native
    // routing decision stays honest.
    expect(dto.sniffed_width).toBe(100_000);
    expect(dto.sniffed_height).toBe(100_000);

    // /preview MUST return 422 preview_unavailable with no raster bytes.
    const prev = await doRequest(
      l,
      "GET",
      `/api/v1/attachments/${dto.id}/preview`,
      null,
    );
    expect(prev.status).toBe(422);
    expect(String(prev.headers["content-type"] ?? "")).toContain("application/json");
    const body = JSON.parse(prev.body.toString("utf-8")) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("preview_unavailable");
    // Body is a JSON error, not image bytes. The raw PNG signature
    // must NOT appear anywhere.
    expect(prev.body.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false);

    // /download still serves the authenticated bytes as an attachment
    // (user-initiated download remains possible; eager inline
    // embedding does not trigger a download).
    const dl = await doRequest(
      l,
      "GET",
      `/api/v1/attachments/${dto.id}/download`,
      null,
    );
    expect(dl.status).toBe(200);
    // The explicit download path serves the sniffed mime as
    // `Content-Disposition: attachment`. That disposition is what
    // prevents a browser from rendering it in-place; the user still
    // has to accept a save prompt.
    expect(String(dl.headers["content-disposition"] ?? "")).toContain("attachment");
    expect(dl.body.length).toBe(png.length);
    expect(dl.body.equals(png)).toBe(true);
  });

  it("GET /preview refuses raster images with unknown dimensions (JPEG without SOF in head slice) with 422 preview_unavailable", async () => {
    const l = listening!;
    const jpg = jpegUnknownDimensions();
    const up = await doRequest(
      l,
      "POST",
      `/api/v1/conversations/${l.conversationId}/attachments`,
      buildMultipart("unknown.jpg", "image/jpeg", jpg).body,
      buildMultipart("unknown.jpg", "image/jpeg", jpg).headers,
    );
    expect(up.status).toBe(201);
    const dto = (JSON.parse(up.body.toString("utf-8")) as {
      attachment: {
        id: string;
        sniffed_mime: string;
        sniffed_width: number | null;
        sniffed_height: number | null;
      };
    }).attachment;
    expect(dto.sniffed_mime).toBe("image/jpeg");
    // JPEG head-sniff never sees SOF; dimensions stay null.
    expect(dto.sniffed_width).toBeNull();
    expect(dto.sniffed_height).toBeNull();

    const prev = await doRequest(
      l,
      "GET",
      `/api/v1/attachments/${dto.id}/preview`,
      null,
    );
    expect(prev.status).toBe(422);
    const body = JSON.parse(prev.body.toString("utf-8")) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("preview_unavailable");
    // No JPEG SOI either.
    expect(prev.body.includes(Buffer.from([0xff, 0xd8]))).toBe(false);
  });

  it("GET /preview serves a safe-dimensions PNG inline (regression gate)", async () => {
    const l = listening!;
    const png = pngOnePixel();
    const up = await doRequest(
      l,
      "POST",
      `/api/v1/conversations/${l.conversationId}/attachments`,
      buildMultipart("ok.png", "image/png", png).body,
      buildMultipart("ok.png", "image/png", png).headers,
    );
    expect(up.status).toBe(201);
    const dto = (JSON.parse(up.body.toString("utf-8")) as {
      attachment: { id: string };
    }).attachment;
    const prev = await doRequest(
      l,
      "GET",
      `/api/v1/attachments/${dto.id}/preview`,
      null,
    );
    expect(prev.status).toBe(200);
    expect(String(prev.headers["content-type"] ?? "")).toBe("image/png");
    expect(String(prev.headers["content-disposition"] ?? "")).toContain("inline");
    expect(prev.body.length).toBe(png.length);
  });

  it("second-turn run routes history-bound attachments in attachment_coverage (not placeholders)", async () => {
    // Admission for turn 2 must build coverage for the UNION of
    // (current refs, historical refs). The second run has NO new
    // attachments but references a PNG the user attached and SENT at
    // turn 1. The frozen `attachment_coverage.routes` for the
    // (openai-default) agent MUST contain an entry whose attachment_id
    // is the turn-1 attachment, with route "native_image" (openai
    // provider + PNG + validated dimensions). Mock dispatch, however,
    // forces route="attachment_only" because the mock executionMode
    // uses the mock-effective capabilities.
    const l = listening!;
    const png = pngOnePixel();
    const up = await doRequest(
      l,
      "POST",
      `/api/v1/conversations/${l.conversationId}/attachments`,
      buildMultipart("pixel.png", "image/png", png).body,
      buildMultipart("pixel.png", "image/png", png).headers,
    );
    expect(up.status).toBe(201);
    const attachmentId = (JSON.parse(up.body.toString("utf-8")) as { attachment: { id: string } })
      .attachment.id;
    // Turn 1: bind the attachment.
    const r1 = await doRequest(
      l,
      "POST",
      `/api/v1/conversations/${l.conversationId}/runs`,
      JSON.stringify({
        execution_mode: "mock",
        mode: "quick",
        agents: [{ agent_id: crypto.randomUUID(), name: "A1", profile_id: "mock-balanced" }],
        prompt: "first turn with attachment",
        attachment_ids: [attachmentId],
      }),
      { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    );
    expect([200, 201, 202]).toContain(r1.status);
    const run1 = JSON.parse(r1.body.toString("utf-8")) as {
      context?: { attachments?: Array<{ id: string }>; attachment_coverage?: unknown };
    };
    // The historical attachments appear on the frozen context exactly
    // once as the "current" refs of turn 1.
    expect(run1.context?.attachments?.some((a) => a.id === attachmentId)).toBe(true);

    // Wait for turn 1 to settle (mock latency is 20 ms per `_helpers`).
    await new Promise((r) => setTimeout(r, 200));

    // Turn 2: NO new attachments. The admission must still produce a
    // routes entry for the turn-1 attachment id so follow-ups can
    // reinspect that file.
    const r2 = await doRequest(
      l,
      "POST",
      `/api/v1/conversations/${l.conversationId}/runs`,
      JSON.stringify({
        execution_mode: "mock",
        mode: "quick",
        agents: [{ agent_id: crypto.randomUUID(), name: "A1", profile_id: "mock-balanced" }],
        prompt: "second turn following up on the attached image",
      }),
      { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    );
    expect([200, 201, 202]).toContain(r2.status);
    const run2 = JSON.parse(r2.body.toString("utf-8")) as {
      context?: {
        attachments?: Array<{ id: string }>;
        attachment_coverage?: Array<{
          agent_id: string;
          routes: Array<{ attachment_id: string; route: string; reason: string }>;
        }>;
      };
    };
    const cov = run2.context?.attachment_coverage ?? [];
    expect(cov.length).toBeGreaterThan(0);
    const flattened = cov.flatMap((c) => c.routes);
    const historical = flattened.find((r) => r.attachment_id === attachmentId);
    expect(historical).toBeDefined();
    // Mock dispatch always routes to attachment_only; the mock adapter
    // never claims to read bytes. The route reason must honestly
    // describe why.
    expect(historical!.route).toBe("attachment_only");
  });

  it("deletes a conversation that already has a SENT attachment without a FK restrict error", async () => {
    const l = listening!;
    const png = pngOnePixel();
    const mp = buildMultipart("pixel.png", "image/png", png);
    const up = await doRequest(
      l,
      "POST",
      `/api/v1/conversations/${l.conversationId}/attachments`,
      mp.body,
      mp.headers,
    );
    expect(up.status).toBe(201);
    const attachmentId = (JSON.parse(up.body.toString("utf-8")) as { attachment: { id: string } })
      .attachment.id;

    // Admit a run that binds this attachment.
    const agentId = crypto.randomUUID();
    const admit = await doRequest(
      l,
      "POST",
      `/api/v1/conversations/${l.conversationId}/runs?idempotency_key=k1`,
      JSON.stringify({
        execution_mode: "mock",
        mode: "quick",
        agents: [{ agent_id: agentId, name: "A1", profile_id: "mock-balanced" }],
        prompt: "describe the attached image",
        attachment_ids: [attachmentId],
      }),
      { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    );
    expect([200, 201, 202]).toContain(admit.status);

    // Wait briefly for the run to settle (it is a mock run).
    await new Promise((r) => setTimeout(r, 300));

    const del = await doRequest(
      l,
      "DELETE",
      `/api/v1/conversations/${l.conversationId}`,
      null,
    );
    expect(del.status).toBe(204);
  });
});

describe("attachments: store-wide quota across conversations", () => {
  it("serializes uploads across different conversations and enforces the shared store cap", async () => {
    const listening = await startListening();
    try {
      // Create a second conversation.
      const resp = await listening.ctx.app.inject({
        method: "POST",
        url: "/api/v1/conversations",
        headers: {
          host: `127.0.0.1:${listening.ctx.config.port}`,
          cookie: listening.cookie,
          origin: listening.origin,
          "x-csrf-token": listening.csrf,
          "content-type": "application/json",
        },
        payload: { title: "second" },
      });
      expect(resp.statusCode).toBe(201);
      const secondId = (resp.json() as { id: string }).id;

      // Fire two concurrent uploads targeting different conversations.
      // The store-wide gate must serialize them: the attachments
      // directory should contain exactly two files, each from a distinct
      // conversation. Without the gate, both uploads would snapshot the
      // same `totalByteSum` and could both admit against a shared cap.
      const png = pngOnePixel();
      const mp1 = buildMultipart("a.png", "image/png", png);
      const mp2 = buildMultipart("b.png", "image/png", png);
      const [r1, r2] = await Promise.all([
        doRequest(
          listening,
          "POST",
          `/api/v1/conversations/${listening.conversationId}/attachments`,
          mp1.body,
          mp1.headers,
        ),
        doRequest(
          listening,
          "POST",
          `/api/v1/conversations/${secondId}/attachments`,
          mp2.body,
          mp2.headers,
        ),
      ]);
      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);
      const attachmentsDir = path.join(listening.dataDir, "attachments");
      const files = fs.readdirSync(attachmentsDir);
      expect(files.length).toBe(2);
    } finally {
      await listening.ctx.app.close();
      await listening.ctx.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Content analysis: cancellation while parsing, validated metadata
// persistence, the media preview guard, and parser-capability booleans.
// ---------------------------------------------------------------------------

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures/content");
const caps = describeBinaryToolCapabilities();

function fixtureBytes(rel: string): Buffer {
  return fs.readFileSync(path.join(FIXTURES, rel));
}

async function uploadFixture(
  l: Listening,
  rel: string,
  mime: string,
): Promise<{ status: number; json: { attachment?: Record<string, unknown>; error?: { code: string } } }> {
  const mp = buildMultipart(path.basename(rel), mime, fixtureBytes(rel));
  const resp = await doRequest(
    l,
    "POST",
    `/api/v1/conversations/${l.conversationId}/attachments`,
    mp.body,
    mp.headers,
  );
  return { status: resp.status, json: JSON.parse(resp.body.toString("utf-8")) };
}

async function waitFor(check: () => boolean, ms = 8_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Send a complete multipart body and return the request so the caller can destroy the socket. */
function sendThenKeepOpen(l: Listening, filename: string, mime: string, body: Buffer): http.ClientRequest {
  const mp = buildMultipart(filename, mime, body);
  const req = http.request({
    host: "127.0.0.1",
    port: l.port,
    method: "POST",
    path: `/api/v1/conversations/${l.conversationId}/attachments`,
    headers: {
      host: `127.0.0.1:${l.ctx.config.port}`,
      cookie: l.cookie,
      origin: `http://127.0.0.1:${l.ctx.config.port}`,
      "x-csrf-token": l.csrf,
      ...mp.headers,
    },
  });
  req.on("error", () => {});
  req.write(mp.body);
  req.end();
  return req;
}

describe("attachments: disconnect during bounded parsing", () => {
  let listening: Listening | null = null;
  afterEach(async () => {
    if (listening) {
      await listening.ctx.app.close();
      await listening.ctx.cleanup();
      listening = null;
    }
  });

  it("aborts a slow extractor when the client closes AFTER the body reached EOF; row failed, no ready row/blob, gate released", async () => {
    let extractorStarted = false;
    let observedAbort = false;
    let calls = 0;
    const slow = (input: ExtractionInput): Promise<ExtractionResult> => {
      calls += 1;
      if (calls > 1) return extractAttachment(input);
      extractorStarted = true;
      return new Promise<ExtractionResult>((resolve) => {
        input.signal!.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            resolve({
              status: "failed",
              coverage: { extracted_chars: 0, truncated: false, label: "cancelled" },
              extractedText: null,
            });
          },
          { once: true },
        );
      });
    };
    listening = await startListening({ buildOptions: { extractAttachmentImpl: slow } });
    const l = listening;
    const req = sendThenKeepOpen(l, "slow.txt", "text/plain", Buffer.from("hello slow parser\n"));
    await waitFor(() => extractorStarted);
    req.destroy();
    await waitFor(() => observedAbort);

    await waitFor(() =>
      l.ctx.bundle.attachments.listDraftByConversation(l.conversationId).every((r) => r.state !== "uploading"),
    );
    const rows = l.ctx.bundle.attachments.listDraftByConversation(l.conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("failed");
    expect(rows[0]!.failure_code).toBe("client_closed_request");
    expect(rows.some((r) => r.state === "ready")).toBe(false);
    expect(fs.readdirSync(path.join(l.dataDir, "attachments"))).toHaveLength(0);

    // The gate was released after the parser settled: a following upload is admitted.
    const next = await uploadFixture(l, "pdf/empty.pdf", "application/pdf");
    expect(next.status).toBe(201);
  });

  it("cancelling a small upload while it is QUEUED behind another never hangs the gate; a third upload succeeds promptly", async () => {
    const seen: string[] = [];
    let releaseA: (() => void) | null = null;
    let aHolding = false;
    const extractor = (input: ExtractionInput): Promise<ExtractionResult> => {
      seen.push(input.sanitized_display_name ?? "?");
      if (input.sanitized_display_name === "holder-a.txt") {
        aHolding = true;
        return new Promise<ExtractionResult>((resolve) => {
          releaseA = () =>
            resolve({
              status: "text_extracted",
              coverage: { extracted_chars: 4, truncated: false, label: "held" },
              extractedText: "held",
            });
        });
      }
      return extractAttachment(input);
    };
    listening = await startListening({ buildOptions: { extractAttachmentImpl: extractor } });
    const l = listening;
    // A takes the store-wide slot and parks inside extraction.
    sendThenKeepOpen(l, "holder-a.txt", "text/plain", Buffer.from("AAAA"));
    await waitFor(() => aHolding);
    // B (a small body that is fully received) queues behind A, then goes away.
    const b = sendThenKeepOpen(l, "queued-b.txt", "text/plain", Buffer.from("BBBB"));
    await new Promise((r) => setTimeout(r, 200));
    b.destroy();
    await new Promise((r) => setTimeout(r, 200));
    releaseA!();
    // The gate must be free: C is admitted and finishes quickly.
    const started = Date.now();
    const c = await uploadFixture(l, "pdf/empty.pdf", "application/pdf");
    expect(c.status).toBe(201);
    expect(Date.now() - started).toBeLessThan(5_000);
    // B never ran extraction and left no row behind.
    expect(seen).not.toContain("queued-b.txt");
    const rows = l.ctx.bundle.attachments.listDraftByConversation(l.conversationId);
    expect(rows.map((r) => r.sanitized_display_name).sort()).toEqual(["empty.pdf", "holder-a.txt"]);
    expect(rows.every((r) => r.state === "ready")).toBe(true);
  });

  it("DELETE of the CONVERSATION mid-upload aborts the parse: the upload ends 409 (never 500), the conversation is gone, no orphan blob", async () => {
    let started = false;
    let observedAbort = false;
    const extractor = (input: ExtractionInput): Promise<ExtractionResult> => {
      started = true;
      return new Promise<ExtractionResult>((resolve) => {
        input.signal!.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            resolve({
              status: "failed",
              coverage: { extracted_chars: 0, truncated: false, label: "cancelled" },
              extractedText: null,
            });
          },
          { once: true },
        );
      });
    };
    listening = await startListening({ buildOptions: { extractAttachmentImpl: extractor } });
    const l = listening;
    const mp = buildMultipart("slow.txt", "text/plain", Buffer.from("conversation is deleted meanwhile"));
    const upload = doRequest(
      l,
      "POST",
      `/api/v1/conversations/${l.conversationId}/attachments`,
      mp.body,
      mp.headers,
    );
    await waitFor(() => started);
    const del = await doRequest(l, "DELETE", `/api/v1/conversations/${l.conversationId}`, null);
    expect(del.status).toBe(204);
    expect(observedAbort).toBe(true);
    const done = await upload;
    expect(done.status).toBeGreaterThanOrEqual(400);
    expect(done.status).toBeLessThan(500);
    expect(done.status).toBe(409);
    expect((JSON.parse(done.body.toString("utf-8")) as { error: { code: string } }).error.code).toBe(
      "attachment_removed",
    );
    const get = await doRequest(l, "GET", `/api/v1/conversations/${l.conversationId}`, null);
    expect(get.status).toBe(404);
    expect(l.ctx.bundle.attachments.listDraftByConversation(l.conversationId)).toHaveLength(0);
    expect(fs.readdirSync(path.join(l.dataDir, "attachments"))).toHaveLength(0);
  });

  it("a row that vanishes without an abort (conversation removed during extraction) ends 409 and leaves no blob", async () => {
    let doDelete: (() => void) | null = null;
    const extractor = (_input: ExtractionInput): Promise<ExtractionResult> => {
      doDelete?.();
      return Promise.resolve({
        status: "text_extracted",
        coverage: { extracted_chars: 2, truncated: false, label: "x" },
        extractedText: "ok",
      });
    };
    listening = await startListening({ buildOptions: { extractAttachmentImpl: extractor } });
    const l = listening;
    doDelete = () => l.ctx.bundle.conversations.delete(l.conversationId);
    const mp = buildMultipart("gone.txt", "text/plain", Buffer.from("row disappears"));
    const resp = await doRequest(
      l,
      "POST",
      `/api/v1/conversations/${l.conversationId}/attachments`,
      mp.body,
      mp.headers,
    );
    expect(resp.status).toBe(409);
    expect((JSON.parse(resp.body.toString("utf-8")) as { error: { code: string } }).error.code).toBe(
      "attachment_removed",
    );
    expect(fs.readdirSync(path.join(l.dataDir, "attachments"))).toHaveLength(0);
  });

  it("DELETE of a still-processing row aborts its extraction; the original request ends 409 (never 500) and the gate is free", async () => {
    let started = false;
    let observedAbort = false;
    const extractor = (input: ExtractionInput): Promise<ExtractionResult> => {
      if (input.sanitized_display_name !== "removed.txt") return extractAttachment(input);
      started = true;
      return new Promise<ExtractionResult>((resolve) => {
        input.signal!.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            resolve({
              status: "failed",
              coverage: { extracted_chars: 0, truncated: false, label: "cancelled" },
              extractedText: null,
            });
          },
          { once: true },
        );
      });
    };
    listening = await startListening({ buildOptions: { extractAttachmentImpl: extractor } });
    const l = listening;
    const mp = buildMultipart("removed.txt", "text/plain", Buffer.from("remove me while processing"));
    const original = doRequest(
      l,
      "POST",
      `/api/v1/conversations/${l.conversationId}/attachments`,
      mp.body,
      mp.headers,
    );
    await waitFor(() => started);
    const rows = l.ctx.bundle.attachments.listDraftByConversation(l.conversationId);
    expect(rows.map((r) => r.state)).toEqual(["uploading"]);
    const del = await doRequest(l, "DELETE", `/api/v1/attachments/${rows[0]!.id}`, null);
    expect(del.status).toBe(204);
    expect(observedAbort).toBe(true);
    const done = await original;
    expect(done.status).toBe(409);
    expect((JSON.parse(done.body.toString("utf-8")) as { error: { code: string } }).error.code).toBe(
      "attachment_removed",
    );
    expect(l.ctx.bundle.attachments.listDraftByConversation(l.conversationId)).toHaveLength(0);
    expect(fs.readdirSync(path.join(l.dataDir, "attachments"))).toHaveLength(0);
    const next = await uploadFixture(l, "pdf/empty.pdf", "application/pdf");
    expect(next.status).toBe(201);
  });

  it("a real worker is terminated and has EXITED before the next upload is admitted (result withheld so the abort always wins)", async () => {
    let created = false;
    let exited = false;
    let exitedWhenNextUploadStarted: boolean | null = null;
    // Wrap a REAL worker but withhold its `message` so the extraction can only
    // settle through the abort, whatever the timing of the runtime.
    const heldWorkerFactory: WorkerFactory = (entry, options) => {
      const real = new Worker(entry as string, options);
      real.on("exit", () => {
        exited = true;
      });
      created = true;
      const wrapped = new Map<(...a: never[]) => void, (...a: unknown[]) => void>();
      const facade: WorkerLike = {
        on(event: string, listener: (...a: never[]) => void): unknown {
          if (event === "message") {
            const w = (): void => undefined; // swallow the result
            wrapped.set(listener, w);
            return real.on("message", w);
          }
          return real.on(event as "error", listener as never);
        },
        removeListener(event: string, listener: (...a: never[]) => void): unknown {
          const w = wrapped.get(listener);
          return real.removeListener(event as "error", (w ?? listener) as never);
        },
        terminate: () => real.terminate(),
      } as unknown as WorkerLike;
      return facade;
    };
    let calls = 0;
    const extractor = (input: ExtractionInput): Promise<ExtractionResult> => {
      calls += 1;
      if (calls === 1) {
        return runAttachmentWorker(
          { operation: "zip", blob_path: input.blob_path, byte_size: input.byte_size },
          { signal: input.signal!, workerFactory: heldWorkerFactory, timeoutMs: 60_000 },
        );
      }
      exitedWhenNextUploadStarted = exited;
      return extractAttachment(input);
    };
    listening = await startListening({ buildOptions: { extractAttachmentImpl: extractor } });
    const l = listening;
    const req = sendThenKeepOpen(l, "bundle.zip", "application/zip", fixtureBytes("zip/supported-mixed.zip"));
    await waitFor(() => created);
    req.destroy();
    await waitFor(() =>
      l.ctx.bundle.attachments.listDraftByConversation(l.conversationId).every((r) => r.state !== "uploading"),
    );
    const rows = l.ctx.bundle.attachments.listDraftByConversation(l.conversationId);
    expect(rows.map((r) => r.state)).toEqual(["failed"]);
    expect(rows[0]!.failure_code).toBe("client_closed_request");
    expect(fs.readdirSync(path.join(l.dataDir, "attachments"))).toHaveLength(0);
    // The gate is only released after the worker is gone: the next upload's
    // extractor can observe that the worker already exited.
    const next = await uploadFixture(l, "pdf/empty.pdf", "application/pdf");
    expect(next.status).toBe(201);
    expect(exitedWhenNextUploadStarted).toBe(true);
  });
});

describe("attachments: validated metadata persistence and media preview guard", () => {
  let listening: Listening | null = null;
  beforeEach(async () => {
    listening = await startListening();
  });
  afterEach(async () => {
    if (listening) {
      await listening.ctx.app.close();
      await listening.ctx.cleanup();
      listening = null;
    }
  });

  it.skipIf(!caps.pdf_text_extraction)("persists PDF pages and coverage (requires poppler)", async () => {
    const r = await uploadFixture(listening!, "pdf/text-one-page.pdf", "application/pdf");
    expect(r.status).toBe(201);
    expect(r.json.attachment).toMatchObject({
      kind: "pdf",
      extraction_status: "text_extracted",
      sniffed_pdf_pages: 1,
    });
  });

  it.skipIf(!caps.media_metadata_probe)(
    "persists validated duration, streams, format and normalized MIME, and previews a short valid clip (requires ffprobe)",
    async () => {
      const l = listening!;
      const r = await uploadFixture(l, "media/valid-clip.mp4", "video/mp4");
      expect(r.status).toBe(201);
      const a = r.json.attachment!;
      expect(a["extraction_status"]).toBe("none");
      expect(String((a["extraction_coverage"] as { label: string }).label)).toMatch(
        /^Metadata only — no transcription/,
      );
      expect(a["sniffed_media_duration_ms"]).toBe(1000);
      expect(a["normalized_media_mime"]).toBe("video/mp4");
      expect(String(a["validated_media_format"])).toContain("mp4");
      const streams = JSON.parse(String(a["sniffed_media_streams_json"])) as Array<{ codec_name: string }>;
      expect(streams.map((s) => s.codec_name)).toEqual(["h264", "aac"]);

      const preview = await doRequest(l, "GET", `/api/v1/attachments/${String(a["id"])}/preview`, null);
      expect(preview.status).toBe(200);
      expect(preview.headers["content-type"]).toBe("video/mp4");
      expect(preview.body.equals(fixtureBytes("media/valid-clip.mp4"))).toBe(true);
    },
  );

  it.skipIf(!caps.media_metadata_probe)(
    "preview returns JSON 422 with zero media bytes for hostile/unvalidated media; /download still serves exact bytes (requires ffprobe)",
    async () => {
      const l = listening!;
      for (const rel of [
        "media/huge-dimensions-header-only.mp4",
        "media/corrupt-truncated.mp4",
        "media/unknown-duration.webm",
      ]) {
        const mime = rel.endsWith(".webm") ? "video/webm" : "video/mp4";
        const up = await uploadFixture(l, rel, mime);
        expect(up.status).toBe(201);
        const id = String(up.json.attachment!["id"]);
        // Never validated: no persisted normalized MIME or streams.
        expect(up.json.attachment!["normalized_media_mime"]).toBeNull();

        const preview = await doRequest(l, "GET", `/api/v1/attachments/${id}/preview`, null);
        expect(preview.status).toBe(422);
        expect(preview.headers["content-type"]).toMatch(/application\/json/);
        expect((JSON.parse(preview.body.toString("utf-8")) as { error: { code: string } }).error.code).toBe(
          "preview_unavailable",
        );
        const bytes = fixtureBytes(rel);
        expect(preview.body.includes(bytes.subarray(0, Math.min(bytes.length, 24)))).toBe(false);

        const download = await doRequest(l, "GET", `/api/v1/attachments/${id}/download`, null);
        expect(download.status).toBe(200);
        expect(download.headers["content-disposition"]).toMatch(/^attachment/);
        expect(download.body.equals(bytes)).toBe(true);
      }
    },
  );

  it.skipIf(!caps.media_metadata_probe)(
    "a legacy row with no persisted validation is not previewed (requires ffprobe)",
    async () => {
      const l = listening!;
      const up = await uploadFixture(l, "media/valid-tone.wav", "audio/wav");
      const id = String(up.json.attachment!["id"]);
      l.ctx.bundle.db
        .prepare("UPDATE attachments SET normalized_media_mime = NULL, sniffed_media_duration_ms = NULL WHERE id = ?")
        .run(id);
      const preview = await doRequest(l, "GET", `/api/v1/attachments/${id}/preview`, null);
      expect(preview.status).toBe(422);
      expect(preview.body.toString("utf-8")).toMatch(/uploaded before metadata probing/);
    },
  );

  it.skipIf(!caps.media_metadata_probe)(
    "preview is 422 for a two-track video where one track is unbounded, and for a codec-scrambled copy (requires ffprobe)",
    async () => {
      const l = listening!;
      const ok = await uploadFixture(l, "media/valid-clip.mp4", "video/mp4");
      const id = String(ok.json.attachment!["id"]);
      expect((await doRequest(l, "GET", `/api/v1/attachments/${id}/preview`, null)).status).toBe(200);
      l.ctx.bundle.db
        .prepare("UPDATE attachments SET sniffed_media_streams_json = ? WHERE id = ?")
        .run(
          JSON.stringify([
            { codec_type: "video", codec_name: "h264", width: 160, height: 90 },
            { codec_type: "video", codec_name: "h264", width: 60000, height: 60000 },
          ]),
          id,
        );
      const twoTrack = await doRequest(l, "GET", `/api/v1/attachments/${id}/preview`, null);
      expect(twoTrack.status).toBe(422);
      expect(twoTrack.headers["content-type"]).toMatch(/application\/json/);

      // Scramble the audio sample entry in a test-time copy.
      const scrambled = Buffer.from(fixtureBytes("media/valid-clip.mp4"));
      for (const [from, to] of [["mp4a", "zq9x"], ["esds", "zzzz"]] as const) {
        scrambled.write(to, scrambled.indexOf(Buffer.from(from)), "latin1");
      }
      const mp = buildMultipart("scrambled.mp4", "video/mp4", scrambled);
      const up = await doRequest(
        l,
        "POST",
        `/api/v1/conversations/${l.conversationId}/attachments`,
        mp.body,
        mp.headers,
      );
      const dto = (JSON.parse(up.body.toString("utf-8")) as { attachment: Record<string, unknown> }).attachment;
      expect(dto["normalized_media_mime"]).toBeNull();
      const preview = await doRequest(l, "GET", `/api/v1/attachments/${String(dto["id"])}/preview`, null);
      expect(preview.status).toBe(422);
    },
  );

  it("GET /providers never returns the profiles-file path, only whether one is configured", async () => {
    const l = listening!;
    const body = JSON.parse((await doRequest(l, "GET", "/api/v1/providers", null)).body.toString("utf-8")) as {
      catalog_source: Record<string, unknown>;
    };
    expect(body.catalog_source).toEqual({ source: "built_in", file_configured: false });
    // With a profiles file configured the path still does not leak.
    await l.ctx.app.close();
    await l.ctx.cleanup();
    listening = await startListening({
      profilesJson: {
        mode: "append",
        profiles: [
          {
            profile_id: "mock-extra",
            provider: "mock",
            label: "extra",
            model_id: "mock-extra-v1",
            safe_input_tokens: 32_000,
            max_output_tokens: 2048,
            api_shape: "mock",
            execution_backend_id: "mock-provider-api",
          },
        ],
      },
    });
    const raw = (await doRequest(listening, "GET", "/api/v1/providers", null)).body.toString("utf-8");
    const parsed = JSON.parse(raw) as { catalog_source: Record<string, unknown> };
    expect(parsed.catalog_source).toEqual({ source: "file_append", file_configured: true });
    expect(raw).not.toMatch(/profiles\.json|proofestra-test-/);
  });

  it("GET /providers exposes exactly two parser booleans and keeps live disabled", async () => {
    const l = listening!;
    const resp = await doRequest(l, "GET", "/api/v1/providers", null);
    expect(resp.status).toBe(200);
    const body = JSON.parse(resp.body.toString("utf-8")) as {
      live_enabled: boolean;
      capabilities: Record<string, unknown>;
    };
    expect(body.live_enabled).toBe(false);
    expect(Object.keys(body.capabilities).sort()).toEqual(["media_metadata_probe", "pdf_text_extraction"]);
    for (const v of Object.values(body.capabilities)) expect(typeof v).toBe("boolean");
    // Nothing but the two booleans (no path, version or tool name) is exposed.
    expect(JSON.stringify(body.capabilities)).toMatch(
      /^\{"pdf_text_extraction":(true|false),"media_metadata_probe":(true|false)\}$/,
    );
  });
});

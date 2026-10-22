// Behavior tests for the remaining branches of src/core/attachments.ts:
// display-name sanitizing, magic-byte sniffing, header dimension sniffing,
// MIME/extension consistency, the on-disk blob store, capability clamping and
// the end-to-end per-agent routing plan. Everything is pure or uses a temp dir.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ATTACHMENT_POLICY,
  attachmentTokenReserveForRoutes,
  BlobStore,
  defaultProviderCapabilities,
  effectiveCapabilitiesFor,
  getAttachmentPolicy,
  isConsistentMimePair,
  isImagePreviewDimensionsSafe,
  makeSha256Streamer,
  NATIVE_TOKEN_BUDGET_FRACTION,
  nativeAttachmentTokenReserve,
  nativeImageTokenReserve,
  nativeWireMime,
  planAttachmentRoutes,
  routeNativeAttachment,
  sanitizeDisplayName,
  sniffImageDimensions,
  sniffMime,
  AttachmentReserveInvariantError,
  type NativeCapabilitySet,
  type NativeRoutingInput,
} from "../../src/core/attachments.js";
import type { AttachmentRef } from "../../src/shared/types.js";

const bytes = (...b: number[]) => Buffer.from(b);
const ascii = (s: string) => Buffer.from(s, "ascii");

describe("sanitizeDisplayName", () => {
  it("keeps only the last path component from POSIX or Windows paths and strips unsafe characters", () => {
    expect(sanitizeDisplayName("/etc/passwd", "text/plain")).toBe("passwd");
    expect(sanitizeDisplayName("C:\\Users\\me\\report.pdf", "application/pdf")).toBe("report.pdf");
    expect(sanitizeDisplayName(`a"b'c<d>e\u0000f\u001fg\u007fh.txt`, "text/plain")).toBe("abcdefgh.txt");
    expect(sanitizeDisplayName("  spaced name.txt  ", "text/plain")).toBe("spaced name.txt");
  });

  it("removes leading dots and cuts to 160 characters", () => {
    expect(sanitizeDisplayName("...hidden.txt", "text/plain")).toBe("hidden.txt");
    expect(sanitizeDisplayName(`${"n".repeat(300)}.txt`, "text/plain")).toHaveLength(160);
  });

  it("falls back to attachment + an extension chosen from the declared MIME when nothing is left", () => {
    const cases: Array<[string, string]> = [
      ["image/png", ".png"],
      ["image/jpeg", ".jpg"],
      ["image/jpg", ".jpg"],
      ["image/webp", ".webp"],
      ["image/gif", ".gif"],
      ["application/pdf", ".pdf"],
      ["application/zip", ".zip"],
      ["application/json", ".json"],
      ["text/csv", ".csv"],
      ["text/markdown", ".txt"],
      ["audio/mpeg", ".bin"],
      ["video/mp4", ".bin"],
      ["application/x-unknown", ".bin"],
      ["", ".bin"],
    ];
    for (const [mime, ext] of cases) expect(sanitizeDisplayName("../..", mime), mime).toBe(`attachment${ext}`);
    expect(sanitizeDisplayName("", "IMAGE/PNG")).toBe("attachment.png");
    expect(sanitizeDisplayName(undefined as unknown as string, "text/plain")).toBe("attachment.txt");
  });
});

describe("sniffMime", () => {
  const pad = (b: Buffer, to = 64) => Buffer.concat([b, Buffer.alloc(Math.max(0, to - b.length), 0x20)]);

  it("recognizes every supported container by its magic bytes", () => {
    const table: Array<[string, Buffer, string, string]> = [
      ["png", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), "image/png", "image"],
      ["jpeg", bytes(0xff, 0xd8, 0xff, 0xe0), "image/jpeg", "image"],
      ["gif87", ascii("GIF87a"), "image/gif", "image"],
      ["gif89", ascii("GIF89a"), "image/gif", "image"],
      ["webp", Buffer.concat([ascii("RIFF"), bytes(0, 0, 0, 0), ascii("WEBP")]), "image/webp", "image"],
      ["svg/xml", ascii("<?XML version"), "application/xml", "binary"],
      ["pdf", ascii("%PDF-1.7"), "application/pdf", "pdf"],
      ["zip local", bytes(0x50, 0x4b, 0x03, 0x04), "application/zip", "archive"],
      ["zip empty", bytes(0x50, 0x4b, 0x05, 0x06), "application/zip", "archive"],
      ["zip spanned", bytes(0x50, 0x4b, 0x07, 0x08), "application/zip", "archive"],
      ["wav", Buffer.concat([ascii("RIFF"), bytes(0, 0, 0, 0), ascii("WAVE")]), "audio/wav", "audio"],
      ["mp3 id3", ascii("ID3\u0004"), "audio/mpeg", "audio"],
      ["mp3 sync", bytes(0xff, 0xfb, 0x90), "audio/mpeg", "audio"],
      ["ogg", ascii("OggS"), "audio/ogg", "audio"],
      ["flac", ascii("fLaC"), "audio/flac", "audio"],
      ["mp4", Buffer.concat([bytes(0, 0, 0, 0x18), ascii("ftypisom")]), "video/mp4", "video"],
      ["quicktime", Buffer.concat([bytes(0, 0, 0, 0x14), ascii("ftypqt  ")]), "video/quicktime", "video"],
      ["webm", bytes(0x1a, 0x45, 0xdf, 0xa3), "video/webm", "video"],
      ["utf8 bom", bytes(0xef, 0xbb, 0xbf, 0x68), "text/plain", "text"],
    ];
    for (const [name, head, mime, kind] of table) {
      expect(sniffMime(pad(head)), name).toEqual({ mime, kind });
    }
  });

  it("does not misclassify near-misses (short heads, wrong brand, RIFF of an unknown type)", () => {
    expect(sniffMime(bytes(0x89, 0x50, 0x4e, 0x47)).kind).not.toBe("image");
    expect(sniffMime(bytes(0xff, 0xd8)).kind).not.toBe("image");
    expect(sniffMime(ascii("GIF88a")).kind).not.toBe("image");
    expect(sniffMime(bytes(0x50, 0x4b, 0x01, 0x01)).kind).toBe("binary");
    expect(sniffMime(Buffer.concat([ascii("RIFF"), bytes(0, 0, 0, 0), ascii("AVI ")])).kind).toBe("binary");
    expect(sniffMime(bytes(0xff, 0x10)).kind).toBe("binary");
  });

  it("text detection: UTF-8 in any script is text; control bytes, NUL, invalid UTF-8 and empty are not", () => {
    for (const t of ["plain ascii\n\ttext\r\n", "สวัสดีชาวโลก", "日本語のテキスト", "emoji 😀 text"]) {
      expect(sniffMime(Buffer.from(t)), t).toEqual({ mime: "text/plain", kind: "text" });
    }
    expect(sniffMime(Buffer.alloc(0)).kind).toBe("binary");
    expect(sniffMime(Buffer.from("abc\u0000def")).kind).toBe("binary");
    expect(sniffMime(Buffer.from("abc\u0001def")).kind).toBe("binary");
    expect(sniffMime(Buffer.from("abc\u007fdef")).kind).toBe("binary");
    expect(sniffMime(bytes(0x61, 0xc3, 0x28, 0x62)).kind).toBe("binary");
  });

  it("a sample cut in the middle of a multi-byte character is still text (partial tail trimmed)", () => {
    const full = Buffer.from("ab😀", "utf8"); // 2 + 4 bytes
    for (let cut = 3; cut < full.length; cut += 1) {
      expect(sniffMime(full.subarray(0, cut)).kind, `cut at ${cut}`).toBe("text");
    }
    const thai = Buffer.from("กข", "utf8");
    expect(sniffMime(thai.subarray(0, 5)).kind).toBe("text");
  });
});

describe("sniffImageDimensions", () => {
  const png = (w: number, h: number, len = 33) => {
    const b = Buffer.alloc(len);
    bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a).copy(b, 0);
    if (len >= 24) {
      b.writeUInt32BE(w, 16);
      b.writeUInt32BE(h, 20);
    }
    return b;
  };
  const webp = (chunk: string, fill: (b: Buffer) => void) => {
    const b = Buffer.alloc(40);
    ascii("RIFF").copy(b, 0);
    ascii("WEBP").copy(b, 8);
    ascii(chunk).copy(b, 12);
    fill(b);
    return b;
  };

  it("reads PNG and GIF headers", () => {
    expect(sniffImageDimensions(png(640, 480), "image/png")).toEqual({ width: 640, height: 480 });
    expect(sniffImageDimensions(png(100_000, 100_000), "image/png")).toEqual({ width: 100_000, height: 100_000 });
    expect(sniffImageDimensions(png(1, 1, 23), "image/png")).toBeNull();
    const gif = Buffer.alloc(10);
    ascii("GIF89a").copy(gif, 0);
    gif.writeUInt16LE(320, 6);
    gif.writeUInt16LE(200, 8);
    expect(sniffImageDimensions(gif, "image/gif")).toEqual({ width: 320, height: 200 });
    expect(sniffImageDimensions(gif.subarray(0, 9), "image/gif")).toBeNull();
  });

  it("reads the three WebP flavours and refuses others and short heads", () => {
    const lossy = webp("VP8 ", (b) => {
      b.writeUInt16LE(0xc000 | 123, 26); // upper bits are scale flags
      b.writeUInt16LE(456, 28);
    });
    expect(sniffImageDimensions(lossy, "image/webp")).toEqual({ width: 123, height: 456 });
    const lossless = webp("VP8L", (b) => {
      b[21] = 99; // width-1 low byte
      b[22] = 0x40; // width-1 high bits 0, height-1 low 2 bits = 01
      b[23] = 12;
      b[24] = 0;
    });
    expect(sniffImageDimensions(lossless, "image/webp")).toEqual({ width: 100, height: 50 });
    const extended = webp("VP8X", (b) => {
      b.writeUIntLE(639, 24, 3);
      b.writeUIntLE(359, 27, 3);
    });
    expect(sniffImageDimensions(extended, "image/webp")).toEqual({ width: 640, height: 360 });
    expect(sniffImageDimensions(webp("ALPH", () => {}), "image/webp")).toBeNull();
    expect(sniffImageDimensions(lossy.subarray(0, 29), "image/webp")).toBeNull();
  });

  it("JPEG and unknown formats have no header-readable size", () => {
    expect(sniffImageDimensions(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0), "image/jpeg")).toBeNull();
    expect(sniffImageDimensions(png(5, 5), "application/pdf")).toBeNull();
  });
});

describe("isImagePreviewDimensionsSafe", () => {
  it("accepts only positive integers within the per-side and pixel caps", () => {
    expect(isImagePreviewDimensionsSafe(4096, 3906)).toBe(true);
    expect(isImagePreviewDimensionsSafe(1, 1)).toBe(true);
    for (const [w, h] of [
      [null, 5], [5, undefined], [Number.NaN, 5], [5, Number.POSITIVE_INFINITY], [1.5, 2], [2, 2.5],
      [0, 5], [5, -1], [4097, 10], [10, 4097], [4096, 4096],
    ] as Array<[number | null | undefined, number | null | undefined]>) {
      expect(isImagePreviewDimensionsSafe(w, h), `${w}x${h}`).toBe(false);
    }
  });
});

describe("isConsistentMimePair", () => {
  it("accepts agreement, unknown declared types and generic text subtypes", () => {
    expect(isConsistentMimePair("image/png", "a.png", "image/png")).toBe(true);
    expect(isConsistentMimePair("application/octet-stream", "a.bin", "text/plain")).toBe(true);
    expect(isConsistentMimePair("text/markdown", "a.md", "text/plain")).toBe(true);
    expect(isConsistentMimePair("image/png", "a.png", "image/jpeg")).toBe(true); // same category
    expect(isConsistentMimePair("application/zip", "a.docx", "application/zip")).toBe(true);
  });

  it("rejects declared/sniffed category mismatches for every known category", () => {
    for (const [declared, sniffed] of [
      ["image/png", "application/zip"],
      ["application/pdf", "image/png"],
      ["application/zip", "application/pdf"],
      ["audio/wav", "video/mp4"],
      ["video/mp4", "audio/wav"],
      ["text/plain", "image/png"],
      ["image/png", "text/plain"],
    ]) {
      expect(isConsistentMimePair(declared!, "file", sniffed!), `${declared} vs ${sniffed}`).toBe(false);
    }
  });

  it("blocks dangerous extension spoofs even when the declared type is unknown", () => {
    for (const ext of ["pdf", "jpg", "jpeg", "png", "webp", "gif", "html", "htm"]) {
      expect(isConsistentMimePair("application/octet-stream", `x.${ext}`, "application/zip"), ext).toBe(false);
    }
    for (const ext of ["html", "htm", "svg"]) {
      expect(isConsistentMimePair("application/octet-stream", `x.${ext}`, "image/png"), ext).toBe(false);
    }
    for (const ext of ["html", "htm"]) {
      expect(isConsistentMimePair("application/octet-stream", `x.${ext}`, "application/pdf"), ext).toBe(false);
    }
    expect(isConsistentMimePair("application/octet-stream", "noextension", "application/zip")).toBe(true);
    expect(isConsistentMimePair("application/octet-stream", "x.PNG", "application/zip")).toBe(false);
  });
});

describe("BlobStore", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofestra-blobstore-"));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates a private attachments directory and mints UUID keys that resolve inside it", () => {
    const store = new BlobStore({ dataDir: path.join(dir, "a") });
    expect(store.root).toBe(path.resolve(dir, "a", "attachments"));
    expect(fs.statSync(store.root).mode & 0o777).toBe(0o700);
    const key = store.mintStorageKey();
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(store.mintStorageKey()).not.toBe(key);
    expect(store.pathFor(key)).toBe(path.join(store.root, key));
    expect(store.pathFor(key.toUpperCase())).toBe(path.join(store.root, key.toUpperCase()));
  });

  it("refuses any key that is not a UUID (traversal, separators, empty, near-miss)", () => {
    const store = new BlobStore({ dataDir: path.join(dir, "b") });
    for (const bad of ["", "../../etc/passwd", "a/b", "00000000-0000-0000-0000-00000000000", "00000000-0000-0000-0000-0000000000000", "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz", " 00000000-0000-4000-8000-000000000000"]) {
      expect(() => store.pathFor(bad), JSON.stringify(bad)).toThrow("invalid storage key");
    }
  });

  it("unlinkSafely removes a blob, tolerates a missing one and rethrows real errors", async () => {
    const store = new BlobStore({ dataDir: path.join(dir, "c") });
    const key = store.mintStorageKey();
    fs.writeFileSync(store.pathFor(key), "x");
    await store.unlinkSafely(key);
    expect(fs.existsSync(store.pathFor(key))).toBe(false);
    await expect(store.unlinkSafely(key)).resolves.toBeUndefined();
    // A directory at the blob path cannot be unlinked: a genuine error, not ENOENT.
    const dirKey = store.mintStorageKey();
    fs.mkdirSync(store.pathFor(dirKey));
    await expect(store.unlinkSafely(dirKey)).rejects.toThrow();
    await expect(store.unlinkSafely("not-a-key")).rejects.toThrow("invalid storage key");
  });

  it("pruneOrphans deletes only blobs without a row, counts them, and survives undeletable entries", async () => {
    const store = new BlobStore({ dataDir: path.join(dir, "d") });
    const keep = store.mintStorageKey();
    const orphanA = store.mintStorageKey();
    const orphanB = store.mintStorageKey();
    for (const k of [keep, orphanA, orphanB]) fs.writeFileSync(store.pathFor(k), k);
    const stuck = "not-a-blob-directory";
    fs.mkdirSync(path.join(store.root, stuck));
    const pruned = await store.pruneOrphans(new Set([keep]));
    expect(pruned).toBe(2);
    expect(fs.existsSync(store.pathFor(keep))).toBe(true);
    expect(fs.existsSync(store.pathFor(orphanA))).toBe(false);
    expect(fs.existsSync(store.pathFor(orphanB))).toBe(false);
    expect(fs.existsSync(path.join(store.root, stuck))).toBe(true);
    expect(await store.pruneOrphans(new Set([keep]))).toBe(0);
  });

  it("pruneOrphans on a vanished directory prunes nothing instead of failing", async () => {
    const store = new BlobStore({ dataDir: path.join(dir, "e") });
    fs.rmSync(store.root, { recursive: true, force: true });
    await expect(store.pruneOrphans(new Set())).resolves.toBe(0);
  });
});

describe("makeSha256Streamer", () => {
  it("hashes streamed chunks identically to the whole content", () => {
    const s = makeSha256Streamer();
    s.update(Buffer.from("hello "));
    s.update(Buffer.from("world"));
    expect(s.digest()).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
    expect(makeSha256Streamer().digest()).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("policy accessor", () => {
  it("getAttachmentPolicy returns the live policy object", () => {
    expect(getAttachmentPolicy()).toBe(ATTACHMENT_POLICY);
    expect(NATIVE_TOKEN_BUDGET_FRACTION).toBe(0.5);
  });
});

describe("default provider capabilities", () => {
  it("openai/anthropic: images (with GIF) and PDF only; gemini: also audio/video and no GIF; unknown/mock: nothing", () => {
    for (const p of ["openai", "anthropic"] as const) {
      const c = defaultProviderCapabilities(p);
      expect([c.image, c.pdf, c.audio, c.video]).toEqual([true, true, false, false]);
      expect(c.image_mime_whitelist).toContain("image/gif");
      expect(c.max_native_media_aggregate_seconds).toBe(0);
    }
    const g = defaultProviderCapabilities("gemini");
    expect([g.image, g.pdf, g.audio, g.video]).toEqual([true, true, true, true]);
    expect(g.image_mime_whitelist).not.toContain("image/gif");
    expect(g.max_native_inline_media_bytes).toBe(ATTACHMENT_POLICY.max_gemini_inline_media_bytes);
    for (const p of ["mock", "something-else"] as never[]) {
      const m = defaultProviderCapabilities(p);
      expect([m.image, m.pdf, m.audio, m.video]).toEqual([false, false, false, false]);
      expect(m.max_native_pdf_pages).toBe(0);
      expect(m.image_mime_whitelist).toBeUndefined();
    }
  });
});

describe("effectiveCapabilitiesFor", () => {
  it("no override returns the provider defaults unchanged", () => {
    expect(effectiveCapabilitiesFor({}, "gemini")).toEqual(defaultProviderCapabilities("gemini"));
  });

  it("an override can switch a capability off but never on, and only tighten numeric caps", () => {
    const off = effectiveCapabilitiesFor({ capabilities: { image: false, pdf: false, audio: false, video: false } }, "gemini");
    expect([off.image, off.pdf, off.audio, off.video]).toEqual([false, false, false, false]);
    const onForMock = effectiveCapabilitiesFor({ capabilities: { image: true, pdf: true, audio: true, video: true } }, "mock");
    expect([onForMock.image, onForMock.pdf, onForMock.audio, onForMock.video]).toEqual([false, false, false, false]);

    const base = defaultProviderCapabilities("gemini");
    const tight = effectiveCapabilitiesFor(
      {
        capabilities: {
          max_native_image_bytes: 1000,
          max_native_aggregate_bytes: 2000,
          max_native_inline_media_bytes: 3000,
          max_native_audio_seconds: 10,
          max_native_video_seconds: 20,
          max_native_media_aggregate_seconds: 30,
          max_native_media_aggregate_bytes: 4000,
          max_native_pdf_pages: 5,
        },
      },
      "gemini",
    );
    expect(tight).toMatchObject({
      max_native_image_bytes: 1000,
      max_native_aggregate_bytes: 2000,
      max_native_inline_media_bytes: 3000,
      max_native_audio_seconds: 10,
      max_native_video_seconds: 20,
      max_native_media_aggregate_seconds: 30,
      max_native_media_aggregate_bytes: 4000,
      max_native_pdf_pages: 5,
    });
    const widen = effectiveCapabilitiesFor(
      { capabilities: { max_native_image_bytes: 1e12, max_native_pdf_pages: 9999, max_native_audio_seconds: -5 } },
      "gemini",
    );
    expect(widen.max_native_image_bytes).toBe(base.max_native_image_bytes);
    expect(widen.max_native_pdf_pages).toBe(base.max_native_pdf_pages);
    expect(widen.max_native_audio_seconds).toBe(0);
  });

  it("codec lists and MIME whitelists can only narrow what the provider documents", () => {
    const caps = effectiveCapabilitiesFor(
      {
        capabilities: {
          audio_codec_whitelist: ["mp3", "not-a-gemini-codec"],
          video_codec_whitelist: [],
          image_mime_whitelist: ["image/png", "image/gif"],
        },
      },
      "gemini",
    );
    expect(caps.audio_codec_whitelist).toEqual(["mp3"]);
    expect(caps.video_codec_whitelist).toEqual([]);
    expect(caps.image_mime_whitelist).toEqual(["image/png"]);

    const keepsBase = effectiveCapabilitiesFor({ capabilities: { image: true } }, "openai");
    expect(keepsBase.image_mime_whitelist).toEqual(defaultProviderCapabilities("openai").image_mime_whitelist);
    expect(keepsBase.image_mime_whitelist).not.toBe(defaultProviderCapabilities("openai").image_mime_whitelist);
    expect(keepsBase.audio_codec_whitelist).toEqual([]);

    const overrideOnly = effectiveCapabilitiesFor({ capabilities: { image_mime_whitelist: ["image/png"] } }, "mock");
    expect(overrideOnly.image_mime_whitelist).toEqual(["image/png"]);
    expect(overrideOnly.image).toBe(false);

    const neither = effectiveCapabilitiesFor({ capabilities: { image: false } }, "mock");
    expect(neither.image_mime_whitelist).toBeUndefined();
  });
});

describe("token reserves", () => {
  it("image reserve: unknown dimensions cost nothing; small images have a 1024 floor; large scale with area", () => {
    expect(nativeImageTokenReserve(null)).toBe(0);
    expect(nativeImageTokenReserve(undefined)).toBe(0);
    expect(nativeImageTokenReserve({ width: Number.NaN, height: 5 })).toBe(0);
    expect(nativeImageTokenReserve({ width: 10, height: Number.POSITIVE_INFINITY })).toBe(0);
    expect(nativeImageTokenReserve({ width: 10, height: 10 })).toBe(1024);
    expect(nativeImageTokenReserve({ width: 3000, height: 1000 })).toBe(4000);
    expect(nativeImageTokenReserve({ width: -3, height: 5 })).toBe(1024);
  });

  const ref = (over: Partial<AttachmentRef> = {}): AttachmentRef => ({
    id: "a1",
    sanitized_display_name: "f.bin",
    sniffed_mime: "application/octet-stream",
    kind: "binary",
    byte_size: 10,
    content_sha256: "0".repeat(64),
    extraction_status: "none",
    extraction_coverage: { extracted_chars: 0, truncated: false, label: "x" },
    ...over,
  });
  const framing = ATTACHMENT_POLICY.native_attachment_framing_tokens;

  it("native reserves price each route from validated metadata and throw on corrupted metadata", () => {
    expect(nativeAttachmentTokenReserve(ref({ sniffed_width: 3000, sniffed_height: 1000 }), "native_image")).toBe(4000 + framing);
    expect(nativeAttachmentTokenReserve(ref({ sniffed_pdf_pages: 4 }), "native_pdf")).toBe(4 * 3000 + framing);
    expect(nativeAttachmentTokenReserve(ref({ sniffed_media_duration_ms: 1500 }), "native_audio")).toBe(2 * 64 + framing);
    expect(nativeAttachmentTokenReserve(ref({ sniffed_media_duration_ms: 1500 }), "native_video")).toBe(2 * 512 + framing);
    for (const [r, route] of [
      [ref({ sniffed_width: null, sniffed_height: 5 }), "native_image"],
      [ref({ sniffed_width: 5000, sniffed_height: 5 }), "native_image"],
      [ref({ sniffed_pdf_pages: 0 }), "native_pdf"],
      [ref({}), "native_pdf"],
      [ref({ sniffed_media_duration_ms: 90_000_000 }), "native_audio"],
      [ref({}), "native_video"],
    ] as const) {
      expect(() => nativeAttachmentTokenReserve(r, route)).toThrow(AttachmentReserveInvariantError);
    }
    expect(new AttachmentReserveInvariantError("m").name).toBe("AttachmentReserveInvariantError");
  });

  it("the shared route reserve sums native, extracted and attachment-only parts and skips unknown ids and routes", () => {
    const refs = new Map<string, AttachmentRef>([
      ["pdf", ref({ id: "pdf", kind: "pdf", sniffed_mime: "application/pdf", sniffed_pdf_pages: 2 })],
      ["txt", ref({ id: "txt", kind: "text", sniffed_mime: "text/plain", sanitized_display_name: "n.txt" })],
      ["bin", ref({ id: "bin" })],
    ]);
    const total = attachmentTokenReserveForRoutes(
      [
        { attachment_id: "pdf", route: "native_pdf" },
        { attachment_id: "txt", route: "extracted_text" },
        { attachment_id: "bin", route: "attachment_only", reason: "no extractor" },
        { attachment_id: "bin", route: "attachment_only" },
        { attachment_id: "missing", route: "native_pdf" },
        { attachment_id: "bin", route: "something_else" },
      ],
      refs,
      (id) => (id === "txt" ? "some extracted text" : ""),
    );
    const pdfPart = 2 * 3000 + framing;
    expect(total).toBeGreaterThan(pdfPart);
    expect(attachmentTokenReserveForRoutes([{ attachment_id: "pdf", route: "native_pdf" }], refs, () => "")).toBe(pdfPart);
    // Empty extracted text costs nothing.
    expect(attachmentTokenReserveForRoutes([{ attachment_id: "txt", route: "extracted_text" }], refs, () => "")).toBe(0);
  });

  it("nativeWireMime: sniffed MIME for non-media, validated normalized MIME for media, invariant error otherwise", () => {
    expect(nativeWireMime({ kind: "image", sniffed_mime: "image/png", normalized_media_mime: null })).toBe("image/png");
    expect(nativeWireMime({ kind: "pdf", sniffed_mime: "application/pdf" })).toBe("application/pdf");
    expect(nativeWireMime({ kind: "video", sniffed_mime: "video/quicktime", normalized_media_mime: "video/mov" })).toBe("video/mov");
    expect(() => nativeWireMime({ kind: "audio", sniffed_mime: "audio/wav", normalized_media_mime: null })).toThrow(AttachmentReserveInvariantError);
    expect(() => nativeWireMime({ kind: "audio", sniffed_mime: "audio/wav", normalized_media_mime: "audio/evil" })).toThrow(AttachmentReserveInvariantError);
  });
});

describe("routeNativeAttachment — remaining branches", () => {
  const gemini = defaultProviderCapabilities("gemini");
  const input = (over: Partial<NativeRoutingInput>, caps: NativeCapabilitySet = gemini): NativeRoutingInput => ({
    provider: "gemini",
    kind: "image",
    sniffed_mime: "image/png",
    normalized_media_mime: null,
    byte_size: 50_000,
    has_extracted_text: false,
    capabilities: caps,
    remainingNativeBytes: caps.max_native_aggregate_bytes,
    remainingMediaBytes: caps.max_native_media_aggregate_bytes,
    remainingMediaSeconds: caps.max_native_media_aggregate_seconds,
    imageDimensions: { width: 100, height: 100 },
    pdfPageCount: null,
    mediaDurationSeconds: null,
    mediaStreams: [],
    validatedMediaFormat: null,
    ...over,
  });
  const route = (over: Partial<NativeRoutingInput>, caps?: NativeCapabilitySet) => routeNativeAttachment(input(over, caps));
  const aStream = { codec_type: "audio" as const, codec_name: "mp3" };
  const vStream = { codec_type: "video" as const, codec_name: "h264", width: 320, height: 240 };

  it("image refusals name the specific defect and a valid image is charged its bytes", () => {
    expect(route({}).route).toBe("native_image");
    expect(route({}).charged_native_bytes).toBe(50_000);
    expect(route({}).native_mime).toBe("image/png");
    expect(route({ sniffed_mime: "image/gif" }).reason).toBe("profile does not accept image/gif");
    expect(route({ byte_size: gemini.max_native_image_bytes + 1 }).reason).toBe("image larger than native cap");
    for (const [w, h] of [[0, 5], [5, -1], [Number.NaN, 5], [5, Number.POSITIVE_INFINITY]]) {
      expect(route({ imageDimensions: { width: w!, height: h! } }).reason).toBe("image dimensions invalid; refusing native");
    }
    expect(route({ imageDimensions: { width: 5000, height: 10 } }).reason).toMatch(/per-side cap/);
    expect(route({ imageDimensions: { width: 4096, height: 4096 } }).reason).toMatch(/pixel cap/);
    const small = { ...gemini, max_native_aggregate_bytes: 10_000 };
    expect(route({}, small).reason).toBe("image alone exceeds the per-call native byte cap");
    expect(route({ remainingNativeBytes: 10 }).reason).toMatch(/would exceed the per-call native aggregate \(earlier attachments/);
    const noImage = { ...gemini, image: false };
    expect(route({}, noImage).reason).toBe("profile does not accept images");
    expect(route({ provider: "mock" }, noImage).reason).toBe("mock mode sends no file bytes to any provider");
    const noWhitelist = { ...gemini };
    delete noWhitelist.image_mime_whitelist;
    expect(route({ sniffed_mime: "image/gif" }, noWhitelist).route).toBe("native_image");
  });

  it("PDF falls back to extracted text when there is any, else attachment-only, with the specific reason", () => {
    const pdf = (over: Partial<NativeRoutingInput> = {}) => route({ kind: "pdf", sniffed_mime: "application/pdf", pdfPageCount: 3, ...over });
    expect(pdf().route).toBe("native_pdf");
    expect(pdf().charged_native_bytes).toBe(50_000);
    const reasons: Array<[Partial<NativeRoutingInput>, string]> = [
      [{ pdfPageCount: null }, "pdf page count not validated"],
      [{ pdfPageCount: 0 }, "pdf page count not validated"],
      [{ pdfPageCount: 2.5 }, "pdf page count not validated"],
      [{ pdfPageCount: 21 }, "pdf has 21 pages; native cap is 20"],
      [{ byte_size: gemini.max_native_aggregate_bytes + 1 }, "pdf larger than native cap"],
      [{ remainingNativeBytes: 1 }, "would exceed the per-call native aggregate"],
    ];
    for (const [over, reason] of reasons) {
      const noText = pdf(over);
      expect(noText.route, reason).toBe("attachment_only");
      expect(noText.reason).toContain(reason);
      const withText = pdf({ ...over, has_extracted_text: true });
      expect(withText.route, reason).toBe("extracted_text");
      expect(withText.reason).toBe(`${noText.reason}; using extracted text`);
    }
    const noPdf = { ...gemini, pdf: false };
    expect(route({ kind: "pdf", pdfPageCount: 1 }, noPdf).reason).toBe("profile does not accept pdf");
    expect(route({ kind: "pdf", provider: "mock", pdfPageCount: 1 }, noPdf).reason).toBe("mock mode sends no file bytes to any provider");
  });

  it("text, archives and binaries are never native; extracted text is used when present", () => {
    for (const kind of ["text", "archive", "binary"] as const) {
      expect(route({ kind, has_extracted_text: true })).toMatchObject({ route: "extracted_text", reason: "", native_mime: null });
      expect(route({ kind })).toMatchObject({ route: "attachment_only", reason: "no native route; no extracted text" });
    }
  });

  it("media refusals, in order: support, streams, duration, caps, codecs, container, budgets", () => {
    const audio = (over: Partial<NativeRoutingInput> = {}) =>
      route({
        kind: "audio",
        sniffed_mime: "audio/mpeg",
        normalized_media_mime: "audio/mpeg",
        mediaStreams: [aStream],
        mediaDurationSeconds: 30,
        byte_size: 1_000_000,
        ...over,
      });
    const ok = audio();
    expect(ok).toMatchObject({ route: "native_audio", native_mime: "audio/mpeg", charged_media_seconds: 30, charged_media_bytes: 1_000_000, charged_native_bytes: 1_000_000 });

    const cases: Array<[Partial<NativeRoutingInput>, RegExp]> = [
      [{ mediaStreams: [] }, /no validated media streams/],
      [{ mediaDurationSeconds: null }, /duration unknown/],
      [{ mediaDurationSeconds: 0 }, /duration unknown/],
      [{ mediaDurationSeconds: Number.NaN }, /duration unknown/],
      [{ mediaDurationSeconds: 121 }, /exceeds the 120 s native cap/],
      [{ mediaStreams: [vStream] }, /no audio stream/],
      [{ mediaStreams: [aStream, vStream] }, /contains a video stream/],
      [{ mediaStreams: [{ codec_type: "audio", codec_name: "weird" }] }, /audio codec weird is not supported natively/],
      [{ normalized_media_mime: null }, /media container not validated/],
      [{ normalized_media_mime: "video/mp4" }, /does not match the file kind/],
      [{ byte_size: gemini.max_native_inline_media_bytes + 1 }, /exceeds the inline media cap/],
      [{ remainingMediaBytes: 10 }, /would exceed the per-call media byte aggregate \(earlier/],
      [{ remainingNativeBytes: 10 }, /would exceed the per-call native aggregate \(earlier/],
      [{ remainingMediaSeconds: 5 }, /would exceed the per-call media duration aggregate \(5 s left; earlier/],
    ];
    for (const [over, re] of cases) {
      const r = audio(over);
      expect(r.route, JSON.stringify(over)).toBe("attachment_only");
      expect(r.reason).toMatch(re);
      expect(r.native_mime).toBeNull();
      expect(r.charged_native_bytes + r.charged_media_bytes + r.charged_media_seconds).toBe(0);
    }
  });

  it("media per-call absolute caps blame the file itself, not earlier attachments", () => {
    const wide = { ...gemini, max_native_inline_media_bytes: 50_000_000, max_native_media_aggregate_bytes: 1000, max_native_aggregate_bytes: 100_000_000 };
    const a = (caps: NativeCapabilitySet, over: Partial<NativeRoutingInput> = {}) =>
      route({ kind: "audio", sniffed_mime: "audio/mpeg", normalized_media_mime: "audio/mpeg", mediaStreams: [aStream], mediaDurationSeconds: 10, byte_size: 5000, ...over }, caps);
    expect(a(wide).reason).toMatch(/alone exceeds the per-call media byte cap \(1000 B\)$/);
    const nativeCap = { ...wide, max_native_media_aggregate_bytes: 100_000_000, max_native_aggregate_bytes: 1000 };
    expect(a(nativeCap).reason).toMatch(/alone exceeds the per-call native byte cap \(1000 B\)$/);
    const secCap = { ...gemini, max_native_media_aggregate_seconds: 5 };
    expect(a(secCap).reason).toMatch(/10 s alone exceeds the 5 s per-call media cap$/);
    expect(a(secCap).reason).not.toContain("earlier");
  });

  it("video requires every video stream bounded and a whitelisted codec; the audio track is checked too", () => {
    const video = (over: Partial<NativeRoutingInput> = {}) =>
      route({ kind: "video", sniffed_mime: "video/mp4", normalized_media_mime: "video/mp4", mediaStreams: [vStream, aStream], mediaDurationSeconds: 10, byte_size: 1_000_000, ...over });
    expect(video().route).toBe("native_video");
    expect(video({ mediaStreams: [{ ...vStream, width: 0, height: 0 }] }).reason).toBe("no positive bounded video stream");
    expect(video({ mediaStreams: [{ ...vStream, codec_name: "prores" }] }).reason).toBe("video codec prores is not supported natively");
    expect(video({ mediaStreams: [vStream, { codec_type: "audio", codec_name: "amr" }] }).reason).toBe("audio codec amr is not supported natively");
    expect(video({ sniffed_mime: "video/quicktime", normalized_media_mime: null }).reason).toBe("QuickTime container not validated");
    expect(video({ normalized_media_mime: "audio/mpeg" }).reason).toBe("validated media type does not match the file kind");
  });

  it("media unsupported for the provider names the reason by provider", () => {
    const openai = defaultProviderCapabilities("openai");
    const mk = (provider: NativeRoutingInput["provider"], caps: NativeCapabilitySet, kind: "audio" | "video" = "audio") =>
      route({ provider, kind }, caps).reason;
    expect(mk("openai", openai)).toBe("native audio/video is not supported for openai in this app");
    expect(mk("anthropic", defaultProviderCapabilities("anthropic"), "video")).toBe("native audio/video is not supported for anthropic in this app");
    expect(mk("mock", defaultProviderCapabilities("mock"))).toBe("mock execution never reads media bytes");
    expect(mk("gemini", { ...gemini, video: false }, "video")).toBe("profile does not accept video");
  });
});

describe("planAttachmentRoutes", () => {
  const caps = defaultProviderCapabilities("gemini");
  const ref = (over: Partial<AttachmentRef>): AttachmentRef => ({
    id: "id",
    sanitized_display_name: "f",
    sniffed_mime: "application/octet-stream",
    kind: "binary",
    byte_size: 1000,
    content_sha256: "0".repeat(64),
    extraction_status: "none",
    extraction_coverage: { extracted_chars: 0, truncated: false, label: "x" },
    ...over,
  });
  const plan = (refs: AttachmentRef[], extra: Partial<Parameters<typeof planAttachmentRoutes>[0]> = {}) =>
    planAttachmentRoutes({ refs, hasExtractedText: () => false, capabilities: caps, provider: "gemini", safeInputTokens: 100_000, ...extra });

  it("routes a mixed turn: native image, native PDF, native video, text, and attachment-only", () => {
    const refs = [
      ref({ id: "img", kind: "image", sniffed_mime: "image/png", sniffed_width: 100, sniffed_height: 100 }),
      ref({ id: "pdf", kind: "pdf", sniffed_mime: "application/pdf", sniffed_pdf_pages: 2 }),
      ref({
        id: "vid",
        kind: "video",
        sniffed_mime: "video/mp4",
        normalized_media_mime: "video/mp4",
        sniffed_media_duration_ms: 10_000,
        sniffed_media_streams_json: JSON.stringify([{ codec_type: "video", codec_name: "h264", width: 320, height: 240 }]),
        validated_media_format: "mov,mp4",
      }),
      ref({ id: "txt", kind: "text", sniffed_mime: "text/plain" }),
      ref({ id: "bin" }),
    ];
    const planned = plan(refs, { hasExtractedText: (id) => id === "txt" });
    expect(planned.map((p) => [p.attachment_id, p.route])).toEqual([
      ["img", "native_image"],
      ["pdf", "native_pdf"],
      ["vid", "native_video"],
      ["txt", "extracted_text"],
      ["bin", "attachment_only"],
    ]);
  });

  it("re-validates persisted metadata: garbage durations, streams and MIME never reach routing as valid", () => {
    const planned = plan([
      ref({
        id: "bad",
        kind: "audio",
        sniffed_mime: "audio/mpeg",
        normalized_media_mime: "audio/evil",
        sniffed_media_duration_ms: -5,
        sniffed_media_streams_json: "{not json",
      }),
    ]);
    expect(planned[0]!.route).toBe("attachment_only");
    expect(planned[0]!.reason).toMatch(/no validated media streams/);
  });

  it("charges budgets in order: a later PDF is refused because earlier ones used the native byte budget", () => {
    const big = (id: string) => ref({ id, kind: "pdf", sniffed_mime: "application/pdf", sniffed_pdf_pages: 1, byte_size: 7 * 1024 * 1024 });
    const planned = plan([big("p1"), big("p2")], { hasExtractedText: (id) => id === "p2" });
    expect(planned[0]!.route).toBe("native_pdf");
    expect(planned[1]!.route).toBe("extracted_text");
    expect(planned[1]!.reason).toContain("earlier attachments in this conversation consumed the per-call native budget first");
  });

  it("the native token budget is half the safe input: an oversized reserve falls back (PDF with text) or becomes attachment-only", () => {
    const pdf = ref({ id: "pdf", kind: "pdf", sniffed_mime: "application/pdf", sniffed_pdf_pages: 10 }); // 31,024 tokens
    const alone = plan([pdf], { safeInputTokens: 40_000, hasExtractedText: () => true });
    expect(alone[0]).toMatchObject({ route: "extracted_text" });
    expect(alone[0]!.reason).toMatch(/native reserve 31024 tokens alone exceeds the profile budget of 20000; using extracted text/);

    const noText = plan([pdf], { safeInputTokens: 40_000 });
    expect(noText[0]).toMatchObject({ route: "attachment_only" });
    expect(noText[0]!.reason).toMatch(/^native reserve 31024 tokens alone exceeds the profile budget of 20000$/);

    const img = (id: string) => ref({ id, kind: "image", sniffed_mime: "image/png", sniffed_width: 1000, sniffed_height: 1000 });
    const cumulative = plan([img("i1"), img("i2")], { safeInputTokens: 6_000 });
    expect(cumulative[0]!.route).toBe("native_image"); // 2,358 tokens each against a 3,000 budget
    expect(cumulative[1]).toMatchObject({ route: "attachment_only" });
    expect(cumulative[1]!.reason).toMatch(/native reserve 4\d{3} tokens exceeds the profile budget of 3000 \(earlier attachments/);
  });

  it("a non-PDF that busts the token budget never falls back to extracted text", () => {
    const planned = plan([ref({ id: "i", kind: "image", sniffed_mime: "image/png", sniffed_width: 1000, sniffed_height: 1000 })], {
      safeInputTokens: 100,
      hasExtractedText: () => true,
    });
    expect(planned[0]!.route).toBe("attachment_only");
  });

  it("an empty turn plans nothing", () => {
    expect(plan([])).toEqual([]);
  });
});

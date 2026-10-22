// Attachment storage, sanitization, MIME-magic sniffing, policy limits, and
// capability routing for the v1 slice.
//
// Design invariants:
//   - The raw uploaded bytes live under `{dataDir}/attachments/{storage_key}`
//     with 0o600 perms, where `storage_key` is a random UUID — the user's
//     filename never appears on disk and is never passed to a shell.
//   - The ONLY name shown in the UI / sent to download Content-Disposition
//     / written to export is the server-sanitized display name.
//   - The ONLY mime trusted for preview or provider routing is the server's
//     magic-byte-sniffed mime; the client-declared mime is kept only for
//     diagnostics.
//   - Byte / count / quota caps are enforced TRANSACTIONALLY: an upload is
//     accepted only if the committed draftByteTotal + the real stream byte
//     count stays within the caps at write time. The caps surface to the
//     UI via `getAttachmentPolicy()` so the composer can refuse before even
//     starting an upload.
//   - Native-provider wire payload is NOT the same thing as "the file is
//     understood": each profile has an explicit `capabilities` matrix.
//     Over-cap files or files the selected profile does not support are
//     delivered as attachment-only (metadata badge in the UI; name/kind
//     line in the system prompt; no raw bytes passed to the adapter).

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { estimateTokens } from "./context.js";
import { frameAttachmentOnlyNote, frameExtractedAttachment } from "../shared/attachmentFraming.js";
import type { AttachmentKind, AttachmentRef, ModelProfile, ProviderId } from "../shared/types.js";
import {
  parsePersistedMediaStreams,
  allVideoStreamsBounded,
  sanitizePersistedDurationMs,
  sanitizePersistedMediaFormat,
  sanitizePersistedMediaMime,
  sanitizePersistedPageCount,
  type MediaStreamMetadata,
} from "../shared/attachmentMetadata.js";

// --- policy caps ----------------------------------------------------------

/** Per-request / per-conversation / per-store caps. */
export const ATTACHMENT_POLICY = {
  // Per turn (one admission): hard upper bound on the number of attachments
  // bound to one user message.
  max_files_per_turn: 8,
  // Per file raw size. Chosen so a single file fits comfortably inside the
  // most restrictive provider native-input ceiling (Anthropic image = 10 MB
  // BASE64 which is ~7.5 MB raw; we cap raw at 25 MiB and clamp per-image
  // native to 5 MiB separately in `routeNativeAttachment`).
  max_file_bytes: 25 * 1024 * 1024,
  // Composer total (ready + uploading drafts for one conversation).
  max_composer_bytes: 100 * 1024 * 1024,
  // Global per-process-store quota across EVERY conversation. Rejects new
  // uploads when the committed on-disk total would exceed this cap.
  max_store_bytes: 1024 * 1024 * 1024,
  // Native per-image clamp (bytes of raw content before base64; Anthropic
  // 10 MB base64 → ~7.5 MB raw, we leave 2.5 MB of headroom).
  max_native_image_bytes: 5 * 1024 * 1024,
  // Native aggregate per adapter call (image + pdf + inline audio/video +
  // base64 overhead + envelope text). Chosen as the stricter of OpenAI's
  // Chat Completions request-size headroom and Anthropic's documented
  // combined-content ceiling.
  max_native_aggregate_bytes: 12 * 1024 * 1024,
  // Gemini-specific inline audio/video request-size cap (vendor guides:
  // 20 MB request).
  max_gemini_inline_media_bytes: 20 * 1024 * 1024,
  // Native audio / video DURATION caps (seconds). These are per-attachment
  // policy ceilings used by `routeNativeAttachment`; a probed media with
  // a longer validated duration is refused native routing regardless of
  // byte size (compressed silence is NOT a bound on token cost). Proposed
  // defaults (DLOG-014), tunable after provider-specific measurement.
  max_native_audio_seconds: 120,
  max_native_video_seconds: 120,
  // Per adapter call: total validated media seconds and raw media bytes
  // across ALL native audio/video, history and current turn combined.
  max_native_media_aggregate_seconds: 120,
  max_native_media_aggregate_bytes: 12 * 1024 * 1024,
  // Native PDF page cap. `native_pdf` is refused whenever the Poppler
  // page count is missing or above this value; the raw byte size is not
  // a bound on per-page token cost. Twenty matches the `pdftotext` page
  // cap so native and extracted coverage are aligned.
  max_native_pdf_pages: 20,
  // Conservative admission reserves (NOT vendor billing).
  native_attachment_framing_tokens: 1_024,
  native_pdf_tokens_per_page: 3_000,
  native_audio_tokens_per_second: 64,
  native_video_tokens_per_second: 512,
  // Text/code/CSV/JSON extraction char cap (how much we send as a quoted
  // "untrusted data" block). Chosen so one attachment cannot blow the
  // 32 Ki safe-input-token budget on a reasonable profile.
  max_extracted_chars: 24_000,
  // Preview raster-image dimension ceiling (px). Larger images download
  // only; they are never re-encoded or re-rendered on the server.
  max_preview_image_dim: 4096,
  // Native raster-image dimension ceiling (px per side). Provider
  // documentation recommends against sending images > ~2k px per side
  // because they consume disproportionate tokens; a 4096×4096 PNG also
  // exceeds the 5 MiB raw cap in most cases. We enforce the per-side
  // limit explicitly from a cheap header sniff before admitting a file
  // as `native_image`.
  max_native_image_side_px: 4096,
  // Native raster-image pixel count (width * height). Covers very wide
  // or very tall images that pass the per-side check but still exceed
  // provider pixel budgets.
  max_native_image_pixels: 16_000_000,
} as const;

export type AttachmentPolicy = typeof ATTACHMENT_POLICY;

export function getAttachmentPolicy(): AttachmentPolicy {
  return ATTACHMENT_POLICY;
}

// --- filename sanitization ------------------------------------------------

/**
 * Produce a safe display filename. The result:
 *   - contains no path separators (`/`, `\`), no control bytes, no NUL;
 *   - never starts with a dot (prevents hidden-file UI confusion);
 *   - is clamped to 160 characters;
 *   - falls back to `attachment` + an extension inferred from mime when the
 *     user-supplied name is empty / entirely stripped.
 *
 * This name is NEVER passed to a shell, a path join, or a filesystem call.
 * It only reaches the UI and the Content-Disposition header.
 */
export function sanitizeDisplayName(rawName: string, declaredMime: string): string {
  const trimmed = typeof rawName === "string" ? rawName : "";
  const base = path.posix.basename(path.win32.basename(trimmed));
  // Strip control bytes, NUL, quotes, path separators, HTML/XML metachars.
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "")
    .replace(/["']/g, "")
    .replace(/[<>]/g, "")
    .trim();
  // Reject names that are empty or purely dots.
  const normalized = cleaned.replace(/^\.+/, "").slice(0, 160);
  if (normalized.length === 0) {
    return `attachment${extForMime(declaredMime)}`;
  }
  return normalized;
}

function extForMime(mime: string): string {
  const m = (mime ?? "").toLowerCase();
  if (m.includes("png")) return ".png";
  if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
  if (m.includes("webp")) return ".webp";
  if (m.includes("gif")) return ".gif";
  if (m.includes("pdf")) return ".pdf";
  if (m.includes("zip")) return ".zip";
  if (m.includes("json")) return ".json";
  if (m.includes("csv")) return ".csv";
  if (m.startsWith("text/")) return ".txt";
  if (m.startsWith("audio/")) return ".bin";
  if (m.startsWith("video/")) return ".bin";
  return ".bin";
}

// --- MIME magic sniff -----------------------------------------------------

/**
 * Sniff the first bytes of a file and return a server-trusted (mime, kind).
 * Only recognizes signatures we actively support. Unknown signatures
 * fall through to `application/octet-stream` + `binary` so the file still
 * uploads successfully as a download-only attachment.
 *
 * This never trusts the client-declared mime; the client-declared value
 * is kept only for diagnostics / debugging.
 */
export function sniffMime(head: Buffer): { mime: string; kind: AttachmentKind } {
  // PNG
  if (
    head.length >= 8 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47 &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a
  ) {
    return { mime: "image/png", kind: "image" };
  }
  // JPEG
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { mime: "image/jpeg", kind: "image" };
  }
  // GIF (not in Gemini native image list; still a known raster)
  if (head.length >= 6 && head.slice(0, 6).toString("ascii") === "GIF87a") {
    return { mime: "image/gif", kind: "image" };
  }
  if (head.length >= 6 && head.slice(0, 6).toString("ascii") === "GIF89a") {
    return { mime: "image/gif", kind: "image" };
  }
  // WebP: RIFF....WEBP
  if (
    head.length >= 12 &&
    head.slice(0, 4).toString("ascii") === "RIFF" &&
    head.slice(8, 12).toString("ascii") === "WEBP"
  ) {
    return { mime: "image/webp", kind: "image" };
  }
  // SVG — explicitly rejected as "image" because we never render it as
  // active HTML; mark as text/xml binary.
  if (head.length >= 5 && head.slice(0, 5).toString("ascii").toLowerCase() === "<?xml") {
    return { mime: "application/xml", kind: "binary" };
  }
  // PDF
  if (head.length >= 5 && head.slice(0, 5).toString("ascii") === "%PDF-") {
    return { mime: "application/pdf", kind: "pdf" };
  }
  // ZIP (incl. DOCX / XLSX / ODT etc).
  if (
    head.length >= 4 &&
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07) &&
    (head[3] === 0x04 || head[3] === 0x06 || head[3] === 0x08)
  ) {
    return { mime: "application/zip", kind: "archive" };
  }
  // WAV
  if (
    head.length >= 12 &&
    head.slice(0, 4).toString("ascii") === "RIFF" &&
    head.slice(8, 12).toString("ascii") === "WAVE"
  ) {
    return { mime: "audio/wav", kind: "audio" };
  }
  // MP3 (ID3 header)
  if (head.length >= 3 && head.slice(0, 3).toString("ascii") === "ID3") {
    return { mime: "audio/mpeg", kind: "audio" };
  }
  // MP3 (frame sync)
  if (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) {
    return { mime: "audio/mpeg", kind: "audio" };
  }
  // OGG
  if (head.length >= 4 && head.slice(0, 4).toString("ascii") === "OggS") {
    return { mime: "audio/ogg", kind: "audio" };
  }
  // FLAC
  if (head.length >= 4 && head.slice(0, 4).toString("ascii") === "fLaC") {
    return { mime: "audio/flac", kind: "audio" };
  }
  // MP4 / MOV: ftyp box starting at offset 4
  if (
    head.length >= 12 &&
    head.slice(4, 8).toString("ascii") === "ftyp"
  ) {
    const brand = head.slice(8, 12).toString("ascii");
    if (brand === "qt  ") return { mime: "video/quicktime", kind: "video" };
    return { mime: "video/mp4", kind: "video" };
  }
  // WebM
  if (
    head.length >= 4 &&
    head[0] === 0x1a &&
    head[1] === 0x45 &&
    head[2] === 0xdf &&
    head[3] === 0xa3
  ) {
    return { mime: "video/webm", kind: "video" };
  }
  // UTF-8 BOM
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
    return { mime: "text/plain", kind: "text" };
  }
  // Treat a prefix as text if it is well-formed UTF-8 and contains no NUL
  // / control bytes other than the usual whitespace. This accepts Thai,
  // CJK, emoji, etc. and rejects binary — the ASCII-only check in the
  // previous version falsely classified non-English UTF-8 as binary.
  if (looksLikeText(head)) {
    return { mime: "text/plain", kind: "text" };
  }
  return { mime: "application/octet-stream", kind: "binary" };
}

function looksLikeText(head: Buffer): boolean {
  if (head.length === 0) return false;
  const sample = head.subarray(0, Math.min(head.length, 512));
  // Reject early on any raw control byte that isn't tab/LF/CR.
  for (const byte of sample) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    if (byte < 0x20 || byte === 0x7f) return false;
    // High-bit bytes are allowed; UTF-8 validity is checked below.
  }
  // Validate as UTF-8 strictly. `TextDecoder("utf-8", { fatal: true })`
  // throws on any invalid sequence. If the sample ends mid-multibyte,
  // trim the trailing partial sequence rather than classifying the whole
  // file as binary.
  const trimmed = trimTrailingPartialUtf8(sample);
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(trimmed);
    // Final sanity: no NUL in the decoded text (binary with 0x00 slipped
    // through would already have been caught above, but defense in depth).
    if (decoded.indexOf("\u0000") >= 0) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Cheap, header-only raster image dimension sniff for PNG / JPEG / GIF /
 * WebP. Returns `null` when the format is unknown or the header is
 * incomplete; the caller treats unknown dimensions as "not safe to admit
 * as native" rather than guessing. We never decode pixel data.
 */
/**
 * The server-side raster-image preview endpoint SHOULD only serve bytes
 * inline when the persisted sniffed dimensions fit the same per-side /
 * pixel-area caps that `routeNativeAttachment` enforces for native
 * admission. A raster image whose dimensions were never validated
 * (unknown, non-finite, non-positive) or whose dimensions exceed the
 * caps is served as a download attachment only — never decoded by the
 * UI's `<img>` tag.
 *
 * This matters because:
 *   - a crafted PNG/GIF/WebP header can declare an astronomical canvas
 *     (e.g. a 69-byte PNG that says `100000x100000`) that the browser
 *     will refuse to decode (OOM) or will decode into a huge raster;
 *   - a JPEG's dimensions do not live at a fixed head offset, so our
 *     cheap 32-byte sniff cannot see them and we must treat JPEG as
 *     "dimensions unknown" for preview purposes;
 *   - we never want the `/preview` surface to produce a decode / render
 *     side-effect that `/download` would not.
 */
export function isImagePreviewDimensionsSafe(
  width: number | null | undefined,
  height: number | null | undefined,
): boolean {
  if (width == null || height == null) return false;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return false;
  if (width <= 0 || height <= 0) return false;
  if (
    width > ATTACHMENT_POLICY.max_native_image_side_px ||
    height > ATTACHMENT_POLICY.max_native_image_side_px
  ) {
    return false;
  }
  if (width * height > ATTACHMENT_POLICY.max_native_image_pixels) return false;
  return true;
}

export function sniffImageDimensions(
  head: Buffer,
  sniffedMime: string,
): { width: number; height: number } | null {
  if (sniffedMime === "image/png") {
    // PNG: 8-byte signature, then IHDR at offset 8 (length 4, type 4,
    // then width:uint32 BE, height:uint32 BE).
    if (head.length < 24) return null;
    const width = head.readUInt32BE(16);
    const height = head.readUInt32BE(20);
    return { width, height };
  }
  if (sniffedMime === "image/gif") {
    // GIF87a / GIF89a: 6-byte signature, then width:uint16 LE,
    // height:uint16 LE.
    if (head.length < 10) return null;
    const width = head.readUInt16LE(6);
    const height = head.readUInt16LE(8);
    return { width, height };
  }
  if (sniffedMime === "image/webp") {
    // WebP: "RIFF" 4-byte, size 4-byte, "WEBP" 4-byte, then chunk.
    // VP8 : offset 26 width:u16 LE, offset 28 height:u16 LE (low 14 bits).
    // VP8L: offset 21 w:14 bits, h:14 bits packed.
    // VP8X: offset 24 w-1 (u24 LE)+1, offset 27 h-1 (u24 LE)+1.
    if (head.length < 30) return null;
    const chunk = head.subarray(12, 16).toString("ascii");
    if (chunk === "VP8 ") {
      const w = head.readUInt16LE(26) & 0x3fff;
      const h = head.readUInt16LE(28) & 0x3fff;
      return { width: w, height: h };
    }
    if (chunk === "VP8L") {
      const b0 = head[21]!;
      const b1 = head[22]!;
      const b2 = head[23]!;
      const b3 = head[24]!;
      const w = 1 + ((b1 & 0x3f) << 8 | b0);
      const h = 1 + ((b3 & 0x0f) << 10 | b2 << 2 | (b1 >> 6));
      return { width: w, height: h };
    }
    if (chunk === "VP8X") {
      const w = 1 + (head[24]! | head[25]! << 8 | head[26]! << 16);
      const h = 1 + (head[27]! | head[28]! << 8 | head[29]! << 16);
      return { width: w, height: h };
    }
    return null;
  }
  // JPEG dimensions live in SOF0..SOF3/SOF5..SOF7/SOF9..SOF11/SOF13..SOF15
  // markers which are not at a fixed offset. The 32-byte sniff slice we
  // actually keep is almost never enough to find the SOF marker, so we
  // return null here and let the native-route check decide (byte-size
  // cap already enforced).
  return null;
}

function trimTrailingPartialUtf8(buf: Buffer): Buffer {
  let end = buf.length;
  for (let i = buf.length - 1; i >= 0 && i > buf.length - 4; i -= 1) {
    const byte = buf[i]!;
    if ((byte & 0xc0) !== 0x80) {
      // Found the lead byte or an ASCII byte.
      const expected =
        (byte & 0x80) === 0 ? 1 : (byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : 4;
      if (buf.length - i < expected) end = i;
      break;
    }
  }
  return buf.subarray(0, end);
}

/**
 * Consistency check between the client-declared MIME, the display name
 * extension, and the server-sniffed MIME. Returns `false` when the pair
 * looks like a MIME-spoof (e.g. `image/png` declared on a ZIP, or an
 * `application/zip` sent as `.pdf`).
 *
 * The check is conservative: unknown declared MIME is accepted, and a
 * declared text/* subtype on a sniffed `text/plain` is accepted (there
 * are many text subtypes we don't model). Only *known* mismatches reject.
 */
export function isConsistentMimePair(
  declared: string,
  displayName: string,
  sniffed: string,
): boolean {
  const d = declared.toLowerCase();
  const s = sniffed.toLowerCase();
  const ext = displayName.toLowerCase().split(".").pop() ?? "";

  // Harmless agreement.
  if (d === s) return true;

  // Known declared ↔ sniffed consistency map. If BOTH are known distinct
  // categories, mismatch is a hard reject.
  const knownCat = (mime: string): string | null => {
    if (mime.startsWith("image/")) return "image";
    if (mime === "application/pdf") return "pdf";
    if (mime === "application/zip") return "zip";
    if (mime.startsWith("audio/")) return "audio";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("text/")) return "text";
    return null;
  };
  const dCat = knownCat(d);
  const sCat = knownCat(s);
  if (dCat && sCat && dCat !== sCat) return false;

  // Extension vs sniffed: block the two most dangerous spoofs — a file
  // sniffed as application/zip arriving with a .pdf/.jpg/.png/.html/.htm
  // extension, and a file sniffed as image/* with .html/.htm.
  if (s === "application/zip" && ["pdf", "jpg", "jpeg", "png", "webp", "gif", "html", "htm"].includes(ext)) {
    return false;
  }
  if (sCat === "image" && ["html", "htm", "svg"].includes(ext)) return false;
  if (sCat === "pdf" && ["html", "htm"].includes(ext)) return false;

  return true;
}

// --- blob store -----------------------------------------------------------

export interface BlobStoreOptions {
  dataDir: string;
}

/**
 * Content-addressed blob store that writes to UUID keys under
 * `{dataDir}/attachments/`. Every write is streamed and bounded; the
 * caller provides an inner cap. Keys are random UUIDs so a stored path
 * never leaks the user's filename.
 */
export class BlobStore {
  readonly root: string;

  constructor(options: BlobStoreOptions) {
    this.root = path.resolve(options.dataDir, "attachments");
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.root, 0o700);
    } catch {
      // best effort on platforms without chmod
    }
  }

  mintStorageKey(): string {
    return randomUUID();
  }

  pathFor(storageKey: string): string {
    // Hard guard: storageKey must look like a UUID; never a relative path,
    // never containing separators. This is defense-in-depth even though
    // the key is minted by us.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(storageKey)) {
      throw new Error("invalid storage key");
    }
    return path.join(this.root, storageKey);
  }

  async unlinkSafely(storageKey: string): Promise<void> {
    try {
      await fs.promises.unlink(this.pathFor(storageKey));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  /**
   * Clean filesystem orphans: delete blob files that have no attachment
   * row. Called at startup; it does NOT delete DB rows that happen to
   * lack a file (those are already in `failed` or `uploading` state and
   * are rejected by the UI).
   */
  async pruneOrphans(knownKeys: Set<string>): Promise<number> {
    let pruned = 0;
    const entries = await fs.promises
      .readdir(this.root)
      .catch(() => [] as string[]);
    for (const entry of entries) {
      if (!knownKeys.has(entry)) {
        try {
          await fs.promises.unlink(path.join(this.root, entry));
          pruned += 1;
        } catch {
          // ignore; best effort
        }
      }
    }
    return pruned;
  }
}

// --- content hashing ------------------------------------------------------

export function makeSha256Streamer(): {
  update(chunk: Buffer): void;
  digest(): string;
} {
  const hash = createHash("sha256");
  return {
    update(chunk: Buffer): void {
      hash.update(chunk);
    },
    digest(): string {
      return hash.digest("hex");
    },
  };
}

// --- native-provider routing ---------------------------------------------

export interface NativeCapabilitySet {
  // Natively understood images (passed as inline base64/data-URL/inlineData
  // per adapter).
  image: boolean;
  image_mime_whitelist?: string[];
  // Natively understood PDF (as a document / file part).
  pdf: boolean;
  // Natively understood audio.
  audio: boolean;
  // Natively understood video.
  video: boolean;
  // Max per-image raw bytes (before base64) for the native path.
  max_native_image_bytes: number;
  // Max per-adapter-call aggregate raw bytes for inline attachments.
  max_native_aggregate_bytes: number;
  // Max per-adapter-call aggregate for inline audio/video specifically (for
  // Gemini which documents a 20 MB inline media cap).
  max_native_inline_media_bytes: number;
  // Numeric per-attachment DURATION ceilings. Zero means "not supported".
  // These are enforced AT ADMISSION, not just reported; the admission
  // path refuses native audio/video whose validated duration exceeds
  // these seconds. Compressed silence is explicitly NOT a loophole
  // because `routeNativeAttachment` compares against the ffprobe-
  // reported duration, not against `byte_size`.
  max_native_audio_seconds: number;
  max_native_video_seconds: number;
  // Per adapter call across all native media (history + current).
  max_native_media_aggregate_seconds: number;
  max_native_media_aggregate_bytes: number;
  // Codec whitelists. A media stream whose ffprobe-sanitized `codec_name`
  // is NOT in the matching whitelist is refused native routing. These
  // mirror the vendor documentation for Gemini (the only provider that
  // currently claims native audio/video). Empty for providers that do
  // not support media.
  audio_codec_whitelist: string[];
  video_codec_whitelist: string[];
  // Native PDF page ceiling. Admission refuses `native_pdf` whenever the
  // probed `pdfPageCount` exceeds this (or is missing). Zero means
  // "native PDF not supported".
  max_native_pdf_pages: number;
}

/**
 * Conservative per-provider capability defaults. These are intentionally
 * narrower than the vendor's maximum published limits because we have no
 * live-call CI and would rather force attachment-only than silently drop
 * or silently claim understanding.
 *
 * Sources (fetched 2026-10-21):
 *   - OpenAI: PDF only via file parts; image inputs via image_url data
 *     URLs; non-audio/video.
 *     https://developers.openai.com/api/docs/guides/file-inputs
 *     https://developers.openai.com/api/docs/guides/images-vision
 *   - Anthropic: image/document via source: base64; image ≤ 10 MB base64 (
 *     ≈7.5 MB raw) — we clamp per-image raw to 5 MiB for headroom.
 *     https://platform.claude.com/docs/en/build-with-claude/vision
 *     https://platform.claude.com/docs/en/build-with-claude/pdf-support
 *   - Gemini: inlineData for image/PDF/audio/video; native image whitelist
 *     is PNG/JPEG/WebP (GIF not documented); inline audio/video ≤ 20 MB
 *     per request.
 *     https://ai.google.dev/gemini-api/docs/generate-content/file-input-methods
 *     https://ai.google.dev/gemini-api/docs/generate-content/audio
 *     https://ai.google.dev/gemini-api/docs/generate-content/video-understanding
 */
export function defaultProviderCapabilities(provider: ProviderId): NativeCapabilitySet {
  switch (provider) {
    case "openai":
      return {
        image: true,
        image_mime_whitelist: ["image/png", "image/jpeg", "image/webp", "image/gif"],
        pdf: true,
        audio: false,
        video: false,
        max_native_image_bytes: ATTACHMENT_POLICY.max_native_image_bytes,
        max_native_aggregate_bytes: ATTACHMENT_POLICY.max_native_aggregate_bytes,
        max_native_inline_media_bytes: 0,
        max_native_audio_seconds: 0,
        max_native_video_seconds: 0,
        max_native_media_aggregate_seconds: 0,
        max_native_media_aggregate_bytes: 0,
        audio_codec_whitelist: [],
        video_codec_whitelist: [],
        max_native_pdf_pages: ATTACHMENT_POLICY.max_native_pdf_pages,
      };
    case "anthropic":
      return {
        image: true,
        image_mime_whitelist: ["image/png", "image/jpeg", "image/webp", "image/gif"],
        pdf: true,
        audio: false,
        video: false,
        max_native_image_bytes: ATTACHMENT_POLICY.max_native_image_bytes,
        max_native_aggregate_bytes: ATTACHMENT_POLICY.max_native_aggregate_bytes,
        max_native_inline_media_bytes: 0,
        max_native_audio_seconds: 0,
        max_native_video_seconds: 0,
        max_native_media_aggregate_seconds: 0,
        max_native_media_aggregate_bytes: 0,
        audio_codec_whitelist: [],
        video_codec_whitelist: [],
        max_native_pdf_pages: ATTACHMENT_POLICY.max_native_pdf_pages,
      };
    case "gemini":
      return {
        image: true,
        // GIF deliberately omitted per vendor docs; GIFs become
        // attachment-only on Gemini and never silently go through.
        image_mime_whitelist: ["image/png", "image/jpeg", "image/webp"],
        pdf: true,
        audio: true,
        video: true,
        max_native_image_bytes: ATTACHMENT_POLICY.max_native_image_bytes,
        max_native_aggregate_bytes: ATTACHMENT_POLICY.max_native_aggregate_bytes,
        max_native_inline_media_bytes: ATTACHMENT_POLICY.max_gemini_inline_media_bytes,
        max_native_audio_seconds: ATTACHMENT_POLICY.max_native_audio_seconds,
        max_native_video_seconds: ATTACHMENT_POLICY.max_native_video_seconds,
        max_native_media_aggregate_seconds: ATTACHMENT_POLICY.max_native_media_aggregate_seconds,
        max_native_media_aggregate_bytes: ATTACHMENT_POLICY.max_native_media_aggregate_bytes,
        audio_codec_whitelist: ["pcm_s16le", "mp3", "aac", "flac", "opus", "vorbis"],
        video_codec_whitelist: ["h264", "hevc", "vp8", "vp9", "av1"],
        max_native_pdf_pages: ATTACHMENT_POLICY.max_native_pdf_pages,
      };
    case "mock":
    default:
      // Mock adapter deliberately does NOT claim to understand bytes; it
      // acknowledges presence by name/kind/size only.
      return {
        image: false,
        pdf: false,
        audio: false,
        video: false,
        max_native_image_bytes: 0,
        max_native_aggregate_bytes: 0,
        max_native_inline_media_bytes: 0,
        max_native_audio_seconds: 0,
        max_native_video_seconds: 0,
        max_native_media_aggregate_seconds: 0,
        max_native_media_aggregate_bytes: 0,
        audio_codec_whitelist: [],
        video_codec_whitelist: [],
        max_native_pdf_pages: 0,
      };
  }
}

/**
 * Resolve the capability set for a profile at admission time. The result
 * is the provider's documented defaults, intersected ("clamped") with any
 * per-profile override:
 *
 *   - Booleans: `true` only if BOTH the provider default and the profile
 *     override allow it. A profile can turn OFF a capability the provider
 *     documents, but cannot turn one ON that the provider does not accept.
 *   - MIME whitelists: intersection of provider list and profile list
 *     when both are present; otherwise the one that is defined; `undefined`
 *     if neither is defined (default-permissive within the already-filtered
 *     boolean).
 *   - Byte caps: `min(provider_default, override)` so a profile can tighten
 *     a cap but never widen it.
 *
 * `effectiveProvider` is the DISPATCH provider for this run, not the
 * profile's nameplate provider. When `executionMode === "mock"` the
 * dispatch provider is `"mock"` even for OpenAI/Anthropic/Gemini profiles
 * because the Mock adapter does not read bytes; this prevents the UI (and
 * the Mock adapter itself) from claiming native byte analysis that will
 * never happen.
 */
export function effectiveCapabilitiesFor(
  profile: { capabilities?: ModelProfile["capabilities"] },
  effectiveProvider: ProviderId,
): NativeCapabilitySet {
  const base = defaultProviderCapabilities(effectiveProvider);
  const override = profile.capabilities;
  if (!override) return base;
  const clamped: NativeCapabilitySet = {
    image: base.image && (override.image ?? true),
    pdf: base.pdf && (override.pdf ?? true),
    audio: base.audio && (override.audio ?? true),
    video: base.video && (override.video ?? true),
    max_native_image_bytes: Math.min(
      base.max_native_image_bytes,
      Math.max(0, override.max_native_image_bytes ?? Number.POSITIVE_INFINITY),
    ),
    max_native_aggregate_bytes: Math.min(
      base.max_native_aggregate_bytes,
      Math.max(0, override.max_native_aggregate_bytes ?? Number.POSITIVE_INFINITY),
    ),
    max_native_inline_media_bytes: Math.min(
      base.max_native_inline_media_bytes,
      Math.max(0, override.max_native_inline_media_bytes ?? Number.POSITIVE_INFINITY),
    ),
    max_native_audio_seconds: clampCap(base.max_native_audio_seconds, override.max_native_audio_seconds),
    max_native_video_seconds: clampCap(base.max_native_video_seconds, override.max_native_video_seconds),
    max_native_media_aggregate_seconds: clampCap(
      base.max_native_media_aggregate_seconds,
      override.max_native_media_aggregate_seconds,
    ),
    max_native_media_aggregate_bytes: clampCap(
      base.max_native_media_aggregate_bytes,
      override.max_native_media_aggregate_bytes,
    ),
    max_native_pdf_pages: clampCap(base.max_native_pdf_pages, override.max_native_pdf_pages),
    audio_codec_whitelist: intersectCodecs(base.audio_codec_whitelist, override.audio_codec_whitelist),
    video_codec_whitelist: intersectCodecs(base.video_codec_whitelist, override.video_codec_whitelist),
  };
  // MIME whitelist intersection: if either side defines one, the result is
  // that one; if both define, intersect. If neither defines, leave undefined.
  if (base.image_mime_whitelist && override.image_mime_whitelist) {
    const allowed = new Set(base.image_mime_whitelist);
    clamped.image_mime_whitelist = override.image_mime_whitelist.filter((m) =>
      allowed.has(m),
    );
  } else if (base.image_mime_whitelist) {
    clamped.image_mime_whitelist = [...base.image_mime_whitelist];
  } else if (override.image_mime_whitelist) {
    // Can only narrow — but with no base list the base is already
    // treated as the whitelist's superset, so pass the override through.
    clamped.image_mime_whitelist = [...override.image_mime_whitelist];
  }
  return clamped;
}

/** A profile may tighten a numeric cap but never widen it. */
function clampCap(base: number, override: number | undefined): number {
  return Math.min(base, Math.max(0, override ?? Number.POSITIVE_INFINITY));
}

/** Profile codec lists can only narrow the provider list. */
function intersectCodecs(base: string[], override: string[] | undefined): string[] {
  if (!override) return [...base];
  const allowed = new Set(base);
  return override.filter((c) => allowed.has(c));
}

export type NativeRoute =
  | "native_image"
  | "native_pdf"
  | "native_audio"
  | "native_video"
  | "extracted_text"
  | "attachment_only";

// ---------------------------------------------------------------------------
// Token-cost reserves used by admission-time capacity checks.
//
// These are conservative UPPER-BOUND estimates used solely for the
// pre-dispatch "will this fit?" check. They do not model vendor billing or
// any particular tokenizer; they trade precision for safety so admission
// never silently sends a request the provider will reject with
// `context_too_large`. See `src/core/context.ts` for the overall admission
// policy.
// ---------------------------------------------------------------------------

/**
 * Rough per-image token reserve. OpenAI documents a per-image cost that
 * depends on dimensions and detail level, Anthropic charges a flat
 * (height × width / 750) tokens for base64 images, Gemini uses tile-based
 * accounting. We take the pessimistic bound of:
 *
 *   max(1024, ceil(width * height / 750))
 *
 * which is the Anthropic worst case plus a 1024-token floor so very small
 * images still carry a visible reserve. Returns `0` when dimensions are
 * unknown — the routing layer refuses `native_image` in that case, so
 * capacity never needs to charge an image reserve for an unknown-sized
 * file.
 */
export function nativeImageTokenReserve(
  dims: { width: number; height: number } | null | undefined,
): number {
  if (!dims || !Number.isFinite(dims.width) || !Number.isFinite(dims.height)) return 0;
  const area = Math.max(0, dims.width * dims.height);
  return Math.max(1024, Math.ceil(area / 750));
}

/** Per-message wrapper allowance (the app's own estimator uses 8). */
const MESSAGE_WRAPPER_TOKENS = 8;

/**
 * Token cost of an extracted-text part as it is ACTUALLY sent: the framed
 * string (notice + header + text) priced with the app's own `estimateTokens`.
 * Admission and dispatch both call this through
 * `attachmentTokenReserveForRoutes`.
 */
export function extractedAttachmentTokenReserve(
  ref: Pick<AttachmentRef, "sanitized_display_name" | "sniffed_mime" | "byte_size" | "extraction_coverage">,
  text: string,
): number {
  if (!text) return 0;
  return (
    estimateTokens(
      frameExtractedAttachment({
        sanitized_display_name: ref.sanitized_display_name,
        sniffed_mime: ref.sniffed_mime,
        byte_size: ref.byte_size,
        text,
        truncated: ref.extraction_coverage.truncated,
      }),
    ) + MESSAGE_WRAPPER_TOKENS
  );
}

/** Token cost of the honest "was NOT analyzed" note that replaces the file. */
export function attachmentOnlyTokenReserve(
  ref: Pick<AttachmentRef, "sanitized_display_name" | "sniffed_mime" | "byte_size">,
  reason: string,
): number {
  return (
    estimateTokens(
      frameAttachmentOnlyNote({
        sanitized_display_name: ref.sanitized_display_name,
        sniffed_mime: ref.sniffed_mime,
        byte_size: ref.byte_size,
        reason,
      }),
    ) + MESSAGE_WRAPPER_TOKENS
  );
}

/** Raised when a frozen native route has no valid metadata to price. */
export class AttachmentReserveInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentReserveInvariantError";
  }
}

type NativeOnlyRoute = Extract<
  NativeRoute,
  "native_image" | "native_pdf" | "native_audio" | "native_video"
>;

/**
 * THE conservative admission/dispatch reserve for one native attachment.
 * Admission and dispatch BOTH call this function, so they cannot drift.
 * These are policy bounds, not vendor billing:
 *   - image: `nativeImageTokenReserve(dims)` + framing
 *   - PDF:   pages * 3,000 + framing
 *   - audio: ceil(seconds) * 64 + framing
 *   - video: ceil(seconds) * 512 + framing (static 1 fps keyframes)
 * A frozen native route whose metadata no longer validates is corruption,
 * not zero-cost input, so this throws instead of returning 0.
 */
export function nativeAttachmentTokenReserve(
  ref: Pick<
    AttachmentRef,
    "id" | "sniffed_width" | "sniffed_height" | "sniffed_pdf_pages" | "sniffed_media_duration_ms"
  >,
  route: NativeOnlyRoute,
): number {
  const framing = ATTACHMENT_POLICY.native_attachment_framing_tokens;
  if (route === "native_image") {
    const w = ref.sniffed_width;
    const h = ref.sniffed_height;
    if (w == null || h == null || !isImagePreviewDimensionsSafe(w, h)) {
      throw new AttachmentReserveInvariantError("native image has no valid dimensions");
    }
    return nativeImageTokenReserve({ width: w, height: h }) + framing;
  }
  if (route === "native_pdf") {
    const pages = sanitizePersistedPageCount(ref.sniffed_pdf_pages ?? null);
    if (pages === null) throw new AttachmentReserveInvariantError("native pdf has no valid page count");
    return pages * ATTACHMENT_POLICY.native_pdf_tokens_per_page + framing;
  }
  const ms = sanitizePersistedDurationMs(ref.sniffed_media_duration_ms ?? null);
  if (ms === null) throw new AttachmentReserveInvariantError("native media has no valid duration");
  const perSecond =
    route === "native_audio"
      ? ATTACHMENT_POLICY.native_audio_tokens_per_second
      : ATTACHMENT_POLICY.native_video_tokens_per_second;
  return Math.ceil(ms / 1000) * perSecond + framing;
}

/**
 * Total attachment token reserve for one agent's frozen routes. Shared by
 * admission and dispatch: native routes go through
 * `nativeAttachmentTokenReserve`, extracted text through
 * `extractedAttachmentTokenReserve`, attachment-only through
 * `attachmentOnlyTokenReserve` (both price the exact framed string).
 */
export function attachmentTokenReserveForRoutes(
  routes: ReadonlyArray<{ attachment_id: string; route: string; reason?: string }>,
  refsById: ReadonlyMap<string, AttachmentRef>,
  extractedTextFor: (attachmentId: string) => string,
): number {
  let total = 0;
  for (const r of routes) {
    const ref = refsById.get(r.attachment_id);
    if (!ref) continue;
    if (
      r.route === "native_image" ||
      r.route === "native_pdf" ||
      r.route === "native_audio" ||
      r.route === "native_video"
    ) {
      total += nativeAttachmentTokenReserve(ref, r.route);
    } else if (r.route === "extracted_text") {
      total += extractedAttachmentTokenReserve(ref, extractedTextFor(r.attachment_id));
    } else if (r.route === "attachment_only") {
      total += attachmentOnlyTokenReserve(ref, r.reason ?? "");
    }
  }
  return total;
}

// --- routing --------------------------------------------------------------

export interface NativeRoutingInput {
  /** The DISPATCH provider (`mock` for mock execution), used only for reasons. */
  provider: ProviderId;
  kind: AttachmentKind;
  sniffed_mime: string;
  normalized_media_mime: string | null;
  byte_size: number;
  has_extracted_text: boolean;
  capabilities: NativeCapabilitySet;
  remainingNativeBytes: number;
  remainingMediaBytes: number;
  remainingMediaSeconds: number;
  imageDimensions: { width: number; height: number } | null;
  pdfPageCount: number | null;
  mediaDurationSeconds: number | null;
  mediaStreams: MediaStreamMetadata[];
  validatedMediaFormat: string | null;
}

export interface NativeRouteDecision {
  route: NativeRoute;
  reason: string;
  /** MIME to put on the provider wire for a native route; else null. */
  native_mime: string | null;
  charged_native_bytes: number;
  charged_media_bytes: number;
  charged_media_seconds: number;
}

const NO_CHARGE = { charged_native_bytes: 0, charged_media_bytes: 0, charged_media_seconds: 0 };

function refuse(route: NativeRoute, reason: string): NativeRouteDecision {
  return { route, reason, native_mime: null, ...NO_CHARGE };
}

const MOCK_NO_BYTES_REASON = "mock mode sends no file bytes to any provider";

const BUDGET_NOTE = "earlier attachments in this conversation consumed the per-call native budget first";

/**
 * Decide how a single attachment is routed for a given profile. All native
 * decisions need VALIDATED metadata (image dimensions, PDF page count,
 * finite media duration, streams, normalized MIME). The caller tracks the
 * `remaining*` budgets across the ordered attachment list (history first,
 * then the current turn) and decrements them by the `charged_*` fields of
 * each native decision.
 */
export function routeNativeAttachment(input: NativeRoutingInput): NativeRouteDecision {
  const caps = input.capabilities;
  if (input.kind === "image") {
    const refuseImage = (reason: string): NativeRouteDecision =>
      refuse("attachment_only", reason);
    if (!caps.image) {
      return refuseImage(
        input.provider === "mock" ? MOCK_NO_BYTES_REASON : "profile does not accept images",
      );
    }
    if (caps.image_mime_whitelist && !caps.image_mime_whitelist.includes(input.sniffed_mime)) {
      return refuseImage(`profile does not accept ${input.sniffed_mime}`);
    }
    if (input.byte_size > caps.max_native_image_bytes) {
      return refuseImage("image larger than native cap");
    }
    // Images MUST have validated dimensions: byte size does not bound
    // pixel area, and a JPEG's dimensions are not in the 64-byte head.
    if (!input.imageDimensions) {
      return refuseImage(
        "image dimensions unknown; refusing native (byte size does not bound pixel area)",
      );
    }
    const { width, height } = input.imageDimensions;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return refuseImage("image dimensions invalid; refusing native");
    }
    if (
      width > ATTACHMENT_POLICY.max_native_image_side_px ||
      height > ATTACHMENT_POLICY.max_native_image_side_px
    ) {
      return refuseImage(
        `image ${width}×${height} exceeds ${ATTACHMENT_POLICY.max_native_image_side_px}px per-side cap`,
      );
    }
    if (width * height > ATTACHMENT_POLICY.max_native_image_pixels) {
      return refuseImage(
        `image ${width}×${height} exceeds ${ATTACHMENT_POLICY.max_native_image_pixels} pixel cap`,
      );
    }
    if (input.byte_size > caps.max_native_aggregate_bytes) {
      return refuseImage("image alone exceeds the per-call native byte cap");
    }
    if (input.byte_size > input.remainingNativeBytes) {
      return refuseImage(`would exceed the per-call native aggregate (${BUDGET_NOTE})`);
    }
    return {
      route: "native_image",
      reason: "",
      native_mime: input.sniffed_mime,
      ...NO_CHARGE,
      charged_native_bytes: input.byte_size,
    };
  }

  if (input.kind === "pdf") {
    const fallback = (reason: string): NativeRouteDecision =>
      input.has_extracted_text
        ? refuse("extracted_text", `${reason}; using extracted text`)
        : refuse("attachment_only", reason);
    if (!caps.pdf) {
      return fallback(input.provider === "mock" ? MOCK_NO_BYTES_REASON : "profile does not accept pdf");
    }
    if (typeof input.pdfPageCount !== "number" || !Number.isInteger(input.pdfPageCount) || input.pdfPageCount <= 0) {
      return fallback("pdf page count not validated; refusing native (no bound on context cost)");
    }
    if (input.pdfPageCount > caps.max_native_pdf_pages) {
      return fallback(`pdf has ${input.pdfPageCount} pages; native cap is ${caps.max_native_pdf_pages}`);
    }
    if (input.byte_size > caps.max_native_aggregate_bytes) {
      return fallback("pdf larger than native cap");
    }
    if (input.byte_size > input.remainingNativeBytes) {
      return fallback(`would exceed the per-call native aggregate (${BUDGET_NOTE})`);
    }
    return {
      route: "native_pdf",
      reason: "",
      native_mime: input.sniffed_mime,
      ...NO_CHARGE,
      charged_native_bytes: input.byte_size,
    };
  }

  if (input.kind === "audio" || input.kind === "video") {
    return routeMedia(input, input.kind);
  }

  // text / archive / document / binary: never native.
  if (input.has_extracted_text) return refuse("extracted_text", "");
  return refuse("attachment_only", "no native route; no extracted text");
}

function routeMedia(input: NativeRoutingInput, kind: "audio" | "video"): NativeRouteDecision {
  const caps = input.capabilities;
  const no = (reason: string): NativeRouteDecision => refuse("attachment_only", reason);
  const supported = kind === "audio" ? caps.audio : caps.video;
  if (!supported) {
    return no(
      input.provider === "openai" || input.provider === "anthropic"
        ? `native audio/video is not supported for ${input.provider} in this app`
        : input.provider === "mock"
          ? "mock execution never reads media bytes"
          : `profile does not accept ${kind}`,
    );
  }
  // Structural checks run before the normalized-MIME check so a refusal
  // names the specific defect (no streams, unknown duration, no bounded
  // video stream) rather than a generic "not validated".
  if (input.mediaStreams.length === 0) return no("no validated media streams");
  const seconds = input.mediaDurationSeconds;
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
    return no("duration unknown; refusing native routing (byte size does not bound context)");
  }
  const perKindCap = kind === "audio" ? caps.max_native_audio_seconds : caps.max_native_video_seconds;
  if (seconds > perKindCap) {
    return no(`${kind} duration ${seconds} s exceeds the ${perKindCap} s native cap`);
  }
  const audioStreams = input.mediaStreams.filter((s) => s.codec_type === "audio");
  const videoStreams = input.mediaStreams.filter((s) => s.codec_type === "video");
  if (kind === "audio") {
    if (audioStreams.length === 0) return no("no audio stream");
    if (videoStreams.length > 0) return no("audio file contains a video stream; refusing native audio");
  } else if (!allVideoStreamsBounded(input.mediaStreams)) {
    return no("no positive bounded video stream");
  }
  for (const s of audioStreams) {
    if (!caps.audio_codec_whitelist.includes(s.codec_name)) {
      return no(`audio codec ${s.codec_name} is not supported natively`);
    }
  }
  for (const s of videoStreams) {
    if (!caps.video_codec_whitelist.includes(s.codec_name)) {
      return no(`video codec ${s.codec_name} is not supported natively`);
    }
  }
  if (!input.normalized_media_mime) {
    return no(
      input.sniffed_mime === "video/quicktime"
        ? "QuickTime container not validated"
        : "media container not validated; refusing native",
    );
  }
  if (!input.normalized_media_mime.startsWith(`${kind}/`)) {
    return no("validated media type does not match the file kind");
  }
  if (input.byte_size > caps.max_native_inline_media_bytes) {
    return no(`${kind} exceeds the inline media cap`);
  }
  // Absolute per-call caps first: a file that exceeds one ALONE must not blame
  // earlier attachments. The "earlier attachments" note is only added when the
  // remaining budget (which earlier files reduced) is what refuses it.
  if (input.byte_size > caps.max_native_media_aggregate_bytes) {
    return no(`${kind} alone exceeds the per-call media byte cap (${caps.max_native_media_aggregate_bytes} B)`);
  }
  if (input.byte_size > caps.max_native_aggregate_bytes) {
    return no(`${kind} alone exceeds the per-call native byte cap (${caps.max_native_aggregate_bytes} B)`);
  }
  if (seconds > caps.max_native_media_aggregate_seconds) {
    return no(`${kind} duration ${seconds} s alone exceeds the ${caps.max_native_media_aggregate_seconds} s per-call media cap`);
  }
  if (input.byte_size > input.remainingMediaBytes) {
    return no(`would exceed the per-call media byte aggregate (${BUDGET_NOTE})`);
  }
  if (input.byte_size > input.remainingNativeBytes) {
    return no(`would exceed the per-call native aggregate (${BUDGET_NOTE})`);
  }
  if (seconds > input.remainingMediaSeconds) {
    return no(
      `would exceed the per-call media duration aggregate (${input.remainingMediaSeconds} s left; ${BUDGET_NOTE})`,
    );
  }
  return {
    route: kind === "audio" ? "native_audio" : "native_video",
    reason: "",
    native_mime: input.normalized_media_mime,
    charged_native_bytes: input.byte_size,
    charged_media_bytes: input.byte_size,
    charged_media_seconds: seconds,
  };
}

// --- per-agent plan ---------------------------------------------------------

/** Cumulative native reserve at most this fraction of the profile's safe input. */
export const NATIVE_TOKEN_BUDGET_FRACTION = 0.5;

export interface PlannedAttachmentRoute {
  attachment_id: string;
  route: NativeRoute;
  reason: string;
}

/**
 * Route EVERY ref (history first, then the current turn) for one agent and
 * freeze the result. Native budgets (bytes, media bytes, media seconds, and
 * the profile-relative native token reserve) are charged in this order, so
 * a later file can be refused because earlier conversation files used the
 * budget; the refusal reason says so. Metadata is re-validated through the
 * shared sanitizers here, never trusted from the caller's object.
 */
export function planAttachmentRoutes(opts: {
  refs: readonly AttachmentRef[];
  hasExtractedText: (attachmentId: string) => boolean;
  capabilities: NativeCapabilitySet;
  provider: ProviderId;
  safeInputTokens: number;
}): PlannedAttachmentRoute[] {
  const caps = opts.capabilities;
  let remainingNativeBytes = caps.max_native_aggregate_bytes;
  let remainingMediaBytes = caps.max_native_media_aggregate_bytes;
  let remainingMediaSeconds = caps.max_native_media_aggregate_seconds;
  let nativeTokens = 0;
  const tokenBudget = Math.floor(opts.safeInputTokens * NATIVE_TOKEN_BUDGET_FRACTION);
  return opts.refs.map((ref) => {
    const hasText = opts.hasExtractedText(ref.id);
    const durationMs = sanitizePersistedDurationMs(ref.sniffed_media_duration_ms ?? null);
    const decision = routeNativeAttachment({
      provider: opts.provider,
      kind: ref.kind,
      sniffed_mime: ref.sniffed_mime,
      normalized_media_mime: sanitizePersistedMediaMime(ref.normalized_media_mime ?? null),
      byte_size: ref.byte_size,
      has_extracted_text: hasText,
      capabilities: caps,
      remainingNativeBytes,
      remainingMediaBytes,
      remainingMediaSeconds,
      imageDimensions:
        ref.sniffed_width != null && ref.sniffed_height != null
          ? { width: ref.sniffed_width, height: ref.sniffed_height }
          : null,
      pdfPageCount: sanitizePersistedPageCount(ref.sniffed_pdf_pages ?? null),
      mediaDurationSeconds: durationMs === null ? null : durationMs / 1000,
      mediaStreams: parsePersistedMediaStreams(ref.sniffed_media_streams_json ?? null),
      validatedMediaFormat: sanitizePersistedMediaFormat(ref.validated_media_format ?? null),
    });
    if (
      decision.route === "native_image" ||
      decision.route === "native_pdf" ||
      decision.route === "native_audio" ||
      decision.route === "native_video"
    ) {
      const reserve = nativeAttachmentTokenReserve(ref, decision.route);
      if (nativeTokens + reserve > tokenBudget) {
        const reason =
          reserve > tokenBudget
            ? `native reserve ${reserve} tokens alone exceeds the profile budget of ${tokenBudget}`
            : `native reserve ${nativeTokens + reserve} tokens exceeds the profile budget of ${tokenBudget} (${BUDGET_NOTE})`;
        return hasText && ref.kind === "pdf"
          ? { attachment_id: ref.id, route: "extracted_text" as const, reason: `${reason}; using extracted text` }
          : { attachment_id: ref.id, route: "attachment_only" as const, reason };
      }
      nativeTokens += reserve;
      remainingNativeBytes = Math.max(0, remainingNativeBytes - decision.charged_native_bytes);
      remainingMediaBytes = Math.max(0, remainingMediaBytes - decision.charged_media_bytes);
      remainingMediaSeconds = Math.max(0, remainingMediaSeconds - decision.charged_media_seconds);
    }
    return { attachment_id: ref.id, route: decision.route, reason: decision.reason };
  });
}

/** MIME that goes on the provider wire for a native route. */
export function nativeWireMime(
  ref: Pick<AttachmentRef, "kind" | "sniffed_mime" | "normalized_media_mime">,
): string {
  if (ref.kind === "audio" || ref.kind === "video") {
    const mime = sanitizePersistedMediaMime(ref.normalized_media_mime ?? null);
    if (mime === null) throw new AttachmentReserveInvariantError("native media has no normalized MIME");
    return mime;
  }
  return ref.sniffed_mime;
}

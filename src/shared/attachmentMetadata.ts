import type { AttachmentExtractionCoverage } from "./types.js";

// Validated attachment metadata shared by storage, the coordinator, routing,
// and the preview guard. Every value that crosses a trust boundary (a
// persisted SQLite row, a probe result) re-enters the domain only through
// these sanitizers, so a corrupted row can never become a cost bound or an
// admission decision. `null` always means "unknown", never "zero".

export interface MediaStreamMetadata {
  codec_type: "audio" | "video";
  codec_name: string;
  width?: number;
  height?: number;
  channels?: number;
  sample_rate?: number;
  duration_seconds?: number;
}

const MAX_PDF_PAGES = 1_000_000;
const MAX_MEDIA_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_STREAMS = 8;
const MAX_STREAMS_JSON_CHARS = 4096;

/** Normalized media MIME values this app supports for validated media. */
export const SUPPORTED_NORMALIZED_MEDIA_MIME: readonly string[] = [
  "audio/wav",
  "audio/mpeg",
  "audio/ogg",
  "audio/flac",
  "video/mp4",
  "video/webm",
  "video/mov",
];

/** Page counts are positive integers; anything else is "unknown". */
export function sanitizePersistedPageCount(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "number") return null;
  if (!Number.isInteger(raw) || raw <= 0 || raw > MAX_PDF_PAGES) return null;
  return raw;
}

/** Duration (ms) is a positive integer of at most 24 hours. */
export function sanitizePersistedDurationMs(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "number") return null;
  if (!Number.isInteger(raw) || raw <= 0 || raw > MAX_MEDIA_DURATION_MS) return null;
  return raw;
}

function toBoundedPositiveInt(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isInteger(value) || value <= 0 || value >= 100_000) return null;
  return value;
}

/**
 * Validate a persisted stream summary. FAILS CLOSED: more than 8 entries, a
 * non-audio/video entry, or an audio/video entry without a clean codec name
 * returns `[]` ("unvalidated"), never a truncated or filtered list.
 */
function sanitizeStreamList(parsed: unknown): MediaStreamMetadata[] {
  if (!Array.isArray(parsed) || parsed.length > MAX_STREAMS) return [];
  const out: MediaStreamMetadata[] = [];
  for (const s of parsed) {
    if (!s || typeof s !== "object") return [];
    const typed = s as Record<string, unknown>;
    const codecType = typed["codec_type"];
    const codecName = typed["codec_name"];
    if (codecType !== "audio" && codecType !== "video") return [];
    if (typeof codecName !== "string" || !/^[a-zA-Z0-9_-]{1,32}$/.test(codecName)) return [];
    const stream: MediaStreamMetadata = { codec_type: codecType, codec_name: codecName };
    const width = toBoundedPositiveInt(typed["width"]);
    const height = toBoundedPositiveInt(typed["height"]);
    const channels = toBoundedPositiveInt(typed["channels"]);
    const sampleRate = toBoundedPositiveInt(typed["sample_rate"]);
    if (width !== null) stream.width = width;
    if (height !== null) stream.height = height;
    if (channels !== null) stream.channels = channels;
    if (sampleRate !== null) stream.sample_rate = sampleRate;
    const dur = typed["duration_seconds"];
    if (typeof dur === "number" && Number.isFinite(dur) && dur > 0 && dur <= 24 * 60 * 60) {
      stream.duration_seconds = Math.round(dur * 1000) / 1000;
    }
    out.push(stream);
  }
  return out;
}

/** Re-serialize a persisted stream summary only if it validates; else null. */
export function sanitizePersistedStreamsJson(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_STREAMS_JSON_CHARS) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const streams = sanitizeStreamList(parsed);
  if (streams.length === 0) return null;
  return JSON.stringify(streams);
}

/** Parse and validate; returns `[]` when the summary is missing or invalid. */
export function parsePersistedMediaStreams(raw: unknown): MediaStreamMetadata[] {
  const clean = sanitizePersistedStreamsJson(raw);
  if (clean === null) return [];
  return sanitizeStreamList(JSON.parse(clean));
}

/** Container `format_name` as reported by ffprobe: <=128 chars of [A-Za-z0-9_,-]. */
export function sanitizePersistedMediaFormat(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 128) return null;
  if (!/^[A-Za-z0-9_,-]+$/.test(raw)) return null;
  return raw;
}

/** Normalized media MIME must be in the locally supported allowlist. */
export function sanitizePersistedMediaMime(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return SUPPORTED_NORMALIZED_MEDIA_MIME.includes(raw) ? raw : null;
}

export const MAX_BOUNDED_VIDEO_SIDE_PX = 4096;
export const MAX_BOUNDED_VIDEO_PIXELS = 16_000_000;

/** First video stream with positive, bounded dimensions; else null. */
export function pickBoundedVideoStreamFrom(
  streams: readonly MediaStreamMetadata[],
): MediaStreamMetadata | null {
  for (const s of streams) {
    if (s.codec_type !== "video") continue;
    if (!s.width || !s.height) continue;
    if (s.width > MAX_BOUNDED_VIDEO_SIDE_PX || s.height > MAX_BOUNDED_VIDEO_SIDE_PX) continue;
    if (s.width * s.height > MAX_BOUNDED_VIDEO_PIXELS) continue;
    return s;
  }
  return null;
}

/**
 * At least one video stream, and EVERY video stream has positive dimensions
 * within bounds. Shared by routing, probe normalization and both preview
 * guards, so a second unbounded track can never ride along with a bounded one.
 */
export function allVideoStreamsBounded(streams: readonly MediaStreamMetadata[]): boolean {
  const video = streams.filter((s) => s.codec_type === "video");
  return video.length > 0 && video.every((s) => pickBoundedVideoStreamFrom([s]) !== null);
}

/**
 * THE structural rule for inline media preview, shared verbatim by the
 * server's `/preview` guard and the client's element gate: persisted finite
 * duration, a normalized MIME, parseable streams, and for audio at least one
 * audio stream, for video every video stream bounded. Preview eligibility
 * never implies provider support.
 */
export function isMediaPreviewValidated(row: {
  kind: string;
  sniffed_media_duration_ms?: unknown;
  sniffed_media_streams_json?: unknown;
  normalized_media_mime?: unknown;
}): boolean {
  if (row.kind !== "audio" && row.kind !== "video") return false;
  if (sanitizePersistedDurationMs(row.sniffed_media_duration_ms) === null) return false;
  if (sanitizePersistedMediaMime(row.normalized_media_mime) === null) return false;
  const streams = parsePersistedMediaStreams(row.sniffed_media_streams_json);
  if (streams.length === 0) return false;
  if (row.kind === "video") return allVideoStreamsBounded(streams);
  return streams.some((s) => s.codec_type === "audio");
}

/** Image width/height: a positive integer of at most 100,000, else unknown. */
export function sanitizePersistedImageDimension(raw: unknown): number | null {
  if (typeof raw !== "number") return null;
  if (!Number.isInteger(raw) || raw <= 0 || raw > 100_000) return null;
  return raw;
}

/**
 * THE extraction-coverage parser, used by the repository (history refs, DTOs)
 * and by the coordinator (current-turn refs), so a malformed row yields the
 * same value on both paths. `truncated` is true only for the boolean `true`
 * (the string "false" is not truthy here), and counts are safe non-negative
 * integers.
 */
export function parseExtractionCoverage(
  json: unknown,
  extractionStatus: string,
): AttachmentExtractionCoverage {
  const fallbackLabel =
    extractionStatus === "unsupported"
      ? "unsupported — attachment-only"
      : extractionStatus === "encrypted"
        ? "encrypted — attachment-only"
        : extractionStatus === "failed"
          ? "extraction failed — attachment-only"
          : "attachment-only";
  const fallback: AttachmentExtractionCoverage = {
    extracted_chars: 0,
    truncated: false,
    label: fallbackLabel,
  };
  if (typeof json !== "string" || json.length === 0) return fallback;
  try {
    const parsed = JSON.parse(json) as Partial<Record<keyof AttachmentExtractionCoverage, unknown>> | null;
    if (!parsed || typeof parsed !== "object") return fallback;
    const chars = parsed.extracted_chars;
    return {
      extracted_chars:
        typeof chars === "number" && Number.isSafeInteger(chars) && chars >= 0 ? chars : 0,
      truncated: parsed.truncated === true,
      label:
        typeof parsed.label === "string" && parsed.label.length > 0
          ? parsed.label.slice(0, 300)
          : fallbackLabel,
    };
  } catch {
    return fallback;
  }
}


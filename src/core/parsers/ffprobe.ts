// Bounded media metadata probe via a fixed, pre-discovered ffprobe
// install.
//
// Transport: FD-ONLY read-only blob inheritance. The server opens the
// UUID blob read-only, passes the FD to the child as `stdio[0]`, and
// tells ffprobe to read from it via the `fd:` protocol with
// `-protocol_whitelist fd`. No other protocol is allowed — not
// `file`, not `crypto`, not `data` — so even a crafted container that
// references a sibling URL cannot cause ffprobe to open anything other
// than the one blob we handed it. The parent-side FD is closed in a
// `finally` block after the child's `close` event.
//
// Hard argv constraints (never caller-supplied):
//   -v error                       suppress informational stderr
//   -protocol_whitelist fd         only fd: protocol
//   -format_whitelist mov,matroska,wav,mp3,ogg,flac
//                                  only trusted container families
//   -probesize 1048576             1 MiB probe window
//   -analyzeduration 1000000       1 s analysis window (µs)
//   -max_alloc 33554432            32 MiB max alloc per instance
//   -show_entries format=duration,format_name:stream=codec_type,
//                codec_name,width,height,duration,sample_rate,channels
//   -of json                       bounded JSON output
//   -fd 0 -i fd:                   input is the inherited FD (a regular
//                                  file FD, so WAV seeking/duration work;
//                                  `pipe:0` would not seek)
//
// Classification rules:
//   - Missing / invalid duration → `duration unknown`, native routing refused.
//   - Empty streams array (fixture: corrupt-truncated.mp4) → native
//     routing refused with "no streams reported" even if exit code is 0.
//   - Any video stream whose declared `width`×`height` is 0 or exceeds
//     the per-side cap → that stream contributes no dimensions. Video
//     requires AT LEAST ONE positive-bounded video stream for the
//     caller to admit native video.
//   - `normalized_mime` is computed ONLY for a structurally validated
//     probe (positive finite duration, non-empty streams, and for video a
//     positive bounded video stream). Sniffed `video/quicktime` becomes
//     `video/mov` only when `format_name` includes the `mov` token. The
//     container family must also match the sniffed MIME (e.g. an EBML
//     file with H.264 is Matroska, not WebM, and is never normalized).
//     Provider codec policy is NOT decided here; routing does that.

import fs from "node:fs";
import {
  allVideoStreamsBounded,
  pickBoundedVideoStreamFrom,
  type MediaStreamMetadata,
} from "../../shared/attachmentMetadata.js";
import type { ChildProcess } from "node:child_process";
import { discoverFfprobe } from "./binaryTools.js";
import { runBoundedProc } from "./boundedProc.js";

const FFPROBE_TIMEOUT_MS = 5_000;
const FFPROBE_STDOUT_CAP_BYTES = 32 * 1024;
const FFPROBE_STDERR_CAP_BYTES = 8 * 1024;

/**
 * Container families we are willing to probe. The forced
 * `-format_whitelist` for every ffprobe invocation. The server-sniffed
 * mime is NOT used to narrow this further at probe time — a mp3 file
 * sniffed as audio/mpeg can safely be probed with the mp3 demuxer
 * because ffprobe will refuse to open a format outside this list even
 * if the container claims to be something else.
 */
const FORMAT_WHITELIST = "mov,matroska,wav,mp3,ogg,flac";

export interface MediaProbeInput {
  blob_path: string;
  sniffed_mime: string;
  byte_size: number;
  signal?: AbortSignal;
  /** Test hooks: the spawned child and the inherited read-only blob FD. */
  onChild?: (child: ChildProcess) => void;
  onBlobFd?: (fd: number) => void;
}

export interface MediaProbeResult {
  /** Non-null when ffprobe reported a bounded, strictly-positive duration. */
  duration_seconds: number | null;
  /** Reported `format_name` after sanitization, e.g. `"mov,mp4,m4a,3gp,3g2,mj2"`. */
  format_name: string | null;
  /** Bounded per-stream summary. */
  streams: MediaStream[];
  /** Media MIME for provider wire use; non-null only for a validated probe. */
  normalized_mime: string | null;
  /** Classification reason when the probe did not validate. */
  reason: string | null;
  /** True iff the external AbortSignal fired. */
  aborted: boolean;
}

export type MediaStream = MediaStreamMetadata;

export async function probeMedia(input: MediaProbeInput): Promise<MediaProbeResult> {
  const bin = discoverFfprobe();
  if (!bin) {
    return baseFail("ffprobe not installed on this server");
  }
  if (input.signal?.aborted) {
    return baseFail("probe cancelled", { aborted: true });
  }

  // Open the UUID blob read-only. The returned FD is inherited by the
  // child via `stdio[0]`; the parent-side FD is closed in `finally`.
  let blobFd: number;
  try {
    blobFd = fs.openSync(input.blob_path, fs.constants.O_RDONLY);
  } catch {
    return baseFail("blob open failed");
  }
  input.onBlobFd?.(blobFd);

  try {
    const argv = [
      "-v", "error",
      "-protocol_whitelist", "fd",
      "-format_whitelist", FORMAT_WHITELIST,
      "-probesize", "1048576",
      "-analyzeduration", "1000000",
      "-max_alloc", "33554432",
      "-show_entries",
      "format=duration,format_name:stream=codec_type,codec_name,width,height,duration,sample_rate,channels",
      "-of", "json",
      "-fd", "0",
      "-i", "fd:",
    ];
    const r = await runBoundedProc(bin.path, argv, {
      timeoutMs: FFPROBE_TIMEOUT_MS,
      captureStdoutBytes: FFPROBE_STDOUT_CAP_BYTES,
      captureStderrBytes: FFPROBE_STDERR_CAP_BYTES,
      stdio: [blobFd, "pipe", "pipe"],
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onChild ? { onChild: input.onChild } : {}),
    });
    if (r.aborted) return baseFail("probe cancelled", { aborted: true });
    if (r.spawnError || r.exitCode !== 0 || r.truncatedStdoutBytes) {
      return baseFail("ffprobe failed");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      return baseFail("ffprobe json parse failed");
    }
    if (!parsed || typeof parsed !== "object") {
      return baseFail("ffprobe empty output");
    }
    return interpretProbeJson(parsed, input.sniffed_mime);
  } finally {
    try { fs.closeSync(blobFd); } catch { /* ignore */ }
  }
}

/**
 * Turn ffprobe's parsed JSON into a validated result. Pure (no process, no
 * file), so synthetic JSON can exercise every refusal branch in unit tests.
 */
export function interpretProbeJson(parsed: unknown, sniffedMime: string): MediaProbeResult {
  const probe = (parsed ?? {}) as {
    format?: { duration?: unknown; format_name?: unknown };
    streams?: unknown[];
  };
  const formatName = sanitizeFormatName(probe.format?.format_name);
  const sanitized = sanitizeStreams(probe.streams);
  if (!sanitized.ok) {
    // Never validate a subset: too many streams, an unidentified codec or an
    // invalid stream duration makes the whole file unvalidated.
    return { ...baseFail(sanitized.reason), format_name: formatName };
  }
  const streams = sanitized.streams;
  // The CONTAINER duration must be present and valid; stream durations can
  // only raise the policy value (largest wins), never stand in for it.
  const containerDuration = sanitizeDuration(probe.format?.duration);
  const duration = containerDuration === null ? null : policyDuration(containerDuration, streams);
  const fail = (reason: string): MediaProbeResult => ({
    duration_seconds: duration,
    format_name: formatName,
    streams,
    normalized_mime: null,
    reason,
    aborted: false,
  });
  // `corrupt-truncated.mp4` exits 0 with empty streams: never native.
  if (streams.length === 0) return fail("no streams reported");
  if (duration === null) return fail("duration not reported or invalid");
  const normalized = normalizeMime(sniffedMime, formatName, streams, sanitized.otherStreams);
  if (normalized.mime === null) return fail(normalized.reason);
  return {
    duration_seconds: duration,
    format_name: formatName,
    streams,
    normalized_mime: normalized.mime,
    reason: null,
    aborted: false,
  };
}

/**
 * The LARGEST reported duration (container and every stream). A missing
 * container duration stays null: stream durations never replace it.
 */
export function policyDuration(
  formatDuration: number | null,
  streams: readonly { duration_seconds?: number }[],
): number | null {
  if (formatDuration === null) return null;
  return Math.max(formatDuration, ...streams.map((st) => st.duration_seconds ?? 0));
}

function baseFail(reason: string, extra: Partial<MediaProbeResult> = {}): MediaProbeResult {
  return {
    duration_seconds: null,
    format_name: null,
    streams: [],
    normalized_mime: null,
    reason,
    aborted: false,
    ...extra,
  };
}

function sanitizeDuration(raw: unknown): number | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const n = typeof raw === "number" ? raw : Number.parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Hard cap: a declared duration above 24 hours is treated as
  // unverified. The routing layer applies its own narrower per-profile
  // policy cap on top of this.
  if (n > 24 * 60 * 60) return null;
  return Math.round(n * 1000) / 1000;
}

function sanitizeFormatName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const stripped = raw.slice(0, 128).replace(/[^a-zA-Z0-9_,-]/g, "");
  return stripped.length > 0 ? stripped : null;
}

const MAX_PROBED_STREAMS = 8;

type SanitizedStreams =
  | { ok: true; streams: MediaStream[]; otherStreams: number }
  | { ok: false; reason: string };

function sanitizeStreams(raw: unknown): SanitizedStreams {
  if (!Array.isArray(raw)) return { ok: true, streams: [], otherStreams: 0 };
  // Counted BEFORE any filtering: subtitle/data streams must not hide later ones.
  if (raw.length > MAX_PROBED_STREAMS) return { ok: false, reason: "more than 8 streams" };
  const out: MediaStream[] = [];
  let otherStreams = 0;
  for (const s of raw) {
    if (!s || typeof s !== "object") return { ok: false, reason: "unidentified stream" };
    const typedS = s as Record<string, unknown>;
    const codecType = typedS["codec_type"];
    if (codecType !== "audio" && codecType !== "video") {
      otherStreams += 1;
      continue;
    }
    const codecName = typedS["codec_name"];
    // ffprobe omits `codec_name` for a codec it cannot identify.
    if (typeof codecName !== "string" || !/^[a-zA-Z0-9_-]{1,32}$/.test(codecName)) {
      return { ok: false, reason: "unidentified stream codec" };
    }
    const stream: MediaStream = { codec_type: codecType, codec_name: codecName };
    const width = toFinitePositiveInt(typedS["width"]);
    const height = toFinitePositiveInt(typedS["height"]);
    const channels = toFinitePositiveInt(typedS["channels"]);
    const sampleRate = toFinitePositiveInt(typedS["sample_rate"]);
    // A stream that reports a duration key must report a VALID one (>0, <=24 h).
    const streamDuration = sanitizeDuration(typedS["duration"]);
    if ("duration" in typedS && typedS["duration"] !== undefined && streamDuration === null) {
      return { ok: false, reason: "stream duration invalid" };
    }
    if (width !== null) stream.width = width;
    if (height !== null) stream.height = height;
    if (channels !== null) stream.channels = channels;
    if (sampleRate !== null) stream.sample_rate = sampleRate;
    if (streamDuration !== null) stream.duration_seconds = streamDuration;
    out.push(stream);
  }
  return { ok: true, streams: out, otherStreams };
}

function toFinitePositiveInt(raw: unknown): number | null {
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  const n = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > 100_000) return null;
  return n;
}

// The container family ffprobe must report for each sniffed MIME. A sniffed
// MIME that the probed container contradicts is never normalized.
const FAMILY_TOKEN_BY_MIME: Record<string, string[]> = {
  "audio/wav": ["wav"],
  "audio/mpeg": ["mp3"],
  "audio/ogg": ["ogg"],
  "audio/flac": ["flac"],
  "video/mp4": ["mov"],
  "video/quicktime": ["mov"],
  "video/webm": ["matroska", "webm"],
};
// EBML containers all sniff as video/webm; only WebM codecs may keep that name.
const WEBM_CODECS = new Set(["vp8", "vp9", "av1", "opus", "vorbis"]);

function normalizeMime(
  sniffed: string,
  formatName: string | null,
  streams: readonly MediaStream[],
  otherStreams: number,
): { mime: string; reason: null } | { mime: null; reason: string } {
  const family = FAMILY_TOKEN_BY_MIME[sniffed];
  if (!family) return { mime: null, reason: "media type not supported" };
  const tokens = (formatName ?? "").split(",");
  if (!family.some((t) => tokens.includes(t))) {
    return { mime: null, reason: "container does not match the file type" };
  }
  if (sniffed.startsWith("audio/")) {
    if (!streams.some((s) => s.codec_type === "audio")) {
      return { mime: null, reason: "no audio stream" };
    }
    return { mime: sniffed, reason: null };
  }
  if (!allVideoStreamsBounded(streams)) {
    return { mime: null, reason: "no positive bounded video stream" };
  }
  if (
    sniffed === "video/webm" &&
    (otherStreams > 0 || !streams.every((s) => WEBM_CODECS.has(s.codec_name)))
  ) {
    return { mime: null, reason: "container is not WebM" };
  }
  // QuickTime is named `video/mov` on the wire only after validation.
  return { mime: sniffed === "video/quicktime" ? "video/mov" : sniffed, reason: null };
}

/**
 * First video stream with strictly positive, bounded dimensions (each
 * side <= 4096, area <= 16 Mpx), else null. `huge-dimensions-header-only.mp4`
 * reports 0x0 and therefore has none.
 */
export function pickBoundedVideoStream(result: Pick<MediaProbeResult, "streams">): MediaStream | null {
  return pickBoundedVideoStreamFrom(result.streams);
}

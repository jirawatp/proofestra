// ffprobe wrapper behavior with the binary discovery and the bounded runner
// REPLACED by scripted fakes (not live ffprobe: real probes of the media
// fixtures are in tests/integration/content_parsers.test.ts and are only ever
// header probes, never decoding). The hostile header-only fixture is not used here.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoundedRunOpts, BoundedRunResult } from "../../src/core/parsers/boundedProc.js";

const tool = { available: true };
const runner = {
  queue: [] as Array<Partial<BoundedRunResult>>,
  calls: [] as Array<{ bin: string; argv: readonly string[]; opts: BoundedRunOpts }>,
};

vi.mock("../../src/core/parsers/binaryTools.js", () => ({
  discoverFfprobe: () => (tool.available ? { path: "/fake/ffprobe", version: "7" } : null),
}));
vi.mock("../../src/core/parsers/boundedProc.js", () => ({
  runBoundedProc: async (bin: string, argv: readonly string[], opts: BoundedRunOpts): Promise<BoundedRunResult> => {
    runner.calls.push({ bin, argv, opts });
    const next = runner.queue.shift();
    if (!next) throw new Error("unexpected extra subprocess call");
    return {
      stdout: "",
      stderr: "",
      exitCode: 0,
      signaled: false,
      aborted: false,
      timedOut: false,
      truncatedStdoutBytes: false,
      truncatedStderrBytes: false,
      spawnError: false,
      ...next,
    };
  },
}));

import {
  interpretProbeJson,
  pickBoundedVideoStream,
  policyDuration,
  probeMedia,
} from "../../src/core/parsers/ffprobe.js";

let tmpDir: string;
let blob: string;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proofestra-ffprobe-unit-"));
  blob = path.join(tmpDir, "00000000-0000-4000-8000-000000000000");
  fs.writeFileSync(blob, "not really media; the runner is faked");
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
beforeEach(() => {
  tool.available = true;
  runner.queue.length = 0;
  runner.calls.length = 0;
});

const video = (extra: object = {}) => ({ codec_type: "video", codec_name: "h264", width: 320, height: 240, ...extra });
const audio = (extra: object = {}) => ({ codec_type: "audio", codec_name: "aac", ...extra });
const mp4 = { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "2.0" };

describe("probeMedia process handling", () => {
  it("ffprobe not installed: refused with a clear reason, nothing spawned", async () => {
    tool.available = false;
    const r = await probeMedia({ blob_path: blob, sniffed_mime: "video/mp4", byte_size: 1 });
    expect(r).toEqual({
      duration_seconds: null,
      format_name: null,
      streams: [],
      normalized_mime: null,
      reason: "ffprobe not installed on this server",
      aborted: false,
    });
    expect(runner.calls).toHaveLength(0);
  });

  it("an already-aborted signal is reported as aborted before opening the blob", async () => {
    const ac = new AbortController();
    ac.abort();
    const onBlobFd = vi.fn();
    const r = await probeMedia({ blob_path: blob, sniffed_mime: "video/mp4", byte_size: 1, signal: ac.signal, onBlobFd });
    expect(r.aborted).toBe(true);
    expect(r.reason).toBe("probe cancelled");
    expect(onBlobFd).not.toHaveBeenCalled();
    expect(runner.calls).toHaveLength(0);
  });

  it("an unopenable blob path fails without spawning", async () => {
    const r = await probeMedia({ blob_path: path.join(tmpDir, "missing"), sniffed_mime: "video/mp4", byte_size: 1 });
    expect(r.reason).toBe("blob open failed");
    expect(r.normalized_mime).toBeNull();
    expect(runner.calls).toHaveLength(0);
  });

  it("probes through the FD only with the fixed, restrictive argv, then closes the parent's FD", async () => {
    runner.queue.push({ stdout: JSON.stringify({ format: mp4, streams: [video(), audio()] }) });
    let fd = -1;
    const ac = new AbortController();
    const onChild = vi.fn();
    const r = await probeMedia({ blob_path: blob, sniffed_mime: "video/mp4", byte_size: 1, signal: ac.signal, onChild, onBlobFd: (f) => (fd = f) });
    expect(r.reason).toBeNull();
    expect(r.normalized_mime).toBe("video/mp4");
    expect(r.duration_seconds).toBe(2);
    expect(r.streams.map((s) => s.codec_type)).toEqual(["video", "audio"]);

    const call = runner.calls[0]!;
    expect(call.bin).toBe("/fake/ffprobe");
    expect(call.argv).toEqual([
      "-v", "error",
      "-protocol_whitelist", "fd",
      "-format_whitelist", "mov,matroska,wav,mp3,ogg,flac",
      "-probesize", "1048576",
      "-analyzeduration", "1000000",
      "-max_alloc", "33554432",
      "-show_entries",
      "format=duration,format_name:stream=codec_type,codec_name,width,height,duration,sample_rate,channels",
      "-of", "json",
      "-fd", "0",
      "-i", "fd:",
    ]);
    expect(call.argv).not.toContain(blob);
    expect(call.opts.stdio).toEqual([fd, "pipe", "pipe"]);
    expect(call.opts.signal).toBe(ac.signal);
    expect(call.opts.onChild).toBe(onChild);
    expect(fd).toBeGreaterThan(2);
    expect(() => fs.fstatSync(fd)).toThrow();
  });

  it("abort during the probe, spawn failure, a non-zero exit and truncated JSON are all refusals", async () => {
    const cases: Array<[Partial<BoundedRunResult>, string, boolean]> = [
      [{ aborted: true, exitCode: null }, "probe cancelled", true],
      [{ spawnError: true, exitCode: null }, "ffprobe failed", false],
      [{ exitCode: 1, stdout: "{}" }, "ffprobe failed", false],
      [{ exitCode: null, signaled: true, timedOut: true }, "ffprobe failed", false],
      [{ stdout: "{\"streams\":[", truncatedStdoutBytes: true }, "ffprobe failed", false],
    ];
    for (const [res, reason, aborted] of cases) {
      let fd = -1;
      runner.queue.push(res);
      const r = await probeMedia({ blob_path: blob, sniffed_mime: "video/mp4", byte_size: 1, onBlobFd: (f) => (fd = f) });
      expect(r.reason, JSON.stringify(res)).toBe(reason);
      expect(r.aborted).toBe(aborted);
      expect(r.normalized_mime).toBeNull();
      expect(() => fs.fstatSync(fd)).toThrow();
    }
  });

  it("invalid JSON, JSON null and non-object JSON are refused with distinct reasons", async () => {
    for (const [stdout, reason] of [
      ["not json", "ffprobe json parse failed"],
      ["", "ffprobe json parse failed"],
      ["null", "ffprobe empty output"],
      ["5", "ffprobe empty output"],
      ['"text"', "ffprobe empty output"],
    ] as const) {
      runner.queue.push({ stdout });
      const r = await probeMedia({ blob_path: blob, sniffed_mime: "video/mp4", byte_size: 1 });
      expect(r.reason, stdout).toBe(reason);
    }
  });

  it("an empty JSON object (what a truncated mp4 can produce) is 'no streams reported', never native", async () => {
    runner.queue.push({ stdout: "{}" });
    const r = await probeMedia({ blob_path: blob, sniffed_mime: "video/mp4", byte_size: 1 });
    expect(r.reason).toBe("no streams reported");
    expect(r.normalized_mime).toBeNull();
  });
});

describe("interpretProbeJson refusals and normalization", () => {
  const interp = (parsed: unknown, mime: string) => interpretProbeJson(parsed, mime);

  it("null/undefined/non-array streams mean no streams", () => {
    expect(interp(null, "video/mp4").reason).toBe("no streams reported");
    expect(interp(undefined, "video/mp4").reason).toBe("no streams reported");
    expect(interp({ format: mp4, streams: "nope" }, "video/mp4").reason).toBe("no streams reported");
  });

  it("a non-object stream entry makes the whole file unvalidated", () => {
    for (const bad of [null, 5, "x"]) {
      expect(interp({ format: mp4, streams: [video(), bad] }, "video/mp4").reason).toBe("unidentified stream");
    }
  });

  it("codec names must be 1-32 safe characters", () => {
    for (const name of ["h 264", "h264;rm", "a".repeat(33), "", 5, undefined]) {
      expect(interp({ format: mp4, streams: [video({ codec_name: name })] }, "video/mp4").reason).toBe("unidentified stream codec");
    }
    expect(interp({ format: mp4, streams: [video({ codec_name: "a".repeat(32) })] }, "video/mp4").reason).toBeNull();
  });

  it("dimensions, channels and sample rate accept bounded positive integers (numbers or numeric strings) and drop the rest", () => {
    const r = interp(
      {
        format: { ...mp4, format_name: "wav" },
        streams: [audio({ channels: "2", sample_rate: "44100", width: 1.5, height: 0 })],
      },
      "audio/wav",
    );
    expect(r.reason).toBeNull();
    expect(r.streams[0]).toEqual({ codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: 44100 });
    const bounded = interp(
      { format: mp4, streams: [video({ width: 100_001, height: -4, channels: {}, sample_rate: "abc" })] },
      "video/mp4",
    );
    expect(bounded.streams[0]).toEqual({ codec_type: "video", codec_name: "h264" });
    expect(bounded.reason).toBe("no positive bounded video stream");
  });

  it("only audio and video streams are kept; other stream types are ignored for MP4 but fatal for WebM", () => {
    const sub = { codec_type: "subtitle", codec_name: "mov_text" };
    const mp = interp({ format: mp4, streams: [video(), sub, { codec_type: "data" }] }, "video/mp4");
    expect(mp.reason).toBeNull();
    expect(mp.streams).toHaveLength(1);
    const webm = { format_name: "matroska,webm", duration: "1.0" };
    expect(interp({ format: webm, streams: [video({ codec_name: "vp9" }), sub] }, "video/webm").reason).toBe("container is not WebM");
    expect(interp({ format: webm, streams: [video({ codec_name: "vp9" }), audio({ codec_name: "opus" })] }, "video/webm").normalized_mime).toBe(
      "video/webm",
    );
  });

  it("an EBML file carrying H.264 is Matroska, not WebM, and is never normalized", () => {
    const r = interp({ format: { format_name: "matroska,webm", duration: "1" }, streams: [video({ codec_name: "h264" })] }, "video/webm");
    expect(r.normalized_mime).toBeNull();
    expect(r.reason).toBe("container is not WebM");
  });

  it("unsupported sniffed types and container/file mismatches are refused", () => {
    expect(interp({ format: mp4, streams: [video()] }, "image/png").reason).toBe("media type not supported");
    expect(interp({ format: mp4, streams: [video()] }, "audio/wav").reason).toBe("container does not match the file type");
    expect(interp({ format: { duration: "1" }, streams: [video()] }, "video/mp4").reason).toBe("container does not match the file type");
    expect(interp({ format: { format_name: 7, duration: "1" }, streams: [video()] }, "video/mp4").format_name).toBeNull();
  });

  it("audio needs an audio stream; video needs every video stream bounded", () => {
    const wav = { format_name: "wav", duration: 1 };
    expect(interp({ format: wav, streams: [video()] }, "audio/wav").reason).toBe("no audio stream");
    expect(interp({ format: wav, streams: [audio()] }, "audio/wav").normalized_mime).toBe("audio/wav");
    expect(interp({ format: mp4, streams: [audio()] }, "video/mp4").reason).toBe("no positive bounded video stream");
    expect(interp({ format: mp4, streams: [video(), video({ width: 0, height: 0 })] }, "video/mp4").reason).toBe(
      "no positive bounded video stream",
    );
  });

  it("every supported audio family normalizes to itself and QuickTime becomes video/mov only after validation", () => {
    for (const [mime, fmt] of [
      ["audio/wav", "wav"],
      ["audio/mpeg", "mp3"],
      ["audio/ogg", "ogg"],
      ["audio/flac", "flac"],
    ] as const) {
      expect(interp({ format: { format_name: fmt, duration: "3" }, streams: [audio()] }, mime).normalized_mime).toBe(mime);
    }
    const mov = { format_name: "mov,mp4,m4a", duration: "1" };
    expect(interp({ format: mov, streams: [video()] }, "video/quicktime").normalized_mime).toBe("video/mov");
    expect(interp({ format: mov, streams: [video({ width: 0 })] }, "video/quicktime").normalized_mime).toBeNull();
  });

  it("format_name is sanitized: unsafe characters stripped, 128-char cap, all-stripped becomes null", () => {
    expect(interp({ format: { format_name: "mov;$(x),mp4 ", duration: "1" }, streams: [video()] }, "video/mp4").format_name).toBe("movx,mp4");
    expect(interp({ format: { format_name: "m".repeat(300), duration: "1" }, streams: [video()] }, "video/mp4").format_name).toHaveLength(128);
    expect(interp({ format: { format_name: "!!! ???", duration: "1" }, streams: [video()] }, "video/mp4").format_name).toBeNull();
  });

  it("durations: numbers and numeric strings are accepted, rounded to milliseconds; 24 h is the ceiling", () => {
    const d = (duration: unknown) => interp({ format: { ...mp4, duration }, streams: [video()] }, "video/mp4").duration_seconds;
    expect(d(1.23456)).toBe(1.235);
    expect(d(86_400)).toBe(86_400);
    expect(d(86_401)).toBeNull();
    expect(d(true)).toBeNull();
    expect(d(null)).toBeNull();
    expect(d(Number.NaN)).toBeNull();
  });
});

describe("policyDuration and pickBoundedVideoStream", () => {
  it("policyDuration never invents a container duration and takes the largest otherwise", () => {
    expect(policyDuration(null, [{ duration_seconds: 99 }])).toBeNull();
    expect(policyDuration(2, [])).toBe(2);
    expect(policyDuration(2, [{ duration_seconds: 5 }, {}])).toBe(5);
  });

  it("pickBoundedVideoStream returns the first positive bounded video stream or null", () => {
    const streams = [
      { codec_type: "audio" as const, codec_name: "aac" },
      { codec_type: "video" as const, codec_name: "h264", width: 0, height: 0 },
      { codec_type: "video" as const, codec_name: "vp9", width: 640, height: 360 },
    ];
    expect(pickBoundedVideoStream({ streams })?.codec_name).toBe("vp9");
    expect(pickBoundedVideoStream({ streams: streams.slice(0, 2) })).toBeNull();
    expect(pickBoundedVideoStream({ streams: [] })).toBeNull();
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parsePersistedMediaStreams,
  pickBoundedVideoStreamFrom,
  sanitizePersistedDurationMs,
  sanitizePersistedMediaFormat,
  sanitizePersistedMediaMime,
  sanitizePersistedPageCount,
  sanitizePersistedStreamsJson,
} from "../../src/shared/attachmentMetadata.js";
import {
  parseExtractionCoverage,
  sanitizePersistedImageDimension,
} from "../../src/shared/attachmentMetadata.js";
import { policyDuration } from "../../src/core/parsers/ffprobe.js";
import { guardAttachmentMetadata } from "../../src/core/coordinator.js";
import { AttachmentReserveInvariantError, defaultProviderCapabilities, effectiveCapabilitiesFor } from "../../src/core/attachments.js";
import { catalogVersion, resetProfileCache } from "../../src/core/registry.js";
import type { ProofestraConfig } from "../../src/shared/config.js";

describe("shared persisted-metadata sanitizers", () => {
  it("page counts accept only positive safe integers", () => {
    expect(sanitizePersistedPageCount(1)).toBe(1);
    expect(sanitizePersistedPageCount(24)).toBe(24);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_000_000, "3", null, undefined]) {
      expect(sanitizePersistedPageCount(bad)).toBeNull();
    }
  });

  it("durations accept only positive integer ms of at most 24 h", () => {
    expect(sanitizePersistedDurationMs(1000)).toBe(1000);
    for (const bad of [0, -5, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 24 * 3600 * 1000 + 1, "1000", null]) {
      expect(sanitizePersistedDurationMs(bad)).toBeNull();
    }
  });

  it("stream JSON rejects malformed, oversized, non-array, and unknown-type input", () => {
    const ok = JSON.stringify([{ codec_type: "video", codec_name: "h264", width: 160, height: 90 }]);
    expect(sanitizePersistedStreamsJson(ok)).toBe(ok);
    expect(sanitizePersistedStreamsJson("{not json")).toBeNull();
    expect(sanitizePersistedStreamsJson("{}")).toBeNull();
    expect(sanitizePersistedStreamsJson("[]")).toBeNull();
    expect(sanitizePersistedStreamsJson(JSON.stringify([{ codec_type: "subtitle", codec_name: "x" }]))).toBeNull();
    expect(sanitizePersistedStreamsJson(JSON.stringify([{ codec_type: "audio", codec_name: "!!!" }]))).toBeNull();
    expect(sanitizePersistedStreamsJson("x".repeat(5000))).toBeNull();
    expect(sanitizePersistedStreamsJson(42)).toBeNull();
  });

  it("stream parsing drops non-positive and non-integer dimensions", () => {
    const streams = parsePersistedMediaStreams(
      JSON.stringify([{ codec_type: "video", codec_name: "mjpeg", width: 0, height: -1 }]),
    );
    expect(streams).toEqual([{ codec_type: "video", codec_name: "mjpeg" }]);
    expect(pickBoundedVideoStreamFrom(streams)).toBeNull();
    expect(parsePersistedMediaStreams("garbage")).toEqual([]);
  });

  it("bounded video stream requires positive sides within 4096 and 16 Mpx", () => {
    const mk = (w: number, h: number) => [
      { codec_type: "video" as const, codec_name: "h264", width: w, height: h },
    ];
    expect(pickBoundedVideoStreamFrom(mk(160, 90))).not.toBeNull();
    expect(pickBoundedVideoStreamFrom(mk(4097, 10))).toBeNull();
    expect(pickBoundedVideoStreamFrom(mk(4096, 4096))).toBeNull();
    expect(pickBoundedVideoStreamFrom([{ codec_type: "audio", codec_name: "aac" }])).toBeNull();
  });

  it("format strings: <=128 chars of [A-Za-z0-9_,-]", () => {
    expect(sanitizePersistedMediaFormat("mov,mp4,m4a,3gp,3g2,mj2")).toBe("mov,mp4,m4a,3gp,3g2,mj2");
    expect(sanitizePersistedMediaFormat("bad format!")).toBeNull();
    expect(sanitizePersistedMediaFormat("a".repeat(129))).toBeNull();
    expect(sanitizePersistedMediaFormat("")).toBeNull();
    expect(sanitizePersistedMediaFormat(7)).toBeNull();
  });

  it("normalized MIME is allowlisted", () => {
    for (const m of ["audio/wav", "audio/mpeg", "video/mp4", "video/webm", "video/mov"]) {
      expect(sanitizePersistedMediaMime(m)).toBe(m);
    }
    expect(sanitizePersistedMediaMime("video/quicktime")).toBeNull();
    expect(sanitizePersistedMediaMime("application/x-evil")).toBeNull();
    expect(sanitizePersistedMediaMime(null)).toBeNull();
  });
});

describe("native capability defaults and overrides", () => {
  it("every provider default carries every new numeric cap and codec list", () => {
    for (const p of ["openai", "anthropic", "gemini", "mock"] as const) {
      const c = defaultProviderCapabilities(p);
      for (const key of [
        "max_native_audio_seconds",
        "max_native_video_seconds",
        "max_native_media_aggregate_seconds",
        "max_native_media_aggregate_bytes",
        "max_native_pdf_pages",
      ] as const) {
        expect(Number.isInteger(c[key])).toBe(true);
      }
      expect(Array.isArray(c.audio_codec_whitelist)).toBe(true);
      expect(Array.isArray(c.video_codec_whitelist)).toBe(true);
    }
    const gemini = defaultProviderCapabilities("gemini");
    expect(gemini.max_native_audio_seconds).toBe(120);
    expect(gemini.max_native_media_aggregate_bytes).toBe(12 * 1024 * 1024);
    expect(gemini.max_native_pdf_pages).toBe(20);
    expect(gemini.audio_codec_whitelist).toEqual(["pcm_s16le", "mp3", "aac", "flac", "opus", "vorbis"]);
    expect(gemini.video_codec_whitelist).toEqual(["h264", "hevc", "vp8", "vp9", "av1"]);
    for (const p of ["openai", "anthropic"] as const) {
      const c = defaultProviderCapabilities(p);
      expect(c.max_native_audio_seconds).toBe(0);
      expect(c.max_native_video_seconds).toBe(0);
      expect(c.max_native_media_aggregate_seconds).toBe(0);
      expect(c.max_native_pdf_pages).toBe(20);
    }
    const mock = defaultProviderCapabilities("mock");
    expect(mock.max_native_pdf_pages).toBe(0);
    expect(mock.audio_codec_whitelist).toEqual([]);
  });

  it("profile overrides tighten numeric caps and intersect codecs; widening is clamped", () => {
    const g = defaultProviderCapabilities("gemini");
    const tightened = effectiveCapabilitiesFor(
      {
        capabilities: {
          max_native_audio_seconds: 30,
          max_native_pdf_pages: 5,
          max_native_media_aggregate_seconds: 60,
          audio_codec_whitelist: ["mp3", "evil_codec"],
          video_codec_whitelist: ["h264"],
        },
      },
      "gemini",
    );
    expect(tightened.max_native_audio_seconds).toBe(30);
    expect(tightened.max_native_pdf_pages).toBe(5);
    expect(tightened.max_native_media_aggregate_seconds).toBe(60);
    expect(tightened.audio_codec_whitelist).toEqual(["mp3"]);
    expect(tightened.video_codec_whitelist).toEqual(["h264"]);
    const widened = effectiveCapabilitiesFor(
      {
        capabilities: {
          max_native_audio_seconds: 9999,
          max_native_video_seconds: 9999,
          max_native_media_aggregate_bytes: 99 * 1024 * 1024,
          max_native_pdf_pages: 500,
        },
      },
      "gemini",
    );
    expect(widened.max_native_audio_seconds).toBe(g.max_native_audio_seconds);
    expect(widened.max_native_video_seconds).toBe(g.max_native_video_seconds);
    expect(widened.max_native_media_aggregate_bytes).toBe(g.max_native_media_aggregate_bytes);
    expect(widened.max_native_pdf_pages).toBe(g.max_native_pdf_pages);
    // OpenAI cannot be widened into media support.
    const openai = effectiveCapabilitiesFor(
      { capabilities: { max_native_audio_seconds: 120, audio_codec_whitelist: ["mp3"] } },
      "openai",
    );
    expect(openai.max_native_audio_seconds).toBe(0);
    expect(openai.audio_codec_whitelist).toEqual([]);
  });
});

describe("catalog digest and capability overrides", () => {
  const dirs: string[] = [];
  afterEach(() => {
    delete process.env.PROOFESTRA_PROFILES_FILE;
    resetProfileCache();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function versionWith(override: Record<string, unknown> | undefined): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofestra-catalog-"));
    dirs.push(dir);
    const file = path.join(dir, "profiles.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        mode: "append",
        profiles: [
          {
            profile_id: "mock-cap-digest",
            provider: "mock",
            label: "digest probe",
            model_id: "mock-digest-v1",
            safe_input_tokens: 32_000,
            max_output_tokens: 2048,
            api_shape: "mock",
            execution_backend_id: "mock-provider-api",
            ...(override ? { capabilities: override } : {}),
          },
        ],
      }),
    );
    process.env.PROOFESTRA_PROFILES_FILE = file;
    resetProfileCache();
    const config: ProofestraConfig = {
      host: "127.0.0.1",
      port: 3000,
      origin: "http://127.0.0.1:3000",
      extraOrigins: [],
      apiPrefix: "/api/v1",
      dataDir: dir,
      liveEnabled: false,
      providerCredentials: { openaiKey: null, anthropicKey: null, googleKey: null },
      providerDefaultModels: { openai: "m-openai", anthropic: "m-anthropic", gemini: "m-gemini" },
    };
    return catalogVersion(config);
  }

  it("rotates when one new capability override changes", () => {
    const none = versionWith(undefined);
    const a = versionWith({ max_native_pdf_pages: 10 });
    const b = versionWith({ max_native_pdf_pages: 11 });
    expect(new Set([none, a, b]).size).toBe(3);
    expect(versionWith({ max_native_pdf_pages: 10 })).toBe(a);
  });
});

describe("shared coverage parser, image dimensions, policy duration, admission guard", () => {
  it("one coverage parser: truncated only for boolean true, counts only safe non-negative ints", () => {
    expect(parseExtractionCoverage('{"extracted_chars":12,"truncated":true,"label":"L"}', "truncated")).toEqual({
      extracted_chars: 12,
      truncated: true,
      label: "L",
    });
    for (const bad of ['"false"', "1", '"true"', "null"]) {
      expect(parseExtractionCoverage(`{"extracted_chars":1,"truncated":${bad},"label":"L"}`, "none").truncated).toBe(false);
    }
    expect(parseExtractionCoverage('{"extracted_chars":-3,"label":"L"}', "none").extracted_chars).toBe(0);
    expect(parseExtractionCoverage('{"extracted_chars":1.5,"label":"L"}', "none").extracted_chars).toBe(0);
    expect(parseExtractionCoverage("{not json", "failed").label).toBe("extraction failed — attachment-only");
    expect(parseExtractionCoverage(null, "unsupported").label).toBe("unsupported — attachment-only");
  });

  it("image dimensions must be positive integers up to 100,000", () => {
    expect(sanitizePersistedImageDimension(160)).toBe(160);
    for (const bad of [0, -1, 1.5, Number.NaN, 100_001, "10", null]) {
      expect(sanitizePersistedImageDimension(bad)).toBeNull();
    }
  });

  it("the policy duration is the largest of the container and every stream", () => {
    expect(policyDuration(1, [{ duration_seconds: 500 }])).toBe(500);
    expect(policyDuration(60, [{ duration_seconds: 30 }, {}])).toBe(60);
    // A missing container duration is never replaced by stream durations.
    expect(policyDuration(null, [{ duration_seconds: 7 }])).toBeNull();
    expect(policyDuration(null, [{}])).toBeNull();
  });

  it("admission converts a reserve invariant error into a 422 attachment_metadata_invalid", () => {
    expect(() =>
      guardAttachmentMetadata(() => {
        throw new AttachmentReserveInvariantError("bad");
      }),
    ).toThrowError(expect.objectContaining({ httpStatus: 422, code: "attachment_metadata_invalid" }));
    expect(guardAttachmentMetadata(() => 7)).toBe(7);
    expect(() =>
      guardAttachmentMetadata(() => {
        throw new Error("other");
      }),
    ).toThrow("other");
  });
});


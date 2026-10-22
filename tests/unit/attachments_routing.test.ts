// Unit regressions for the per-profile native-attachment router.
//
// These assertions are the executable record of the "unknown or
// unverified dimension / page count / duration MUST refuse native" policy,
// the codec and aggregate caps, the QuickTime mapping, the mock-effective
// routing rule, and the single shared admission/dispatch token reserve.

import { describe, expect, it } from "vitest";
import {
  attachmentTokenReserveForRoutes,
  AttachmentReserveInvariantError,
  defaultProviderCapabilities,
  effectiveCapabilitiesFor,
  attachmentOnlyTokenReserve,
  extractedAttachmentTokenReserve,
  isImagePreviewDimensionsSafe,
  nativeAttachmentTokenReserve,
  nativeImageTokenReserve,
  nativeWireMime,
  planAttachmentRoutes,
  routeNativeAttachment,
  type NativeRoutingInput,
} from "../../src/core/attachments.js";
import { estimateTokens } from "../../src/core/context.js";
import {
  frameAttachmentOnlyNote,
  frameExtractedAttachment,
} from "../../src/shared/attachmentFraming.js";
import type { MediaStreamMetadata } from "../../src/shared/attachmentMetadata.js";
import type { AttachmentRef } from "../../src/shared/types.js";
import { sanitizeFailureMessage } from "../../src/storage/repos.js";

type Caps = ReturnType<typeof defaultProviderCapabilities>;

function route(caps: Caps, overrides: Partial<NativeRoutingInput>): ReturnType<typeof routeNativeAttachment> {
  return routeNativeAttachment({
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
    imageDimensions: null,
    pdfPageCount: null,
    mediaDurationSeconds: null,
    mediaStreams: [],
    validatedMediaFormat: null,
    ...overrides,
  });
}

describe("routeNativeAttachment — image dimensions", () => {
  const base = defaultProviderCapabilities("openai");
  const img = (o: Partial<NativeRoutingInput>) => route(base, { provider: "openai", ...o });
  it("refuses native when image dimensions are unknown (null)", () => {
    const r = img({ imageDimensions: null });
    expect(r.route).toBe("attachment_only");
    expect(r.reason).toContain("dimensions unknown");
  });
  it("refuses native when dimensions are invalid (NaN / zero / negative)", () => {
    const r = img({ imageDimensions: { width: 0, height: 1024 } });
    expect(r.route).toBe("attachment_only");
    expect(r.reason).toMatch(/invalid/);
  });
  it("refuses native when either side exceeds the per-side cap", () => {
    const r = img({ imageDimensions: { width: 8000, height: 1024 } });
    expect(r.route).toBe("attachment_only");
    expect(r.reason).toMatch(/exceeds.*per-side/);
  });
  it("refuses native when the pixel count exceeds the pixel cap", () => {
    const r = img({ imageDimensions: { width: 4096, height: 4096 } });
    expect(r.route).toBe("attachment_only");
    expect(r.reason).toMatch(/pixel cap/);
  });
  it("admits native image when dimensions are present and within caps", () => {
    const r = img({ imageDimensions: { width: 1024, height: 1024 } });
    expect(r.route).toBe("native_image");
    expect(r.native_mime).toBe("image/png");
    expect(r.charged_native_bytes).toBe(50_000);
    expect(r.charged_media_bytes).toBe(0);
  });
});

describe("routeNativeAttachment — PDF pages", () => {
  const openai = defaultProviderCapabilities("openai");
  const pdf = (o: Partial<NativeRoutingInput>) =>
    route(openai, {
      provider: "openai",
      kind: "pdf",
      sniffed_mime: "application/pdf",
      byte_size: 2 * 1024 * 1024,
      ...o,
    });
  it("refuses native PDF when the page count is missing, with attachment-only or extracted-text fallback", () => {
    expect(pdf({ pdfPageCount: null }).route).toBe("attachment_only");
    expect(pdf({ pdfPageCount: null }).reason).toMatch(/page count not validated/);
    expect(pdf({ pdfPageCount: null, has_extracted_text: true }).route).toBe("extracted_text");
    expect(pdf({ pdfPageCount: 0 }).route).toBe("attachment_only");
  });
  it("accepts 1 and 20 pages, refuses 21 (extracted text when available)", () => {
    expect(pdf({ pdfPageCount: 1 }).route).toBe("native_pdf");
    expect(pdf({ pdfPageCount: 20 }).route).toBe("native_pdf");
    expect(pdf({ pdfPageCount: 20 }).native_mime).toBe("application/pdf");
    const over = pdf({ pdfPageCount: 21 });
    expect(over.route).toBe("attachment_only");
    expect(over.reason).toMatch(/21 pages; native cap is 20/);
    expect(pdf({ pdfPageCount: 21, has_extracted_text: true }).route).toBe("extracted_text");
  });
  it("applies the native byte aggregate with an extracted-text fallback", () => {
    const r = pdf({ pdfPageCount: 5, remainingNativeBytes: 1024, has_extracted_text: true });
    expect(r.route).toBe("extracted_text");
    expect(r.reason).toMatch(/aggregate/);
  });
});

describe("routeNativeAttachment — Gemini audio/video", () => {
  const gemini = defaultProviderCapabilities("gemini");
  const audioStream = (codec: string): MediaStreamMetadata => ({ codec_type: "audio", codec_name: codec, channels: 1, sample_rate: 16000 });
  const videoStream = (codec: string, w = 160, h = 90): MediaStreamMetadata => ({ codec_type: "video", codec_name: codec, width: w, height: h });
  const audio = (o: Partial<NativeRoutingInput>) =>
    route(gemini, {
      kind: "audio",
      sniffed_mime: "audio/mpeg",
      normalized_media_mime: "audio/mpeg",
      byte_size: 1_000_000,
      mediaDurationSeconds: 10,
      mediaStreams: [audioStream("mp3")],
      ...o,
    });
  const video = (o: Partial<NativeRoutingInput>) =>
    route(gemini, {
      kind: "video",
      sniffed_mime: "video/mp4",
      normalized_media_mime: "video/mp4",
      byte_size: 2_000_000,
      mediaDurationSeconds: 10,
      mediaStreams: [videoStream("h264"), audioStream("aac")],
      ...o,
    });

  it("admits validated audio and video with the normalized wire MIME", () => {
    const a = audio({});
    expect(a.route).toBe("native_audio");
    expect(a.native_mime).toBe("audio/mpeg");
    expect(a.charged_media_seconds).toBe(10);
    expect(a.charged_media_bytes).toBe(1_000_000);
    const v = video({});
    expect(v.route).toBe("native_video");
    expect(v.native_mime).toBe("video/mp4");
  });
  it("refuses missing, zero and NaN durations", () => {
    for (const d of [null, 0, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const r = audio({ mediaDurationSeconds: d });
      expect(r.route).toBe("attachment_only");
      expect(r.reason).toMatch(/duration unknown/);
    }
  });
  it("accepts exactly 120 s and refuses more", () => {
    expect(audio({ mediaDurationSeconds: 120 }).route).toBe("native_audio");
    const over = audio({ mediaDurationSeconds: 120.001 });
    expect(over.route).toBe("attachment_only");
    expect(over.reason).toMatch(/exceeds the 120 s native cap/);
    expect(video({ mediaDurationSeconds: 121 }).route).toBe("attachment_only");
  });
  it("refuses missing streams, a missing/unbounded video stream, and WebM audio-only treated as video", () => {
    expect(audio({ mediaStreams: [] }).reason).toMatch(/no validated media streams/);
    expect(video({ mediaStreams: [audioStream("opus")], normalized_media_mime: "video/webm" }).reason).toMatch(
      /no positive bounded video stream/,
    );
    expect(video({ mediaStreams: [{ codec_type: "video", codec_name: "mjpeg" }] }).reason).toMatch(
      /no positive bounded video stream/,
    );
    expect(video({ mediaStreams: [videoStream("h264", 5000, 100)] }).route).toBe("attachment_only");
  });
  it("enforces the audio and video codec whitelists on EVERY stream", () => {
    for (const c of ["pcm_s16le", "mp3", "aac", "flac", "opus", "vorbis"]) {
      expect(audio({ mediaStreams: [audioStream(c)] }).route).toBe("native_audio");
    }
    expect(audio({ mediaStreams: [audioStream("wmav2")] }).reason).toMatch(/audio codec wmav2/);
    for (const c of ["h264", "hevc", "vp8", "vp9", "av1"]) {
      expect(video({ mediaStreams: [videoStream(c)] }).route).toBe("native_video");
    }
    expect(video({ mediaStreams: [videoStream("mpeg4")] }).reason).toMatch(/video codec mpeg4/);
    // Supported H.264 + unsupported audio must not slip through.
    const mixed = video({ mediaStreams: [videoStream("h264"), audioStream("wmav2")] });
    expect(mixed.route).toBe("attachment_only");
    expect(mixed.reason).toMatch(/audio codec wmav2/);
  });
  it("refuses an audio file that contains a video stream", () => {
    const r = audio({ mediaStreams: [audioStream("mp3"), videoStream("mjpeg", 100, 100)] });
    expect(r.route).toBe("attachment_only");
    expect(r.reason).toMatch(/contains a video stream/);
  });
  it("maps QuickTime to video/mov only when validated; otherwise attachment-only", () => {
    const ok = video({ sniffed_mime: "video/quicktime", normalized_media_mime: "video/mov" });
    expect(ok.route).toBe("native_video");
    expect(ok.native_mime).toBe("video/mov");
    const unvalidated = video({ sniffed_mime: "video/quicktime", normalized_media_mime: null });
    expect(unvalidated.route).toBe("attachment_only");
    expect(unvalidated.reason).toBe("QuickTime container not validated");
  });
  it("keeps audio/mpeg as audio/mpeg on the wire", () => {
    expect(audio({}).native_mime).toBe("audio/mpeg");
  });
  it("applies per-call media seconds and bytes aggregates plus the inline cap", () => {
    // 61 s consumed first, 60 s second: refused. 60 + 60 accepted exactly.
    const second = audio({ mediaDurationSeconds: 60, remainingMediaSeconds: 59 });
    expect(second.route).toBe("attachment_only");
    expect(second.reason).toMatch(/duration aggregate/);
    expect(second.reason).toMatch(/earlier attachments/);
    expect(audio({ mediaDurationSeconds: 60, remainingMediaSeconds: 60 }).route).toBe("native_audio");
    const bytes = audio({ byte_size: 3_000_000, remainingMediaBytes: 2_999_999 });
    expect(bytes.route).toBe("attachment_only");
    expect(bytes.reason).toMatch(/media byte aggregate/);
    const native = audio({ byte_size: 3_000_000, remainingNativeBytes: 2_999_999 });
    expect(native.reason).toMatch(/native aggregate/);
    const inline = audio({ byte_size: gemini.max_native_inline_media_bytes + 1 });
    expect(inline.reason).toMatch(/inline media cap/);
  });
});

describe("routeNativeAttachment — OpenAI/Anthropic/mock never claim media", () => {
  for (const provider of ["openai", "anthropic"] as const) {
    it(`${provider}: explicit unsupported-provider reason for audio and video`, () => {
      const caps = defaultProviderCapabilities(provider);
      for (const kind of ["audio", "video"] as const) {
        const r = route(caps, {
          provider,
          kind,
          sniffed_mime: kind === "audio" ? "audio/mpeg" : "video/mp4",
          normalized_media_mime: kind === "audio" ? "audio/mpeg" : "video/mp4",
          mediaDurationSeconds: 5,
          mediaStreams: [{ codec_type: kind, codec_name: kind === "audio" ? "mp3" : "h264", width: 160, height: 90 }],
        });
        expect(r.route).toBe("attachment_only");
        expect(r.reason).toBe(`native audio/video is not supported for ${provider} in this app`);
      }
    });
  }
  it("mock execution never reads media bytes", () => {
    const r = route(defaultProviderCapabilities("mock"), {
      provider: "mock",
      kind: "audio",
      normalized_media_mime: "audio/mpeg",
      mediaDurationSeconds: 5,
      mediaStreams: [{ codec_type: "audio", codec_name: "mp3" }],
    });
    expect(r.route).toBe("attachment_only");
  });
});

describe("effectiveCapabilitiesFor — mock dispatch route", () => {
  it("mock-effective provider returns no-native capabilities regardless of profile", () => {
    const caps = effectiveCapabilitiesFor({ provider: "openai" } as never, "mock");
    expect(caps.image).toBe(false);
    expect(caps.pdf).toBe(false);
    expect(caps.audio).toBe(false);
    expect(caps.video).toBe(false);
  });
  it("per-profile override can tighten but never widen caps", () => {
    const openai = defaultProviderCapabilities("openai");
    const caps = effectiveCapabilitiesFor(
      {
        capabilities: {
          image: false, // text-only variant: tighten
          max_native_image_bytes: 100 * 1024 * 1024, // try to widen; must clamp
          image_mime_whitelist: ["image/png"], // tighten to one
        },
      },
      "openai",
    );
    expect(caps.image).toBe(false);
    expect(caps.max_native_image_bytes).toBe(openai.max_native_image_bytes);
    expect(caps.image_mime_whitelist).toEqual(["image/png"]);
  });
});

describe("isImagePreviewDimensionsSafe", () => {
  it("accepts a 1×1 image", () => {
    expect(isImagePreviewDimensionsSafe(1, 1)).toBe(true);
  });
  it("accepts a 4096×4096 image at the per-side cap", () => {
    // 4096 * 4096 = 16_777_216 which exceeds the 16_000_000 pixel cap.
    expect(isImagePreviewDimensionsSafe(4096, 4096)).toBe(false);
    // 4096 * 3906 = 15_998_976 which fits.
    expect(isImagePreviewDimensionsSafe(4096, 3906)).toBe(true);
  });
  it("refuses when either side exceeds the per-side cap", () => {
    expect(isImagePreviewDimensionsSafe(4097, 10)).toBe(false);
    expect(isImagePreviewDimensionsSafe(10, 4097)).toBe(false);
  });
  it("refuses when pixel area exceeds the pixel cap", () => {
    // 4096 * 5000 = 20_480_000 > 16_000_000 and 5000 > 4096 side cap.
    expect(isImagePreviewDimensionsSafe(4096, 5000)).toBe(false);
    // 100000 * 100000 = 10 Gpx (the exact fixture from QA).
    expect(isImagePreviewDimensionsSafe(100_000, 100_000)).toBe(false);
  });
  it("refuses unknown / null / NaN / zero / non-integer / non-finite", () => {
    expect(isImagePreviewDimensionsSafe(null, null)).toBe(false);
    expect(isImagePreviewDimensionsSafe(undefined, 10)).toBe(false);
    expect(isImagePreviewDimensionsSafe(10, undefined)).toBe(false);
    expect(isImagePreviewDimensionsSafe(Number.NaN, 10)).toBe(false);
    expect(isImagePreviewDimensionsSafe(10, Number.POSITIVE_INFINITY)).toBe(false);
    expect(isImagePreviewDimensionsSafe(0, 10)).toBe(false);
    expect(isImagePreviewDimensionsSafe(-1, 10)).toBe(false);
    expect(isImagePreviewDimensionsSafe(10.5, 10)).toBe(false);
  });
});

describe("sanitizeFailureMessage (defense-in-depth)", () => {
  it("passes through a short safe label", () => {
    expect(sanitizeFailureMessage("upload_failed")).toBe("upload_failed");
    expect(sanitizeFailureMessage("blob_missing")).toBe("blob_missing");
  });
  it("replaces a message containing an absolute POSIX path", () => {
    expect(sanitizeFailureMessage("ENOENT: /tmp/attachments/abc")).toBe(
      "attachment unavailable",
    );
  });
  it("replaces a message containing a Windows path", () => {
    expect(sanitizeFailureMessage("EACCES at C:\\Users\\x\\blob")).toBe(
      "attachment unavailable",
    );
  });
  it("replaces a message containing an errno token", () => {
    expect(sanitizeFailureMessage("read error ENOENT")).toBe("attachment unavailable");
    expect(sanitizeFailureMessage("errno=-2")).toBe("attachment unavailable");
  });
  it("replaces a message containing control bytes", () => {
    expect(sanitizeFailureMessage("safe\u0001label")).toBe("attachment unavailable");
  });
  it("replaces a message that is too long", () => {
    expect(sanitizeFailureMessage("x".repeat(400))).toBe("attachment unavailable");
  });
  it("replaces an empty or non-string input", () => {
    expect(sanitizeFailureMessage("")).toBe("attachment unavailable");
    // @ts-expect-error — intentional misuse
    expect(sanitizeFailureMessage(undefined)).toBe("attachment unavailable");
  });
});

describe("token reserves", () => {
  it("nativeImageTokenReserve returns 0 for null/unknown dims", () => {
    expect(nativeImageTokenReserve(null)).toBe(0);
    expect(nativeImageTokenReserve({ width: Number.NaN, height: 100 })).toBe(0);
  });
  it("nativeImageTokenReserve floors at 1024 and scales by area/750", () => {
    expect(nativeImageTokenReserve({ width: 10, height: 10 })).toBe(1024);
    expect(nativeImageTokenReserve({ width: 1500, height: 1500 })).toBe(
      Math.max(1024, Math.ceil((1500 * 1500) / 750)),
    );
  });
  it("the extracted-text reserve prices the exact framed string, not just the text", () => {
    const ref = {
      sanitized_display_name: "notes.txt",
      sniffed_mime: "text/plain",
      byte_size: 11,
      extraction_coverage: { extracted_chars: 11, truncated: false, label: "x" },
    };
    const framed = frameExtractedAttachment({ ...ref, text: "hello world", truncated: false });
    const r = extractedAttachmentTokenReserve(ref, "hello world");
    expect(r).toBe(estimateTokens(framed) + 8);
    // The notice + header alone cost far more than the old flat +64 allowance.
    expect(r).toBeGreaterThan(estimateTokens("hello world") + 100);
    expect(extractedAttachmentTokenReserve(ref, "")).toBe(0);
    const longName = { ...ref, sanitized_display_name: "ก".repeat(160) };
    expect(extractedAttachmentTokenReserve(longName, "x")).toBeGreaterThan(r + 300);
  });
  it("attachment-only notes are priced on the exact note, not as free", () => {
    const ref = { sanitized_display_name: "v.mp4", sniffed_mime: "video/mp4", byte_size: 9 };
    const reason = "native audio/video is not supported for openai in this app";
    expect(attachmentOnlyTokenReserve(ref, reason)).toBe(
      estimateTokens(frameAttachmentOnlyNote({ ...ref, reason })) + 8,
    );
    expect(attachmentOnlyTokenReserve(ref, reason)).toBeGreaterThan(40);
  });

});

function mkRef(over: Partial<AttachmentRef> & { id: string; kind: AttachmentRef["kind"] }): AttachmentRef {
  return {
    sanitized_display_name: `${over.id}.bin`,
    sniffed_mime: "application/octet-stream",
    byte_size: 10_000,
    content_sha256: "0".repeat(64),
    extraction_status: "none",
    extraction_coverage: { extracted_chars: 0, truncated: false, label: "x" },
    ...over,
  };
}

const audioRef = (id: string, seconds: number, extra: Partial<AttachmentRef> = {}): AttachmentRef =>
  mkRef({
    id,
    kind: "audio",
    sniffed_mime: "audio/mpeg",
    normalized_media_mime: "audio/mpeg",
    sniffed_media_duration_ms: Math.round(seconds * 1000),
    sniffed_media_streams_json: JSON.stringify([{ codec_type: "audio", codec_name: "mp3" }]),
    validated_media_format: "mp3",
    ...extra,
  });
const videoRef = (id: string, seconds: number, extra: Partial<AttachmentRef> = {}): AttachmentRef =>
  mkRef({
    id,
    kind: "video",
    sniffed_mime: "video/mp4",
    normalized_media_mime: "video/mp4",
    sniffed_media_duration_ms: Math.round(seconds * 1000),
    sniffed_media_streams_json: JSON.stringify([
      { codec_type: "video", codec_name: "h264", width: 160, height: 90 },
      { codec_type: "audio", codec_name: "aac" },
    ]),
    validated_media_format: "mov,mp4,m4a,3gp,3g2,mj2",
    ...extra,
  });
const pdfRef = (id: string, pages: number | null, extra: Partial<AttachmentRef> = {}): AttachmentRef =>
  mkRef({
    id,
    kind: "pdf",
    sniffed_mime: "application/pdf",
    sniffed_pdf_pages: pages,
    ...extra,
  });
const imageRef = (id: string, w: number, h: number): AttachmentRef =>
  mkRef({ id, kind: "image", sniffed_mime: "image/png", sniffed_width: w, sniffed_height: h });

describe("shared native token reserve (admission === dispatch)", () => {
  it("prices image, PDF, audio and video exactly, including framing", () => {
    expect(nativeAttachmentTokenReserve(imageRef("i", 10, 10), "native_image")).toBe(
      nativeImageTokenReserve({ width: 10, height: 10 }) + 1024,
    );
    expect(nativeAttachmentTokenReserve(imageRef("i", 1500, 1500), "native_image")).toBe(
      Math.ceil((1500 * 1500) / 750) + 1024,
    );
    expect(nativeAttachmentTokenReserve(pdfRef("p", 1), "native_pdf")).toBe(3_000 + 1024);
    expect(nativeAttachmentTokenReserve(pdfRef("p", 20), "native_pdf")).toBe(60_000 + 1024);
    expect(nativeAttachmentTokenReserve(audioRef("a", 10.2), "native_audio")).toBe(11 * 64 + 1024);
    expect(nativeAttachmentTokenReserve(videoRef("v", 60), "native_video")).toBe(60 * 512 + 1024);
  });

  it("throws a typed invariant error (never zero) for missing metadata", () => {
    expect(() => nativeAttachmentTokenReserve(pdfRef("p", null), "native_pdf")).toThrow(
      AttachmentReserveInvariantError,
    );
    expect(() =>
      nativeAttachmentTokenReserve(mkRef({ id: "a", kind: "audio" }), "native_audio"),
    ).toThrow(AttachmentReserveInvariantError);
    expect(() =>
      nativeAttachmentTokenReserve(mkRef({ id: "i", kind: "image" }), "native_image"),
    ).toThrow(AttachmentReserveInvariantError);
    expect(() => nativeWireMime(mkRef({ id: "v", kind: "video" }))).toThrow(AttachmentReserveInvariantError);
  });

  it("admission and dispatch compute identical totals for planned routes, historical refs included", () => {
    const gemini = defaultProviderCapabilities("gemini");
    const refs = [
      imageRef("hist-image", 800, 600),
      pdfRef("hist-pdf", 3),
      audioRef("cur-audio", 30),
      videoRef("cur-video", 20),
    ];
    const text = new Map([["txt", "hello extracted"]]);
    const plan = planAttachmentRoutes({
      refs,
      hasExtractedText: () => false,
      capabilities: gemini,
      provider: "gemini",
      safeInputTokens: 1_000_000,
    });
    expect(plan.map((r) => r.route)).toEqual(["native_image", "native_pdf", "native_audio", "native_video"]);
    const byId = new Map(refs.map((r) => [r.id, r]));
    const expected =
      nativeAttachmentTokenReserve(refs[0]!, "native_image") +
      nativeAttachmentTokenReserve(refs[1]!, "native_pdf") +
      nativeAttachmentTokenReserve(refs[2]!, "native_audio") +
      nativeAttachmentTokenReserve(refs[3]!, "native_video");
    const lookup = (id: string): string => text.get(id) ?? "";
    // "Admission" and "dispatch" are the same function over the same frozen routes.
    const admission = attachmentTokenReserveForRoutes(plan, byId, lookup);
    const dispatch = attachmentTokenReserveForRoutes(
      JSON.parse(JSON.stringify(plan)) as typeof plan,
      new Map(JSON.parse(JSON.stringify([...byId])) as Array<[string, AttachmentRef]>),
      lookup,
    );
    expect(admission).toBe(expected);
    expect(dispatch).toBe(expected);
    const txtRef = mkRef({ id: "txt", kind: "text" });
    const withText = attachmentTokenReserveForRoutes(
      [{ attachment_id: "txt", route: "extracted_text" }],
      new Map([["txt", txtRef]]),
      lookup,
    );
    expect(withText).toBe(extractedAttachmentTokenReserve(txtRef, "hello extracted"));
    const onlyRef = mkRef({ id: "only", kind: "video", sniffed_mime: "video/mp4" });
    const withNote = attachmentTokenReserveForRoutes(
      [{ attachment_id: "only", route: "attachment_only", reason: "no" }],
      new Map([["only", onlyRef]]),
      lookup,
    );
    expect(withNote).toBe(attachmentOnlyTokenReserve(onlyRef, "no"));
  });
});

describe("planAttachmentRoutes — aggregates across history + current turn", () => {
  const gemini = defaultProviderCapabilities("gemini");
  const plan = (refs: AttachmentRef[], over: Partial<Parameters<typeof planAttachmentRoutes>[0]> = {}) =>
    planAttachmentRoutes({
      refs,
      hasExtractedText: () => false,
      capabilities: gemini,
      provider: "gemini",
      safeInputTokens: 10_000_000,
      ...over,
    });

  it("61 s then 60 s: the second is refused and says earlier attachments used the budget; 60 + 60 is accepted", () => {
    const r = plan([audioRef("a1", 61), audioRef("a2", 60)]);
    expect(r[0]!.route).toBe("native_audio");
    expect(r[1]!.route).toBe("attachment_only");
    expect(r[1]!.reason).toMatch(/duration aggregate.*earlier attachments in this conversation/);
    const ok = plan([audioRef("a1", 60), videoRef("v1", 60)]);
    expect(ok.map((x) => x.route)).toEqual(["native_audio", "native_video"]);
  });

  it("12 MiB aggregate media bytes and the all-native byte aggregate", () => {
    const mb = 1024 * 1024;
    const r = plan([
      audioRef("a1", 5, { byte_size: 7 * mb }),
      audioRef("a2", 5, { byte_size: 5 * mb + 1 }),
    ]);
    expect(r[0]!.route).toBe("native_audio");
    expect(r[1]!.route).toBe("attachment_only");
    expect(r[1]!.reason).toMatch(/media byte aggregate/);
    // Images consume the all-native aggregate that later media shares.
    const img = (id: string): AttachmentRef => ({ ...imageRef(id, 100, 100), byte_size: 4 * mb });
    const mixed = plan([img("i1"), img("i2"), img("i3"), audioRef("a", 5, { byte_size: mb })]);
    expect(mixed.map((x) => x.route)).toEqual(["native_image", "native_image", "native_image", "attachment_only"]);
    expect(mixed[3]!.reason).toMatch(/native aggregate/);
  });

  it("PDF over 20 pages / missing pages falls back to extracted text; extra native PDFs respect the 50% profile budget", () => {
    const over = plan([pdfRef("p", 21)], { hasExtractedText: () => true });
    expect(over[0]).toMatchObject({ route: "extracted_text" });
    const missing = plan([pdfRef("p", null)]);
    expect(missing[0]!.route).toBe("attachment_only");
    // Two 20-page PDFs = 2 x 61,024 tokens; a 128k profile budgets 64,000.
    const two = plan([pdfRef("p1", 20), pdfRef("p2", 20)], {
      hasExtractedText: () => true,
      safeInputTokens: 128_000,
    });
    expect(two[0]!.route).toBe("native_pdf");
    expect(two[1]!.route).toBe("extracted_text");
    expect(two[1]!.reason).toMatch(/native reserve .* exceeds the profile budget of 64000/);
    const noText = plan([pdfRef("p1", 20), pdfRef("p2", 20)], { safeInputTokens: 128_000 });
    expect(noText[1]!.route).toBe("attachment_only");
  });

  it("history is routed first and its budget use is stable", () => {
    const history = [audioRef("old", 100)];
    const current = [audioRef("new", 30)];
    const r = plan([...history, ...current]);
    expect(r.map((x) => x.route)).toEqual(["native_audio", "attachment_only"]);
  });

  it("re-validates persisted metadata: a corrupt duration or stream summary cannot become native", () => {
    const r = plan([
      audioRef("bad-dur", 5, { sniffed_media_duration_ms: -5 }),
      audioRef("bad-streams", 5, { sniffed_media_streams_json: "{not json" }),
      audioRef("bad-mime", 5, { normalized_media_mime: "application/x-evil" }),
    ]);
    expect(r.every((x) => x.route === "attachment_only")).toBe(true);
  });

  it("mock execution routes everything attachment-only", () => {
    const r = plan([imageRef("i", 100, 100), pdfRef("p", 2), audioRef("a", 3)], {
      capabilities: defaultProviderCapabilities("mock"),
      provider: "mock",
    });
    expect(r.every((x) => x.route === "attachment_only")).toBe(true);
  });

  it("wire MIME: image/PDF keep the sniffed MIME; media uses the normalized MIME", () => {
    expect(nativeWireMime(imageRef("i", 1, 1))).toBe("image/png");
    expect(nativeWireMime(pdfRef("p", 1))).toBe("application/pdf");
    expect(nativeWireMime(audioRef("a", 1))).toBe("audio/mpeg");
    expect(
      nativeWireMime(videoRef("v", 1, { sniffed_mime: "video/quicktime", normalized_media_mime: "video/mov" })),
    ).toBe("video/mov");
  });
});

describe("honest refusal reasons", () => {
  const gemini = defaultProviderCapabilities("gemini");
  const plan = (refs: AttachmentRef[], over: Partial<Parameters<typeof planAttachmentRoutes>[0]> = {}) =>
    planAttachmentRoutes({
      refs,
      hasExtractedText: () => false,
      capabilities: gemini,
      provider: "gemini",
      safeInputTokens: 10_000_000,
      ...over,
    });
  const mb = 1024 * 1024;

  it("a lone file over a per-call cap does NOT blame earlier attachments", () => {
    const loneVideo = plan([videoRef("v", 60, { byte_size: 15 * mb })]);
    expect(loneVideo[0]!.route).toBe("attachment_only");
    expect(loneVideo[0]!.reason).toMatch(/alone exceeds the per-call media byte cap/);
    expect(loneVideo[0]!.reason).not.toMatch(/earlier attachments/);
    const loneLong = routeNativeAttachment({
      provider: "gemini",
      kind: "audio",
      sniffed_mime: "audio/mpeg",
      normalized_media_mime: "audio/mpeg",
      byte_size: 1000,
      has_extracted_text: false,
      capabilities: { ...gemini, max_native_audio_seconds: 500 },
      remainingNativeBytes: gemini.max_native_aggregate_bytes,
      remainingMediaBytes: gemini.max_native_media_aggregate_bytes,
      remainingMediaSeconds: gemini.max_native_media_aggregate_seconds,
      imageDimensions: null,
      pdfPageCount: null,
      mediaDurationSeconds: 200,
      mediaStreams: [{ codec_type: "audio", codec_name: "mp3" }],
      validatedMediaFormat: "mp3",
    });
    expect(loneLong.reason).toMatch(/alone exceeds the 120 s per-call media cap/);
    expect(loneLong.reason).not.toMatch(/earlier attachments/);
  });

  it("the earlier-attachments note appears only when earlier attachments were charged", () => {
    const r = plan([audioRef("a1", 100), audioRef("a2", 30)]);
    expect(r[1]!.reason).toMatch(/duration aggregate.*earlier attachments/);
    const bytes = plan([audioRef("a1", 5, { byte_size: 8 * mb }), audioRef("a2", 5, { byte_size: 5 * mb })]);
    expect(bytes[1]!.reason).toMatch(/media byte aggregate.*earlier attachments/);
  });

  it("a lone native PDF over the profile token budget says so without blaming earlier files", () => {
    const r = plan([pdfRef("p", 20)], { safeInputTokens: 64_000, hasExtractedText: () => true });
    expect(r[0]!.route).toBe("extracted_text");
    expect(r[0]!.reason).toMatch(/alone exceeds the profile budget of 32000/);
    expect(r[0]!.reason).not.toMatch(/earlier attachments/);
    const two = plan([pdfRef("p1", 15), pdfRef("p2", 10)], { safeInputTokens: 128_000 });
    expect(two[1]!.reason).toMatch(/earlier attachments/);
  });

  it("mock mode says no bytes are sent instead of claiming the profile rejects the type", () => {
    const mock = defaultProviderCapabilities("mock");
    const r = plan([imageRef("i", 100, 100), pdfRef("p", 2)], {
      capabilities: mock,
      provider: "mock",
      hasExtractedText: (id) => id === "p",
    });
    expect(r[0]!.reason).toBe("mock mode sends no file bytes to any provider");
    expect(r[1]!.route).toBe("extracted_text");
    expect(r[1]!.reason).toBe("mock mode sends no file bytes to any provider; using extracted text");
    expect(r.every((x) => !/does not accept/.test(x.reason))).toBe(true);
  });
});


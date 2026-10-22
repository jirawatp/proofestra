// Routing and result-shaping of `extractAttachment`. The PDF, ffprobe and worker
// parsers are replaced by scripted fakes so the dispatch logic (which extractor,
// with which inputs, how results are labelled) is tested in isolation; the text,
// image and "no extractor" paths run for real against temp files. Real parser
// behavior is covered by tests/integration/content_parsers.test.ts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaProbeResult } from "../../src/core/parsers/ffprobe.js";
import type { ExtractionResult } from "../../src/core/attachmentExtraction.js";

const fakes = {
  pdf: vi.fn(),
  probe: vi.fn(),
  worker: vi.fn(),
};
vi.mock("../../src/core/parsers/pdf.js", () => ({ extractPdfText: (...a: unknown[]) => fakes.pdf(...a) }));
vi.mock("../../src/core/parsers/ffprobe.js", () => ({ probeMedia: (...a: unknown[]) => fakes.probe(...a) }));
vi.mock("../../src/core/workerExtraction.js", () => ({ runAttachmentWorker: (...a: unknown[]) => fakes.worker(...a) }));

import { extractAttachment, MEDIA_METADATA_ONLY_LABEL, type ExtractionInput } from "../../src/core/attachmentExtraction.js";

let tmpDir: string;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proofestra-extract-"));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
beforeEach(() => {
  fakes.pdf.mockReset();
  fakes.probe.mockReset();
  fakes.worker.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

let counter = 0;
function blob(data: Buffer | string): { p: string; size: number } {
  counter += 1;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const p = path.join(tmpDir, `blob-${counter}`);
  fs.writeFileSync(p, buf);
  return { p, size: buf.length };
}

const input = (over: Partial<ExtractionInput>): ExtractionInput => ({
  kind: "text",
  sniffed_mime: "text/plain",
  byte_size: 10,
  blob_path: "/nonexistent",
  ...over,
});

describe("shared preconditions", () => {
  it("an empty file is status none without touching any extractor", async () => {
    const r = await extractAttachment(input({ kind: "pdf", byte_size: 0 }));
    expect(r).toEqual({
      status: "none",
      coverage: { extracted_chars: 0, truncated: false, label: "empty file" },
      extractedText: null,
    });
    expect(fakes.pdf).not.toHaveBeenCalled();
  });

  it("an already-aborted signal is a cancelled failure before any work", async () => {
    const ac = new AbortController();
    ac.abort();
    for (const kind of ["text", "pdf", "archive", "audio"] as const) {
      const r = await extractAttachment(input({ kind, signal: ac.signal }));
      expect(r).toEqual({
        status: "failed",
        coverage: { extracted_chars: 0, truncated: false, label: "extraction cancelled" },
        extractedText: null,
      });
    }
    expect(fakes.pdf).not.toHaveBeenCalled();
    expect(fakes.probe).not.toHaveBeenCalled();
    expect(fakes.worker).not.toHaveBeenCalled();
  });
});

describe("text attachments (real files)", () => {
  it("a short UTF-8 file is extracted whole with an exact char count", async () => {
    const { p, size } = blob("สวัสดี\nhello");
    const r = await extractAttachment(input({ blob_path: p, byte_size: size }));
    expect(r).toEqual({
      status: "text_extracted",
      coverage: { extracted_chars: 12, truncated: false, label: "text (12 chars)" },
      extractedText: "สวัสดี\nhello",
    });
  });

  it("more than 24000 characters is truncated at the cap", async () => {
    const { p, size } = blob("x".repeat(30_000));
    const r = await extractAttachment(input({ blob_path: p, byte_size: size }));
    expect(r.status).toBe("truncated");
    expect(r.extractedText).toBe("x".repeat(24_000));
    expect(r.coverage).toEqual({ extracted_chars: 24_000, truncated: true, label: "text (truncated at 24000 chars)" });
  });

  it("a file larger than the read window is truncated even if the window decodes to under the cap", async () => {
    // 4-byte characters: the 96,016-byte read window holds ~24,004 chars.
    const { p, size } = blob("😀".repeat(40_000));
    const r = await extractAttachment(input({ blob_path: p, byte_size: size }));
    expect(r.status).toBe("truncated");
    expect(r.coverage.truncated).toBe(true);
    expect(r.extractedText!.length).toBeLessThanOrEqual(24_000);
  });

  it("invalid UTF-8 is decoded with replacement characters rather than failing", async () => {
    const { p, size } = blob(Buffer.from([0x61, 0xff, 0x62]));
    const r = await extractAttachment(input({ blob_path: p, byte_size: size }));
    expect(r.status).toBe("text_extracted");
    expect(r.extractedText).toBe("a\ufffdb");
  });

  it("aborting while the file is being read discards the content", async () => {
    const { p, size } = blob("some text");
    const ac = new AbortController();
    const pending = extractAttachment(input({ blob_path: p, byte_size: size, signal: ac.signal }));
    ac.abort();
    const r = await pending;
    expect(r.status).toBe("failed");
    expect(r.coverage.label).toBe("text extraction cancelled");
    expect(r.extractedText).toBeNull();
  });

  it("a decoder that throws becomes an honest text decode failure", async () => {
    const { p, size } = blob("text");
    vi.stubGlobal(
      "TextDecoder",
      class {
        decode(): string {
          throw new Error("decoder unavailable");
        }
      },
    );
    const r = await extractAttachment(input({ blob_path: p, byte_size: size }));
    expect(r).toEqual({
      status: "failed",
      coverage: { extracted_chars: 0, truncated: false, label: "text decode failed" },
      extractedText: null,
    });
  });

  it("a missing blob rejects (the caller owns turning that into a failed upload)", async () => {
    await expect(extractAttachment(input({ blob_path: path.join(tmpDir, "gone") }))).rejects.toThrow();
  });
});

describe("images and other kinds", () => {
  it("images are never OCR'd: status none with the routing note", async () => {
    const r = await extractAttachment(input({ kind: "image", sniffed_mime: "image/png" }));
    expect(r).toEqual({
      status: "none",
      coverage: { extracted_chars: 0, truncated: false, label: "image (native routing depends on profile and dimensions)" },
      extractedText: null,
    });
  });

  it("document and binary kinds have no extractor and say so", async () => {
    for (const kind of ["document", "binary"] as const) {
      const r = await extractAttachment(input({ kind }));
      expect(r).toEqual({
        status: "unsupported",
        coverage: { extracted_chars: 0, truncated: false, label: `${kind} attachment-only (no extractor)` },
        extractedText: null,
      });
    }
  });
});

describe("PDF dispatch", () => {
  it("passes only the blob path and signal, and maps page count and encryption (null when unknown)", async () => {
    const ac = new AbortController();
    fakes.pdf.mockResolvedValueOnce({
      status: "truncated",
      coverage: { extracted_chars: 5, truncated: true, label: "PDF (30 pages) · first 20 pages" },
      extractedText: "hello",
      pdf_pages: 30,
      pdf_encrypted: false,
    });
    const r = await extractAttachment(input({ kind: "pdf", blob_path: "/blobs/u", byte_size: 99, signal: ac.signal, sanitized_display_name: "secret-name.pdf" }));
    expect(fakes.pdf).toHaveBeenCalledWith({ blob_path: "/blobs/u", byte_size: 99, signal: ac.signal });
    expect(JSON.stringify(fakes.pdf.mock.calls)).not.toContain("secret-name");
    expect(r).toEqual({
      status: "truncated",
      coverage: { extracted_chars: 5, truncated: true, label: "PDF (30 pages) · first 20 pages" },
      extractedText: "hello",
      pdf_pages: 30,
      pdf_encrypted: false,
    });

    fakes.pdf.mockResolvedValueOnce({
      status: "failed",
      coverage: { extracted_chars: 0, truncated: false, label: "PDF metadata parse failed" },
      extractedText: null,
    });
    const unknown = await extractAttachment(input({ kind: "pdf", byte_size: 99 }));
    expect(fakes.pdf.mock.calls[1]![0]).toEqual({ blob_path: "/nonexistent", byte_size: 99 });
    expect(unknown.pdf_pages).toBeNull();
    expect(unknown.pdf_encrypted).toBeNull();
  });
});

describe("archive dispatch (Office vs plain ZIP)", () => {
  const workerResult: ExtractionResult = {
    status: "text_extracted",
    coverage: { extracted_chars: 1, truncated: false, label: "ok" },
    extractedText: "x",
  };

  it("an Office extension runs the office operation, with the macro flag only for macro/template variants", async () => {
    fakes.worker.mockResolvedValue(workerResult);
    const cases: Array<[string, string, boolean]> = [
      ["report.docx", "docx", false],
      ["REPORT.DOCM", "docx", true],
      ["sheet.xlsm", "xlsx", true],
      ["deck.pptx", "pptx", false],
      ["deck.ppsx", "pptx", true],
      ["doc.odt", "odt", false],
      ["calc.ods", "ods", false],
      ["slides.odp", "odp", false],
    ];
    for (const [name, officeKind, macro] of cases) {
      fakes.worker.mockClear();
      const r = await extractAttachment(input({ kind: "archive", byte_size: 7, blob_path: "/blobs/u", sanitized_display_name: name }));
      expect(r).toBe(workerResult);
      const [workerInput, options] = fakes.worker.mock.calls[0]!;
      expect(workerInput, name).toEqual({
        operation: "office",
        blob_path: "/blobs/u",
        byte_size: 7,
        office_kind: officeKind,
        ...(macro ? { macro_variant: true } : {}),
      });
      expect(options).toEqual({});
      expect(JSON.stringify(workerInput)).not.toContain(name);
    }
  });

  it("any other name, or no name, is a plain ZIP; the signal is forwarded to the worker", async () => {
    fakes.worker.mockResolvedValue(workerResult);
    const ac = new AbortController();
    await extractAttachment(input({ kind: "archive", byte_size: 7, blob_path: "/blobs/u", sanitized_display_name: "bundle.zip", signal: ac.signal }));
    expect(fakes.worker.mock.calls[0]).toEqual([{ operation: "zip", blob_path: "/blobs/u", byte_size: 7 }, { signal: ac.signal }]);
    await extractAttachment(input({ kind: "archive", byte_size: 7, blob_path: "/blobs/u" }));
    expect(fakes.worker.mock.calls[1]![0]).toEqual({ operation: "zip", blob_path: "/blobs/u", byte_size: 7 });
    await extractAttachment(input({ kind: "archive", byte_size: 7, blob_path: "/blobs/u", sanitized_display_name: "" }));
    expect(fakes.worker.mock.calls[2]![0]).toMatchObject({ operation: "zip" });
  });
});

describe("media dispatch", () => {
  const probe = (over: Partial<MediaProbeResult>): MediaProbeResult => ({
    duration_seconds: 12.345,
    format_name: "mov,mp4,m4a",
    streams: [
      { codec_type: "video", codec_name: "h264", width: 640, height: 360 },
      { codec_type: "audio", codec_name: "aac", sample_rate: 48_000, channels: 2 },
    ],
    normalized_mime: "video/mp4",
    reason: null,
    aborted: false,
    ...over,
  });
  const run = (over: Partial<ExtractionInput> = {}) =>
    extractAttachment(input({ kind: "video", sniffed_mime: "video/mp4", byte_size: 1000, blob_path: "/blobs/u", ...over }));

  it("a validated probe is metadata-only (never a transcript) and records the validated facts", async () => {
    fakes.probe.mockResolvedValueOnce(probe({}));
    const r = await run();
    expect(r.status).toBe("none");
    expect(r.extractedText).toBeNull();
    expect(r.coverage.label).toBe(`${MEDIA_METADATA_ONLY_LABEL} (12.35 s · video h264 640x360 · audio aac 48000 Hz/2ch)`);
    expect(r.media_duration_seconds).toBe(12.345);
    expect(JSON.parse(r.media_streams_json!)).toHaveLength(2);
    expect(r.validated_media_format).toBe("mov,mp4,m4a");
    expect(r.normalized_media_mime).toBe("video/mp4");
    expect(fakes.probe).toHaveBeenCalledWith({ blob_path: "/blobs/u", sniffed_mime: "video/mp4", byte_size: 1000 });
  });

  it("the summary names at most 3 streams and omits unknown rates, channels and dimensions", async () => {
    fakes.probe.mockResolvedValueOnce(
      probe({
        duration_seconds: 3,
        streams: [
          { codec_type: "audio", codec_name: "mp3" },
          { codec_type: "audio", codec_name: "opus", sample_rate: 24_000 },
          { codec_type: "video", codec_name: "vp9", width: 100, height: 0 },
          { codec_type: "video", codec_name: "never-listed", width: 1, height: 1 },
        ],
      }),
    );
    const r = await run({ kind: "audio" });
    expect(r.coverage.label).toBe(`${MEDIA_METADATA_ONLY_LABEL} (3.00 s · audio mp3 · audio opus 24000 Hz · video vp9)`);
    expect(r.coverage.label).not.toContain("never-listed");
  });

  it("forwards the signal to the probe; an aborted probe is a cancelled failure", async () => {
    const ac = new AbortController();
    fakes.probe.mockResolvedValueOnce(probe({ aborted: true, normalized_mime: null, reason: "probe cancelled" }));
    const r = await run({ signal: ac.signal });
    expect(fakes.probe.mock.calls[0]![0].signal).toBe(ac.signal);
    expect(r).toEqual({
      status: "failed",
      coverage: { extracted_chars: 0, truncated: false, label: "media probe cancelled" },
      extractedText: null,
    });
  });

  it("an unvalidated probe is unsupported, names the defect, keeps structure for routing and never sets the container name or MIME", async () => {
    fakes.probe.mockResolvedValueOnce(
      probe({ normalized_mime: null, reason: "container does not match the file type", format_name: "matroska,webm" }),
    );
    const r = await run({ kind: "audio" });
    expect(r.status).toBe("unsupported");
    expect(r.coverage.label).toBe("audio metadata unavailable (container does not match the file type)");
    expect(r.media_duration_seconds).toBe(12.345);
    expect(JSON.parse(r.media_streams_json!)[0].codec_name).toBe("h264");
    expect(r.validated_media_format).toBeNull();
    expect(r.normalized_media_mime).toBeNull();
  });

  it("each missing piece (duration, streams, MIME) is unsupported; a missing reason says 'not validated'", async () => {
    fakes.probe.mockResolvedValueOnce(probe({ duration_seconds: null, reason: "duration not reported or invalid" }));
    const noDuration = await run();
    expect(noDuration.coverage.label).toBe("video metadata unavailable (duration not reported or invalid)");
    expect(noDuration.media_duration_seconds).toBeNull();

    fakes.probe.mockResolvedValueOnce(probe({ streams: [], reason: "no streams reported" }));
    const noStreams = await run();
    expect(noStreams.status).toBe("unsupported");
    expect(noStreams.media_streams_json).toBeNull();

    fakes.probe.mockResolvedValueOnce(probe({ normalized_mime: null, reason: null }));
    const noReason = await run();
    expect(noReason.coverage.label).toBe("video metadata unavailable (not validated)");
  });
});

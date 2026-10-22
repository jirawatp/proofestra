// Real-parser tests over the synthetic fixtures in tests/fixtures/content.
//
// Every fixture named by a manifest is registered through `fixtureCase`,
// and the last test asserts the registered set equals the manifest set, so a
// fixture added later fails until it is mapped. Real-tool cases (Poppler,
// ffprobe) use `skipIf` on the capability booleans, and the title says which
// tool is required so a skip is visible in the report.
//
// The hostile `huge-dimensions-header-only.mp4` is only ever PROBED here; it
// is never decoded, transcoded, thumbnailed or rendered.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { extractAttachment, type ExtractionResult } from "../../src/core/attachmentExtraction.js";
import {
  defaultProviderCapabilities,
  planAttachmentRoutes,
  sniffMime,
} from "../../src/core/attachments.js";
import type { AttachmentRef } from "../../src/shared/types.js";
import { buildZip } from "../unit/_zipBuilder.js";
import { describeBinaryToolCapabilities } from "../../src/core/parsers/binaryTools.js";
import {
  resolveWorkerLaunch,
  runAttachmentWorker,
  WORKER_RESOURCE_LIMITS,
  type WorkerFactory,
  type WorkerLike,
} from "../../src/core/workerExtraction.js";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures/content");
const caps = describeBinaryToolCapabilities();

const registered = new Set<string>();

function fixturePath(rel: string): string {
  return path.join(FIXTURES, rel);
}

async function extractFixture(rel: string, signal?: AbortSignal): Promise<ExtractionResult> {
  const p = fixturePath(rel);
  const bytes = fs.readFileSync(p);
  const sniffed = sniffMime(bytes.subarray(0, 64));
  return extractAttachment({
    kind: sniffed.kind,
    sniffed_mime: sniffed.mime,
    byte_size: bytes.length,
    blob_path: p,
    sanitized_display_name: path.basename(p),
    ...(signal ? { signal } : {}),
  });
}

/** Register `rel` as exercised and define its test. */
function fixtureCase(
  rel: string,
  tool: "poppler" | "ffprobe" | null,
  body: () => Promise<void>,
): void {
  registered.add(rel);
  const available =
    tool === null ||
    (tool === "poppler" ? caps.pdf_text_extraction : caps.media_metadata_probe);
  const title = tool ? `${rel} (requires ${tool}${available ? "" : " — SKIPPED: not installed"})` : rel;
  it.skipIf(!available)(title, body);
}

function expectMarkers(text: string | null, markers: string[]): void {
  expect(text).not.toBeNull();
  for (const m of markers) expect(text).toContain(m);
}

describe("PDF fixtures (Poppler pdfinfo/pdftotext)", () => {
  fixtureCase("pdf/text-one-page.pdf", "poppler", async () => {
    const r = await extractFixture("pdf/text-one-page.pdf");
    expect(r.status).toBe("text_extracted");
    expect(r.pdf_pages).toBe(1);
    expectMarkers(r.extractedText, ["PDF_QUARTZ_ALPHA_2718"]);
  });

  fixtureCase("pdf/text-24-pages.pdf", "poppler", async () => {
    const r = await extractFixture("pdf/text-24-pages.pdf");
    expect(r.status).toBe("truncated");
    expect(r.pdf_pages).toBe(24);
    expect(r.coverage.truncated).toBe(true);
    expectMarkers(r.extractedText, ["PDF_PAGE_01_MARKER", "PDF_PAGE_20_MARKER"]);
    expect(r.extractedText).not.toContain("PDF_PAGE_21_MARKER");
    expect(r.extractedText).not.toContain("PDF_PAGE_24_MARKER");
  });

  fixtureCase("pdf/raster-only.pdf", "poppler", async () => {
    const r = await extractFixture("pdf/raster-only.pdf");
    expect(r.status).toBe("unsupported");
    expect(r.extractedText).toBeNull();
    expect(r.pdf_pages).toBe(1);
    expect(r.coverage.label).toMatch(/no selectable text/);
  });

  fixtureCase("pdf/malformed.pdf", "poppler", async () => {
    const r = await extractFixture("pdf/malformed.pdf");
    expect(["failed", "unsupported"]).toContain(r.status);
    expect(r.extractedText).toBeNull();
    // Never a success claim and never raw tool output or a path.
    expect(r.coverage.label).not.toMatch(/\/|Syntax Error|Error:/);
  });

  // Top-level empty-file path: no tool is spawned at all.
  fixtureCase("pdf/empty.pdf", null, async () => {
    const r = await extractFixture("pdf/empty.pdf");
    expect(r.status).toBe("none");
    expect(r.extractedText).toBeNull();
    expect(r.coverage.label).toBe("empty file");
  });

  fixtureCase("pdf/password-protected.pdf", "poppler", async () => {
    const r = await extractFixture("pdf/password-protected.pdf");
    expect(r.status).toBe("encrypted");
    expect(r.extractedText).toBeNull();
    expect(r.pdf_encrypted).toBe(true);
  });

  it.skipIf(!caps.pdf_text_extraction)(
    "a pre-aborted signal spawns no Poppler child (requires poppler)",
    async () => {
      const ac = new AbortController();
      ac.abort();
      const r = await extractFixture("pdf/text-24-pages.pdf", ac.signal);
      expect(r.status).toBe("failed");
      expect(r.extractedText).toBeNull();
    },
  );
});

interface MediaManifestEntry {
  file: string;
  mime: string;
  expected: {
    duration_range_seconds?: [number, number];
    dimensions?: [number, number];
    native_candidate: boolean;
  };
  probe: {
    metadata: {
      streams: Array<{ codec_name: string; codec_type: string }>;
      format: { format_name: string };
    };
  };
}

const mediaManifest = JSON.parse(
  fs.readFileSync(fixturePath("media/expected-manifest.json"), "utf8"),
) as { fixtures: MediaManifestEntry[] };

function mediaEntry(file: string): MediaManifestEntry {
  const e = mediaManifest.fixtures.find((f) => f.file === file);
  if (!e) throw new Error(`media manifest has no ${file}`);
  return e;
}

function streamsOf(r: ExtractionResult): Array<Record<string, unknown>> {
  return JSON.parse(r.media_streams_json ?? "[]") as Array<Record<string, unknown>>;
}

function expectValidMedia(
  r: ExtractionResult,
  entry: MediaManifestEntry,
  normalizedMime: string,
): void {
  expect(r.status).toBe("none");
  expect(r.coverage.label.startsWith("Metadata only — no transcription (")).toBe(true);
  expect(r.extractedText).toBeNull();
  const [lo, hi] = entry.expected.duration_range_seconds!;
  expect(r.media_duration_seconds!).toBeGreaterThanOrEqual(lo);
  expect(r.media_duration_seconds!).toBeLessThanOrEqual(hi);
  expect(r.normalized_media_mime).toBe(normalizedMime);
  expect(r.validated_media_format).toBe(entry.probe.metadata.format.format_name);
  const codecs = streamsOf(r).map((s) => `${s["codec_type"]}:${s["codec_name"]}`);
  expect(codecs).toEqual(
    entry.probe.metadata.streams.map((s) => `${s.codec_type}:${s.codec_name}`),
  );
  if (entry.expected.dimensions) {
    const video = streamsOf(r).find((s) => s["codec_type"] === "video")!;
    expect([video["width"], video["height"]]).toEqual(entry.expected.dimensions);
  }
}

describe("media fixtures (ffprobe, FD-only, probe-only)", () => {
  fixtureCase("media/valid-tone.wav", "ffprobe", async () => {
    const r = await extractFixture("media/valid-tone.wav");
    expectValidMedia(r, mediaEntry("valid-tone.wav"), "audio/wav");
    expect(streamsOf(r)[0]!["codec_name"]).toBe("pcm_s16le");
  });
  fixtureCase("media/valid-tone.mp3", "ffprobe", async () => {
    const r = await extractFixture("media/valid-tone.mp3");
    expectValidMedia(r, mediaEntry("valid-tone.mp3"), "audio/mpeg");
  });
  fixtureCase("media/valid-clip.mp4", "ffprobe", async () => {
    const r = await extractFixture("media/valid-clip.mp4");
    expectValidMedia(r, mediaEntry("valid-clip.mp4"), "video/mp4");
  });
  fixtureCase("media/valid-clip.webm", "ffprobe", async () => {
    const r = await extractFixture("media/valid-clip.webm");
    expectValidMedia(r, mediaEntry("valid-clip.webm"), "video/webm");
  });
  fixtureCase("media/unknown-duration.webm", "ffprobe", async () => {
    const r = await extractFixture("media/unknown-duration.webm");
    expect(r.status).toBe("unsupported");
    expect(r.normalized_media_mime).toBeNull();
    expect(r.media_duration_seconds).toBeNull();
    expect(r.coverage.label).toMatch(/duration/);
  });
  fixtureCase("media/excessive-duration-121s.mp3", "ffprobe", async () => {
    const r = await extractFixture("media/excessive-duration-121s.mp3");
    // A valid long file stays metadata-only here; routing refuses it by policy.
    expect(r.status).toBe("none");
    expect(r.media_duration_seconds!).toBeGreaterThanOrEqual(121);
    expect(r.media_duration_seconds!).toBeLessThanOrEqual(122);
  });
  fixtureCase("media/excessive-duration-121s.mp4", "ffprobe", async () => {
    const r = await extractFixture("media/excessive-duration-121s.mp4");
    expect(r.status).toBe("none");
    expect(r.media_duration_seconds!).toBeGreaterThanOrEqual(121);
    expect(r.media_duration_seconds!).toBeLessThanOrEqual(121.01);
    const video = streamsOf(r)[0]!;
    expect([video["width"], video["height"]]).toEqual([32, 32]);
  });
  fixtureCase("media/corrupt-truncated.mp4", "ffprobe", async () => {
    const r = await extractFixture("media/corrupt-truncated.mp4");
    expect(r.status).toBe("unsupported");
    expect(r.media_streams_json).toBeNull();
    expect(r.media_duration_seconds).toBeNull();
    expect(r.normalized_media_mime).toBeNull();
    expect(r.coverage.label).toMatch(/no streams reported/);
  });
  // Probe only: ffprobe is allowed to read the header; nothing decodes it.
  fixtureCase("media/huge-dimensions-header-only.mp4", "ffprobe", async () => {
    const r = await extractFixture("media/huge-dimensions-header-only.mp4");
    expect(r.status).toBe("unsupported");
    expect(r.normalized_media_mime).toBeNull();
    expect(r.coverage.label).toMatch(/no positive bounded video stream/);
    // Whatever was reported has no positive bounded video stream.
    expect(streamsOf(r).some((s) => (s["width"] as number) > 0 && (s["height"] as number) > 0)).toBe(false);
  });

  it.skipIf(!caps.media_metadata_probe)(
    "a pre-aborted signal spawns no ffprobe child and yields no metadata (requires ffprobe)",
    async () => {
      const ac = new AbortController();
      ac.abort();
      const r = await extractFixture("media/valid-clip.mp4", ac.signal);
      expect(r.status).toBe("failed");
      expect(r.normalized_media_mime ?? null).toBeNull();
    },
  );
});

describe("media fixtures: native routing decisions per provider (requires ffprobe)", () => {
  async function refFor(rel: string): Promise<AttachmentRef> {
    const bytes = fs.readFileSync(fixturePath(rel));
    const sniffed = sniffMime(bytes.subarray(0, 64));
    const r = await extractFixture(rel);
    return {
      id: rel,
      sanitized_display_name: path.basename(rel),
      sniffed_mime: sniffed.mime,
      kind: sniffed.kind,
      byte_size: bytes.length,
      content_sha256: "0".repeat(64),
      extraction_status: r.status,
      extraction_coverage: r.coverage,
      sniffed_media_duration_ms:
        r.media_duration_seconds == null ? null : Math.round(r.media_duration_seconds * 1000),
      sniffed_media_streams_json: r.media_streams_json ?? null,
      validated_media_format: r.validated_media_format ?? null,
      normalized_media_mime: r.normalized_media_mime ?? null,
    };
  }
  async function geminiRoute(rel: string) {
    const ref = await refFor(rel);
    const [decision] = planAttachmentRoutes({
      refs: [ref],
      hasExtractedText: () => false,
      capabilities: defaultProviderCapabilities("gemini"),
      provider: "gemini",
      safeInputTokens: 128_000,
    });
    return decision!;
  }

  for (const [rel, route] of [
    ["media/valid-tone.wav", "native_audio"],
    ["media/valid-tone.mp3", "native_audio"],
    ["media/valid-clip.mp4", "native_video"],
    ["media/valid-clip.webm", "native_video"],
  ] as const) {
    it.skipIf(!caps.media_metadata_probe)(`${rel} is a Gemini native candidate (requires ffprobe)`, async () => {
      expect((await geminiRoute(rel)).route).toBe(route);
    });
  }

  const refused: Array<[string, RegExp]> = [
    ["media/unknown-duration.webm", /duration unknown/],
    ["media/excessive-duration-121s.mp3", /exceeds the 120 s native cap/],
    ["media/excessive-duration-121s.mp4", /exceeds the 120 s native cap/],
    ["media/corrupt-truncated.mp4", /no validated media streams/],
    ["media/huge-dimensions-header-only.mp4", /no positive bounded video stream/],
  ];
  for (const [rel, reason] of refused) {
    it.skipIf(!caps.media_metadata_probe)(`${rel} is refused natively with a specific reason (requires ffprobe)`, async () => {
      const d = await geminiRoute(rel);
      expect(d.route).toBe("attachment_only");
      expect(d.reason).toMatch(reason);
    });
  }

  it.skipIf(!caps.media_metadata_probe)("OpenAI and Anthropic never route valid media natively (requires ffprobe)", async () => {
    const ref = await refFor("media/valid-clip.mp4");
    for (const provider of ["openai", "anthropic"] as const) {
      const [d] = planAttachmentRoutes({
        refs: [ref],
        hasExtractedText: () => false,
        capabilities: defaultProviderCapabilities(provider),
        provider,
        safeInputTokens: 128_000,
      });
      expect(d!.route).toBe("attachment_only");
      expect(d!.reason).toBe(`native audio/video is not supported for ${provider} in this app`);
    }
  });
});

describe("ZIP fixtures (worker thread, bounded)", () => {
  fixtureCase("zip/supported-mixed.zip", null, async () => {
    const r = await extractFixture("zip/supported-mixed.zip");
    expect(r.status).toBe("truncated");
    expect(r.coverage.truncated).toBe(true);
    expect(r.extractedText).toContain("7 entries");
    expectMarkers(r.extractedText, [
      "ZIP_DIRECT_TEXT_LANTERN_31415",
      "ZIP_CSV_CEDAR_2718",
      "ZIP_JSON_KITE_1618",
      // Source is read as inert text; the raise in it is never run.
      "ZIP_SOURCE_NEVER_EXECUTED_5772",
    ]);
    const excluded = r.extractedText!.split("--- excluded ---")[1] ?? "";
    expect(excluded).toMatch(/nested\.zip — nested archive, not recursed/);
    expect(excluded).toMatch(/binary\.bin — unsupported or binary/);
  });
  fixtureCase("zip/nested-only.zip", null, async () => {
    const r = await extractFixture("zip/nested-only.zip");
    expect(r.extractedText).toContain("1 entry");
    expect(r.extractedText).toMatch(/nested\.zip — nested archive, not recursed/);
    expect(r.extractedText).not.toContain("ZIP_NESTED_DO_NOT_RECURSE_31415");
  });
  fixtureCase("zip/empty.zip", null, async () => {
    const r = await extractFixture("zip/empty.zip");
    expect(r.status).toBe("none");
    expect(r.coverage.label).toBe("empty ZIP (0 entries)");
    expect(r.extractedText).toBeNull();
  });

  const hostile: Array<[string, string]> = [
    ["zip/traversal.zip", "traversal"],
    ["zip/absolute.zip", "absolute_path"],
    ["zip/windows-absolute.zip", "absolute_path"],
    ["zip/duplicate-entry.zip", "duplicate_entry"],
    ["zip/symlink.zip", "symlink"],
    ["zip/high-ratio-small.zip", "compression_ratio"],
    ["zip/bad-crc.zip", "crc_mismatch"],
    ["zip/local-central-name-mismatch.zip", "local_central_name_mismatch"],
    ["zip/local-central-size-mismatch.zip", "local_central_size_mismatch"],
    ["zip/local-central-method-mismatch.zip", "local_central_method_mismatch"],
    ["zip/declared-inflated-limit.zip", "declared_size"],
    ["zip/multi-disk.zip", "multi_disk_unsupported"],
    ["zip/truncated.zip", "truncated"],
  ];
  for (const [rel, code] of hostile) {
    fixtureCase(rel, null, async () => {
      const r = await extractFixture(rel);
      expect(r.status).toBe("failed");
      expect(r.coverage.label).toContain(`(${code})`);
      expect(r.extractedText).toBeNull();
    });
  }
  fixtureCase("zip/encrypted.zip", null, async () => {
    const r = await extractFixture("zip/encrypted.zip");
    expect(r.status).toBe("encrypted");
    expect(r.extractedText).toBeNull();
    expect(r.coverage.label).toContain("(encrypted)");
  });
});

describe("Office fixtures (worker thread, bounded)", () => {
  const officeManifest = JSON.parse(
    fs.readFileSync(fixturePath("office/manifest.json"), "utf8"),
  ) as {
    files: Array<{
      file: string;
      required_markers: string[];
      optional_markers: string[];
      forbidden_markers?: string[];
      omitted_or_not_analyzed: string[];
    }>;
  };
  const entry = (file: string) => officeManifest.files.find((f) => f.file === file)!;

  for (const file of [
    "proofestra-content.docx",
    "namespace-variant.docx",
    "proofestra-content.xlsx",
    "proofestra-content.odt",
  ]) {
    fixtureCase(`office/${file}`, null, async () => {
      const r = await extractFixture(`office/${file}`);
      expect(r.status).toBe("text_extracted");
      expectMarkers(r.extractedText, entry(file).required_markers);
    });
  }
  fixtureCase("office/entity-declaration.docx", null, async () => {
    const r = await extractFixture("office/entity-declaration.docx");
    expect(r.status).toBe("unsupported");
    expect(r.extractedText).toBeNull();
    expect(r.coverage.label).toMatch(/DTD or entity/);
    for (const m of entry("entity-declaration.docx").forbidden_markers!) {
      expect(JSON.stringify(r)).not.toContain(m);
    }
  });
  fixtureCase("office/external-entity.docx", null, async () => {
    const r = await extractFixture("office/external-entity.docx");
    expect(r.status).toBe("unsupported");
    expect(r.coverage.label).toMatch(/DTD or entity/);
    expect(r.extractedText).toBeNull();
    for (const m of entry("external-entity.docx").forbidden_markers!) {
      expect(JSON.stringify(r)).not.toContain(m);
    }
  });
  fixtureCase("office/large-sheet.xlsx", null, async () => {
    const r = await extractFixture("office/large-sheet.xlsx");
    expect(r.status).toBe("truncated");
    expect(r.coverage.truncated).toBe(true);
    expect(r.extractedText!.length).toBeLessThanOrEqual(24_000);
    expect(r.coverage.extracted_chars).toBe(r.extractedText!.length);
    expectMarkers(r.extractedText, entry("large-sheet.xlsx").required_markers);
    expect(r.extractedText).not.toContain("PROOFESTRA_XLSX_TAIL_BEYOND_TEXT_LIMIT");
  });
  fixtureCase("office/proofestra-content.pptx", null, async () => {
    const r = await extractFixture("office/proofestra-content.pptx");
    expect(r.status).toBe("text_extracted");
    expectMarkers(r.extractedText, entry("proofestra-content.pptx").required_markers);
    const text = r.extractedText!;
    expect(text.indexOf("PROOFESTRA_PPTX_SLIDE_ONE_ORCHID_42")).toBeLessThan(
      text.indexOf("PROOFESTRA_PPTX_SLIDE_TWO_BLUE_17"),
    );
    // Notes are read after slide bodies.
    expect(text.indexOf("PROOFESTRA_PPTX_NOTES_OPTIONAL")).toBeGreaterThan(
      text.indexOf("PROOFESTRA_PPTX_SLIDE_TWO_BLUE_17"),
    );
  });

  it("xlsx formulas are never evaluated: only shared/inline strings appear", async () => {
    const r = await extractFixture("office/proofestra-content.xlsx");
    expect(r.extractedText).not.toMatch(/SUM\(/);
  });
});

describe("Office/ZIP edge cases built in memory", () => {
  async function extractBuffer(name: string, data: Buffer): Promise<ExtractionResult> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofestra-zip-"));
    try {
      const p = path.join(dir, "00000000-0000-4000-8000-000000000000");
      fs.writeFileSync(p, data);
      return await extractAttachment({
        kind: "archive",
        sniffed_mime: "application/zip",
        byte_size: data.length,
        blob_path: p,
        sanitized_display_name: name,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const docXml = (t: string): Buffer =>
    Buffer.from(`<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:body></w:document>`);

  it("macro-enabled and template extensions parse as text and say macros are not executed", async () => {
    const data = buildZip([
      { name: "word/document.xml", data: docXml("MACRO_VARIANT_BODY_77") },
      { name: "word/vbaProject.bin", data: Buffer.from("VBA_MUST_NEVER_BE_READ") },
    ]);
    for (const name of ["a.docm", "a.dotx", "a.dotm"]) {
      const r = await extractBuffer(name, data);
      expect(r.status).toBe("text_extracted");
      expect(r.extractedText).toContain("MACRO_VARIANT_BODY_77");
      expect(r.extractedText).not.toContain("VBA_MUST_NEVER");
      expect(r.coverage.label).toContain("macros not executed");
    }
    const plain = await extractBuffer("a.docx", data);
    expect(plain.coverage.label).not.toContain("macros");
  });

  it("an XML part that is UTF-16 is refused, never decoded as UTF-8", async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`<w:document ${W}/>`, "utf16le")]);
    const r = await extractBuffer("a.docx", buildZip([{ name: "word/document.xml", data: utf16 }]));
    expect(r.status).toBe("unsupported");
    expect(r.coverage.label).toMatch(/not UTF-8/);
  });

  it("a docx-looking package renamed .zip never dumps raw XML parts", async () => {
    const data = buildZip([
      { name: "[Content_Types].xml", data: Buffer.from("<Types>PACKAGE_RAW_XML_MARKER</Types>") },
      { name: "notes.txt", data: Buffer.from("PLAIN_NOTE_MARKER") },
    ]);
    const r = await extractBuffer("renamed.zip", data);
    expect(r.extractedText).toContain("PLAIN_NOTE_MARKER");
    expect(r.extractedText).not.toContain("PACKAGE_RAW_XML_MARKER");
    expect(r.extractedText).toMatch(/Office\/ODF package part/);
  });

  it("empty members inside a ZIP do not fail the archive", async () => {
    const data = buildZip([
      { name: "pkg/__init__.py", data: Buffer.alloc(0) },
      { name: "pkg/main.py", data: Buffer.from("MAIN_PY_MARKER = 1\n") },
    ]);
    const r = await extractBuffer("code.zip", data);
    expect(r.status).not.toBe("failed");
    expect(r.extractedText).toContain("MAIN_PY_MARKER");
  });

  it("decodes only the five built-in entities, once (no double decoding)", async () => {
    const data = buildZip([
      { name: "word/document.xml", data: docXml("a &amp;lt; b &lt;tag&gt; &#65; &custom;") },
    ]);
    const r = await extractBuffer("e.docx", data);
    expect(r.extractedText).toContain("a &lt; b <tag> &#65; &custom;");
  });
});

const zipInputForLateError = { operation: "zip", blob_path: "unused", byte_size: 1 } as const;

describe("worker lifecycle", () => {
  function fakeWorker(terminateDelayMs: number, log: string[]): WorkerLike & EventEmitter {
    const w = new EventEmitter() as WorkerLike & EventEmitter;
    w.terminate = async () => {
      log.push("terminate-start");
      await new Promise((r) => setTimeout(r, terminateDelayMs));
      log.push("terminate-done");
      return 0;
    };
    return w;
  }
  const zipInput = { operation: "zip", blob_path: "unused", byte_size: 1 } as const;

  it("abort awaits terminate() before the extraction settles and removes listeners", async () => {
    const log: string[] = [];
    const w = fakeWorker(40, log);
    const ac = new AbortController();
    const p = runAttachmentWorker(zipInput, { signal: ac.signal, workerFactory: () => w }).then((r) => {
      log.push("settled");
      return r;
    });
    ac.abort();
    const r = await p;
    expect(log).toEqual(["terminate-start", "terminate-done", "settled"]);
    expect(r.status).toBe("failed");
    expect(r.coverage.label).toMatch(/cancelled/);
    for (const ev of ["message", "error", "exit"]) expect(w.listenerCount(ev)).toBe(0);
    // A late message after settlement is ignored.
    w.emit("message", { ok: true, result: { status: "text_extracted" } });
  });

  it("timeout awaits terminate() before settling", async () => {
    const log: string[] = [];
    const w = fakeWorker(30, log);
    const r = await runAttachmentWorker(zipInput, { timeoutMs: 40, workerFactory: () => w }).then((x) => {
      log.push("settled");
      return x;
    });
    expect(log).toEqual(["terminate-start", "terminate-done", "settled"]);
    expect(r.coverage.label).toMatch(/timed out after 0\.04 s/);
  });

  it("an already-aborted signal never creates a worker", async () => {
    const ac = new AbortController();
    ac.abort();
    let created = 0;
    const r = await runAttachmentWorker(zipInput, {
      signal: ac.signal,
      workerFactory: () => {
        created += 1;
        return fakeWorker(0, []);
      },
    });
    expect(created).toBe(0);
    expect(r.status).toBe("failed");
  });

  it("creates the worker with resource limits, an empty env and only the blob path/size", async () => {
    let seen: { entry: URL | string; options: Parameters<WorkerFactory>[1] } | null = null;
    const w = fakeWorker(0, []);
    const p = runAttachmentWorker(
      { operation: "office", blob_path: "/blob/uuid", byte_size: 9, office_kind: "docx" },
      {
        workerFactory: (entry, options) => {
          seen = { entry, options };
          return w;
        },
      },
    );
    w.emit("message", {
      ok: true,
      result: { status: "none", coverage: { extracted_chars: 0, truncated: false, label: "x" }, extractedText: null },
    });
    await p;
    expect(seen!.options.resourceLimits).toEqual(WORKER_RESOURCE_LIMITS);
    expect(WORKER_RESOURCE_LIMITS).toEqual({
      maxOldGenerationSizeMb: 192,
      maxYoungGenerationSizeMb: 32,
      stackSizeMb: 4,
    });
    expect(seen!.options.env).toEqual({});
    expect(seen!.options.workerData).toEqual({
      operation: "office",
      blob_path: "/blob/uuid",
      byte_size: 9,
      office_kind: "docx",
    });
    // Running under Vitest/tsx: the source (.ts) worker via the tsx bootstrap.
    expect(seen!.options.eval).toBe(true);
    expect(String(seen!.entry)).toContain("attachmentWorker.ts");
  });

  it("resolves the built .js worker directly (no tsx) for compiled modules", () => {
    const built = resolveWorkerLaunch("file:///app/dist/server/core/workerExtraction.js");
    expect(built.eval).toBe(false);
    expect(built.execArgv).toEqual([]);
    expect(String(built.entry)).toBe("file:///app/dist/server/core/attachmentWorker.js");
    const source = resolveWorkerLaunch("file:///app/src/core/workerExtraction.ts");
    expect(source.eval).toBe(true);
    expect(String(source.entry)).toContain("file:///app/src/core/attachmentWorker.ts");
  });

  it("a real worker terminates before an abort settles the real extraction", async () => {
    const blob = fixturePath("zip/supported-mixed.zip");
    const ac = new AbortController();
    let exited = false;
    const p = runAttachmentWorker(
      { operation: "zip", blob_path: blob, byte_size: fs.statSync(blob).size },
      {
        signal: ac.signal,
        workerFactory: (entry, options) => {
          const real = new Worker(entry as string, options);
          real.on("exit", () => {
            exited = true;
          });
          return real as unknown as WorkerLike;
        },
      },
    );
    ac.abort();
    const r = await p;
    expect(r.status).toBe("failed");
    expect(r.coverage.label).toMatch(/cancelled/);
    expect(exited).toBe(true);
  });

  it("a late worker 'error' during terminate() is absorbed: error/exit listeners stay attached until terminate settles", async () => {
    const w = new EventEmitter() as WorkerLike & EventEmitter;
    let errorListenersDuringTerminate = -1;
    let messageListenersDuringTerminate = -1;
    w.terminate = async () => {
      await new Promise((r) => setTimeout(r, 20));
      errorListenersDuringTerminate = w.listenerCount("error");
      messageListenersDuringTerminate = w.listenerCount("message");
      // Without a listener this throws and would take the server down.
      w.emit("error", Object.assign(new Error("late out-of-memory stop"), { code: "ERR_WORKER_OUT_OF_MEMORY" }));
      return 0;
    };
    const ac = new AbortController();
    const p = runAttachmentWorker(zipInputForLateError, { signal: ac.signal, workerFactory: () => w });
    ac.abort();
    const r = await p;
    expect(r.coverage.label).toMatch(/cancelled/);
    expect(errorListenersDuringTerminate).toBeGreaterThan(0);
    expect(messageListenersDuringTerminate).toBe(0);
    expect(w.listenerCount("error")).toBe(0);
    expect(w.listenerCount("exit")).toBe(0);
  });

  it("a failing worker reports a generic failure with no path or stack", async () => {
    const w = fakeWorker(0, []);
    const p = runAttachmentWorker(zipInput, { workerFactory: () => w });
    w.emit("error", Object.assign(new Error("secret /Users/x/blob"), { code: "ERR_X" }));
    const r = await p;
    expect(r.status).toBe("failed");
    expect(JSON.stringify(r)).not.toMatch(/secret|\/Users/);
  });
});

describe("fixture coverage", () => {
  it("manifest entries equal the exercised fixture cases", () => {
    const manifest = JSON.parse(fs.readFileSync(fixturePath("manifest.json"), "utf8")) as {
      fixtures: Array<{ path: string }>;
    };
    const office = JSON.parse(fs.readFileSync(fixturePath("office/manifest.json"), "utf8")) as {
      files: Array<{ file: string }>;
    };
    const expected = new Set<string>([
      ...manifest.fixtures.map((f) => f.path),
      ...office.files.map((f) => `office/${f.file}`),
      ...mediaManifest.fixtures.map((f) => `media/${f.file}`),
    ]);
    expect([...registered].sort()).toEqual([...expected].sort());
    for (const rel of expected) expect(fs.existsSync(fixturePath(rel))).toBe(true);
  });

  it("no fixture manifest contains an absolute local path or username", () => {
    for (const rel of ["manifest.json", "office/manifest.json", "media/expected-manifest.json"]) {
      const text = fs.readFileSync(fixturePath(rel), "utf8");
      expect(text).not.toMatch(/\/Users\/|\/home\/|C:\\\\|jirawat/);
    }
  });
});

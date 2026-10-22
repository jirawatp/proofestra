// Review-driven hardening tests. Hostile variants are built at TEST TIME in a
// temp directory from the committed fixtures or from scratch; the committed
// fixtures are never modified. Real-tool cases skip visibly when Poppler or
// ffprobe is missing. The hostile huge-dimensions media is never touched here.

import fs from "node:fs";
import type { ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractAttachment, type ExtractionResult } from "../../src/core/attachmentExtraction.js";
import {
  defaultProviderCapabilities,
  planAttachmentRoutes,
  sniffMime,
} from "../../src/core/attachments.js";
import { describeBinaryToolCapabilities } from "../../src/core/parsers/binaryTools.js";
import {
  allVideoStreamsBounded,
  isMediaPreviewValidated,
  sanitizePersistedStreamsJson,
  parsePersistedMediaStreams,
} from "../../src/shared/attachmentMetadata.js";
import type { AttachmentRef } from "../../src/shared/types.js";
import { extractPdfText } from "../../src/core/parsers/pdf.js";
import { probeMedia } from "../../src/core/parsers/ffprobe.js";
import { nativeWireMime } from "../../src/core/attachments.js";
import { buildPdf } from "../unit/_pdfBuilder.js";
import { buildZip } from "../unit/_zipBuilder.js";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures/content");
const caps = describeBinaryToolCapabilities();
const tmpDirs: string[] = [];

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "proofestra-hardening-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function writeTemp(name: string, data: Buffer): string {
  const p = path.join(tmp(), name);
  fs.writeFileSync(p, data);
  return p;
}

async function extractFile(p: string, displayName = path.basename(p)): Promise<ExtractionResult> {
  const bytes = fs.readFileSync(p);
  const sniffed = sniffMime(bytes.subarray(0, 64));
  return extractAttachment({
    kind: sniffed.kind,
    sniffed_mime: sniffed.mime,
    byte_size: bytes.length,
    blob_path: p,
    sanitized_display_name: displayName,
  });
}

function refFrom(r: ExtractionResult, sniffedMime: string, kind: AttachmentRef["kind"]): AttachmentRef {
  return {
    id: "x",
    sanitized_display_name: "x",
    sniffed_mime: sniffedMime,
    kind,
    byte_size: 1000,
    content_sha256: "0".repeat(64),
    extraction_status: r.status,
    extraction_coverage: r.coverage,
    sniffed_pdf_pages: r.pdf_pages ?? null,
    sniffed_media_duration_ms:
      r.media_duration_seconds == null ? null : Math.round(r.media_duration_seconds * 1000),
    sniffed_media_streams_json: r.media_streams_json ?? null,
    validated_media_format: r.validated_media_format ?? null,
    normalized_media_mime: r.normalized_media_mime ?? null,
  };
}

const gemini = defaultProviderCapabilities("gemini");
function geminiRoute(ref: AttachmentRef) {
  return planAttachmentRoutes({
    refs: [ref],
    hasExtractedText: () => false,
    capabilities: gemini,
    provider: "gemini",
    safeInputTokens: 1_000_000,
  })[0]!;
}

describe("PDF metadata cannot be spoofed by the document (requires poppler)", () => {
  it.skipIf(!caps.pdf_text_extraction)("a Title containing 'Pages: 1' on a 30-page PDF fails closed", async () => {
    const honest = await extractFile(writeTemp("honest.pdf", buildPdf(30, { title: "Quarterly" })));
    expect(honest.pdf_pages).toBe(30);

    const spoof = await extractFile(writeTemp("spoof.pdf", buildPdf(30, { title: "Quarterly\nPages: 1" })));
    expect(spoof.status).toBe("failed");
    expect(spoof.coverage.label).toBe("PDF metadata ambiguous");
    expect(spoof.pdf_pages ?? null).toBeNull();
    expect(spoof.extractedText).toBeNull();
    // No page count means no native route.
    const ref = refFrom(spoof, "application/pdf", "pdf");
    expect(geminiRoute(ref).route).toBe("attachment_only");
  });

  it.skipIf(!caps.pdf_text_extraction)("an injected 'Encrypted: no' line cannot mask the real flag", async () => {
    const r = await extractFile(writeTemp("enc.pdf", buildPdf(3, { title: "x\nEncrypted: no" })));
    expect(r.status).toBe("failed");
    expect(r.coverage.label).toBe("PDF metadata ambiguous");
    const yes = await extractFile(writeTemp("enc2.pdf", buildPdf(3, { title: "x\nEncrypted: yes" })));
    expect(yes.status).toBe("failed");
    expect(yes.pdf_encrypted ?? null).toBeNull();
  });
});

describe("media streams fail closed", () => {
  const stream = (t: string, c: string, extra: object = {}) => ({ codec_type: t, codec_name: c, ...extra });

  it("a persisted summary with more than 8 streams is unvalidated, never truncated", () => {
    const nine = JSON.stringify([
      stream("video", "h264", { width: 160, height: 90 }),
      ...Array.from({ length: 7 }, () => stream("audio", "aac")),
      stream("audio", "wmav2"),
    ]);
    expect(sanitizePersistedStreamsJson(nine)).toBeNull();
    expect(parsePersistedMediaStreams(nine)).toEqual([]);
    const eight = JSON.stringify(Array.from({ length: 8 }, () => stream("audio", "aac")));
    expect(parsePersistedMediaStreams(eight)).toHaveLength(8);
  });

  it("a persisted audio/video stream without a clean codec, or any non-audio/video entry, is unvalidated", () => {
    expect(parsePersistedMediaStreams(JSON.stringify([stream("video", "h264", { width: 2, height: 2 }), { codec_type: "audio" }]))).toEqual([]);
    expect(parsePersistedMediaStreams(JSON.stringify([stream("audio", "bad codec!")]))).toEqual([]);
    expect(parsePersistedMediaStreams(JSON.stringify([stream("audio", "aac"), stream("subtitle", "mov_text")]))).toEqual([]);
  });

  it("routing refuses a 9-stream summary even though the first 8 look fine", () => {
    const ref: AttachmentRef = {
      id: "nine",
      sanitized_display_name: "nine.mp4",
      sniffed_mime: "video/mp4",
      kind: "video",
      byte_size: 1000,
      content_sha256: "0".repeat(64),
      extraction_status: "none",
      extraction_coverage: { extracted_chars: 0, truncated: false, label: "x" },
      sniffed_media_duration_ms: 5000,
      normalized_media_mime: "video/mp4",
      sniffed_media_streams_json: JSON.stringify([
        stream("video", "h264", { width: 160, height: 90 }),
        ...Array.from({ length: 7 }, () => stream("audio", "aac")),
        stream("audio", "wmav2"),
      ]),
    };
    expect(geminiRoute(ref).route).toBe("attachment_only");
  });

  it("every video track must be bounded: one 160x90 track plus one 60000x60000 track is refused and not previewable", () => {
    const json = JSON.stringify([
      stream("video", "h264", { width: 160, height: 90 }),
      stream("video", "h264", { width: 60000, height: 60000 }),
    ]);
    const streams = parsePersistedMediaStreams(json);
    expect(streams).toHaveLength(2);
    expect(allVideoStreamsBounded(streams)).toBe(false);
    expect(allVideoStreamsBounded([streams[0]!])).toBe(true);
    expect(
      isMediaPreviewValidated({
        kind: "video",
        sniffed_media_duration_ms: 1000,
        normalized_media_mime: "video/mp4",
        sniffed_media_streams_json: json,
      }),
    ).toBe(false);
    const ref: AttachmentRef = {
      id: "two",
      sanitized_display_name: "two.mp4",
      sniffed_mime: "video/mp4",
      kind: "video",
      byte_size: 1000,
      content_sha256: "0".repeat(64),
      extraction_status: "none",
      extraction_coverage: { extracted_chars: 0, truncated: false, label: "x" },
      sniffed_media_duration_ms: 5000,
      normalized_media_mime: "video/mp4",
      sniffed_media_streams_json: json,
    };
    const r = geminiRoute(ref);
    expect(r.route).toBe("attachment_only");
    expect(r.reason).toMatch(/no positive bounded video stream/);
  });

  it.skipIf(!caps.media_metadata_probe)(
    "a test-time copy of valid-clip.mp4 with an unidentifiable audio codec is never native and not previewable (requires ffprobe)",
    async () => {
      const original = fs.readFileSync(path.join(FIXTURES, "media/valid-clip.mp4"));
      const scrambled = Buffer.from(original);
      for (const [from, to] of [
        ["mp4a", "zq9x"],
        ["esds", "zzzz"],
      ] as const) {
        const at = scrambled.indexOf(Buffer.from(from));
        expect(at).toBeGreaterThan(0);
        scrambled.write(to, at, "latin1");
      }
      const r = await extractFile(writeTemp("scrambled.mp4", scrambled));
      expect(r.status).toBe("unsupported");
      expect(r.normalized_media_mime ?? null).toBeNull();
      expect(r.coverage.label).toMatch(/unidentified stream codec/);
      const ref = refFrom(r, "video/mp4", "video");
      expect(geminiRoute(ref).route).toBe("attachment_only");
      expect(isMediaPreviewValidated(ref)).toBe(false);
      // The committed fixture itself still validates.
      const ok = await extractFile(path.join(FIXTURES, "media/valid-clip.mp4"));
      expect(ok.normalized_media_mime).toBe("video/mp4");
    },
  );
});

describe("Office tokenizer is linear and bounded", () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  async function docx(xml: string, method: 0 | 8 = 0): Promise<{ r: ExtractionResult; ms: number }> {
    const zip = buildZip([{ name: "word/document.xml", data: Buffer.from(xml), method }]);
    const p = writeTemp("x.docx", zip);
    const t0 = Date.now();
    const r = await extractFile(p);
    return { r, ms: Date.now() - t0 };
  }

  it("1 MB of deep nesting is refused as unsupported, quickly", async () => {
    const depth = 140_000; // ~1 MB of "<w:p>"
    const xml = `<w:document ${W}>${"<w:p>".repeat(depth)}`;
    const { r, ms } = await docx(xml);
    expect(r.status).toBe("unsupported");
    expect(r.coverage.label).toMatch(/nesting or tag too large/);
    expect(ms).toBeLessThan(4_000);
  });

  it("a 200 KB attribute run in one tag is refused as unsupported, quickly", async () => {
    const xml = `<w:document ${W}><w:p ${"a".repeat(200_000)} xmlns:x="y"><w:r><w:t>hi</w:t></w:r></w:p></w:document>`;
    const { r, ms } = await docx(xml);
    expect(r.status).toBe("unsupported");
    expect(r.coverage.label).toMatch(/nesting or tag too large/);
    expect(ms).toBeLessThan(4_000);
  });

  it("many prefix declarations stay linear and namespaces scope correctly", async () => {
    const decls = Array.from({ length: 2000 }, (_, i) => `xmlns:p${i}="urn:n${i}"`).join(" ");
    const xml = `<doc:document xmlns:doc="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ${decls}><doc:body><doc:p><doc:r><doc:t>SCOPED_OK</doc:t></doc:r></doc:p><other:p xmlns:other="urn:other"><other:t>WRONG_NS</other:t></other:p></doc:body></doc:document>`;
    const { r, ms } = await docx(xml);
    expect(r.extractedText).toContain("SCOPED_OK");
    expect(r.extractedText).not.toContain("WRONG_NS");
    expect(ms).toBeLessThan(4_000);
  });

  it("depth just under the cap still parses", async () => {
    const xml = `<w:document ${W}>${"<w:b>".repeat(200)}<w:p><w:r><w:t>DEEP_OK</w:t></w:r></w:p>${"</w:b>".repeat(200)}</w:document>`;
    const { r } = await docx(xml);
    expect(r.extractedText).toContain("DEEP_OK");
  });
});

describe("XLSX stored cell values (formulas never evaluated)", () => {
  const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  async function xlsx(sheet: string, shared = ""): Promise<ExtractionResult> {
    const entries = [
      ...(shared ? [{ name: "xl/sharedStrings.xml", data: Buffer.from(`<sst ${S}>${shared}</sst>`) }] : []),
      { name: "xl/worksheets/sheet1.xml", data: Buffer.from(`<worksheet ${S}><sheetData>${sheet}</sheetData></worksheet>`) },
    ];
    return extractFile(writeTemp("v.xlsx", buildZip(entries)));
  }

  it("reads numbers, booleans, errors, cached formula strings, inline and shared strings by index; never <f>", async () => {
    const r = await xlsx(
      '<row r="1"><c r="A1" t="s"><v>1</v></c><c r="B1"><v>42.5</v></c><c r="C1" t="b"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="str"><f>CONCAT("a","b")</f><v>CACHED_AB</v></c><c r="B2" t="e"><v>#DIV/0!</v></c>' +
        '<c r="C2" t="inlineStr"><is><t>INLINE_X</t></is></c></row>' +
        '<row r="3"><c r="A3"><f>1+1</f><v>2</v></c><c r="B3"><v>45292</v></c></row>',
      "<si><t>zero</t></si><si><t>ONE_SHARED</t></si>",
    );
    expect(r.status).toBe("text_extracted");
    const text = r.extractedText!;
    for (const m of ["ONE_SHARED", "42.5", "TRUE", "CACHED_AB", "#DIV/0!", "INLINE_X", "45292"]) {
      expect(text).toContain(m);
    }
    expect(text).not.toContain("CONCAT");
    expect(text).not.toContain("1+1");
    // Dates stay stored serial numbers; the label says what was read.
    expect(r.coverage.label).toContain("cached values, formulas not evaluated");
    expect(text.split("\n")[0]).toBe("ONE_SHARED\t42.5\tTRUE");
  });

  it("the committed fixture now includes the cached SUM value 5 and still excludes the formula", async () => {
    const r = await extractFile(path.join(FIXTURES, "office/proofestra-content.xlsx"));
    expect(r.extractedText).toContain("PROOFESTRA_XLSX_CACHED_TOTAL\t5");
    expect(r.extractedText).toContain("Apples\t3");
    expect(r.extractedText).not.toContain("SUM(");
    expect(r.coverage.label).toContain("cached values, formulas not evaluated");
  });
});

describe("Office strict UTF-8 and ZIP text-entry hygiene", () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const doc = (head: string, t: string) =>
    Buffer.from(`${head}<w:document ${W}><w:body><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:body></w:document>`, "utf8");

  it("an XML part that declares a non-UTF-8 encoding, or holds invalid UTF-8, is refused", async () => {
    const declared = await extractFile(
      writeTemp("a.docx", buildZip([{ name: "word/document.xml", data: doc('<?xml version="1.0" encoding="windows-1252"?>', "X") }])),
    );
    expect(declared.status).toBe("unsupported");
    expect(declared.coverage.label).toMatch(/not UTF-8/);
    const invalid = Buffer.concat([doc('<?xml version="1.0"?>', "ok"), Buffer.from([0xff, 0xfe, 0x80])]);
    const bad = await extractFile(writeTemp("b.docx", buildZip([{ name: "word/document.xml", data: invalid }])));
    expect(bad.status).toBe("unsupported");
    const good = await extractFile(
      writeTemp("c.docx", buildZip([{ name: "word/document.xml", data: doc('<?xml version="1.0" encoding="UTF-8"?>', "สวัสดี") }])),
    );
    expect(good.extractedText).toContain("สวัสดี");
  });

  async function zipText(entries: Parameters<typeof buildZip>[0]): Promise<ExtractionResult> {
    return extractFile(writeTemp("t.zip", buildZip(entries)));
  }

  it("a STORED nested archive or binary renamed .txt/.json/.py is not dumped as text", async () => {
    const inner = buildZip([{ name: "secret.txt", data: Buffer.from("INNER_PLAINTEXT_MARKER"), method: 0 }]);
    const r = await zipText([
      { name: "renamed.txt", data: inner, method: 0 },
      { name: "binary.json", data: Buffer.from([0x7b, 0x00, 0x01, 0x02, 0x7d]), method: 0 },
      { name: "latin1.py", data: Buffer.from([0x63, 0xe9, 0x74, 0xe9]), method: 0 },
      { name: "ok.txt", data: Buffer.from("PLAIN_OK_MARKER"), method: 0 },
    ]);
    expect(r.extractedText).toContain("PLAIN_OK_MARKER");
    expect(r.extractedText).not.toContain("INNER_PLAINTEXT_MARKER");
    expect(r.extractedText).not.toContain("\u0000");
    const excluded = r.extractedText!.split("--- excluded ---")[1] ?? "";
    for (const name of ["renamed.txt", "binary.json", "latin1.py"]) {
      expect(excluded).toContain(`${name} — content is not UTF-8 text`);
    }
  });

  it("slicing to the character cap never leaves half of a surrogate pair", async () => {
    // Make the emoji straddle the 24,000-character boundary for several offsets.
    for (let pad = 0; pad < 3; pad += 1) {
      const body = "a".repeat(23_700 + pad) + "😀".repeat(400);
      const r = await zipText([{ name: "big.txt", data: Buffer.from(body), method: 0 }]);
      const text = r.extractedText!;
      expect(text.length).toBeLessThanOrEqual(24_000);
      expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)).toBe(false);
    }
  });
});

describe("media: container name is recorded only for validated files (requires ffprobe)", () => {
  it.skipIf(!caps.media_metadata_probe)("unsupported probes persist no validated format", async () => {
    for (const rel of ["media/corrupt-truncated.mp4", "media/unknown-duration.webm"]) {
      const r = await extractFile(path.join(FIXTURES, rel));
      expect(r.status).toBe("unsupported");
      expect(r.validated_media_format ?? null).toBeNull();
    }
    const ok = await extractFile(path.join(FIXTURES, "media/valid-clip.mp4"));
    expect(ok.validated_media_format).toContain("mp4");
  });
});

describe("QuickTime brand, validated end to end (requires ffprobe)", () => {
  function withQtBrand(src: string): string {
    const data = Buffer.from(fs.readFileSync(src));
    expect(data.subarray(4, 8).toString("latin1")).toBe("ftyp");
    data.write("qt  ", 8, "latin1");
    return writeTemp("clip.mov", data);
  }

  it.skipIf(!caps.media_metadata_probe)("a qt-branded copy of valid-clip.mp4 normalizes to video/mov and routes native with that wire MIME", async () => {
    const p = withQtBrand(path.join(FIXTURES, "media/valid-clip.mp4"));
    expect(sniffMime(fs.readFileSync(p).subarray(0, 64)).mime).toBe("video/quicktime");
    const r = await extractFile(p);
    expect(r.status).toBe("none");
    expect(r.normalized_media_mime).toBe("video/mov");
    const ref = refFrom(r, "video/quicktime", "video");
    expect(geminiRoute(ref).route).toBe("native_video");
    expect(nativeWireMime(ref)).toBe("video/mov");
  });

  it.skipIf(!caps.media_metadata_probe)("a qt-branded copy of the corrupt fixture is refused", async () => {
    const p = withQtBrand(path.join(FIXTURES, "media/corrupt-truncated.mp4"));
    const r = await extractFile(p);
    expect(r.normalized_media_mime ?? null).toBeNull();
    const ref = refFrom(r, "video/quicktime", "video");
    expect(geminiRoute(ref).route).toBe("attachment_only");
  });
});

describe("mid-run abort of the real tools (child already spawned)", () => {
  it.skipIf(!caps.pdf_text_extraction)(
    "aborting after pdfinfo/pdftotext has started waits for the child's close and returns a cancelled result (requires poppler)",
    async () => {
      const ac = new AbortController();
      let spawned = 0;
      let closes = 0;
      const result = await extractPdfText({
        blob_path: path.join(FIXTURES, "pdf/text-24-pages.pdf"),
        byte_size: fs.statSync(path.join(FIXTURES, "pdf/text-24-pages.pdf")).size,
        signal: ac.signal,
        onChild: (c) => {
          spawned += 1;
          c.once("close", () => {
            closes += 1;
          });
          c.once("spawn", () => ac.abort());
        },
      });
      // Every spawned child's `close` event was observed before the extractor settled.
      expect(spawned).toBeGreaterThanOrEqual(1);
      expect(closes).toBe(spawned);
      expect(result.status).toBe("failed");
      expect(result.coverage.label).toMatch(/cancelled/);
      expect(result.extractedText).toBeNull();
    },
  );

  it.skipIf(!caps.media_metadata_probe)(
    "aborting after ffprobe has started kills and awaits it, and the inherited blob descriptor is released (requires ffprobe)",
    async () => {
      const file = path.join(FIXTURES, "media/valid-clip.mp4");
      const ac = new AbortController();
      let fd = -1;
      let closed = false;
      const result = await probeMedia({
        blob_path: file,
        sniffed_mime: "video/mp4",
        byte_size: fs.statSync(file).size,
        signal: ac.signal,
        onBlobFd: (n) => {
          fd = n;
        },
        onChild: (c: ChildProcess) => {
          c.once("close", () => {
            closed = true;
          });
          c.once("spawn", () => ac.abort());
        },
      });
      expect(result.aborted).toBe(true);
      expect(result.normalized_mime).toBeNull();
      expect(closed).toBe(true); // `close` observed before probeMedia settled
      expect(fd).toBeGreaterThan(2);
      expect(() => fs.fstatSync(fd)).toThrowError(/EBADF/);
    },
  );
});

describe("PPTX slides sort numerically", () => {
  it("slide10, slide2, slide1 in central-directory order read as 1, 2, 10", async () => {
    const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
    const slide = (t: string) => Buffer.from(`<p:sld xmlns:p="urn:p" ${A}><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`);
    const zip = buildZip([
      { name: "ppt/slides/slide10.xml", data: slide("SLIDE_TEN") },
      { name: "ppt/slides/slide2.xml", data: slide("SLIDE_TWO") },
      { name: "ppt/slides/slide1.xml", data: slide("SLIDE_ONE") },
    ]);
    const r = await extractFile(writeTemp("order.pptx", zip));
    const t = r.extractedText!;
    expect(t.indexOf("SLIDE_ONE")).toBeLessThan(t.indexOf("SLIDE_TWO"));
    expect(t.indexOf("SLIDE_TWO")).toBeLessThan(t.indexOf("SLIDE_TEN"));
  });
});

describe("external entity refusal (sentinel created at test time)", () => {
  it("is refused with the DTD/entity reason and the sentinel next to it is never read", async () => {
    const dir = tmp();
    const target = path.join(dir, "external-entity.docx");
    fs.copyFileSync(path.join(FIXTURES, "office/external-entity.docx"), target);
    // The fixture's SYSTEM identifier is the relative name `xxe-sentinel.txt`:
    // create it where a resolver working from the document's directory would
    // find it, so a regression that reads entities could actually surface it.
    fs.writeFileSync(path.join(dir, "xxe-sentinel.txt"), "XXE_SENTINEL_MUST_NOT_APPEAR");
    const r = await extractFile(target);
    expect(r.status).toBe("unsupported");
    expect(r.coverage.label).toMatch(/DTD or entity/);
    expect(JSON.stringify(r)).not.toContain("XXE_SENTINEL_MUST_NOT_APPEAR");
    expect(r.extractedText).toBeNull();
  });
});


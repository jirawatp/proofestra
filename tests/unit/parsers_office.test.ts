// Direct, in-process tests of the pure Office extractor (`extractOfficeTextSync`).
//
// These call the parser on the test thread so V8 coverage can see it. They are
// ADDITIONAL to the real worker_threads tests in
// tests/integration/content_parsers.test.ts and are NOT child-worker coverage.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  extractOfficeTextSync,
  isMacroOrTemplateVariant,
  officeKindFromName,
  type OfficeKind,
} from "../../src/core/parsers/office.js";
import { buildZip, type BuildEntry } from "./_zipBuilder.js";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures/content/office");

const NS_WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const NS_DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_SHEET = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_ODF_TEXT = "urn:oasis:names:tc:opendocument:xmlns:text:1.0";

let tmpDir: string;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proofestra-office-unit-"));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});

let counter = 0;
function writeTmp(data: Buffer): string {
  counter += 1;
  const p = path.join(tmpDir, `blob-${counter}`);
  fs.writeFileSync(p, data);
  return p;
}

function extractZip(kind: OfficeKind, entries: BuildEntry[], macro = false) {
  const data = buildZip(entries);
  return extractOfficeTextSync({
    blob_path: writeTmp(data),
    byte_size: data.length,
    office_kind: kind,
    ...(macro ? { macro_variant: true } : {}),
  });
}

function extractFixtureFile(kind: OfficeKind, rel: string) {
  const p = path.join(FIXTURES, rel);
  return extractOfficeTextSync({ blob_path: p, byte_size: fs.statSync(p).size, office_kind: kind });
}

const xml = (s: string): Buffer => Buffer.from(s, "utf8");
const wDoc = (body: string): Buffer =>
  xml(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${NS_WORD}"><w:body>${body}</w:body></w:document>`);
const wPart = (root: string, body: string): Buffer => xml(`<w:${root} xmlns:w="${NS_WORD}">${body}</w:${root}>`);
const para = (t: string): string => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
const sst = (inner: string): Buffer => xml(`<sst xmlns="${NS_SHEET}">${inner}</sst>`);
const sheet = (rows: string): Buffer =>
  xml(`<worksheet xmlns="${NS_SHEET}"><sheetData>${rows}</sheetData></worksheet>`);
const odfContent = (inner: string): Buffer =>
  xml(
    `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="${NS_ODF_TEXT}"><office:body><office:text>${inner}</office:text></office:body></office:document-content>`,
  );

describe("officeKindFromName / isMacroOrTemplateVariant", () => {
  it("maps every supported extension (case-insensitive) to its kind and others to null", () => {
    const table: Array<[string, OfficeKind | null]> = [
      ["a.docx", "docx"], ["a.DOCM", "docx"], ["a.dotx", "docx"], ["a.dotm", "docx"],
      ["a.xlsx", "xlsx"], ["a.xlsm", "xlsx"], ["a.xltx", "xlsx"], ["A.XLTM", "xlsx"],
      ["a.pptx", "pptx"], ["a.pptm", "pptx"], ["a.potx", "pptx"], ["a.potm", "pptx"],
      ["a.ppsx", "pptx"], ["a.ppsm", "pptx"],
      ["a.odt", "odt"], ["a.ODS", "ods"], ["a.odp", "odp"],
      ["a.zip", null], ["a.txt", null], ["docx", null], ["a.docx.bak", null], ["a.doc", null],
    ];
    for (const [name, kind] of table) expect(officeKindFromName(name), name).toBe(kind);
  });

  it("flags only macro-enabled and template OOXML names", () => {
    for (const n of ["a.docm", "a.dotx", "a.DOTM", "a.xlsm", "a.xltx", "a.xltm", "a.pptm", "a.potx", "a.potm", "a.ppsx", "a.ppsm"]) {
      expect(isMacroOrTemplateVariant(n), n).toBe(true);
    }
    for (const n of ["a.docx", "a.xlsx", "a.pptx", "a.odt", "a.zip", "docm"]) {
      expect(isMacroOrTemplateVariant(n), n).toBe(false);
    }
  });
});

describe("real Office fixtures, parsed in-process", () => {
  it("DOCX fixture yields body, table, Thai text and tab/break/header content", () => {
    const r = extractFixtureFile("docx", "proofestra-content.docx");
    expect(r.status).toBe("text_extracted");
    expect(r.coverage.truncated).toBe(false);
    expect(r.coverage.label).toBe(`DOCX text (${r.extractedText!.length} chars)`);
    expect(r.coverage.extracted_chars).toBe(r.extractedText!.length);
    for (const m of [
      "PROOFESTRA_DOCX_BODY_ORCHID_42",
      "สวัสดี เอกสารทดสอบภาษาไทย",
      "PROOFESTRA_DOCX_TABLE_CELL",
      "PROOFESTRA_DOCX_TAB_LEFT\tPROOFESTRA_DOCX_TAB_RIGHT",
    ]) {
      expect(r.extractedText).toContain(m);
    }
    // A hard line break separates the text on both sides.
    expect(r.extractedText).toMatch(/\nPROOFESTRA_DOCX_AFTER_BREAK/);
  });

  it("namespace variant (doc: prefix) is matched by namespace URI, not prefix", () => {
    const r = extractFixtureFile("docx", "namespace-variant.docx");
    expect(r.status).toBe("text_extracted");
    expect(r.extractedText).toContain("PROOFESTRA_DOCX_BODY_ORCHID_42");
    expect(r.extractedText).toContain("สวัสดี เอกสารทดสอบภาษาไทย");
  });

  it("entity-declaration and external-entity DOCX are refused whole, with no content", () => {
    for (const f of ["entity-declaration.docx", "external-entity.docx"]) {
      const r = extractFixtureFile("docx", f);
      expect(r.status, f).toBe("unsupported");
      expect(r.extractedText).toBeNull();
      expect(r.coverage).toEqual({
        extracted_chars: 0,
        truncated: false,
        label: "DOCX refused: XML DTD or entity declarations are not processed",
      });
    }
  });

  it("XLSX fixture: shared + inline strings and cached values, never the formula text", () => {
    const r = extractFixtureFile("xlsx", "proofestra-content.xlsx");
    expect(r.status).toBe("text_extracted");
    expect(r.coverage.label).toContain("cached values, formulas not evaluated");
    for (const m of ["PROOFESTRA_XLSX_SHARED_ORCHID_42", "PROOFESTRA_XLSX_INLINE_TEXT", "สวัสดี ตารางทดสอบภาษาไทย", "Apples", "Pears"]) {
      expect(r.extractedText).toContain(m);
    }
    expect(r.extractedText).not.toMatch(/SUM\(/);
  });

  it("large XLSX fixture truncates at the character cap and does not claim full coverage", () => {
    const r = extractFixtureFile("xlsx", "large-sheet.xlsx");
    expect(r.status).toBe("truncated");
    expect(r.coverage.truncated).toBe(true);
    expect(r.extractedText!.length).toBeLessThanOrEqual(24_000);
    expect(r.coverage.label).toContain("truncated at 24000 chars");
    expect(r.extractedText).toContain("PROOFESTRA_XLSX_SHARED_ORCHID_42");
    expect(r.extractedText).not.toContain("PROOFESTRA_XLSX_TAIL_BEYOND_TEXT_LIMIT");
  });

  it("PPTX fixture reads slides in order, then notes", () => {
    const r = extractFixtureFile("pptx", "proofestra-content.pptx");
    expect(r.status).toBe("text_extracted");
    const t = r.extractedText!;
    expect(t.indexOf("PROOFESTRA_PPTX_SLIDE_ONE_ORCHID_42")).toBeGreaterThanOrEqual(0);
    expect(t.indexOf("PROOFESTRA_PPTX_SLIDE_ONE_ORCHID_42")).toBeLessThan(t.indexOf("PROOFESTRA_PPTX_SLIDE_TWO_BLUE_17"));
    expect(t.indexOf("PROOFESTRA_PPTX_NOTES_OPTIONAL")).toBeGreaterThan(t.indexOf("PROOFESTRA_PPTX_SLIDE_TWO_BLUE_17"));
    expect(t).toContain("สวัสดี สไลด์ทดสอบภาษาไทย");
  });

  it("ODT fixture yields heading, table cell and Thai text", () => {
    const r = extractFixtureFile("odt", "proofestra-content.odt");
    expect(r.status).toBe("text_extracted");
    expect(r.coverage.label).toMatch(/^ODT text \(\d+ chars\)$/);
    for (const m of ["PROOFESTRA_ODT_HEADING_ORCHID_42", "สวัสดี เอกสารโอดีทีภาษาไทย", "PROOFESTRA_ODT_TABLE_CELL"]) {
      expect(r.extractedText).toContain(m);
    }
  });
});

describe("DOCX parts", () => {
  it("emits paragraphs, tabs, breaks, entities and CDATA; ignores non-text elements; orders header/footer numerically", () => {
    const r = extractZip("docx", [
      { name: "word/footnotes.xml", data: wPart("footnotes", para("FOOTNOTE")) },
      { name: "word/endnotes.xml", data: wPart("endnotes", para("ENDNOTE")) },
      { name: "word/footer1.xml", data: wPart("ftr", para("FOOTER")) },
      { name: "word/header10.xml", data: wPart("hdr", para("HEADER10")) },
      { name: "word/header2.xml", data: wPart("hdr", para("HEADER2")) },
      {
        name: "word/document.xml",
        data: wDoc(
          `<w:p><w:r><w:t>Hello</w:t><w:tab/><w:t>World &amp; &lt;x&gt; &quot;q&quot; &apos;a&apos;</w:t></w:r></w:p>` +
            `<w:p><w:r><w:t>A</w:t><w:br/><w:t>B</w:t><w:cr/><w:t>C</w:t></w:r></w:p>` +
            `<w:p><w:r><w:instrText>FIELD_CODE_IGNORED</w:instrText><w:t><![CDATA[c<d&amp;]]></w:t></w:r></w:p>` +
            `<!-- comment ignored --><?pi ignored?>`,
        ),
      },
      { name: "word/media/image1.png", data: Buffer.from("PNG_IGNORED") },
    ]);
    expect(r.status).toBe("text_extracted");
    expect(r.extractedText).toBe(
      "Hello\tWorld & <x> \"q\" 'a'\nA\nB\nC\nc<d&amp;\nHEADER2\nHEADER10\nFOOTER\nFOOTNOTE\nENDNOTE",
    );
    expect(r.coverage).toEqual({
      extracted_chars: r.extractedText!.length,
      truncated: false,
      label: `DOCX text (${r.extractedText!.length} chars)`,
    });
  });

  it("macro_variant adds the not-executed note and macro parts are never read", () => {
    const entries: BuildEntry[] = [
      { name: "word/document.xml", data: wDoc(para("BODY")) },
      { name: "word/vbaProject.bin", data: Buffer.from("VBA_SECRET") },
    ];
    const macro = extractZip("docx", entries, true);
    expect(macro.coverage.label).toBe("DOCX text (4 chars; macros not executed)");
    expect(JSON.stringify(macro)).not.toContain("VBA_SECRET");
    expect(extractZip("docx", entries, false).coverage.label).toBe("DOCX text (4 chars)");
  });

  it("text outside <w:t>, and DOCX parts under another namespace, is not extracted", () => {
    const r = extractZip("docx", [
      {
        name: "word/document.xml",
        data: xml(
          `<w:document xmlns:w="${NS_WORD}" xmlns:o="urn:other"><w:body>loose text<o:p><o:t>OTHER_NS</o:t></o:p>${para("KEPT")}</w:body></w:document>`,
        ),
      },
    ]);
    expect(r.extractedText).toBe("KEPT");
  });
});

describe("XLSX parts", () => {
  const shared = sst(
    `<si><t>Alpha</t></si>` +
      `<si><r><t>Be</t></r><r><t>ta</t></r><rPh sb="0" eb="1"><t>PHONETIC_SKIPPED</t></rPh></si>` +
      `<si><t>ガンマ &amp; &lt;g&gt;</t><rPh sb="0" eb="1"><t>ghost</t></rPh></si>`,
  );

  it("renders shared, inline, boolean, numeric, error and cached formula values; skips phonetics and formula text", () => {
    const r = extractZip("xlsx", [
      { name: "xl/worksheets/sheet10.xml", data: sheet(`<row><c t="inlineStr"><is><t>SHEET10</t></is></c></row>`) },
      {
        name: "xl/worksheets/sheet2.xml",
        data: sheet(
          `<row r="1">` +
            `<c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1"><v>42</v></c>` +
            `<c r="D1" t="b"><v>1</v></c><c r="E1" t="b"><v>0</v></c>` +
            `</row>` +
            `<row r="2">` +
            `<c t="inlineStr"><is><t>Inline</t><rPh><t>NOPE</t></rPh></is></c>` +
            `<c t="str"><f>SUM(A1:B1)</f><v>cached 7</v></c>` +
            `<c><f>1+1</f><v>2</v></c>` +
            `<c t="e"><v>#DIV/0!</v></c>` +
            `<c r="F2"/>` +
            `<c t="s"><v>2</v></c>` +
            `<c t="s"><v>99</v></c>` +
            `</row>` +
            `<row r="3"><c t="s"><v>not-a-number</v></c></row>`,
        ),
      },
      { name: "xl/sharedStrings.xml", data: shared },
    ]);
    expect(r.status).toBe("text_extracted");
    expect(r.extractedText).toBe(
      "Alpha\tBeta\t42\tTRUE\tFALSE\nInline\tcached 7\t2\t#DIV/0!\tガンマ & <g>\nSHEET10",
    );
    expect(r.extractedText).not.toMatch(/SUM|1\+1|PHONETIC|ghost|NOPE/);
    expect(r.coverage.label).toBe(
      `XLSX text (${r.extractedText!.length} chars; cached values, formulas not evaluated)`,
    );
  });

  it("macro-enabled XLSX carries both the macro and cached-values notes", () => {
    const r = extractZip(
      "xlsx",
      [{ name: "xl/worksheets/sheet1.xml", data: sheet(`<row><c><v>5</v></c></row>`) }],
      true,
    );
    expect(r.coverage.label).toBe("XLSX text (1 chars; macros not executed; cached values, formulas not evaluated)");
  });

  it("a sheet without shared strings still yields numbers; an empty sheet is unsupported", () => {
    const ok = extractZip("xlsx", [{ name: "xl/worksheets/sheet1.xml", data: sheet(`<row><c><v> 3.5 </v></c></row>`) }]);
    expect(ok.extractedText).toBe("3.5");
    const empty = extractZip("xlsx", [{ name: "xl/worksheets/sheet1.xml", data: sheet(`<row><c/></row>`) }]);
    expect(empty.status).toBe("unsupported");
    expect(empty.coverage.label).toBe("XLSX: no extractable text (likely image-only)");
  });
});

describe("XLSX shared-string limits are reported as partial coverage", () => {
  const sheetFor = (...indexes: number[]): BuildEntry => ({
    name: "xl/worksheets/sheet1.xml",
    data: sheet(`<row>${indexes.map((i) => `<c t="s"><v>${i}</v></c>`).join("")}</row>`),
  });
  // Stored (method 0) so the synthetic repeated content is not refused by the
  // 100x compression-ratio guard.
  const stored = (name: string, data: Buffer): BuildEntry => ({ name, data, method: 0 });

  it("more than 200000 shared strings: a cell on a dropped index makes the result truncated, not text_extracted", () => {
    const MAX = 200_000;
    const items = "<si><t>s</t></si>".repeat(MAX) + "<si><t>DROPPED_TAIL</t></si>";
    const r = extractZip("xlsx", [stored("xl/sharedStrings.xml", sst(items)), sheetFor(0, MAX)]);
    expect(r.extractedText).toBe("s");
    expect(r.extractedText).not.toContain("DROPPED_TAIL");
    expect(r.status).toBe("truncated");
    expect(r.coverage.truncated).toBe(true);
    expect(r.coverage.label).toMatch(/shared-string limit.*cached text omitted/);
  });

  it("an 8 MiB shared-string character budget: strings beyond it are partial and flagged", () => {
    const big = "b".repeat(8 * 1024 * 1024);
    const items = `<si><t>head</t></si><si><t>${big}</t></si><si><t>tail</t></si>`;
    const entries = [stored("xl/sharedStrings.xml", sst(items))];
    const partial = extractZip("xlsx", [...entries, sheetFor(0, 2)]);
    expect(partial.extractedText).toBe("head");
    expect(partial.status).toBe("truncated");
    expect(partial.coverage.truncated).toBe(true);
    expect(partial.coverage.label).toMatch(/shared-string limit.*cached text omitted/);
    // The partially cut string itself is also flagged.
    const cut = extractZip("xlsx", [...entries, sheetFor(0, 1)]);
    expect(cut.status).toBe("truncated");
  });

  it("no false alarm: referencing only strings before the cap stays text_extracted", () => {
    const MAX = 200_000;
    const items = "<si><t>s</t></si>".repeat(MAX) + "<si><t>unreferenced</t></si>";
    const r = extractZip("xlsx", [stored("xl/sharedStrings.xml", sst(items)), sheetFor(0, 1, MAX - 1)]);
    expect(r.extractedText).toBe("s\ts\ts");
    expect(r.status).toBe("text_extracted");
    expect(r.coverage.truncated).toBe(false);
  });
});

describe("XLSX structure tolerance", () => {
  it("pretty-printed XML and foreign-namespace elements (in sharedStrings and sheets) are ignored, not emitted", () => {
    const shared = xml(
      `<?xml version="1.0"?>\n<sst xmlns="${NS_SHEET}" xmlns:x="urn:foreign">\n  <x:si><x:t>FOREIGN_SI</x:t></x:si>\n  <si>\n    <t>Real</t>\n    <x:ext>FOREIGN_EXT</x:ext>\n  </si>\n</sst>`,
    );
    const sheetXml = xml(
      `<worksheet xmlns="${NS_SHEET}" xmlns:x="urn:foreign">\n  <sheetData>\n    <row r="1">\n      <c t="s">\n        <v>0</v>\n        <x:v>FOREIGN_V</x:v>\n      </c>\n      <x:c><x:v>FOREIGN_CELL</x:v></x:c>\n    </row>\n  </sheetData>\n</worksheet>`,
    );
    const r = extractZip("xlsx", [
      { name: "xl/sharedStrings.xml", data: shared },
      { name: "xl/worksheets/sheet1.xml", data: sheetXml },
    ]);
    expect(r.extractedText).toBe("Real");
    expect(r.status).toBe("text_extracted");
  });
});

describe("text cap boundaries", () => {
  it("a paragraph that exactly fills the cap followed by more text keeps the cap's worth and reports truncation", () => {
    const r = extractZip("docx", [
      {
        name: "word/document.xml",
        data: wDoc(para("a".repeat(24_000)) + para("LOST_AFTER_CAP")),
        method: 0,
      },
    ]);
    expect(r.extractedText === "a".repeat(24_000)).toBe(true);
    expect(r.status).toBe("truncated");
    expect(r.coverage.truncated).toBe(true);
    expect(r.extractedText).not.toContain("LOST_AFTER_CAP");
  });

  it("empty CDATA and empty text nodes contribute nothing and do not disturb neighbours", () => {
    const r = extractZip("docx", [
      { name: "word/document.xml", data: wDoc(`<w:p><w:r><w:t><![CDATA[]]></w:t><w:t>kept</w:t></w:r></w:p>`) },
    ]);
    expect(r.extractedText).toBe("kept");
  });
});

describe("PPTX parts", () => {
  const slide = (t: string, extra = ""): Buffer =>
    xml(
      `<p:sld xmlns:p="urn:p" xmlns:a="${NS_DRAWING}"><a:p><a:r><a:t>${t}</a:t></a:r>${extra}</a:p></p:sld>`,
    );

  it("orders slides numerically, then notes; breaks split lines; ignores non-drawing namespaces", () => {
    const r = extractZip("pptx", [
      { name: "ppt/notesSlides/notesSlide1.xml", data: slide("NOTE1") },
      { name: "ppt/slides/slide10.xml", data: slide("SLIDE10") },
      { name: "ppt/slides/slide2.xml", data: slide("SLIDE2", `<a:br/><a:r><a:t>AFTER_BREAK</a:t></a:r>`) },
      {
        name: "ppt/slides/slide1.xml",
        data: xml(`<p:sld xmlns:p="urn:p" xmlns:a="${NS_DRAWING}"><p:t>NOT_DRAWING</p:t><a:p><a:r><a:t>SLIDE1</a:t></a:r></a:p></p:sld>`),
      },
    ]);
    expect(r.status).toBe("text_extracted");
    expect(r.extractedText).toBe("SLIDE1\nSLIDE2\nAFTER_BREAK\nSLIDE10\nNOTE1");
    expect(r.coverage.label).toBe(`PPTX text (${r.extractedText!.length} chars)`);
  });
});

describe("ODF parts", () => {
  const body =
    `<text:h>Title</text:h>` +
    `<text:p>a<text:tab/>b<text:line-break/>c<text:s/>d<text:span>e</text:span></text:p>` +
    `<text:tab/>OUTSIDE<text:p/>`;

  for (const kind of ["odt", "ods", "odp"] as const) {
    it(`${kind}: tab, line-break and space elements and entities inside paragraphs/headings`, () => {
      const r = extractZip(kind, [
        { name: "mimetype", data: Buffer.from("application/vnd.oasis.opendocument.text"), method: 0 },
        { name: "content.xml", data: odfContent(body.replace("Title", "Title &amp; &lt;t&gt;")) },
      ]);
      expect(r.status).toBe("text_extracted");
      expect(r.extractedText).toBe("Title & <t>\na\tb\nc de");
      expect(r.coverage.label).toBe(`${kind.toUpperCase()} text (${r.extractedText!.length} chars)`);
    });
  }

  it("ignores paragraph-like elements from other namespaces", () => {
    const r = extractZip("odt", [
      { name: "content.xml", data: xml(`<r xmlns:t="urn:not-odf"><t:p>NOT_TEXT</t:p></r>`) },
    ]);
    expect(r.status).toBe("unsupported");
  });
});

describe("failure and refusal paths", () => {
  it("an unreadable blob path fails with a kind-specific label", () => {
    const r = extractOfficeTextSync({ blob_path: path.join(tmpDir, "does-not-exist"), byte_size: 1, office_kind: "pptx" });
    expect(r).toEqual({
      status: "failed",
      coverage: { extracted_chars: 0, truncated: false, label: "PPTX could not be read" },
      extractedText: null,
    });
  });

  it("a valid ZIP without the kind's text parts is unsupported with a clear label", () => {
    const r = extractZip("docx", [{ name: "xl/worksheets/sheet1.xml", data: sheet("") }]);
    expect(r.status).toBe("unsupported");
    expect(r.coverage.label).toBe("DOCX contains no recognized text parts");
    expect(r.extractedText).toBeNull();
    expect(extractZip("odt", [{ name: "other.xml", data: xml("<a/>") }]).coverage.label).toBe(
      "ODT contains no recognized text parts",
    );
  });

  it("a document with only empty paragraphs reports no extractable text", () => {
    const r = extractZip("docx", [{ name: "word/document.xml", data: wDoc(`<w:p><w:r/></w:p><w:p/>`) }]);
    expect(r.status).toBe("unsupported");
    expect(r.coverage.label).toBe("DOCX: no extractable text (likely image-only)");
  });

  it("an oversized part is skipped, the rest is kept, and the result is flagged truncated", () => {
    // Declared 33 MiB (>32 MiB entry cap) in a 400 KB stored entry: the ratio
    // guard passes and the part is skipped before any read or inflate.
    const huge: BuildEntry = {
      name: "word/footnotes.xml",
      data: Buffer.alloc(400 * 1024, 0x20),
      method: 0,
      centralUncompressed: 33 * 1024 * 1024,
    };
    const r = extractZip("docx", [{ name: "word/document.xml", data: wDoc(para("KEPT_BODY")) }, huge]);
    expect(r.status).toBe("truncated");
    expect(r.extractedText).toBe("KEPT_BODY");
    expect(r.coverage.truncated).toBe(true);
    expect(r.coverage.label).toContain("oversized part not read");
  });

  it("the character cap truncates, never splits a surrogate pair, and later parts are not read", () => {
    const text = "a".repeat(23_999) + "😀tail";
    const r = extractZip("docx", [
      // Stored: highly repetitive text would trip the 100x ratio guard.
      { name: "word/document.xml", data: wDoc(para(text)), method: 0 },
      { name: "word/footnotes.xml", data: wPart("footnotes", para("NEVER_READ_FOOTNOTE")) },
    ]);
    expect(r.status).toBe("truncated");
    expect(r.coverage.truncated).toBe(true);
    expect(r.extractedText!.length).toBe(23_999);
    expect(r.extractedText === "a".repeat(23_999)).toBe(true);
    expect(r.coverage.label).toBe("DOCX text (truncated at 24000 chars)");
    expect(/[\ud800-\udbff]$/.test(r.extractedText!)).toBe(false);
    expect(r.extractedText).not.toContain("NEVER_READ_FOOTNOTE");
  });

  it("a cap that falls on a BMP boundary keeps every unit; truncation at exactly the cap", () => {
    const r = extractZip("docx", [{ name: "word/document.xml", data: wDoc(para("b".repeat(30_000))), method: 0 }]);
    expect(r.extractedText === "b".repeat(24_000)).toBe(true);
    expect(r.status).toBe("truncated");
  });

  describe("XML encoding refusals", () => {
    const docRefusal = (data: Buffer) => extractZip("docx", [{ name: "word/document.xml", data }]);
    const expectNotUtf8 = (r: ReturnType<typeof docRefusal>) => {
      expect(r.status).toBe("unsupported");
      expect(r.extractedText).toBeNull();
      expect(r.coverage.label).toBe("DOCX refused: XML part is not UTF-8");
    };

    it("UTF-16LE and UTF-16BE BOMs are refused", () => {
      expectNotUtf8(docRefusal(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`<w:document xmlns:w="${NS_WORD}"/>`, "utf16le")])));
      expectNotUtf8(docRefusal(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("<a/>", "utf16le").swap16()])));
    });

    it("a NUL in the first four bytes (BOM-less UTF-16) is refused", () => {
      expectNotUtf8(docRefusal(Buffer.from("<\u0000w\u0000", "latin1")));
    });

    it("an XML declaration naming another encoding is refused; utf-8 spellings and a UTF-8 BOM are accepted", () => {
      const withDecl = (decl: string): Buffer => xml(`${decl}<w:document xmlns:w="${NS_WORD}"><w:body>${para("OK")}</w:body></w:document>`);
      expectNotUtf8(docRefusal(withDecl(`<?xml version="1.0" encoding="ISO-8859-1"?>`)));
      expectNotUtf8(docRefusal(withDecl(`<?xml version='1.0' encoding='utf-16'?>`)));
      for (const decl of [`<?xml version="1.0" encoding="UTF-8"?>`, `<?xml version="1.0" encoding='utf8'?>`, `<?xml version="1.0"?>`]) {
        expect(docRefusal(withDecl(decl)).extractedText, decl).toBe("OK");
      }
      const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), withDecl(`<?xml version="1.0"?>`)]);
      expect(docRefusal(bom).extractedText).toBe("OK");
    });

    it("invalid UTF-8 bytes are refused rather than replaced", () => {
      const bad = Buffer.concat([Buffer.from(`<w:document xmlns:w="${NS_WORD}"><w:body><w:p><w:r><w:t>`), Buffer.from([0xc3, 0x28]), Buffer.from("</w:t></w:r></w:p></w:body></w:document>")]);
      expectNotUtf8(docRefusal(bad));
    });

    it("the same refusals apply to the XLSX shared-strings part", () => {
      const r = extractZip("xlsx", [
        { name: "xl/sharedStrings.xml", data: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("<sst/>", "utf16le")]) },
        { name: "xl/worksheets/sheet1.xml", data: sheet(`<row><c><v>1</v></c></row>`) },
      ]);
      expect(r.coverage.label).toBe("XLSX refused: XML part is not UTF-8");
    });
  });

  describe("DTD / ENTITY refusal", () => {
    it("any case of <!DOCTYPE or <!ENTITY refuses the whole document", () => {
      for (const decl of [
        `<!DOCTYPE w:document>`,
        `<!doctype x [<!entity e "v">]>`,
        `<!ENTITY e SYSTEM "file:///etc/passwd">`,
      ]) {
        const r = extractZip("docx", [
          { name: "word/document.xml", data: xml(`${decl}<w:document xmlns:w="${NS_WORD}"><w:body>${para("&e;")}</w:body></w:document>`) },
        ]);
        expect(r.status, decl).toBe("unsupported");
        expect(r.coverage.label).toBe("DOCX refused: XML DTD or entity declarations are not processed");
        expect(JSON.stringify(r)).not.toContain("passwd");
      }
    });

    it("a DTD in a later part still refuses everything extracted so far", () => {
      const r = extractZip("docx", [
        { name: "word/document.xml", data: wDoc(para("FIRST_PART")) },
        { name: "word/footnotes.xml", data: xml(`<!DOCTYPE f><w:footnotes xmlns:w="${NS_WORD}"/>`) },
      ]);
      expect(r.status).toBe("unsupported");
      expect(r.extractedText).toBeNull();
      expect(JSON.stringify(r)).not.toContain("FIRST_PART");
    });

    it("a DTD in sharedStrings refuses the XLSX", () => {
      const r = extractZip("xlsx", [
        { name: "xl/sharedStrings.xml", data: xml(`<!DOCTYPE sst><sst xmlns="${NS_SHEET}"/>`) },
        { name: "xl/worksheets/sheet1.xml", data: sheet(`<row><c><v>1</v></c></row>`) },
      ]);
      expect(r.coverage.label).toMatch(/^XLSX refused: XML DTD/);
    });
  });

  it("XML nesting over the depth cap or a tag over 64 KiB makes the document unsupported", () => {
    const deep = extractZip("docx", [
      { name: "word/document.xml", data: xml(`<w:document xmlns:w="${NS_WORD}">${"<w:p>".repeat(300)}</w:document>`), method: 0 },
    ]);
    expect(deep).toEqual({
      status: "unsupported",
      coverage: { extracted_chars: 0, truncated: false, label: "DOCX refused: XML nesting or tag too large" },
      extractedText: null,
    });
    const wide = extractZip("odt", [
      { name: "content.xml", data: xml(`<text:p xmlns:text="${NS_ODF_TEXT}" ${"x".repeat(70_000)}>t</text:p>`), method: 0 },
    ]);
    expect(wide.status).toBe("unsupported");
    expect(wide.coverage.label).toBe("ODT refused: XML nesting or tag too large");
  });

  describe("ZIP-level rejections", () => {
    it("an encrypted entry yields status encrypted with the code in the label", () => {
      const r = extractZip("docx", [{ name: "word/document.xml", data: wDoc(para("x")), flags: 1 }]);
      expect(r.status).toBe("encrypted");
      expect(r.extractedText).toBeNull();
      expect(r.coverage.label).toBe("DOCX rejected (encrypted): encrypted entries are not supported");
    });

    it("other hostile archives fail with their code and a fixed path-free reason", () => {
      const doc = wDoc(para("x"));
      const crc = extractZip("docx", [{ name: "word/document.xml", data: doc, centralCrc: 7, localCrc: 7 }]);
      expect(crc.status).toBe("failed");
      expect(crc.coverage.label).toBe("DOCX rejected (crc_mismatch): an entry failed its CRC-32 check");
      const trav = extractZip("xlsx", [{ name: "../evil.xml", data: doc }]);
      expect(trav.coverage.label).toBe("XLSX rejected (traversal): an entry name tries to leave the archive directory");
      const trunc = extractOfficeTextSync({ blob_path: writeTmp(Buffer.from("PK\u0003\u0004 not a zip at all, but long enough")), byte_size: 40, office_kind: "odp" });
      expect(trunc.status).toBe("failed");
      expect(trunc.coverage.label).toBe("ODP rejected (truncated): the archive is truncated or malformed");
    });

    it("a corrupt deflate stream inside a wanted part is reported as corrupt_entry", () => {
      const data = buildZip([{ name: "word/document.xml", data: wDoc(para("x".repeat(50))) }]);
      const dataStart = 30 + "word/document.xml".length;
      data.fill(0xff, dataStart, dataStart + 6);
      const r = extractOfficeTextSync({ blob_path: writeTmp(data), byte_size: data.length, office_kind: "docx" });
      expect(r.status).toBe("failed");
      expect(r.coverage.label).toContain("(corrupt_entry)");
    });

    it("an unexpected non-validation error becomes a generic failure with no detail leaked", () => {
      const spy = vi.spyOn(fs, "readFileSync").mockReturnValue("SECRET_PATH_DETAIL".repeat(5) as never);
      const r = extractOfficeTextSync({ blob_path: "/irrelevant", byte_size: 1, office_kind: "docx" });
      expect(spy).toHaveBeenCalledOnce();
      expect(r).toEqual({
        status: "failed",
        coverage: { extracted_chars: 0, truncated: false, label: "DOCX extraction failed" },
        extractedText: null,
      });
    });
  });
});

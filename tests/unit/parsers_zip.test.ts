// Direct, in-process tests of the pure ZIP extractor (`extractZipArchiveSync`).
//
// These call the parser on the test thread so V8 coverage can see it. They are
// ADDITIONAL to the real worker_threads tests in
// tests/integration/content_parsers.test.ts and are NOT child-worker coverage.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { extractZipArchiveSync, ZIP_TEXT_EXTENSIONS } from "../../src/core/parsers/zip.js";
import { buildZip, type BuildEntry } from "./_zipBuilder.js";

const ZIP_FIXTURES = path.resolve(import.meta.dirname, "../fixtures/content/zip");

let tmpDir: string;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proofestra-zip-unit-"));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});

let counter = 0;
function extractData(data: Buffer) {
  counter += 1;
  const p = path.join(tmpDir, `blob-${counter}`);
  fs.writeFileSync(p, data);
  return extractZipArchiveSync({ blob_path: p, byte_size: data.length });
}
const extract = (entries: BuildEntry[]) => extractData(buildZip(entries));
const txt = (name: string, text: string | Buffer, method: 0 | 8 = 8): BuildEntry => ({
  name,
  data: Buffer.isBuffer(text) ? text : Buffer.from(text),
  method,
});

describe("ZIP inventory and text entries", () => {
  it("an empty archive has status none and a precise label", () => {
    const r = extractData(fs.readFileSync(path.join(ZIP_FIXTURES, "empty.zip")));
    expect(r).toEqual({
      status: "none",
      coverage: { extracted_chars: 0, truncated: false, label: "empty ZIP (0 entries)" },
      extractedText: null,
    });
  });

  it("one supported entry: singular inventory header, entry sizes and the entry text", () => {
    const body = "hello zip\nsecond line\n";
    const r = extract([txt("notes/readme.md", body)]);
    expect(r.status).toBe("text_extracted");
    const text = r.extractedText!;
    expect(text.startsWith("ZIP archive, 1 entry (metadata only unless the entry text is shown below).")).toBe(true);
    expect(text).toMatch(/- notes\/readme\.md · \d+ B compressed · 22 B declared/);
    expect(text).toContain(`\n--- notes/readme.md (22 B) ---\n${body}`);
    expect(text).not.toContain("--- excluded ---");
    expect(r.coverage).toEqual({
      extracted_chars: text.length,
      truncated: false,
      label: "ZIP inventory + bounded text entries (1 entry, 0 excluded)",
    });
  });

  it("several entries: plural header, every text entry shown, directories and empty members skipped silently", () => {
    const r = extract([
      txt("src/", Buffer.alloc(0), 0),
      txt("src/a.py", "print('a')\n"),
      txt("src/__init__.py", Buffer.alloc(0), 0),
      txt("src/b.json", '{"k": 1}'),
    ]);
    const text = r.extractedText!;
    expect(text).toContain("ZIP archive, 4 entries");
    expect(text).toContain("--- src/a.py (11 B) ---\nprint('a')");
    expect(text).toContain("--- src/b.json (8 B) ---\n{\"k\": 1}");
    // The directory and the empty member are inventoried but never "shown" or excluded.
    expect(text).not.toContain("--- src/__init__.py");
    expect(text).not.toContain("--- excluded ---");
    expect(r.status).toBe("text_extracted");
    expect(r.coverage.label).toBe("ZIP inventory + bounded text entries (4 entries, 0 excluded)");
  });

  it("lists at most 64 entries, says how many are not listed and reports partial coverage", () => {
    const entries = Array.from({ length: 70 }, (_, i) => txt(`f${String(i).padStart(2, "0")}.txt`, `body ${i}`));
    const r = extract(entries);
    const text = r.extractedText!;
    expect(text).toContain("ZIP archive, 70 entries");
    expect(text).toContain("- f63.txt ·");
    expect(text).not.toContain("- f64.txt ·");
    expect(text).toContain("… and 6 more entries not listed.");
    expect(text).toContain("- 6 entries beyond the 64-entry inventory limit");
    // Text entries beyond the inventory window are still read (they are valid entries).
    expect(text).toContain("--- f69.txt (7 B) ---\nbody 69");
    expect(r.status).toBe("truncated");
    expect(r.coverage.truncated).toBe(true);
    expect(r.coverage.label).toBe("ZIP inventory + bounded text entries (70 entries, 1 excluded)");
  });

  it("the shipped supported-mixed fixture shows its text entries and excludes non-text members", () => {
    const r = extractData(fs.readFileSync(path.join(ZIP_FIXTURES, "supported-mixed.zip")));
    expect(["text_extracted", "truncated"]).toContain(r.status);
    expect(r.extractedText).toContain("ZIP archive, ");
    expect(r.extractedText).toMatch(/--- .+ \(\d+ B\) ---/);
  });

  it("nested archives are inventoried but never recursed or read", () => {
    const inner = buildZip([txt("secret.txt", "NESTED_SECRET")]);
    const r = extract([
      txt("inner.zip", inner, 0),
      txt("lib.jar", Buffer.from("JAR_BYTES"), 0),
      txt("doc.docx", Buffer.from("DOCX_BYTES"), 0),
      txt("archive.TAR", Buffer.from("TAR_BYTES"), 0),
      txt("ok.txt", "visible"),
    ]);
    const text = r.extractedText!;
    expect(text).not.toContain("NESTED_SECRET");
    for (const n of ["inner.zip", "lib.jar", "doc.docx", "archive.TAR"]) {
      expect(text).toContain(`- ${n} — nested archive, not recursed`);
    }
    expect(text).toContain("--- ok.txt (7 B) ---\nvisible");
    expect(r.status).toBe("truncated");
    expect(r.coverage.label).toBe("ZIP inventory + bounded text entries (5 entries, 4 excluded)");
  });

  it("an Office/ODF package renamed .zip never dumps raw XML parts, but plain text is shown", () => {
    for (const marker of ["[Content_Types].xml", "mimetype"]) {
      const r = extract([
        txt(marker, "<Types>PACKAGE_RAW_XML_MARKER</Types>"),
        txt("word/document.xml", "<w:document>DOC_XML_MARKER</w:document>"),
        txt("notes.txt", "PLAIN_NOTE_MARKER"),
      ]);
      const text = r.extractedText!;
      expect(text).toContain("--- notes.txt (17 B) ---\nPLAIN_NOTE_MARKER");
      expect(text).not.toContain("--- word/document.xml");
      expect(text).not.toContain("DOC_XML_MARKER\n");
      expect(text).toContain("- word/document.xml — Office/ODF package part, not read as raw text");
    }
    // Without the package marker the same .xml member is ordinary text.
    const plain = extract([txt("config.xml", "<c>PLAIN_XML_SHOWN</c>")]);
    expect(plain.extractedText).toContain("--- config.xml (22 B) ---\n<c>PLAIN_XML_SHOWN</c>");
  });

  it("unsupported or binary entry types are excluded and their bytes are never shown", () => {
    const r = extract([
      txt("tool.exe", "EXE_BYTES_SHOWN?"),
      txt("image.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      txt("README", "no extension"),
      txt(".hidden", "dotfile"),
      txt("trailing.", "trailing dot"),
      txt("ok.txt", "x"),
    ]);
    const text = r.extractedText!;
    expect(text).not.toContain("EXE_BYTES_SHOWN?\n");
    for (const n of ["tool.exe", "image.png", "README", ".hidden", "trailing."]) {
      expect(text).toContain(`- ${n} — unsupported or binary entry type, not read`);
    }
    expect(r.coverage.label).toContain("5 excluded");
  });

  it("a member larger than the 128 KiB per-entry cap is excluded without being read", () => {
    const r = extract([txt("big.txt", Buffer.alloc(128 * 1024 + 1, 0x61), 0), txt("small.txt", "s")]);
    const text = r.extractedText!;
    expect(text).toContain("- big.txt — exceeds the 131072-byte per-entry read cap");
    expect(text).not.toContain("--- big.txt");
    expect(text).toContain("--- small.txt (1 B) ---\ns");
    expect(r.status).toBe("truncated");
    expect(r.coverage.label).toBe("ZIP inventory + bounded text entries (2 entries, 1 excluded)");
  });

  it("a member of exactly 128 KiB is read, then limited only by the shared text budget", () => {
    const r = extract([txt("exact.txt", Buffer.alloc(128 * 1024, 0x62), 0)]);
    expect(r.extractedText).toContain("--- exact.txt (131072 B) ---\nbbbb");
    expect(r.extractedText!.length).toBe(24_000);
    expect(r.status).toBe("truncated");
    expect(r.coverage.truncated).toBe(true);
  });

  it("text that looks like a binary (NUL bytes, other formats' magic, invalid UTF-8) is excluded", () => {
    const r = extract([
      txt("nul.txt", Buffer.from("before\u0000after")),
      txt("fake.json", Buffer.from("%PDF-1.4\nnot really text")),
      txt("fake.py", Buffer.from("GIF89a-ish text")),
      txt("fake.md", Buffer.from("PK\u0003\u0004rest of an archive")),
      txt("bad-utf8.txt", Buffer.from([0x61, 0xc3, 0x28, 0x62])),
      txt("real.txt", "REAL_TEXT"),
    ]);
    const text = r.extractedText!;
    for (const n of ["nul.txt", "fake.json", "fake.py", "fake.md", "bad-utf8.txt"]) {
      expect(text).toContain(`- ${n} — content is not UTF-8 text (binary or archive bytes), not shown`);
      expect(text).not.toContain(`--- ${n} (`);
    }
    expect(text).toContain("--- real.txt (9 B) ---\nREAL_TEXT");
    expect(r.coverage.label).toContain("5 excluded");
  });

  it("control characters in entry names are shown as ? and long names are cut to 160 characters", () => {
    const longName = `${"d".repeat(200)}.txt`;
    const r = extract([txt("bad\u0001na\u007fme\n.txt", "x"), txt(longName, "y")]);
    const text = r.extractedText!;
    expect(text).toContain("- bad?na?me?.txt ·");
    expect(text).toContain("--- bad?na?me?.txt (1 B) ---");
    expect(text).not.toMatch(/[\u0001\u007f]/);
    expect(text).toContain(`- ${"d".repeat(160)} ·`);
    expect(text).not.toContain("d".repeat(161));
  });

  it("control characters inside shown text become spaces; tab, newline and CR are preserved", () => {
    const r = extract([txt("c.txt", "a\u0001b\u000bc\td\ne\r\nf\u007fg")]);
    expect(r.extractedText).toContain("--- c.txt (");
    expect(r.extractedText).toContain("a b c\td\ne\r\nf g");
  });

  it("ZIP_TEXT_EXTENSIONS contains source/text types and no archive or Office types", () => {
    for (const e of ["txt", "md", "py", "ts", "json", "yaml", "sql"]) expect(ZIP_TEXT_EXTENSIONS.has(e), e).toBe(true);
    for (const e of ["zip", "docx", "png", "exe", "pdf"]) expect(ZIP_TEXT_EXTENSIONS.has(e), e).toBe(false);
  });
});

describe("ZIP text budget (24000 characters)", () => {
  // Largest single-entry length that still fits whole, found by search so the
  // test does not hard-code inventory formatting.
  function exactFit(extra: BuildEntry[]): number {
    for (let len = 23_900; len > 0; len -= 1) {
      const r = extract([txt("a.txt", Buffer.alloc(len, 0x61), 0), ...extra]);
      // `a` fitting whole leaves exactly one exclusion (the next entry); a cut
      // `a` adds a second. (The footer itself may be cut off by the budget.)
      if (r.coverage.label.endsWith(", 1 excluded)")) return len;
    }
    throw new Error("no fit");
  }

  it("a second entry is cut at the budget, the third is excluded, nothing exceeds the cap", () => {
    const r = extract([
      txt("a.txt", Buffer.alloc(20_000, 0x61), 0),
      txt("b.txt", Buffer.alloc(20_000, 0x62), 0),
      txt("c.txt", "CCC"),
    ]);
    const text = r.extractedText!;
    expect(text.length).toBeLessThanOrEqual(24_000);
    expect(text).toContain("--- a.txt (20000 B) ---");
    expect(text).toContain("--- b.txt (20000 B) ---");
    expect(text).not.toContain("--- c.txt");
    expect(r.status).toBe("truncated");
    expect(r.coverage.truncated).toBe(true);
    expect(r.coverage.extracted_chars).toBe(text.length);
    // The footer is cut off by the very budget it reports on; the status is
    // still partial coverage even if the exclusion list did not fit.
    expect(r.coverage.label).toBe("ZIP inventory + bounded text entries (3 entries, 2 excluded)");
  });

  it("an entry that exactly fills the budget leaves no room: the next entry is excluded as exhausted", () => {
    const extra = [txt("b.txt", "B")];
    const len = exactFit(extra);
    const r = extract([txt("a.txt", Buffer.alloc(len, 0x61), 0), ...extra]);
    expect(r.extractedText!.length).toBe(24_000);
    expect(r.status).toBe("truncated");
    expect(r.coverage.label).toBe("ZIP inventory + bounded text entries (2 entries, 1 excluded)");
    expect(r.extractedText).not.toContain("--- b.txt");
  });

  it("slicing at the budget never leaves half a surrogate pair", () => {
    // The two prefixes put the cut on opposite sides of a pair, so a naive
    // slice would leave a lone surrogate for exactly one of them.
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    const lengths: number[] = [];
    for (const prefix of ["", "x"]) {
      const r = extract([txt("e.txt", Buffer.from(prefix + "😀".repeat(15_000)), 0)]);
      const text = r.extractedText!;
      expect(lone.test(text), `prefix ${JSON.stringify(prefix)}`).toBe(false);
      expect(text.length).toBeLessThanOrEqual(24_000);
      expect(r.status).toBe("truncated");
      lengths.push(text.length);
    }
    expect(lengths).toHaveLength(2);
  });
});

describe("ZIP failure paths", () => {
  it("an unreadable blob path fails with a fixed label", () => {
    const r = extractZipArchiveSync({ blob_path: path.join(tmpDir, "nope"), byte_size: 1 });
    expect(r).toEqual({
      status: "failed",
      coverage: { extracted_chars: 0, truncated: false, label: "ZIP could not be read" },
      extractedText: null,
    });
  });

  it("an encrypted entry is reported as encrypted", () => {
    const r = extract([{ name: "a.txt", data: Buffer.from("x"), flags: 1 }]);
    expect(r.status).toBe("encrypted");
    expect(r.extractedText).toBeNull();
    expect(r.coverage.label).toBe("ZIP rejected (encrypted): encrypted entries are not supported");
  });

  it("hostile archives fail with their code and a fixed, path-free reason", () => {
    const cases: Array<[string, Buffer, string]> = [
      ["traversal", buildZip([txt("../x.txt", "x")]), "an entry name tries to leave the archive directory"],
      ["absolute_path", buildZip([txt("/etc/x.txt", "x")]), "an entry name is an absolute path"],
      ["duplicate_entry", buildZip([txt("a.txt", "x"), txt("a.txt", "y")]), "duplicate entry names"],
      ["truncated", Buffer.from("PK\u0003\u0004 short garbage, not a zip but over twenty-two bytes"), "the archive is truncated or malformed"],
    ];
    for (const [code, data, reason] of cases) {
      const r = extractData(data);
      expect(r.status, code).toBe("failed");
      expect(r.coverage.label, code).toBe(`ZIP rejected (${code}): ${reason}`);
      expect(r.extractedText).toBeNull();
    }
  });

  it("a CRC failure found only while reading a shown entry fails the whole extraction", () => {
    const r = extract([
      txt("good.txt", "good"),
      { name: "bad.txt", data: Buffer.from("tampered"), method: 0, centralCrc: 1234, localCrc: 1234 },
    ]);
    expect(r.status).toBe("failed");
    expect(r.extractedText).toBeNull();
    expect(r.coverage.label).toBe("ZIP rejected (crc_mismatch): an entry failed its CRC-32 check");
  });

  it("an unexpected non-validation error becomes a generic failure with no detail leaked", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue("PATH_DETAIL_SECRET".repeat(4) as never);
    const r = extractZipArchiveSync({ blob_path: "/irrelevant", byte_size: 1 });
    expect(r).toEqual({
      status: "failed",
      coverage: { extracted_chars: 0, truncated: false, label: "ZIP extraction failed" },
      extractedText: null,
    });
  });
});

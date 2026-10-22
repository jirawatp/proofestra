// Classification logic of the PDF extractor with the Poppler pair and the
// bounded runner REPLACED by scripted fakes. These are not live Poppler tests:
// they prove how pdfinfo/pdftotext output, exit codes, timeouts and caps are
// interpreted. Real Poppler runs are in tests/integration/content_parsers.test.ts
// (skipped visibly when Poppler is absent).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoundedRunOpts, BoundedRunResult } from "../../src/core/parsers/boundedProc.js";

const poppler = { available: true };
const runner = {
  queue: [] as Array<Partial<BoundedRunResult>>,
  calls: [] as Array<{ bin: string; argv: readonly string[]; opts: BoundedRunOpts }>,
};

vi.mock("../../src/core/parsers/binaryTools.js", () => ({
  discoverPopplerPair: () =>
    poppler.available
      ? { pdfinfo: { path: "/fake/pdfinfo", version: "1" }, pdftotext: { path: "/fake/pdftotext", version: "1" } }
      : null,
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

import { extractPdfText } from "../../src/core/parsers/pdf.js";

const BLOB = "/blobs/00000000-0000-4000-8000-000000000000";
const info = (pages: string | number, encrypted = "no") => ({
  stdout: `Title:          Some title\nProducer:       test\nEncrypted:      ${encrypted}\nPages:          ${pages}\nFile size:      1 bytes\n`,
});
const go = (extra: { signal?: AbortSignal; onChild?: () => void } = {}) =>
  extractPdfText({ blob_path: BLOB, byte_size: 1, ...extra } as Parameters<typeof extractPdfText>[0]);

beforeEach(() => {
  poppler.available = true;
  runner.queue.length = 0;
  runner.calls.length = 0;
});

describe("availability and cancellation", () => {
  it("no Poppler: unsupported with a server-side label and no process is started", async () => {
    poppler.available = false;
    const r = await go();
    expect(r).toEqual({
      status: "unsupported",
      coverage: {
        extracted_chars: 0,
        truncated: false,
        label: "PDF text extraction unavailable (Poppler not installed on this server)",
      },
      extractedText: null,
    });
    expect(runner.calls).toHaveLength(0);
  });

  it("an already-aborted signal is cancelled before any process", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await go({ signal: ac.signal });
    expect(r.status).toBe("failed");
    expect(r.coverage.label).toBe("PDF extraction cancelled");
    expect(runner.calls).toHaveLength(0);
  });

  it("aborting during pdfinfo or during pdftotext is cancelled and stops at that step", async () => {
    runner.queue.push({ aborted: true, exitCode: null });
    expect((await go()).coverage.label).toBe("PDF extraction cancelled");
    expect(runner.calls).toHaveLength(1);

    runner.calls.length = 0;
    runner.queue.push(info(3), { aborted: true, exitCode: null });
    const r = await go();
    expect(r.status).toBe("failed");
    expect(r.coverage.label).toBe("PDF extraction cancelled");
    expect(r.extractedText).toBeNull();
    expect(runner.calls).toHaveLength(2);
  });

  it("forwards the signal and the child observer to both Poppler processes, using only the blob path in argv", async () => {
    const ac = new AbortController();
    const onChild = vi.fn();
    runner.queue.push(info(2), { stdout: "hello" });
    await go({ signal: ac.signal, onChild });
    expect(runner.calls.map((c) => c.bin)).toEqual(["/fake/pdfinfo", "/fake/pdftotext"]);
    for (const c of runner.calls) {
      expect(c.opts.signal).toBe(ac.signal);
      expect(c.opts.onChild).toBe(onChild);
      expect(c.argv).toContain(BLOB);
    }
    expect(runner.calls[0]!.argv).toEqual([BLOB]);
    expect(runner.calls[1]!.argv).toEqual(["-layout", "-nopgbrk", "-enc", "UTF-8", "-eol", "unix", "-q", "-l", "2", BLOB, "-"]);
  });
});

describe("pdfinfo interpretation", () => {
  it("spawn failure, timeout or an unrelated non-zero exit fail with a fixed label", async () => {
    for (const bad of [
      { spawnError: true, exitCode: null },
      { timedOut: true, exitCode: null, stdout: "Pages: 3\nEncrypted: no\n" },
      { exitCode: 1, stderr: "Syntax Error: Couldn't read xref table /secret/path" },
    ] satisfies Array<Partial<BoundedRunResult>>) {
      runner.calls.length = 0;
      runner.queue.push(bad);
      const r = await go();
      expect(r.status).toBe("failed");
      expect(r.coverage.label).toBe("PDF metadata parse failed");
      expect(JSON.stringify(r)).not.toContain("/secret/path");
      expect(runner.calls).toHaveLength(1);
    }
  });

  it("a non-zero exit whose stderr mentions a password or encryption is classified encrypted", async () => {
    for (const stderr of [
      "Command Line Error: Incorrect password",
      "Error: Owner password required",
      "need the USER PASSWORD",
      "This file is Encrypted",
      "unsupported encryption filter",
    ]) {
      runner.calls.length = 0;
      runner.queue.push({ exitCode: 1, stderr });
      const r = await go();
      expect(r.status, stderr).toBe("encrypted");
      expect(r.pdf_encrypted).toBe(true);
      expect(r.extractedText).toBeNull();
      expect(r.coverage.label).toBe("encrypted PDF (password required; text extraction refused)");
      expect(runner.calls).toHaveLength(1);
    }
  });

  it("an Encrypted: yes line on a successful pdfinfo is classified encrypted without running pdftotext", async () => {
    runner.queue.push(info(4, "yes (print:yes copy:no change:no addNotes:no algorithm:AES)"));
    const r = await go();
    expect(r.status).toBe("encrypted");
    expect(r.pdf_encrypted).toBe(true);
    expect(runner.calls).toHaveLength(1);
  });

  it("planted look-alike Pages:/Encrypted: lines, a missing line or unparsable values fail closed as ambiguous", async () => {
    const cases = [
      { stdout: "Pages: 1\nPages: 99\nEncrypted: no\n" },
      { stdout: "Encrypted: no\nEncrypted: yes\nPages: 5\n" },
      { stdout: "Pages: 5\n" },
      { stdout: "Encrypted: no\n" },
      { stdout: "" },
      { stdout: "Pages: five\nEncrypted: no\n" },
      { stdout: "Pages: 5 pages\nEncrypted: no\n" },
      { stdout: "Pages: 5\nEncrypted: maybe\n" },
    ];
    for (const c of cases) {
      runner.calls.length = 0;
      runner.queue.push(c);
      const r = await go();
      expect(r.status, JSON.stringify(c)).toBe("failed");
      expect(r.coverage.label).toBe("PDF metadata ambiguous");
      expect(runner.calls).toHaveLength(1);
    }
  });

  it("CRLF output is accepted; a zero or absurd page count fails (not ambiguous)", async () => {
    runner.queue.push({ stdout: "Encrypted: no\r\nPages: 1\r\n" }, { stdout: "ok" });
    expect((await go()).status).toBe("text_extracted");
    for (const pages of ["0", "1000001"]) {
      runner.calls.length = 0;
      runner.queue.push(info(pages));
      const r = await go();
      expect(r.status, pages).toBe("failed");
      expect(r.coverage.label).toBe("PDF metadata parse failed");
    }
  });
});

describe("pdftotext interpretation", () => {
  it("a clean extraction reports page count, char count and no truncation", async () => {
    runner.queue.push(info(3), { stdout: "  Hello PDF\n\nSecond line  \n" });
    const r = await go();
    expect(r).toEqual({
      status: "text_extracted",
      coverage: { extracted_chars: 22, truncated: false, label: "PDF (3 pages)" },
      extractedText: "Hello PDF\n\nSecond line",
      pdf_pages: 3,
    });
    expect(runner.calls[1]!.argv).toContain("3");
  });

  it("control characters are replaced by spaces; tabs and newlines survive", async () => {
    runner.queue.push(info(1), { stdout: "a\u0001b\u000bc\u0000d\te\nf" });
    const r = await go();
    expect(r.extractedText).toBe("a b c d\te\nf");
  });

  it("more than 20 pages: only 20 are requested and the result says so", async () => {
    runner.queue.push(info(55), { stdout: "page text" });
    const r = await go();
    expect(runner.calls[1]!.argv.slice(runner.calls[1]!.argv.indexOf("-l"), runner.calls[1]!.argv.indexOf("-l") + 2)).toEqual(["-l", "20"]);
    expect(r.status).toBe("truncated");
    expect(r.coverage).toEqual({ extracted_chars: 9, truncated: true, label: "PDF (55 pages) · first 20 pages" });
    expect(r.pdf_pages).toBe(55);
  });

  it("text over the 24000-char budget is cut at the cap without splitting a surrogate pair", async () => {
    runner.queue.push(info(1), { stdout: "x".repeat(23_999) + "😀tail" });
    const cut = await go();
    expect(cut.status).toBe("truncated");
    expect(cut.extractedText!.length).toBe(23_999);
    expect(cut.coverage.label).toBe("PDF (1 pages) · truncated at 24000 chars");

    runner.queue.push(info(1), { stdout: "y".repeat(30_000) });
    const plain = await go();
    expect(plain.extractedText!.length).toBe(24_000);
    expect(plain.coverage.truncated).toBe(true);
  });

  it("stdout overflow with a non-zero exit is a bounded partial success, not a failure", async () => {
    runner.queue.push(info(2), { stdout: "partial prefix", exitCode: null, signaled: true, truncatedStdoutBytes: true });
    const r = await go();
    expect(r.status).toBe("truncated");
    expect(r.extractedText).toBe("partial prefix");
    expect(r.coverage.label).toBe("PDF (2 pages) · stdout truncated at 262144 bytes");
  });

  it("a pdftotext timeout keeps the prefix as truncated, but with no text it is a failure", async () => {
    runner.queue.push(info(2), { stdout: "got this far", timedOut: true, exitCode: null, signaled: true });
    const partial = await go();
    expect(partial.status).toBe("truncated");
    expect(partial.extractedText).toBe("got this far");
    expect(partial.coverage.label).toBe("PDF (2 pages) · text extraction timed out after 5 s; partial text");

    runner.queue.push(info(2), { stdout: "  \n ", timedOut: true, exitCode: null });
    const none = await go();
    expect(none.status).toBe("failed");
    expect(none.coverage.label).toBe("PDF text extraction timed out after 5 s");
    expect(none.pdf_pages).toBe(2);
  });

  it("stderr that says encrypted wins over everything else, even a timeout or output", async () => {
    runner.queue.push(info(2), { stdout: "leaked?", stderr: "Command Line Error: Incorrect password", exitCode: 1 });
    const r = await go();
    expect(r.status).toBe("encrypted");
    expect(r.pdf_pages).toBe(2);
    expect(r.extractedText).toBeNull();
    expect(r.coverage.label).toBe("encrypted PDF (text extraction refused by pdftotext)");
  });

  it("spawn failure or a plain non-zero exit with no overflow fails with a fixed label", async () => {
    runner.queue.push(info(1), { spawnError: true, exitCode: null });
    expect((await go()).coverage.label).toBe("PDF text extraction failed");
    runner.queue.push(info(1), { exitCode: 2, stdout: "ignored on failure", stderr: "Syntax Error: boom /x/y" });
    const r = await go();
    expect(r.status).toBe("failed");
    expect(r.extractedText).toBeNull();
    expect(r.pdf_pages).toBe(1);
    expect(JSON.stringify(r)).not.toContain("/x/y");
  });

  it("empty or whitespace-only text from a positive page count is a scanned/image-only PDF", async () => {
    runner.queue.push(info(7), { stdout: "\u000c \n\u0001 " });
    const r = await go();
    expect(r).toEqual({
      status: "unsupported",
      coverage: { extracted_chars: 0, truncated: false, label: "scanned PDF or image-only text (7 pages — no selectable text)" },
      extractedText: null,
      pdf_pages: 7,
      pdf_scanned_no_text: true,
    });
  });
});

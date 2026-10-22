// IN-PROCESS instrumented coverage of the worker entry's dispatch function
// (`src/core/attachmentWorker.ts`). It executes on import, so each case
// re-imports the module with a faked `node:worker_threads` (fake parentPort +
// chosen workerData).
//
// This is direct coverage of the dispatch code on the test thread. It is NOT
// child-worker coverage: the real worker_threads behavior (resource limits,
// terminate, message transport) is exercised by
// tests/integration/content_parsers.test.ts and tests/integration/content_hardening.test.ts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerExtractionMessage } from "../../src/core/workerExtraction.js";
import { buildZip } from "./_zipBuilder.js";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures/content");
const NS_WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

let tmpDir: string;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proofestra-worker-entry-"));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.doUnmock("node:worker_threads");
  vi.resetModules();
});

/** Import the worker entry with fake worker_threads and return what it posted. */
async function runEntry(workerData: unknown): Promise<unknown[]> {
  const postMessage = vi.fn();
  vi.doMock("node:worker_threads", () => ({
    parentPort: { postMessage },
    workerData,
    isMainThread: true,
  }));
  await import("../../src/core/attachmentWorker.js");
  return postMessage.mock.calls.map((c) => c[0]);
}

function docxBlob(text: string): { p: string; size: number } {
  const data = buildZip([
    {
      name: "word/document.xml",
      data: Buffer.from(
        `<w:document xmlns:w="${NS_WORD}"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
      ),
    },
  ]);
  const p = path.join(tmpDir, `docx-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(p, data);
  return { p, size: data.length };
}

describe("attachmentWorker dispatch (in-process, faked worker_threads)", () => {
  it("office operation: posts the parser result for the real DOCX fixture", async () => {
    const p = path.join(FIXTURES, "office/proofestra-content.docx");
    const messages = (await runEntry({
      operation: "office",
      blob_path: p,
      byte_size: fs.statSync(p).size,
      office_kind: "docx",
    })) as WorkerExtractionMessage[];
    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg.ok).toBe(true);
    if (!msg.ok) throw new Error("unreachable");
    expect(msg.result.status).toBe("text_extracted");
    expect(msg.result.extractedText).toContain("PROOFESTRA_DOCX_BODY_ORCHID_42");
    expect(msg.result.coverage.label).not.toContain("macros");
  });

  it("office operation: macro_variant true is passed through to the label, false/absent is not", async () => {
    const { p, size } = docxBlob("MACRO_TEXT");
    const base = { operation: "office", blob_path: p, byte_size: size, office_kind: "docx" };
    const [withMacro] = (await runEntry({ ...base, macro_variant: true })) as WorkerExtractionMessage[];
    expect(withMacro).toMatchObject({
      ok: true,
      result: { status: "text_extracted", coverage: { label: "DOCX text (10 chars; macros not executed)" } },
    });
    vi.resetModules();
    const [explicitFalse] = (await runEntry({ ...base, macro_variant: false })) as WorkerExtractionMessage[];
    expect(explicitFalse).toMatchObject({ ok: true, result: { coverage: { label: "DOCX text (10 chars)" } } });
    vi.resetModules();
    const [absent] = (await runEntry(base)) as WorkerExtractionMessage[];
    expect(absent).toMatchObject({ ok: true, result: { coverage: { label: "DOCX text (10 chars)" } } });
  });

  it("zip operation: posts the ZIP inventory result", async () => {
    const p = path.join(FIXTURES, "zip/supported-mixed.zip");
    const messages = (await runEntry({
      operation: "zip",
      blob_path: p,
      byte_size: fs.statSync(p).size,
    })) as WorkerExtractionMessage[];
    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg.ok).toBe(true);
    if (!msg.ok) throw new Error("unreachable");
    expect(["text_extracted", "truncated"]).toContain(msg.result.status);
    expect(msg.result.extractedText).toContain("ZIP archive, ");
  });

  it("an unreadable blob is a normal parser failure message (ok:true, status failed), not an exception", async () => {
    const messages = await runEntry({
      operation: "zip",
      blob_path: path.join(tmpDir, "missing"),
      byte_size: 1,
    });
    expect(messages).toEqual([
      {
        ok: true,
        result: {
          status: "failed",
          coverage: { extracted_chars: 0, truncated: false, label: "ZIP could not be read" },
          extractedText: null,
        },
      },
    ]);
  });

  it("an exception inside a parser posts exactly the generic worker_exception message", async () => {
    // Real stack: a null workerData makes `input.operation` throw a TypeError.
    expect(await runEntry(null)).toEqual([
      { ok: false, code: "worker_exception", message: "extraction failed" },
    ]);
  });

  it("a malformed office input (office_kind missing) is contained as worker_exception without detail", async () => {
    const { p, size } = docxBlob("x");
    const messages = await runEntry({ operation: "office", blob_path: p, byte_size: size });
    expect(messages).toEqual([{ ok: false, code: "worker_exception", message: "extraction failed" }]);
    expect(JSON.stringify(messages)).not.toContain(p);
  });

  it("with no parentPort (not running as a worker) the module imports without throwing and posts nothing", async () => {
    vi.doMock("node:worker_threads", () => ({
      parentPort: undefined,
      workerData: { operation: "zip", blob_path: path.join(tmpDir, "irrelevant"), byte_size: 1 },
      isMainThread: true,
    }));
    await expect(import("../../src/core/attachmentWorker.js")).resolves.toBeDefined();
  });
});

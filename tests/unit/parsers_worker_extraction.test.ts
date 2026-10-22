// Parent-side worker protocol (`runAttachmentWorker`) with a scripted
// WorkerLike. No thread is started: this covers settle ordering, label
// classification and listener hygiene. Real worker_threads behavior (resource
// limits, terminate, transport) is covered by tests/integration/content_parsers.test.ts.

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ExtractionResult } from "../../src/core/attachmentExtraction.js";
import {
  DEFAULT_WORKER_TIMEOUT_MS,
  resolveWorkerLaunch,
  runAttachmentWorker,
  WORKER_RESOURCE_LIMITS,
  type WorkerFactory,
  type WorkerLike,
} from "../../src/core/workerExtraction.js";

class FakeWorker implements WorkerLike {
  terminated = 0;
  private readonly bus = new EventEmitter();
  private readonly terminateDone: Promise<number>;
  private release!: () => void;
  constructor(readonly entry: unknown, readonly options: Record<string, unknown>, deferTerminate = false) {
    this.terminateDone = deferTerminate
      ? new Promise<number>((resolve) => {
          this.release = () => resolve(0);
        })
      : Promise.resolve(0);
  }
  on(event: "message" | "error" | "exit", listener: (...args: never[]) => void): this {
    this.bus.on(event, listener as (...args: unknown[]) => void);
    return this;
  }
  removeListener(event: "message" | "error" | "exit", listener: (...args: never[]) => void): this {
    this.bus.removeListener(event, listener as (...args: unknown[]) => void);
    return this;
  }
  emit(event: "message" | "error" | "exit", ...args: unknown[]): boolean {
    return this.bus.emit(event, ...args);
  }
  listenerCount(event: "message" | "error" | "exit"): number {
    return this.bus.listenerCount(event);
  }
  terminate(): Promise<number> {
    this.terminated += 1;
    return this.terminateDone;
  }
  finishTerminate(): void {
    this.release();
  }
}

const OK: ExtractionResult = {
  status: "text_extracted",
  coverage: { extracted_chars: 2, truncated: false, label: "DOCX text (2 chars)" },
  extractedText: "hi",
};
const zipInput = { operation: "zip", blob_path: "/blobs/x", byte_size: 5 } as const;
const docxInput = { operation: "office", blob_path: "/blobs/x", byte_size: 5, office_kind: "docx" } as const;

function setup(deferTerminate = false) {
  const made: FakeWorker[] = [];
  const workerFactory: WorkerFactory = (entry, options) => {
    const w = new FakeWorker(entry, options as unknown as Record<string, unknown>, deferTerminate);
    made.push(w);
    return w;
  };
  return { made, workerFactory };
}

const failed = (label: string): ExtractionResult => ({
  status: "failed",
  coverage: { extracted_chars: 0, truncated: false, label },
  extractedText: null,
});

describe("runAttachmentWorker", () => {
  it("launches with the blob-only workerData, resource limits and an EMPTY environment", async () => {
    const { made, workerFactory } = setup();
    const p = runAttachmentWorker(docxInput, { workerFactory });
    const w = made[0]!;
    expect(w.options["workerData"]).toEqual(docxInput);
    expect(w.options["resourceLimits"]).toEqual(WORKER_RESOURCE_LIMITS);
    expect(w.options["env"]).toEqual({});
    expect(w.options["stdout"]).toBe(false);
    expect(w.options["stderr"]).toBe(false);
    w.emit("message", { ok: true, result: OK });
    await expect(p).resolves.toEqual(OK);
    expect(w.terminated).toBe(1);
  });

  it("a worker's ok:true message resolves with the parser result; a worker exception message becomes a labelled failure", async () => {
    const a = setup();
    const okP = runAttachmentWorker(zipInput, { workerFactory: a.workerFactory });
    a.made[0]!.emit("message", { ok: true, result: OK });
    await expect(okP).resolves.toEqual(OK);

    for (const bad of [
      { ok: false, code: "worker_exception", message: "extraction failed" },
      null,
      "garbage",
      { ok: "true", result: OK },
    ]) {
      const b = setup();
      const p = runAttachmentWorker(docxInput, { workerFactory: b.workerFactory });
      b.made[0]!.emit("message", bad);
      await expect(p).resolves.toEqual(failed("DOCX extraction failed"));
    }
  });

  it("a factory that throws makes extraction unavailable without a worker", async () => {
    const workerFactory: WorkerFactory = () => {
      throw new Error("no threads");
    };
    await expect(runAttachmentWorker(zipInput, { workerFactory })).resolves.toEqual(failed("ZIP extraction unavailable"));
  });

  it("an error event is a plain failure; an out-of-memory error names the memory limit", async () => {
    const plain = setup();
    const p1 = runAttachmentWorker(docxInput, { workerFactory: plain.workerFactory });
    plain.made[0]!.emit("error", new Error("boom with /secret/path"));
    const r1 = await p1;
    expect(r1).toEqual(failed("DOCX extraction failed"));
    expect(JSON.stringify(r1)).not.toContain("/secret/path");

    const oom = setup();
    const p2 = runAttachmentWorker({ ...docxInput, office_kind: "xlsx" }, { workerFactory: oom.workerFactory });
    oom.made[0]!.emit("error", Object.assign(new Error("heap"), { code: "ERR_WORKER_OUT_OF_MEMORY" }));
    await expect(p2).resolves.toEqual(failed("XLSX extraction exceeded its memory limit"));
  });

  it("a worker that exits without a message is reported as ended unexpectedly", async () => {
    const { made, workerFactory } = setup();
    const p = runAttachmentWorker({ ...docxInput, office_kind: "pptx" }, { workerFactory });
    made[0]!.emit("exit", 1);
    await expect(p).resolves.toEqual(failed("PPTX extraction ended unexpectedly"));
    expect(made[0]!.terminated).toBe(1);
  });

  it("a timeout terminates the worker and reports the configured limit", async () => {
    const { made, workerFactory } = setup();
    const r = await runAttachmentWorker(zipInput, { workerFactory, timeoutMs: 20 });
    expect(r).toEqual(failed("ZIP extraction timed out after 0.02 s"));
    expect(made[0]!.terminated).toBe(1);
    expect(DEFAULT_WORKER_TIMEOUT_MS).toBe(10_000);
  });

  it("an abort terminates the worker; a pre-aborted signal never creates one", async () => {
    const { made, workerFactory } = setup();
    const ac = new AbortController();
    const p = runAttachmentWorker(docxInput, { workerFactory, signal: ac.signal });
    ac.abort();
    await expect(p).resolves.toEqual(failed("DOCX extraction cancelled"));
    expect(made[0]!.terminated).toBe(1);

    const pre = new AbortController();
    pre.abort();
    const again = setup();
    await expect(runAttachmentWorker(zipInput, { workerFactory: again.workerFactory, signal: pre.signal })).resolves.toEqual(
      failed("ZIP extraction cancelled"),
    );
    expect(again.made).toHaveLength(0);
  });

  it("settles only AFTER terminate() resolves, so callers always see a dead worker", async () => {
    const { made, workerFactory } = setup(true);
    const p = runAttachmentWorker(zipInput, { workerFactory });
    const w = made[0]!;
    let settled = false;
    void p.then(() => (settled = true));
    w.emit("message", { ok: true, result: OK });
    await new Promise((r) => setTimeout(r, 30));
    expect(w.terminated).toBe(1);
    expect(settled).toBe(false);
    w.finishTerminate();
    await expect(p).resolves.toEqual(OK);
  });

  it("late messages, errors and exits during teardown are ignored and keep error/exit listeners until teardown ends", async () => {
    const { made, workerFactory } = setup(true);
    const p = runAttachmentWorker(zipInput, { workerFactory });
    const w = made[0]!;
    w.emit("message", { ok: true, result: OK });
    // Teardown in progress: the message listener is gone, error/exit remain.
    expect(w.listenerCount("message")).toBe(0);
    expect(w.listenerCount("error")).toBe(1);
    expect(w.listenerCount("exit")).toBe(1);
    expect(() => w.emit("error", new Error("late OOM"))).not.toThrow();
    w.emit("exit", 1);
    w.emit("message", { ok: false, code: "x", message: "late" });
    w.finishTerminate();
    await expect(p).resolves.toEqual(OK);
    expect(w.listenerCount("error")).toBe(0);
    expect(w.listenerCount("exit")).toBe(0);
    expect(w.terminated).toBe(1);
  });

  it("removes its abort listener and clears its timer once settled", async () => {
    const { made, workerFactory } = setup();
    const ac = new AbortController();
    const remove = vi.spyOn(ac.signal, "removeEventListener");
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const p = runAttachmentWorker(zipInput, { workerFactory, signal: ac.signal });
    made[0]!.emit("message", { ok: true, result: OK });
    await p;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
    // Aborting afterwards changes nothing.
    ac.abort();
    expect(made[0]!.terminated).toBe(1);
  });
});

describe("resolveWorkerLaunch", () => {
  it("source runtime (.ts) uses an eval bootstrap that registers tsx and imports the .ts worker", () => {
    const launch = resolveWorkerLaunch("file:///app/src/core/workerExtraction.ts");
    expect(launch.eval).toBe(true);
    expect(launch.execArgv).toEqual([]);
    expect(typeof launch.entry).toBe("string");
    expect(launch.entry as string).toContain('import("tsx/esm/api")');
    expect(launch.entry as string).toContain(JSON.stringify("file:///app/src/core/attachmentWorker.ts"));
  });

  it("built runtime (.js) loads attachmentWorker.js directly as a file URL", () => {
    const launch = resolveWorkerLaunch("file:///app/dist/core/workerExtraction.js");
    expect(launch.eval).toBe(false);
    expect((launch.entry as URL).href).toBe("file:///app/dist/core/attachmentWorker.js");
  });
});

// Parent side of the Office/ZIP extraction worker.
//
// Contract:
//   - The worker is created with `resourceLimits` and receives only the
//     UUID blob path, byte size and operation (never a user filename).
//   - On abort or timeout the parent removes every listener it installed,
//     AWAITS `worker.terminate()`, and only then settles, so the upload gate
//     never releases while parser code may still be running.
//   - Late worker messages after settlement are ignored.
//   - Source (`.ts`, under tsx/Vitest) and built (`.js`) runtimes resolve
//     different worker files. `--import tsx` in `execArgv` does NOT register
//     tsx's resolver inside a worker thread (verified on Node 22.19: the
//     `.js` -> `.ts` import mapping fails), so the source runtime starts a
//     tiny eval bootstrap that registers `tsx/esm/api` and then imports the
//     `.ts` worker. The built runtime loads `attachmentWorker.js` directly.

import { Worker, type WorkerOptions } from "node:worker_threads";
import type { ExtractionResult } from "./attachmentExtraction.js";
import type { OfficeKind } from "./parsers/office.js";

export type WorkerExtractionInput =
  | {
      operation: "office";
      blob_path: string;
      byte_size: number;
      office_kind: OfficeKind;
      macro_variant?: boolean;
    }
  | { operation: "zip"; blob_path: string; byte_size: number };

export type WorkerExtractionMessage =
  | { ok: true; result: ExtractionResult }
  | { ok: false; code: string; message: string };

/** The subset of `Worker` this module uses; injectable for tests. */
export interface WorkerLike {
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  removeListener(event: "message" | "error" | "exit", listener: (...args: never[]) => void): unknown;
  terminate(): Promise<number>;
}

export type WorkerFactory = (entry: URL | string, options: WorkerOptions) => WorkerLike;

export const WORKER_RESOURCE_LIMITS = {
  maxOldGenerationSizeMb: 192,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
} as const;

export const DEFAULT_WORKER_TIMEOUT_MS = 10_000;

export interface WorkerLaunch {
  /** A file URL (built runtime) or eval source (source runtime). */
  entry: URL | string;
  eval: boolean;
  execArgv: string[];
}

export function resolveWorkerLaunch(moduleUrl: string): WorkerLaunch {
  if (moduleUrl.endsWith(".ts")) {
    const target = new URL("./attachmentWorker.ts", moduleUrl).href;
    return {
      entry:
        `const { register } = await import("tsx/esm/api");` +
        ` register(); await import(${JSON.stringify(target)});`,
      eval: true,
      execArgv: [],
    };
  }
  return { entry: new URL("./attachmentWorker.js", moduleUrl), eval: false, execArgv: [] };
}

export interface RunAttachmentWorkerOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  workerFactory?: WorkerFactory;
}

function failedResult(label: string): ExtractionResult {
  return {
    status: "failed",
    coverage: { extracted_chars: 0, truncated: false, label },
    extractedText: null,
  };
}

export function runAttachmentWorker(
  input: WorkerExtractionInput,
  options: RunAttachmentWorkerOptions = {},
): Promise<ExtractionResult> {
  const kind = input.operation === "office" ? input.office_kind.toUpperCase() : "ZIP";
  if (options.signal?.aborted) {
    return Promise.resolve(failedResult(`${kind} extraction cancelled`));
  }
  const launch = resolveWorkerLaunch(import.meta.url);
  const workerOptions: WorkerOptions = {
    workerData: input,
    resourceLimits: { ...WORKER_RESOURCE_LIMITS },
    eval: launch.eval,
    execArgv: launch.execArgv,
    env: {},
    stdout: false,
    stderr: false,
  };
  const factory: WorkerFactory =
    options.workerFactory ?? ((url, opts) => new Worker(url, opts) as unknown as WorkerLike);
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;

  return new Promise<ExtractionResult>((resolve) => {
    let worker: WorkerLike;
    try {
      worker = factory(launch.entry, workerOptions);
    } catch {
      resolve(failedResult(`${kind} extraction unavailable`));
      return;
    }
    let settled = false;

    // `error` and `exit` stay attached until `terminate()` has settled: Node
    // can still emit a late `error` (e.g. an out-of-memory stop) while the
    // worker is being torn down, and an `error` event without a listener
    // would crash the whole server process.
    const removeTailListeners = (): void => {
      worker.removeListener("error", onError as never);
      worker.removeListener("exit", onExit as never);
    };
    // Terminate first, then settle: callers rely on a dead worker.
    const settle = (result: ExtractionResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      worker.removeListener("message", onMessage as never);
      const done = (): void => {
        removeTailListeners();
        resolve(result);
      };
      void worker.terminate().then(done, done);
    };

    function onMessage(message: unknown): void {
      if (settled) return;
      const m = message as WorkerExtractionMessage | null;
      if (m && m.ok === true) settle(m.result);
      else settle(failedResult(`${kind} extraction failed`));
    }
    function onError(err: Error): void {
      if (settled) return; // late error during teardown: swallowed on purpose
      const code = (err as NodeJS.ErrnoException).code;
      settle(
        failedResult(
          code === "ERR_WORKER_OUT_OF_MEMORY"
            ? `${kind} extraction exceeded its memory limit`
            : `${kind} extraction failed`,
        ),
      );
    }
    function onExit(): void {
      if (settled) return;
      settle(failedResult(`${kind} extraction ended unexpectedly`));
    }
    function onAbort(): void {
      settle(failedResult(`${kind} extraction cancelled`));
    }

    const timer = setTimeout(() => {
      settle(failedResult(`${kind} extraction timed out after ${timeoutMs / 1000} s`));
    }, Math.max(1, timeoutMs));

    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

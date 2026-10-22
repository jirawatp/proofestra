// Shared bounded subprocess runner for the Poppler and ffprobe parsers.
//
// Invariants every call site inherits:
//   - `spawn(bin, [argv], { shell: false })` — never a shell, never a
//     user filename, never `$PATH` resolution.
//   - stdio is a controlled triple. For file-descriptor-based media
//     probing the caller passes an already-opened read-only blob FD as
//     `stdio[0]`; the parent-side FD is NEVER closed by this runner
//     (the caller opened it and must close it after `run()` returns).
//     Everything else must be "ignore" / "pipe".
//   - Hard wallclock timeout. On fire → send SIGKILL, THEN await the
//     child's `close` event, THEN resolve. Resolving before close could
//     leak a running child past the upload gate's lifetime; the gate
//     release must observe a dead child.
//   - External AbortSignal. On abort → same kill-then-await-close dance.
//   - Byte caps on stdout and stderr. When stdout overflows we DO NOT
//     throw away everything collected; we kill the child, await close,
//     and return the bounded partial text to the caller with
//     `truncatedByBytes: true`. The caller decides whether a bounded
//     partial is still usable (PDF: yes — chars we got are valid
//     prefix; ffprobe: no — JSON must be complete).
//   - Every path removes exactly the listeners and timer this runner
//     installed (never `removeAllListeners`). No stale `signal`
//     listener survives past `run()`.
//   - A child `error` event settles immediately only when no PID exists
//     (the spawn itself failed). With a PID the child is real, so we keep
//     waiting for `close` — settling earlier could leave a live process
//     behind the upload gate.
//   - Captured output is trimmed to a complete UTF-8 sequence, so a
//     byte-capped or killed child never yields a split code point.
//
// The runner is dumb on purpose: no classification, no retries, no
// fallback paths. Classification lives in the per-parser caller
// (`pdf.ts`, `ffprobe.ts`) so each parser can map exit codes and
// stderr fragments to its own sanitized labels.

import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";

export interface BoundedRunOpts {
  /** Hard wallclock cap. SIGKILL on fire; await close before resolving. */
  timeoutMs: number;
  /** Hard cap on captured stdout. Caller receives bounded partial on overflow. */
  captureStdoutBytes: number;
  /** Hard cap on captured stderr. Caller receives bounded partial on overflow. */
  captureStderrBytes: number;
  /**
   * stdio triple for the child. Default: `["ignore", "pipe", "pipe"]`.
   * ffprobe's FD-only transport passes `[blobFd, "pipe", "pipe"]` to
   * attach the read-only UUID blob as the child's stdin. The parent
   * is responsible for `fs.close(blobFd)` AFTER `run()` returns —
   * this runner does NOT close caller-provided FDs because doing so
   * would race the child's inherited copy.
   */
  stdio?: StdioOptions;
  /** External cancellation. SIGKILL on fire; await close before resolving. */
  signal?: AbortSignal;
  /** Observation hook for tests: receives the spawned child. */
  onChild?: (child: ChildProcess) => void;
}

export interface BoundedRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signaled: boolean;
  /** True iff the external AbortSignal fired OR the parent explicitly killed. */
  aborted: boolean;
  /** True iff the timeoutMs cap was hit. */
  timedOut: boolean;
  /** True iff stdout hit `captureStdoutBytes` before the child exited naturally. */
  truncatedStdoutBytes: boolean;
  /** True iff stderr hit `captureStderrBytes` before the child exited naturally. */
  truncatedStderrBytes: boolean;
  /** True iff the child could not be spawned (binary missing / EACCES). */
  spawnError: boolean;
}

/** Decode `chunks` as UTF-8, dropping an incomplete trailing sequence. */
export function decodeBoundedUtf8(chunks: Buffer[], byteLength: number): string {
  const buf = Buffer.concat(chunks, byteLength);
  let end = buf.length;
  // Walk back over at most 3 continuation bytes to the lead byte.
  for (let i = buf.length - 1; i >= 0 && i >= buf.length - 4; i -= 1) {
    const byte = buf[i]!;
    if ((byte & 0xc0) === 0x80) continue;
    const expected =
      (byte & 0x80) === 0 ? 1 : (byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : (byte & 0xf8) === 0xf0 ? 4 : 1;
    if (buf.length - i < expected) end = i;
    break;
  }
  return buf.subarray(0, end).toString("utf-8");
}

function emptyResult(extra: Partial<BoundedRunResult>): BoundedRunResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: null,
    signaled: false,
    aborted: false,
    timedOut: false,
    truncatedStdoutBytes: false,
    truncatedStderrBytes: false,
    spawnError: false,
    ...extra,
  };
}

/**
 * Spawn `bin argv…` with the given bounds. Never throws. Always awaits
 * child `close` before resolving, even on timeout / abort / overflow.
 */
export async function runBoundedProc(
  bin: string,
  argv: readonly string[],
  opts: BoundedRunOpts,
): Promise<BoundedRunResult> {
  const captureStdout = Math.max(0, Math.floor(opts.captureStdoutBytes));
  const captureStderr = Math.max(0, Math.floor(opts.captureStderrBytes));
  const stdio: StdioOptions = opts.stdio ?? ["ignore", "pipe", "pipe"];
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  let outBytes = 0;
  let errBytes = 0;
  let truncatedStdoutBytes = false;
  let truncatedStderrBytes = false;
  let timedOut = false;
  let abortedByCaller = false;

  if (opts.signal?.aborted) return emptyResult({ aborted: true });

  let child: ChildProcess;
  try {
    child = spawn(bin, [...argv], {
      shell: false,
      stdio,
      // Locked-down env: no user locale, no inherited PATH.
      env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
    });
  } catch {
    return emptyResult({ spawnError: true });
  }
  opts.onChild?.(child);

  const killIfLive = (): void => {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  };

  const onStdout = (chunk: Buffer): void => {
    if (outBytes >= captureStdout) {
      if (!truncatedStdoutBytes) {
        truncatedStdoutBytes = true;
        killIfLive();
      }
      return;
    }
    const room = captureStdout - outBytes;
    if (chunk.length > room) {
      outChunks.push(chunk.subarray(0, room));
      outBytes += room;
      truncatedStdoutBytes = true;
      killIfLive();
    } else {
      outChunks.push(chunk);
      outBytes += chunk.length;
    }
  };
  const onStderr = (chunk: Buffer): void => {
    if (errBytes >= captureStderr) {
      truncatedStderrBytes = true;
      return;
    }
    const room = captureStderr - errBytes;
    if (chunk.length > room) {
      errChunks.push(chunk.subarray(0, room));
      errBytes += room;
      truncatedStderrBytes = true;
    } else {
      errChunks.push(chunk);
      errBytes += chunk.length;
    }
  };
  child.stdout?.on("data", onStdout);
  child.stderr?.on("data", onStderr);

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    killIfLive();
  }, Math.max(1, opts.timeoutMs));

  const onAbort = (): void => {
    abortedByCaller = true;
    killIfLive();
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const closeInfo: { code: number | null; signal: NodeJS.Signals | null } = {
    code: null,
    signal: null,
  };
  let spawnFailed = false;

  await new Promise<void>((resolve) => {
    let done = false;
    const settle = (): void => {
      if (done) return;
      done = true;
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      resolve();
    };
    const onClose = (code: number | null, signalName: NodeJS.Signals | null): void => {
      closeInfo.code = code;
      closeInfo.signal = signalName;
      settle();
    };
    const onError = (): void => {
      // No PID means spawn() failed and `close` will not reliably follow.
      // With a PID the child exists; wait for its real `close`.
      if (child.pid === undefined) {
        spawnFailed = true;
        settle();
      }
    };
    child.on("close", onClose);
    child.on("error", onError);
  });

  clearTimeout(timeoutHandle);
  opts.signal?.removeEventListener("abort", onAbort);
  child.stdout?.removeListener("data", onStdout);
  child.stderr?.removeListener("data", onStderr);

  return {
    stdout: decodeBoundedUtf8(outChunks, outBytes),
    stderr: decodeBoundedUtf8(errChunks, errBytes),
    exitCode: closeInfo.code,
    signaled: closeInfo.signal !== null,
    aborted: abortedByCaller,
    timedOut,
    truncatedStdoutBytes,
    truncatedStderrBytes,
    spawnError: spawnFailed,
  };
}

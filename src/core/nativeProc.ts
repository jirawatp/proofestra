// Supervised, bounded subprocess for a native (vendor CLI) job.
//
// Unlike the parser runner this one:
//   - takes an explicit, minimal environment from the caller (the caller is
//     responsible for keeping credentials out of it) and an explicit cwd;
//   - writes the prompt to stdin so a private conversation never appears in
//     argv;
//   - streams stdout line by line with a per-line and a total byte cap and
//     lets the caller reject a line (kill) as soon as it is seen;
//   - never retains stderr text beyond a tiny bounded sample used only for
//     fixed-category classification by the caller;
//   - puts the child in its own process group and SIGKILLs that group on
//     timeout, cancel, overflow or a rejected line (best effort: a descendant
//     that left the group, e.g. via setsid, is NOT contained by this);
//   - settles in bounded time. It waits for `close`, but if the child's pipes
//     are still held open `settleGraceMs` after the child exited (or after a
//     kill was requested), it destroys the pipes it owns and resolves with
//     `streamsForceClosed: true`. That means a descendant may still be
//     running: callers must treat the work as externally UNKNOWN and must
//     never claim the whole tree was killed.
//
// It never throws and never inspects what the child says.

import { spawn, type ChildProcess } from "node:child_process";

export type LineVerdict = "continue" | "kill";

export interface NativeJobOpts {
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd: string;
  /** Written to the child's stdin, then stdin is closed. */
  stdin: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxLineBytes: number;
  /** Bytes of stderr kept (in memory only) for classification. */
  stderrSampleBytes: number;
  signal?: AbortSignal;
  /** Called for each complete stdout line. Return "kill" to stop the child now. */
  onLine: (line: string) => LineVerdict;
  /** Observation hook for tests. */
  onChild?: (child: ChildProcess) => void;
  /**
   * How long to wait for the child's pipes to close after it exited (or after a
   * kill was requested) before force-closing them. Default 1500 ms.
   */
  settleGraceMs?: number;
}

export interface NativeJobResult {
  exitCode: number | null;
  signaled: boolean;
  aborted: boolean;
  timedOut: boolean;
  spawnError: boolean;
  stdoutOverflow: boolean;
  lineOverflow: boolean;
  killedByHandler: boolean;
  /**
   * The pipes were still open after the grace period and were destroyed by us.
   * A descendant that escaped the process group may still be running, so the
   * job's side effects are unknown and no whole-tree kill may be claimed.
   */
  streamsForceClosed: boolean;
  /** The child itself never reported an exit within the grace after a kill. */
  unreaped: boolean;
  stderrSample: string;
}

function blank(extra: Partial<NativeJobResult>): NativeJobResult {
  return {
    exitCode: null,
    signaled: false,
    aborted: false,
    timedOut: false,
    spawnError: false,
    stdoutOverflow: false,
    lineOverflow: false,
    killedByHandler: false,
    streamsForceClosed: false,
    unreaped: false,
    stderrSample: "",
    ...extra,
  };
}

export async function runNativeJob(bin: string, opts: NativeJobOpts): Promise<NativeJobResult> {
  if (opts.signal?.aborted) return blank({ aborted: true });

  let child: ChildProcess;
  try {
    child = spawn(bin, [...opts.argv], {
      shell: false,
      cwd: opts.cwd,
      env: { ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      // New process group so the whole tree can be killed together.
      detached: true,
    });
  } catch {
    return blank({ spawnError: true });
  }
  opts.onChild?.(child);

  const state = {
    timedOut: false,
    aborted: false,
    stdoutOverflow: false,
    lineOverflow: false,
    killedByHandler: false,
    unreaped: false,
  };
  let exited = false;

  const killTree = (): void => {
    const pid = child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  };

  // --- stdout: bounded, line-framed ------------------------------------
  let pending: Buffer = Buffer.alloc(0);
  let stdoutBytes = 0;
  let stopped = false;
  const graceMs = Math.max(1, opts.settleGraceMs ?? 1500);
  let requestSettle: (() => void) | null = null;
  let killGraceTimer: NodeJS.Timeout | null = null;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    killTree();
    // Even a killed child can fail to report (kernel stall, pid not ours any
    // more): never wait unboundedly for it.
    killGraceTimer = setTimeout(() => {
      state.unreaped = !exited;
      requestSettle?.();
    }, graceMs);
  };
  const emit = (lineBuf: Buffer): void => {
    if (stopped) return;
    const text = lineBuf.toString("utf8").replace(/\r$/, "");
    if (text.length === 0) return;
    if (opts.onLine(text) === "kill") {
      state.killedByHandler = true;
      stop();
    }
  };
  const onStdout = (chunk: Buffer): void => {
    if (stopped) return;
    stdoutBytes += chunk.length;
    if (stdoutBytes > opts.maxStdoutBytes) {
      state.stdoutOverflow = true;
      stop();
      return;
    }
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let newline = pending.indexOf(0x0a);
    while (newline !== -1 && !stopped) {
      // The per-line cap applies to every line, including complete
      // newline-terminated ones and lines assembled from several chunks; the
      // limit is checked on raw bytes BEFORE decoding or delivery.
      if (newline > opts.maxLineBytes) {
        state.lineOverflow = true;
        stop();
        break;
      }
      emit(pending.subarray(0, newline));
      pending = pending.subarray(newline + 1);
      newline = pending.indexOf(0x0a);
    }
    if (!stopped && pending.length > opts.maxLineBytes) {
      state.lineOverflow = true;
      stop();
    }
  };

  // --- stderr: tiny in-memory sample for classification only ----------
  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;
  const onStderr = (chunk: Buffer): void => {
    const room = opts.stderrSampleBytes - stderrBytes;
    if (room <= 0) return;
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    stderrChunks.push(part);
    stderrBytes += part.length;
  };

  child.stdout?.on("data", onStdout);
  child.stderr?.on("data", onStderr);
  child.stdin?.on("error", () => {
    /* child may exit before reading stdin; irrelevant to supervision */
  });

  const timeoutHandle = setTimeout(
    () => {
      state.timedOut = true;
      stop();
    },
    Math.max(1, opts.timeoutMs),
  );
  const onAbort = (): void => {
    state.aborted = true;
    stop();
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const closeInfo: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null };
  let spawnFailed = false;
  let forceClosed = false;
  await new Promise<void>((resolve) => {
    let done = false;
    let exitGraceTimer: NodeJS.Timeout | null = null;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (exitGraceTimer) clearTimeout(exitGraceTimer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      child.removeListener("close", onClose);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      resolve();
    };
    // Grace expired with pipes (or the child) still open: close what we own.
    requestSettle = (): void => {
      if (done) return;
      forceClosed = true;
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      finish();
    };
    const onClose = (code: number | null, signalName: NodeJS.Signals | null): void => {
      if (!exited) {
        closeInfo.code = code;
        closeInfo.signal = signalName;
      }
      finish();
    };
    const onExit = (code: number | null, signalName: NodeJS.Signals | null): void => {
      exited = true;
      closeInfo.code = code;
      closeInfo.signal = signalName;
      // `close` normally follows at once; if a descendant holds the pipes it
      // never will, so bound the wait.
      exitGraceTimer = setTimeout(() => requestSettle?.(), graceMs);
    };
    const onError = (): void => {
      if (child.pid === undefined) {
        spawnFailed = true;
        finish();
      }
    };
    child.on("close", onClose);
    child.on("exit", onExit);
    child.on("error", onError);
    // A real child exists iff it has a pid (spawn failure reports via `error`).
    if (child.pid !== undefined) child.stdin?.end(opts.stdin);
  });

  clearTimeout(timeoutHandle);
  opts.signal?.removeEventListener("abort", onAbort);
  child.stdout?.removeListener("data", onStdout);
  child.stderr?.removeListener("data", onStderr);
  // A final line without a trailing newline is still a line (but not after a
  // force-close: whatever a still-running descendant wrote is not trusted).
  if (!stopped && !forceClosed && pending.length > 0) emit(pending);
  // Sweep any descendant the CLI left behind in its process group.
  if (!spawnFailed) killTree();

  return {
    exitCode: closeInfo.code,
    signaled: closeInfo.signal !== null,
    aborted: state.aborted,
    timedOut: state.timedOut,
    spawnError: spawnFailed,
    stdoutOverflow: state.stdoutOverflow,
    lineOverflow: state.lineOverflow,
    killedByHandler: state.killedByHandler,
    streamsForceClosed: forceClosed,
    unreaped: state.unreaped,
    stderrSample: Buffer.concat(stderrChunks, stderrBytes).toString("utf8"),
  };
}

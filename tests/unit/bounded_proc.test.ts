import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { decodeBoundedUtf8, runBoundedProc } from "../../src/core/parsers/boundedProc.js";

const NODE = process.execPath;

function observeChild(): { onChild: (c: ChildProcess) => void; get: () => ChildProcess } {
  let child: ChildProcess | null = null;
  return {
    onChild: (c) => {
      child = c;
    },
    get: () => child!,
  };
}

describe("runBoundedProc", () => {
  it("abort kills the child and resolves only after close", async () => {
    const obs = observeChild();
    const ac = new AbortController();
    let closeSeen = false;
    const p = runBoundedProc("/bin/sleep", ["5"], {
      timeoutMs: 10_000,
      captureStdoutBytes: 1024,
      captureStderrBytes: 1024,
      signal: ac.signal,
      onChild: (c) => {
        obs.onChild(c);
        c.once("close", () => {
          closeSeen = true;
        });
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    const r = await p;
    expect(closeSeen).toBe(true);
    expect(r.aborted).toBe(true);
    expect(r.signaled).toBe(true);
    expect(obs.get().exitCode === null && obs.get().signalCode === "SIGKILL").toBe(true);
  });

  it("timeout kills the child and resolves only after close", async () => {
    let closeSeen = false;
    const started = Date.now();
    const r = await runBoundedProc("/bin/sleep", ["5"], {
      timeoutMs: 100,
      captureStdoutBytes: 1024,
      captureStderrBytes: 1024,
      onChild: (c) => c.once("close", () => (closeSeen = true)),
    });
    expect(closeSeen).toBe(true);
    expect(r.timedOut).toBe(true);
    expect(r.aborted).toBe(false);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("an already-aborted signal never spawns", async () => {
    const ac = new AbortController();
    ac.abort();
    const spawned = vi.fn();
    const r = await runBoundedProc("/bin/sleep", ["5"], {
      timeoutMs: 1000,
      captureStdoutBytes: 10,
      captureStderrBytes: 10,
      signal: ac.signal,
      onChild: spawned,
    });
    expect(r.aborted).toBe(true);
    expect(spawned).not.toHaveBeenCalled();
  });

  it("stdout overflow returns exactly the bounded UTF-8-safe prefix", async () => {
    // "ก" is 3 bytes in UTF-8; an 8-byte cap lands inside the third code point.
    const r = await runBoundedProc(
      NODE,
      ["-e", "process.stdout.write('กกกกกกกกกก'); setInterval(()=>{}, 1000)"],
      { timeoutMs: 5_000, captureStdoutBytes: 8, captureStderrBytes: 1024 },
    );
    expect(r.truncatedStdoutBytes).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.stdout).toBe("กก");
    expect(Buffer.byteLength(r.stdout)).toBe(6);
  });

  it("spawn failure sets spawnError without throwing", async () => {
    const r = await runBoundedProc("/nonexistent/proofestra-bin", [], {
      timeoutMs: 1000,
      captureStdoutBytes: 10,
      captureStderrBytes: 10,
    });
    expect(r.spawnError).toBe(true);
    expect(r.exitCode).toBeNull();
  });

  it("removes its abort listener, stream listeners and timer on every path", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const setSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      for (const mode of ["natural", "abort", "timeout"] as const) {
        const ac = new AbortController();
        const add = vi.spyOn(ac.signal, "addEventListener");
        const remove = vi.spyOn(ac.signal, "removeEventListener");
        const obs = observeChild();
        setSpy.mockClear();
        clearSpy.mockClear();
        const p = runBoundedProc(
          mode === "natural" ? NODE : "/bin/sleep",
          mode === "natural" ? ["-e", "process.stdout.write('ok')"] : ["5"],
          {
            timeoutMs: mode === "timeout" ? 80 : 5_000,
            captureStdoutBytes: 100,
            captureStderrBytes: 100,
            signal: ac.signal,
            onChild: obs.onChild,
          },
        );
        if (mode === "abort") {
          await new Promise((r) => setTimeout(r, 40));
          ac.abort();
        }
        await p;
        const child = obs.get();
        expect(child.stdout!.listenerCount("data")).toBe(0);
        expect(child.stderr!.listenerCount("data")).toBe(0);
        expect(child.listenerCount("close")).toBe(0);
        expect(child.listenerCount("error")).toBe(0);
        expect(add).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledTimes(1);
        // The runner's own timer handle was cleared.
        const runnerTimers = setSpy.mock.results
          .map((r) => r.value as NodeJS.Timeout)
          .filter((t) => (t as unknown as { _idleTimeout: number })._idleTimeout !== 40);
        expect(runnerTimers.length).toBeGreaterThan(0);
        for (const t of runnerTimers) {
          expect(clearSpy.mock.calls.some((c) => c[0] === t)).toBe(true);
        }
      }
    } finally {
      clearSpy.mockRestore();
      setSpy.mockRestore();
    }
  });

  it("does not remove third-party listeners on the child", async () => {
    const third = vi.fn();
    const r = await runBoundedProc(NODE, ["-e", "process.stdout.write('x')"], {
      timeoutMs: 5_000,
      captureStdoutBytes: 10,
      captureStderrBytes: 10,
      onChild: (c) => {
        c.stdout!.on("data", third);
        c.on("close", third);
      },
    });
    expect(r.stdout).toBe("x");
    expect(third).toHaveBeenCalled();
  });

  it("runs with a fixed environment and no shell", async () => {
    const r = await runBoundedProc("/usr/bin/env", [], {
      timeoutMs: 5_000,
      captureStdoutBytes: 4096,
      captureStderrBytes: 1024,
    });
    const lines = r.stdout.split("\n").filter(Boolean).sort();
    expect(lines).toEqual(["LC_ALL=C", "PATH=/usr/bin:/bin"]);
    // A shell metacharacter argument stays a literal argv element.
    const echo = await runBoundedProc("/bin/echo", ["a;b $HOME `x`"], {
      timeoutMs: 5_000,
      captureStdoutBytes: 1024,
      captureStderrBytes: 1024,
    });
    expect(echo.stdout).toBe("a;b $HOME `x`\n");
  });
});

describe("decodeBoundedUtf8", () => {
  it("drops an incomplete trailing sequence and keeps complete ones", () => {
    const full = Buffer.from("aก", "utf8"); // 1 + 3 bytes
    expect(decodeBoundedUtf8([full.subarray(0, 3)], 3)).toBe("a");
    expect(decodeBoundedUtf8([full], 4)).toBe("aก");
    expect(decodeBoundedUtf8([], 0)).toBe("");
  });
});

// Additional real-subprocess behavior tests for the bounded runner
// (complements tests/unit/bounded_proc.test.ts). Children are plain `node -e`
// scripts; nothing here touches the network or any user data.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeBoundedUtf8, runBoundedProc } from "../../src/core/parsers/boundedProc.js";

const NODE = process.execPath;

let tmpDir: string;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proofestra-boundedproc-"));
});
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const run = (script: string, opts: Partial<Parameters<typeof runBoundedProc>[2]> = {}) =>
  runBoundedProc(NODE, ["-e", script], {
    timeoutMs: 8_000,
    captureStdoutBytes: 1024,
    captureStderrBytes: 1024,
    ...opts,
  });

describe("runBoundedProc results", () => {
  it("a normal exit reports its code, both streams and no limit flags", async () => {
    const r = await run("process.stdout.write('out'); process.stderr.write('err'); process.exit(3)");
    expect(r).toEqual({
      stdout: "out",
      stderr: "err",
      exitCode: 3,
      signaled: false,
      aborted: false,
      timedOut: false,
      truncatedStdoutBytes: false,
      truncatedStderrBytes: false,
      spawnError: false,
    });
  });

  it("a child that kills itself is signaled with no exit code and is not mistaken for a timeout or abort", async () => {
    const r = await run("process.kill(process.pid, 'SIGKILL'); setInterval(()=>{}, 1000)");
    expect(r.signaled).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.timedOut).toBe(false);
    expect(r.aborted).toBe(false);
  });

  it("stdout over the cap in LATER chunks keeps the exact prefix, kills the child and flags truncation", async () => {
    const r = await run(
      "process.stdout.write('AAAAA'); setTimeout(()=>{process.stdout.write('BBBBB')}, 150); setInterval(()=>{}, 1000)",
      { captureStdoutBytes: 5 },
    );
    expect(r.stdout).toBe("AAAAA");
    expect(r.truncatedStdoutBytes).toBe(true);
    expect(r.signaled).toBe(true);
    expect(r.timedOut).toBe(false);
  });

  it("a zero or negative stdout cap captures nothing but still reports truncation once output arrives", async () => {
    for (const cap of [0, -5, 0.9]) {
      const r = await run("process.stdout.write('data'); setInterval(()=>{}, 1000)", { captureStdoutBytes: cap });
      expect(r.stdout, `cap ${cap}`).toBe("");
      expect(r.truncatedStdoutBytes, `cap ${cap}`).toBe(true);
    }
  });

  it("stderr is capped independently without killing the child", async () => {
    const r = await run(
      "process.stderr.write('0123456789'); setTimeout(()=>{process.stderr.write('MORE'); process.stdout.write('done')}, 150)",
      { captureStderrBytes: 4 },
    );
    expect(r.stderr).toBe("0123");
    expect(r.truncatedStderrBytes).toBe(true);
    expect(r.stdout).toBe("done");
    expect(r.exitCode).toBe(0);
    expect(r.signaled).toBe(false);
  });

  it("stderr that fits the cap exactly is not flagged", async () => {
    const r = await run("process.stderr.write('abcd')", { captureStderrBytes: 4 });
    expect(r.stderr).toBe("abcd");
    expect(r.truncatedStderrBytes).toBe(false);
  });

  it("a spawn() that throws synchronously (invalid argv) is reported as spawnError, not thrown", async () => {
    const r = await runBoundedProc(NODE, ["bad\u0000arg"], {
      timeoutMs: 1_000,
      captureStdoutBytes: 10,
      captureStderrBytes: 10,
    });
    expect(r.spawnError).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toBe("");
  });

  it("a caller-provided blob FD becomes the child's stdin and is NOT closed by the runner", async () => {
    const file = path.join(tmpDir, "blob.bin");
    fs.writeFileSync(file, "BLOB CONTENT FROM FD");
    const fd = fs.openSync(file, fs.constants.O_RDONLY);
    try {
      const r = await runBoundedProc("/bin/cat", [], {
        timeoutMs: 5_000,
        captureStdoutBytes: 1024,
        captureStderrBytes: 1024,
        stdio: [fd, "pipe", "pipe"],
      });
      expect(r.stdout).toBe("BLOB CONTENT FROM FD");
      expect(r.exitCode).toBe(0);
      // The parent's descriptor is still valid: closing it is the caller's job.
      expect(() => fs.fstatSync(fd)).not.toThrow();
    } finally {
      fs.closeSync(fd);
    }
  });

  it("an abort that fires after the child already finished does not flip the result", async () => {
    const ac = new AbortController();
    const r = await run("process.stdout.write('quick')", { signal: ac.signal });
    ac.abort();
    expect(r.aborted).toBe(false);
    expect(r.stdout).toBe("quick");
  });

  it("a timeout shorter than the minimum is still honored as at least 1 ms", async () => {
    const r = await runBoundedProc("/bin/sleep", ["5"], {
      timeoutMs: 0,
      captureStdoutBytes: 10,
      captureStderrBytes: 10,
    });
    expect(r.timedOut).toBe(true);
    expect(r.signaled).toBe(true);
  });
});

describe("decodeBoundedUtf8 edge cases", () => {
  const dec = (bytes: number[]) => decodeBoundedUtf8([Buffer.from(bytes)], bytes.length);

  it("drops an incomplete 2-, 3- and 4-byte tail but keeps complete sequences", () => {
    expect(dec([0x41, 0xc3])).toBe("A");
    expect(dec([0x41, 0xe0, 0xb8])).toBe("A");
    expect(dec([0x41, 0xf0, 0x9f, 0x98])).toBe("A");
    expect(dec([0x41, 0xc3, 0xa9])).toBe("Aé");
    expect(dec([0xf0, 0x9f, 0x98, 0x80])).toBe("😀");
  });

  it("an ASCII tail and an empty buffer are untouched", () => {
    expect(dec([0x68, 0x69])).toBe("hi");
    expect(dec([])).toBe("");
  });

  it("an invalid lead byte (0xF8+) is treated as a single byte and decodes to U+FFFD", () => {
    expect(dec([0x41, 0xf8])).toBe("A\ufffd");
  });

  it("a run of continuation bytes longer than any sequence is left to the decoder, never looped on", () => {
    expect(dec([0x80, 0x80, 0x80, 0x80, 0x80])).toBe("\ufffd".repeat(5));
  });

  it("joins multiple chunks before looking at the tail", () => {
    const full = Buffer.from("กข", "utf8"); // 6 bytes
    expect(decodeBoundedUtf8([full.subarray(0, 2), full.subarray(2, 5)], 5)).toBe("ก");
    expect(decodeBoundedUtf8([full.subarray(0, 2), full.subarray(2)], 6)).toBe("กข");
  });
});

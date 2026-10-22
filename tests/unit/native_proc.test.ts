// Supervision guarantees of the native job runner, exercised with real child
// processes (the test's own node binary): bounded streaming, whole-tree kill,
// cancel/timeout, explicit environment, stdin-only prompt delivery.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runNativeJob, type NativeJobOpts } from "../../src/core/nativeProc.js";

const NODE = process.execPath;
const dirs: string[] = [];
function scratch(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pf-proc-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function opts(code: string, over: Partial<NativeJobOpts> = {}, lines: string[] = []): NativeJobOpts {
  return {
    argv: ["-e", code],
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    cwd: scratch(),
    stdin: "",
    timeoutMs: 10_000,
    maxStdoutBytes: 1 << 20,
    maxLineBytes: 1 << 16,
    stderrSampleBytes: 64,
    onLine: (line) => {
      lines.push(line);
      return "continue";
    },
    ...over,
  };
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50; i += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  return false;
}

describe("runNativeJob", () => {
  it("frames stdout into lines, including a final line with no newline, and delivers stdin", async () => {
    const lines: string[] = [];
    const r = await runNativeJob(
      NODE,
      opts(
        `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write("a\\r\\n\\nb\\n"+s.toUpperCase())})`,
        { stdin: "tail" },
        lines,
      ),
    );
    expect(lines).toEqual(["a", "b", "TAIL"]);
    expect(r).toMatchObject({ exitCode: 0, signaled: false, timedOut: false, aborted: false, spawnError: false });
  });

  it("passes ONLY the given environment and cwd (no inherited secrets)", async () => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-must-not-leak";
    try {
      const lines: string[] = [];
      const cwd = scratch();
      await runNativeJob(
        NODE,
        opts(`console.log(JSON.stringify({env:process.env,cwd:process.cwd()}))`, { cwd, env: { PATH: "/usr/bin:/bin", HOME: "/h" } }, lines),
      );
      const seen = JSON.parse(lines[0]!) as { env: Record<string, string>; cwd: string };
      expect(Object.keys(seen.env).filter((k) => k !== "__CF_USER_TEXT_ENCODING").sort()).toEqual(["HOME", "PATH"]);
      expect(lines[0]).not.toContain("sk-must-not-leak");
      expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(cwd));
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
  });

  it("a rejected line kills the child immediately and later output is never delivered", async () => {
    const lines: string[] = [];
    const started = Date.now();
    const r = await runNativeJob(
      NODE,
      opts(`console.log("bad");console.log("after");setInterval(()=>{},1000)`, {
        onLine: (l) => {
          lines.push(l);
          return l === "bad" ? "kill" : "continue";
        },
      }),
    );
    expect(r.killedByHandler).toBe(true);
    expect(r.signaled).toBe(true);
    expect(lines).toEqual(["bad"]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("total stdout over the cap kills the child", async () => {
    const r = await runNativeJob(
      NODE,
      opts(`const l="x".repeat(100)+"\\n";setInterval(()=>process.stdout.write(l),1)`, { maxStdoutBytes: 2_000 }),
    );
    expect(r.stdoutOverflow).toBe(true);
    expect(r.signaled).toBe(true);
  });

  it("a single line over the cap (no newline) kills the child", async () => {
    const lines: string[] = [];
    const r = await runNativeJob(
      NODE,
      opts(`process.stdout.write("y".repeat(5000));setInterval(()=>{},1000)`, { maxLineBytes: 1_000 }, lines),
    );
    expect(r.lineOverflow).toBe(true);
    expect(lines).toEqual([]);
  });

  describe("per-line byte cap", () => {
    const write = (js: string): string => `${js};setInterval(()=>{},1000)`;

    it("a COMPLETE newline-terminated line over the cap is refused before delivery", async () => {
      const lines: string[] = [];
      const r = await runNativeJob(
        NODE,
        opts(write(`process.stdout.write("z".repeat(1001)+"\\n")`), { maxLineBytes: 1_000 }, lines),
      );
      expect(r.lineOverflow).toBe(true);
      expect(r.signaled).toBe(true);
      expect(lines).toEqual([]);
    });

    it("a line of exactly the cap is delivered; one byte more is not (terminated and final)", async () => {
      const ok: string[] = [];
      const exact = await runNativeJob(
        NODE,
        opts(`process.stdout.write("a".repeat(1000)+"\\n"+"b".repeat(1000))`, { maxLineBytes: 1_000 }, ok),
      );
      expect(exact.lineOverflow).toBe(false);
      expect(ok.map((l) => l.length)).toEqual([1000, 1000]);

      const over: string[] = [];
      const r = await runNativeJob(
        NODE,
        opts(`process.stdout.write("a".repeat(1001))`, { maxLineBytes: 1_000 }, over),
      );
      expect(r.lineOverflow).toBe(true);
      expect(over).toEqual([]);
    });

    it("an overlong line assembled across many chunks is still refused", async () => {
      const lines: string[] = [];
      const code = write(
        `let i=0;const t=setInterval(()=>{process.stdout.write("q".repeat(400));if(++i===4){process.stdout.write("\\n");clearInterval(t)}},30)`,
      );
      const r = await runNativeJob(NODE, opts(code, { maxLineBytes: 1_000 }, lines));
      expect(r.lineOverflow).toBe(true);
      expect(lines).toEqual([]);
    });

    it("lines before an overlong one in the same chunk are delivered; the overlong one and later ones are not", async () => {
      const lines: string[] = [];
      const r = await runNativeJob(
        NODE,
        opts(
          write(`process.stdout.write("ok1\\nok2\\n"+"x".repeat(2000)+"\\nlate\\n")`),
          { maxLineBytes: 1_000 },
          lines,
        ),
      );
      expect(r.lineOverflow).toBe(true);
      expect(lines).toEqual(["ok1", "ok2"]);
    });

    it("CRLF framing counts the carriage return as a raw byte of the line", async () => {
      const lines: string[] = [];
      const r = await runNativeJob(
        NODE,
        opts(`process.stdout.write("c".repeat(999)+"\\r\\n")`, { maxLineBytes: 1_000 }, lines),
      );
      expect(r.lineOverflow).toBe(false);
      expect(lines).toEqual(["c".repeat(999)]);
    });
  });

  it("timeout kills the whole process GROUP: a grandchild does not survive", async () => {
    const pidFile = path.join(scratch(), "gc.pid");
    const code = `const cp=require("child_process");const c=cp.spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});require("fs").writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`;
    const r = await runNativeJob(NODE, opts(code, { timeoutMs: 600 }));
    expect(r.timedOut).toBe(true);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(Number.isInteger(pid)).toBe(true);
    expect(await gone(pid)).toBe(true);
  });

  it("a leftover descendant is swept even when the main process exits normally", async () => {
    const pidFile = path.join(scratch(), "gc2.pid");
    const code = `const cp=require("child_process");const c=cp.spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});require("fs").writeFileSync(${JSON.stringify(pidFile)},String(c.pid));process.exit(0)`;
    const r = await runNativeJob(NODE, opts(code));
    expect(r.exitCode).toBe(0);
    expect(await gone(Number(fs.readFileSync(pidFile, "utf8")))).toBe(true);
  });

  describe("bounded settlement when a descendant escapes the process group", () => {
    // The escaped grandchild is owned by the test: it inherits stdout/stderr (so it
    // holds the pipes open), leaves the child's process group (detached) and exits
    // by itself after 4 s; the test also kills it explicitly on cleanup.
    const escapee = (pidFile: string): string =>
      `const cp=require("child_process");const g=cp.spawn(process.execPath,["-e","setTimeout(()=>{},4000)"],{detached:true,stdio:["ignore",1,2]});require("fs").writeFileSync(${JSON.stringify(pidFile)},String(g.pid));g.unref();`;
    const reap = (pidFile: string): void => {
      try {
        process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL");
      } catch {
        /* already gone */
      }
    };

    it("a timed-out job whose escaped grandchild holds the pipes settles in bounded time and says so", async () => {
      const pidFile = path.join(scratch(), "escapee.pid");
      const started = Date.now();
      const r = await runNativeJob(
        NODE,
        opts(`${escapee(pidFile)}setInterval(()=>{},1000)`, { timeoutMs: 300, settleGraceMs: 200 }),
      );
      try {
        expect(r.timedOut).toBe(true);
        expect(r.streamsForceClosed).toBe(true);
        expect(Date.now() - started).toBeLessThan(2_500);
        // The escapee is alive: nothing here claims the whole tree was killed.
        const pid = Number(fs.readFileSync(pidFile, "utf8"));
        expect(() => process.kill(pid, 0)).not.toThrow();
      } finally {
        reap(pidFile);
      }
    });

    it("a child that exits normally but leaves a pipe-holding descendant is force-closed, not trusted", async () => {
      const pidFile = path.join(scratch(), "escapee2.pid");
      const lines: string[] = [];
      const started = Date.now();
      const r = await runNativeJob(
        NODE,
        opts(`${escapee(pidFile)}process.stdout.write("done\\npartial-tail");process.exit(0)`, { settleGraceMs: 200 }, lines),
      );
      try {
        expect(r.exitCode).toBe(0);
        expect(r.timedOut).toBe(false);
        expect(r.streamsForceClosed).toBe(true);
        expect(Date.now() - started).toBeLessThan(2_500);
        // The unterminated tail after a force-close is not delivered as a line.
        expect(lines).toEqual(["done"]);
      } finally {
        reap(pidFile);
      }
    });

    it("a clean child with no descendants never reports a force-close or an unreaped child", async () => {
      const r = await runNativeJob(NODE, opts(`process.stdout.write("x\\n")`, { settleGraceMs: 200 }));
      expect(r).toMatchObject({ exitCode: 0, streamsForceClosed: false, unreaped: false });
    });

    it("leaves no timer or handle behind after a force-closed settle", async () => {
      const pidFile = path.join(scratch(), "escapee3.pid");
      const before = (process as unknown as { getActiveResourcesInfo(): string[] }).getActiveResourcesInfo().filter((n) => n === "Timeout").length;
      await runNativeJob(NODE, opts(`${escapee(pidFile)}setInterval(()=>{},1000)`, { timeoutMs: 200, settleGraceMs: 100 }));
      reap(pidFile);
      await new Promise((r) => setTimeout(r, 50));
      const after = (process as unknown as { getActiveResourcesInfo(): string[] }).getActiveResourcesInfo().filter((n) => n === "Timeout").length;
      expect(after).toBeLessThanOrEqual(before);
    });
  });

  it("abort mid-run kills the child and resolves only after close", async () => {
    const ac = new AbortController();
    let closed = false;
    const p = runNativeJob(
      NODE,
      opts(`setInterval(()=>{},1000)`, {
        signal: ac.signal,
        onChild: (c) => c.once("close", () => (closed = true)),
      }),
    );
    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(closed).toBe(true);
  });

  it("an already-aborted signal never spawns", async () => {
    const ac = new AbortController();
    ac.abort();
    let spawned = false;
    const r = await runNativeJob(NODE, opts(`1`, { signal: ac.signal, onChild: () => (spawned = true) }));
    expect(r.aborted).toBe(true);
    expect(spawned).toBe(false);
  });

  it("a missing executable reports spawnError, not a throw", async () => {
    const r = await runNativeJob("/nonexistent/codex", opts(""));
    expect(r.spawnError).toBe(true);
    expect(r.exitCode).toBeNull();
  });

  it("a nonexistent cwd is a spawn error too", async () => {
    const r = await runNativeJob(NODE, opts(`1`, { cwd: "/nonexistent/dir/for/test" }));
    expect(r.spawnError).toBe(true);
  });

  it("keeps only a tiny stderr sample and tolerates a child that never reads stdin", async () => {
    const r = await runNativeJob(
      NODE,
      opts(`process.stderr.write("E".repeat(500));process.exit(3)`, { stderrSampleBytes: 16, stdin: "z".repeat(200_000) }),
    );
    expect(r.stderrSample).toBe("E".repeat(16));
    expect(r.exitCode).toBe(3);
  });
});

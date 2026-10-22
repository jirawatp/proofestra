// Binary discovery classification with the filesystem and child_process faked
// (nothing is spawned; no real tool or environment is consulted). The fixed
// child environment itself is asserted by tests/unit/binary_tools_env.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

type SpawnOut = { stdout?: Buffer | null; stderr?: Buffer | null } | Error;

const state = {
  files: new Map<string, "file" | "dir" | "error">(),
  probes: new Map<string, SpawnOut>(),
  probed: [] as Array<[string, string]>,
};

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const spawnSync = (bin: string, args: string[]) => {
    state.probed.push([bin, args[0]!]);
    const out = state.probes.get(bin) ?? { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    if (out instanceof Error) throw out;
    return out;
  };
  return { ...original, spawnSync };
});
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  const statSync = (p: string) => {
    const kind = state.files.get(p);
    if (kind === undefined || kind === "error") throw new Error("ENOENT");
    return { isFile: () => kind === "file" };
  };
  return { ...original, statSync, default: { ...original, statSync } };
});

async function freshTools() {
  const tools = await import("../../src/core/parsers/binaryTools.js");
  tools.__resetBinaryToolsCache();
  return tools;
}

const out = (s: string) => ({ stdout: Buffer.from(s), stderr: Buffer.alloc(0) });
const err = (s: string) => ({ stdout: Buffer.alloc(0), stderr: Buffer.from(s) });

beforeEach(() => {
  state.files.clear();
  state.probes.clear();
  state.probed.length = 0;
});

describe("binary tool discovery", () => {
  it("nothing installed: every capability is false and no probe is run", async () => {
    const tools = await freshTools();
    expect(tools.describeBinaryToolCapabilities()).toEqual({ pdf_text_extraction: false, media_metadata_probe: false });
    expect(tools.discoverPopplerPair()).toBeNull();
    expect(tools.discoverFfprobe()).toBeNull();
    expect(state.probed).toEqual([]);
  });

  it("uses the first existing candidate, the right version flag, and accepts either output channel", async () => {
    state.files.set("/opt/homebrew/bin/pdfinfo", "file");
    state.files.set("/usr/bin/pdfinfo", "file");
    state.files.set("/usr/local/bin/pdftotext", "file");
    state.files.set("/usr/bin/ffprobe", "file");
    state.probes.set("/opt/homebrew/bin/pdfinfo", err("pdfinfo version 24.02\nCopyright"));
    state.probes.set("/usr/bin/pdfinfo", err("should not be reached"));
    state.probes.set("/usr/local/bin/pdftotext", err("pdftotext version 24.02"));
    state.probes.set("/usr/bin/ffprobe", out("ffprobe version 7.0\nbuilt with clang"));
    const tools = await freshTools();
    const pair = tools.discoverPopplerPair();
    expect(pair).toEqual({
      pdfinfo: { path: "/opt/homebrew/bin/pdfinfo", version: "pdfinfo version 24.02" },
      pdftotext: { path: "/usr/local/bin/pdftotext", version: "pdftotext version 24.02" },
    });
    expect(tools.discoverFfprobe()).toEqual({ path: "/usr/bin/ffprobe", version: "ffprobe version 7.0" });
    expect(state.probed).toContainEqual(["/opt/homebrew/bin/pdfinfo", "-v"]);
    expect(state.probed).toContainEqual(["/usr/bin/ffprobe", "-version"]);
    expect(state.probed.some(([bin]) => bin === "/usr/bin/pdfinfo")).toBe(false);
    expect(tools.describeBinaryToolCapabilities()).toEqual({ pdf_text_extraction: true, media_metadata_probe: true });
  });

  it("skips a candidate that is a directory, unreadable, throws when probed, or prints nothing, then falls through", async () => {
    state.files.set("/opt/homebrew/bin/ffprobe", "dir");
    state.files.set("/usr/local/bin/ffprobe", "file");
    state.files.set("/usr/bin/ffprobe", "file");
    state.probes.set("/usr/local/bin/ffprobe", new Error("EACCES"));
    state.probes.set("/usr/bin/ffprobe", out("ffprobe fallback 1"));
    const tools = await freshTools();
    expect(tools.discoverFfprobe()).toEqual({ path: "/usr/bin/ffprobe", version: "ffprobe fallback 1" });
    expect(state.probed.map(([b]) => b)).toEqual(["/usr/local/bin/ffprobe", "/usr/bin/ffprobe"]);

    state.files.clear();
    state.probed.length = 0;
    state.files.set("/opt/homebrew/bin/ffprobe", "file");
    state.probes.set("/opt/homebrew/bin/ffprobe", { stdout: Buffer.from("  \n "), stderr: null });
    const silent = await freshTools();
    expect(silent.discoverFfprobe()).toBeNull();
  });

  it("a missing stdout/stderr buffer is tolerated and the version line is cut to 120 characters", async () => {
    state.files.set("/usr/bin/ffprobe", "file");
    state.probes.set("/usr/bin/ffprobe", { stdout: null, stderr: Buffer.from("v".repeat(300)) });
    const tools = await freshTools();
    expect(tools.discoverFfprobe()!.version).toHaveLength(120);
  });

  it("a half-installed Poppler (only one of the pair) is unavailable, and the result is cached", async () => {
    state.files.set("/usr/bin/pdfinfo", "file");
    state.probes.set("/usr/bin/pdfinfo", err("pdfinfo 1"));
    const tools = await freshTools();
    expect(tools.discoverPopplerPair()).toBeNull();
    expect(tools.describeBinaryToolCapabilities().pdf_text_extraction).toBe(false);
    const probes = state.probed.length;
    tools.discoverFfprobe();
    tools.describeBinaryToolCapabilities();
    expect(state.probed.length).toBe(probes);
  });
});

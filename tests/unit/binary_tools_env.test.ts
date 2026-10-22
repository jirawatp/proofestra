// Binary discovery must probe `-v` / `-version` with the FIXED environment,
// never the server's own (which can hold provider keys). The child process
// and the filesystem are mocked: nothing is spawned and no env is read.
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSync = vi.fn(() => ({ stdout: Buffer.from("tool 1.0\n"), stderr: Buffer.alloc(0) }));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawnSync };
});
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  const statSync = (): { isFile: () => boolean } => ({ isFile: () => true });
  return { ...original, statSync, default: { ...original, statSync } };
});

describe("binary discovery environment", () => {
  beforeEach(() => spawnSync.mockClear());

  it("runs every version probe with { LC_ALL: 'C', PATH: '/usr/bin:/bin' } and no shell", async () => {
    const tools = await import("../../src/core/parsers/binaryTools.js");
    tools.__resetBinaryToolsCache();
    expect(tools.describeBinaryToolCapabilities()).toEqual({
      pdf_text_extraction: true,
      media_metadata_probe: true,
    });
    expect(spawnSync).toHaveBeenCalledTimes(3);
    for (const call of spawnSync.mock.calls as unknown as Array<[string, string[], Record<string, unknown>]>) {
      expect(call[2]["env"]).toEqual({ LC_ALL: "C", PATH: "/usr/bin:/bin" });
      expect(call[2]["shell"]).toBe(false);
    }
    // Cached after the first discovery: no further probes.
    tools.describeBinaryToolCapabilities();
    expect(spawnSync).toHaveBeenCalledTimes(3);
    tools.__resetBinaryToolsCache();
  });
});

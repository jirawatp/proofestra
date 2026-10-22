// Additional zipCore rejection/limit branches (complements tests/unit/zip_core.test.ts).
// Each case patches a well-formed in-memory archive at one field and asserts
// the exact rejection code; nothing is written to disk.

import { describe, expect, it } from "vitest";
import {
  describeZipRejection,
  parseZipCentralDirectory,
  readZipEntry,
  ZipValidationError,
  type ZipRejectionCode,
} from "../../src/core/parsers/zipCore.js";
import { buildZip, type BuildEntry } from "./_zipBuilder.js";

const text = Buffer.from("zip core branch text\n".repeat(10));

/** Offsets for a single-entry archive made by `buildZip`. */
function layout(data: Buffer) {
  const eocd = data.length - 22;
  const cdOffset = data.readUInt32LE(eocd + 16);
  return { eocd, cdOffset, cdSize: data.readUInt32LE(eocd + 12) };
}

function patched(data: Buffer, edit: (b: Buffer, l: ReturnType<typeof layout>) => void): Buffer {
  const copy = Buffer.from(data);
  edit(copy, layout(copy));
  return copy;
}

function codeOf(data: Buffer, read = false): ZipRejectionCode | null {
  try {
    const zip = parseZipCentralDirectory(data);
    if (read) for (const e of zip.entries) readZipEntry(data, e, 1024 * 1024);
    return null;
  } catch (err) {
    if (err instanceof ZipValidationError) return err.code;
    throw err;
  }
}

const one = (extra: Partial<BuildEntry> = {}): Buffer => buildZip([{ name: "a.txt", data: text, ...extra }]);

describe("central directory refusals", () => {
  it("a central directory that claims to extend past the end-of-central-directory record is truncated", () => {
    expect(codeOf(patched(one(), (b, l) => b.writeUInt32LE(l.cdSize + 500, l.eocd + 12)))).toBe("truncated");
  });

  it("an entry count larger than the records actually present is truncated", () => {
    const two = patched(one(), (b, l) => {
      b.writeUInt16LE(2, l.eocd + 8);
      b.writeUInt16LE(2, l.eocd + 10);
    });
    expect(codeOf(two)).toBe("truncated");
  });

  it("a central header without its signature is truncated", () => {
    expect(codeOf(patched(one(), (b, l) => b.writeUInt32LE(0xdeadbeef, l.cdOffset)))).toBe("truncated");
  });

  it("trailing bytes inside the declared central directory are truncated, not ignored", () => {
    const base = one();
    const { eocd, cdSize } = layout(base);
    const withJunk = Buffer.concat([base.subarray(0, eocd), Buffer.alloc(7, 0x41), base.subarray(eocd)]);
    withJunk.writeUInt32LE(cdSize + 7, withJunk.length - 22 + 12);
    expect(codeOf(withJunk)).toBe("truncated");
  });

  it("an EOCD record cut short at the end of the file is truncated", () => {
    const base = one();
    const cut = Buffer.concat([base, Buffer.alloc(0)]);
    // Keep the EOCD signature but drop its tail: signature found with < 22 bytes left.
    const sigOnly = Buffer.concat([base.subarray(0, base.length - 22), Buffer.alloc(18, 0), Buffer.from([0x50, 0x4b, 0x05, 0x06])]);
    expect(codeOf(sigOnly)).toBe("truncated");
    expect(codeOf(cut.subarray(0, 21))).toBe("truncated");
  });

  it("a multi-disk start (cdDisk or per-entry disk) is refused", () => {
    expect(codeOf(patched(one(), (b, l) => b.writeUInt16LE(1, l.eocd + 6)))).toBe("multi_disk_unsupported");
    expect(codeOf(patched(one(), (b, l) => b.writeUInt16LE(1, l.cdOffset + 34)))).toBe("multi_disk_unsupported");
  });

  it("ZIP64 sentinels in any central size or offset field are refused", () => {
    for (const field of [20, 24, 42]) {
      expect(codeOf(patched(one(), (b, l) => b.writeUInt32LE(0xffffffff, l.cdOffset + field))), `field ${field}`).toBe(
        "zip64_unsupported",
      );
    }
    expect(codeOf(patched(one(), (b, l) => b.writeUInt32LE(0xffffffff, l.eocd + 12)))).toBe("zip64_unsupported");
  });

  it("an empty entry name is refused", () => {
    expect(codeOf(patched(one(), (b, l) => b.writeUInt16LE(0, l.cdOffset + 28)))).toBe("truncated");
  });

  it("a record whose name/extra/comment lengths run past the directory is truncated", () => {
    expect(codeOf(patched(one(), (b, l) => b.writeUInt16LE(2000, l.cdOffset + 32)))).toBe("truncated");
  });

  it("a local header offset that points into or beyond the central directory is truncated", () => {
    expect(codeOf(patched(one(), (b, l) => b.writeUInt32LE(l.cdOffset, l.cdOffset + 42)))).toBe("truncated");
    expect(codeOf(patched(one(), (b, l) => b.writeUInt32LE(l.cdOffset + 5, l.cdOffset + 42)))).toBe("truncated");
  });

  it("name rules: backslash and drive-letter absolutes, traversal with either separator, and valid look-alikes", () => {
    const rejects: Array<[string, ZipRejectionCode]> = [
      ["\\share\\x.txt", "absolute_path"],
      ["C:\\x.txt", "absolute_path"],
      ["d:/x.txt", "absolute_path"],
      ["ok/../x.txt", "traversal"],
      ["ok\\..\\x.txt", "traversal"],
      ["..", "traversal"],
    ];
    for (const [name, code] of rejects) expect(codeOf(buildZip([{ name, data: text }])), name).toBe(code);
    for (const name of ["dir/..hidden.txt", "a..b.txt", "x:y.txt", "dir/sub/file.txt"]) {
      expect(codeOf(buildZip([{ name, data: text }])), name).toBeNull();
    }
  });

  it("a symlink entry is refused wherever its Unix mode is stored", () => {
    const zip = patched(one(), (b, l) => b.writeUInt32LE((0xa1ff << 16) >>> 0, l.cdOffset + 38));
    expect(codeOf(zip)).toBe("symlink");
    // A regular-file mode is fine.
    expect(codeOf(patched(one(), (b, l) => b.writeUInt32LE((0x81a4 << 16) >>> 0, l.cdOffset + 38)))).toBeNull();
  });

  it("size limits: one entry or the running total over 100 MiB are declared_size; ratio guard needs a compressed size", () => {
    const over = 100 * 1024 * 1024 + 1;
    expect(codeOf(patched(one(), (b, l) => b.writeUInt32LE(over, l.cdOffset + 24)))).toBe("declared_size");
    const two = buildZip([
      { name: "a.bin", data: text, method: 0 },
      { name: "b.bin", data: text, method: 0 },
    ]);
    const total = Buffer.from(two);
    const cd = layout(total).cdOffset;
    // 60 MiB + 60 MiB: each fits alone, the sum does not (compressed sizes
    // raised so the ratio guard would pass).
    for (const [i, size] of [[0, 60 * 1024 * 1024], [1, 60 * 1024 * 1024]] as const) {
      const rec = cd + i * (46 + 5);
      total.writeUInt32LE(size, rec + 24);
      total.writeUInt32LE(size, rec + 20);
    }
    expect(codeOf(total)).toBe("declared_size");
    // compressed size 0 with a declared size is a ratio failure (no divide by zero).
    expect(codeOf(patched(one(), (b, l) => b.writeUInt32LE(0, l.cdOffset + 20)))).toBe("compression_ratio");
  });
});

describe("local header cross-checks", () => {
  it("a local header with oversized name/extra lengths is truncated at parse time", () => {
    expect(codeOf(patched(one(), (b) => b.writeUInt16LE(0xffff, 26)))).toBe("truncated");
    expect(codeOf(patched(one(), (b) => b.writeUInt16LE(0xffff, 28)))).toBe("truncated");
  });

  it("an encrypted flag that only the LOCAL header carries is still refused", () => {
    expect(codeOf(patched(one(), (b) => b.writeUInt16LE(1, 6)))).toBe("encrypted");
  });

  it("compressed data that runs into the central directory is truncated", () => {
    const grown = patched(one(), (b, l) => {
      b.writeUInt32LE(b.readUInt32LE(18) + 50, 18);
      b.writeUInt32LE(b.readUInt32LE(l.cdOffset + 20) + 50, l.cdOffset + 20);
    });
    expect(codeOf(grown)).toBe("truncated");
  });

  it("readZipEntry re-checks the header against a buffer that has since been cut", () => {
    const data = one();
    const entry = parseZipCentralDirectory(data).entries[0]!;
    expect(() => readZipEntry(data.subarray(0, 20), entry, 4096)).toThrowError(
      expect.objectContaining({ code: "truncated" }),
    );
    expect(() => readZipEntry(data.subarray(0, 40), entry, 4096)).toThrowError(
      expect.objectContaining({ code: "truncated" }),
    );
  });
});

describe("readZipEntry size and data consistency", () => {
  it("a stored entry whose declared size differs from its stored bytes is a size mismatch", () => {
    const zip = buildZip([{ name: "a.txt", data: text, method: 0, centralUncompressed: text.length - 3 }]);
    expect(codeOf(zip, true)).toBe("local_central_size_mismatch");
  });

  it("an entry declared empty must have no payload (stored) or only a tiny empty-deflate payload", () => {
    const stored = buildZip([{ name: "a.txt", data: Buffer.from("abc"), method: 0, centralUncompressed: 0 }]);
    expect(codeOf(stored, true)).toBe("local_central_size_mismatch");
    const deflated = buildZip([{ name: "a.txt", data: Buffer.from("abcdefghijkl"), method: 8, centralUncompressed: 0 }]);
    expect(codeOf(deflated, true)).toBe("local_central_size_mismatch");
  });

  it("an empty deflate stream (2-byte payload) for an empty entry is accepted", () => {
    const zip = buildZip([{ name: "e.txt", data: Buffer.alloc(0), method: 8 }]);
    const entry = parseZipCentralDirectory(zip).entries[0]!;
    expect(entry.compressedSize).toBeLessThanOrEqual(2);
    expect(readZipEntry(zip, entry, 16).length).toBe(0);
  });

  it("deflate output larger than the declared size is declared_size; shorter than declared is declared_size too", () => {
    const bigger = buildZip([{ name: "a.txt", data: text, centralUncompressed: 20 }]);
    expect(codeOf(bigger, true)).toBe("declared_size");
    const smaller = buildZip([{ name: "a.txt", data: text, centralUncompressed: text.length + 40 }]);
    expect(codeOf(smaller, true)).toBe("declared_size");
  });

  it("a content CRC mismatch (central and local agree on a wrong value) is reported when the entry is read", () => {
    const zip = buildZip([{ name: "a.txt", data: text, centralCrc: 99, localCrc: 99 }]);
    expect(codeOf(zip)).toBeNull();
    expect(codeOf(zip, true)).toBe("crc_mismatch");
  });

  it("the caller's output cap is enforced before any local-header work", () => {
    const data = one();
    const entry = parseZipCentralDirectory(data).entries[0]!;
    expect(() => readZipEntry(data, entry, text.length - 1)).toThrowError(expect.objectContaining({ code: "declared_size" }));
    expect(readZipEntry(data, entry, text.length).equals(text)).toBe(true);
  });
});

describe("EOCD search window", () => {
  it("finds an EOCD followed by a ZIP comment of up to 64 KiB and ignores one that is further back", () => {
    const base = one();
    const comment = Buffer.alloc(300, 0x20);
    const withComment = Buffer.concat([base, comment]);
    withComment.writeUInt16LE(comment.length, base.length - 2);
    expect(codeOf(withComment, true)).toBeNull();
    const farBack = Buffer.concat([base, Buffer.alloc(0x10000 + 64, 0x20)]);
    expect(codeOf(farBack)).toBe("truncated");
  });
});

describe("describeZipRejection", () => {
  it("gives every rejection code a distinct, fixed, path-free sentence", () => {
    const codes: ZipRejectionCode[] = [
      "encrypted",
      "traversal",
      "absolute_path",
      "duplicate_entry",
      "symlink",
      "compression_ratio",
      "declared_size",
      "crc_mismatch",
      "local_central_name_mismatch",
      "local_central_size_mismatch",
      "local_central_method_mismatch",
      "multi_disk_unsupported",
      "zip64_unsupported",
      "truncated",
      "corrupt_entry",
      "unsupported_method",
    ];
    const sentences = codes.map(describeZipRejection);
    expect(new Set(sentences).size).toBe(codes.length);
    for (const s of sentences) {
      expect(s.length).toBeGreaterThan(10);
      expect(s).not.toMatch(/[/\\]|\.\.|undefined/);
    }
    expect(describeZipRejection("zip64_unsupported")).toBe("ZIP64 archives are not supported");
  });

  it("ZipValidationError carries its code as name, message and field", () => {
    const err = new ZipValidationError("symlink");
    expect(err).toBeInstanceOf(Error);
    expect([err.name, err.message, err.code]).toEqual(["ZipValidationError", "symlink", "symlink"]);
  });
});

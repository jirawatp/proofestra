import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseZipCentralDirectory,
  readZipEntry,
  ZipValidationError,
  type ZipRejectionCode,
} from "../../src/core/parsers/zipCore.js";
import { buildZip } from "./_zipBuilder.js";

const ZIP_DIR = path.resolve(import.meta.dirname, "../fixtures/content/zip");

/** Parse and read every entry; return the rejection code or null. */
function rejectionOf(data: Buffer): ZipRejectionCode | null {
  try {
    const zip = parseZipCentralDirectory(data);
    for (const entry of zip.entries) readZipEntry(data, entry, 128 * 1024);
    return null;
  } catch (err) {
    if (err instanceof ZipValidationError) return err.code;
    throw err;
  }
}

describe("zipCore hostile fixtures", () => {
  const expected: Record<string, ZipRejectionCode> = {
    "traversal.zip": "traversal",
    "absolute.zip": "absolute_path",
    "windows-absolute.zip": "absolute_path",
    "duplicate-entry.zip": "duplicate_entry",
    "symlink.zip": "symlink",
    "high-ratio-small.zip": "compression_ratio",
    "bad-crc.zip": "crc_mismatch",
    "local-central-name-mismatch.zip": "local_central_name_mismatch",
    "local-central-size-mismatch.zip": "local_central_size_mismatch",
    "local-central-method-mismatch.zip": "local_central_method_mismatch",
    // 128 MiB declared in a 25-byte stored entry: refused as declared size
    // before any read (the ratio check would also fire; size is checked first).
    "declared-inflated-limit.zip": "declared_size",
    "multi-disk.zip": "multi_disk_unsupported",
    "truncated.zip": "truncated",
    "encrypted.zip": "encrypted",
  };
  for (const [file, code] of Object.entries(expected)) {
    it(`${file} -> ${code}`, () => {
      expect(rejectionOf(fs.readFileSync(path.join(ZIP_DIR, file)))).toBe(code);
    });
  }

  it("benign fixtures parse and every read entry verifies", () => {
    for (const file of ["supported-mixed.zip", "nested-only.zip"]) {
      expect(rejectionOf(fs.readFileSync(path.join(ZIP_DIR, file)))).toBeNull();
    }
    expect(parseZipCentralDirectory(fs.readFileSync(path.join(ZIP_DIR, "empty.zip"))).entries).toEqual([]);
  });
});

describe("zipCore synthetic archives", () => {
  const text = Buffer.from("hello zip core\n".repeat(20));

  it("reads stored and RAW deflate entries (not zlib-wrapped) with exact CRC", () => {
    const data = buildZip([
      { name: "a.txt", data: text, method: 8 },
      { name: "b.txt", data: text, method: 0 },
    ]);
    const zip = parseZipCentralDirectory(data);
    expect(zip.entries.map((e) => e.name)).toEqual(["a.txt", "b.txt"]);
    for (const e of zip.entries) expect(readZipEntry(data, e, 4096).equals(text)).toBe(true);
  });

  it("with bit 3 the local CRC/sizes must be zero and central values are used", () => {
    const ok = buildZip([{ name: "d.txt", data: text, flags: 0x0008, localCrc: 0, localSizes: [0, 0] }]);
    const z = parseZipCentralDirectory(ok);
    expect(readZipEntry(ok, z.entries[0]!, 4096).equals(text)).toBe(true);
    const bad = buildZip([{ name: "d.txt", data: text, flags: 0x0008, localCrc: 1, localSizes: [0, 0] }]);
    expect(rejectionOf(bad)).toBe("local_central_size_mismatch");
  });

  it("refuses an inflated length that differs from the declared size", () => {
    const lie = buildZip([{ name: "x.txt", data: text, centralUncompressed: text.length - 10 }]);
    expect(rejectionOf(lie)).toBe("declared_size");
  });

  it("refuses ZIP64 sentinels, too many entries and unsupported methods", () => {
    const one = buildZip([{ name: "a.txt", data: text }]);
    const zip64 = Buffer.from(one);
    zip64.writeUInt32LE(0xffffffff, zip64.length - 22 + 16);
    expect(rejectionOf(zip64)).toBe("zip64_unsupported");
    const total = Buffer.from(one);
    total.writeUInt16LE(0xffff, total.length - 22 + 10);
    total.writeUInt16LE(0xffff, total.length - 22 + 8);
    expect(rejectionOf(total)).toBe("zip64_unsupported");
    const many = Buffer.from(one);
    many.writeUInt16LE(1025, many.length - 22 + 10);
    many.writeUInt16LE(1025, many.length - 22 + 8);
    expect(rejectionOf(many)).toBe("declared_size");
    const method = Buffer.from(one);
    const cdOffset = method.readUInt32LE(method.length - 22 + 16);
    method.writeUInt16LE(14, cdOffset + 10);
    expect(rejectionOf(method)).toBe("unsupported_method");
  });

  it("refuses a name over 512 UTF-8 bytes and an entry larger than the read cap", () => {
    expect(rejectionOf(buildZip([{ name: "n".repeat(513), data: text }]))).toBe("truncated");
    const data = buildZip([{ name: "big.txt", data: Buffer.alloc(200 * 1024, 0x61), method: 0 }]);
    const zip = parseZipCentralDirectory(data);
    expect(() => readZipEntry(data, zip.entries[0]!, 128 * 1024)).toThrowError(
      expect.objectContaining({ code: "declared_size" }),
    );
  });

  it("refuses data that is cut off or whose local header is missing", () => {
    const data = buildZip([{ name: "a.txt", data: text }]);
    const zip = parseZipCentralDirectory(data);
    const broken = Buffer.from(data);
    broken.writeUInt32LE(0, 0); // clobber the local header signature
    expect(() => readZipEntry(broken, zip.entries[0]!, 4096)).toThrowError(
      expect.objectContaining({ code: "truncated" }),
    );
    expect(rejectionOf(data.subarray(0, 10))).toBe("truncated");
    expect(rejectionOf(Buffer.alloc(0))).toBe("truncated");
  });

  it("handles empty members explicitly (no inflate call) and rejects bad empties", () => {
    for (const method of [0, 8] as const) {
      const data = buildZip([{ name: "__init__.py", data: Buffer.alloc(0), method }]);
      const zip = parseZipCentralDirectory(data);
      expect(readZipEntry(data, zip.entries[0]!, 1024).length).toBe(0);
    }
    const badCrc = buildZip([{ name: "e.txt", data: Buffer.alloc(0), method: 0, centralCrc: 5, localCrc: 5 }]);
    expect(rejectionOf(badCrc)).toBe("crc_mismatch");
  });

  it("maps corrupt deflate data to corrupt_entry and checks every local header at parse time", () => {
    const data = buildZip([{ name: "c.txt", data: text }]);
    const zip = parseZipCentralDirectory(data);
    const dataStart = 30 + "c.txt".length;
    const corrupt = Buffer.from(data);
    corrupt.fill(0xff, dataStart, dataStart + 6);
    expect(() => readZipEntry(corrupt, zip.entries[0]!, 4096)).toThrowError(
      expect.objectContaining({ code: "corrupt_entry" }),
    );
    // An entry that is never read still fails the parse when its local header lies.
    const lying = buildZip([
      { name: "ok.txt", data: text },
      { name: "never-read.bin", data: text, localSizes: [1, 1] },
    ]);
    expect(() => parseZipCentralDirectory(lying)).toThrowError(
      expect.objectContaining({ code: "local_central_size_mismatch" }),
    );
  });
});

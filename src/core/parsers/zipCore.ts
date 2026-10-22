// One hardened ZIP core shared by the Office and the plain-ZIP extractors.
//
// Scope: parse the central directory of an in-memory archive and read a
// SELECTED entry into memory. Nothing is ever written to disk, nothing is
// recursed into, and nothing is executed.
//
// Hard bounds (all enforced BEFORE any inflate):
//   - at most 1,024 entries, entry names at most 512 UTF-8 bytes;
//   - declared uncompressed total at most 100 MiB;
//   - per-entry compression ratio at most 100x;
//   - only stored (0) and raw deflate (8); everything else is refused;
//   - no encryption, symlinks, absolute or traversal names, duplicate
//     names, multi-disk archives, or ZIP64 (sentinel values are refused,
//     not parsed).
//
// Every entry that is actually read is checked against its local header
// (name, method, sizes; with bit 3 the local CRC/sizes must be zero and the
// central values are used), inflated with a hard `maxOutputLength`, and
// verified for exact length and CRC-32.

import { crc32, inflateRawSync } from "node:zlib";

export const ZIP_MAX_ENTRIES = 1024;
export const ZIP_MAX_NAME_BYTES = 512;
export const ZIP_MAX_DECLARED_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
export const ZIP_MAX_COMPRESSION_RATIO = 100;

export type ZipRejectionCode =
  | "encrypted"
  | "traversal"
  | "absolute_path"
  | "duplicate_entry"
  | "symlink"
  | "compression_ratio"
  | "declared_size"
  | "crc_mismatch"
  | "local_central_name_mismatch"
  | "local_central_size_mismatch"
  | "local_central_method_mismatch"
  | "multi_disk_unsupported"
  | "zip64_unsupported"
  | "truncated"
  | "corrupt_entry"
  | "unsupported_method";

export class ZipValidationError extends Error {
  constructor(readonly code: ZipRejectionCode) {
    super(code);
    this.name = "ZipValidationError";
  }
}

export interface ZipEntry {
  name: string;
  flags: number;
  method: 0 | 8;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  externalAttributes: number;
}

export interface ParsedZip {
  entries: ZipEntry[];
  totalDeclaredUncompressed: number;
}

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const EOCD_MIN = 22;

export function parseZipCentralDirectory(data: Buffer): ParsedZip {
  if (data.length < EOCD_MIN) throw new ZipValidationError("truncated");
  const searchStart = Math.max(0, data.length - (0xffff + EOCD_MIN));
  let eocd = -1;
  for (let i = data.length - 4; i >= searchStart; i -= 1) {
    if (data.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  // An EOCD signature whose fixed record is cut short is a truncated file.
  if (eocd < 0 || eocd + EOCD_MIN > data.length) throw new ZipValidationError("truncated");

  const diskNo = data.readUInt16LE(eocd + 4);
  const cdDisk = data.readUInt16LE(eocd + 6);
  const entriesOnDisk = data.readUInt16LE(eocd + 8);
  const totalEntries = data.readUInt16LE(eocd + 10);
  const cdSize = data.readUInt32LE(eocd + 12);
  const cdOffset = data.readUInt32LE(eocd + 16);
  if (diskNo !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new ZipValidationError("multi_disk_unsupported");
  }
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipValidationError("zip64_unsupported");
  }
  if (totalEntries > ZIP_MAX_ENTRIES) throw new ZipValidationError("declared_size");
  if (cdOffset + cdSize > eocd) throw new ZipValidationError("truncated");

  const cdEnd = cdOffset + cdSize;
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let offset = cdOffset;
  let totalDeclared = 0;
  for (let i = 0; i < totalEntries; i += 1) {
    if (offset + 46 > cdEnd) throw new ZipValidationError("truncated");
    if (data.readUInt32LE(offset) !== CDH_SIG) throw new ZipValidationError("truncated");
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    const crc = data.readUInt32LE(offset + 16);
    const compressedSize = data.readUInt32LE(offset + 20);
    const uncompressedSize = data.readUInt32LE(offset + 24);
    const nameLen = data.readUInt16LE(offset + 28);
    const extraLen = data.readUInt16LE(offset + 30);
    const commentLen = data.readUInt16LE(offset + 32);
    const diskStart = data.readUInt16LE(offset + 34);
    const externalAttributes = data.readUInt32LE(offset + 38);
    const localHeaderOffset = data.readUInt32LE(offset + 42);

    if ((flags & 0x0001) !== 0) throw new ZipValidationError("encrypted");
    if (diskStart !== 0) throw new ZipValidationError("multi_disk_unsupported");
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new ZipValidationError("zip64_unsupported");
    }
    if (nameLen === 0 || nameLen > ZIP_MAX_NAME_BYTES) throw new ZipValidationError("truncated");
    const recordEnd = offset + 46 + nameLen + extraLen + commentLen;
    if (recordEnd > cdEnd) throw new ZipValidationError("truncated");
    const name = data.subarray(offset + 46, offset + 46 + nameLen).toString("utf-8");

    if (name.startsWith("/") || name.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(name)) {
      throw new ZipValidationError("absolute_path");
    }
    if (name.split(/[\\/]/).some((part) => part === "..")) {
      throw new ZipValidationError("traversal");
    }
    if (seen.has(name)) throw new ZipValidationError("duplicate_entry");
    seen.add(name);
    if (((externalAttributes >>> 16) & 0xf000) === 0xa000) {
      throw new ZipValidationError("symlink");
    }
    if (method !== 0 && method !== 8) throw new ZipValidationError("unsupported_method");

    totalDeclared += uncompressedSize;
    if (
      uncompressedSize > ZIP_MAX_DECLARED_UNCOMPRESSED_BYTES ||
      totalDeclared > ZIP_MAX_DECLARED_UNCOMPRESSED_BYTES
    ) {
      throw new ZipValidationError("declared_size");
    }
    if (uncompressedSize > 0) {
      if (compressedSize === 0 || uncompressedSize / compressedSize > ZIP_MAX_COMPRESSION_RATIO) {
        throw new ZipValidationError("compression_ratio");
      }
    }
    if (localHeaderOffset >= cdOffset) throw new ZipValidationError("truncated");

    entries.push({
      name,
      flags,
      method,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      externalAttributes,
    });
    offset = recordEnd;
  }
  if (offset !== cdEnd) throw new ZipValidationError("truncated");
  // Second pass so central-directory refusals keep priority: every entry's
  // local header and data range must agree with the central record, even
  // for entries that are never read.
  for (const entry of entries) checkLocalHeader(data, entry, cdOffset);
  return { entries, totalDeclaredUncompressed: totalDeclared };
}

interface LocalHeader {
  dataStart: number;
}

/**
 * Cross-check an entry's local header against its central record and
 * return where its data starts. Runs for EVERY entry at parse time and
 * again right before an entry is read. With bit 3 (data descriptor) the
 * local CRC/sizes must be zero and the central values are trusted.
 */
function checkLocalHeader(data: Buffer, entry: ZipEntry, dataLimit: number): LocalHeader {
  const base = entry.localHeaderOffset;
  if (base + 30 > data.length) throw new ZipValidationError("truncated");
  if (data.readUInt32LE(base) !== LFH_SIG) throw new ZipValidationError("truncated");
  const localFlags = data.readUInt16LE(base + 6);
  const localMethod = data.readUInt16LE(base + 8);
  const localCrc = data.readUInt32LE(base + 14);
  const localCompressed = data.readUInt32LE(base + 18);
  const localUncompressed = data.readUInt32LE(base + 22);
  const nameLen = data.readUInt16LE(base + 26);
  const extraLen = data.readUInt16LE(base + 28);
  const nameStart = base + 30;
  const dataStart = nameStart + nameLen + extraLen;
  if (dataStart > data.length) throw new ZipValidationError("truncated");

  const localName = data.subarray(nameStart, nameStart + nameLen).toString("utf-8");
  if (localName !== entry.name) throw new ZipValidationError("local_central_name_mismatch");
  if (localMethod !== entry.method) throw new ZipValidationError("local_central_method_mismatch");
  if ((localFlags & 0x0001) !== 0) throw new ZipValidationError("encrypted");
  if ((localFlags & 0x0008) !== 0) {
    if (localCrc !== 0 || localCompressed !== 0 || localUncompressed !== 0) {
      throw new ZipValidationError("local_central_size_mismatch");
    }
  } else {
    if (
      localCompressed !== entry.compressedSize ||
      localUncompressed !== entry.uncompressedSize
    ) {
      throw new ZipValidationError("local_central_size_mismatch");
    }
    if (localCrc !== entry.crc32) throw new ZipValidationError("crc_mismatch");
  }
  if (dataStart + entry.compressedSize > dataLimit) throw new ZipValidationError("truncated");
  return { dataStart };
}

/**
 * Read one entry fully into memory after validating its local header against
 * the central directory. Throws `ZipValidationError`; never returns partial
 * or unverified bytes.
 */
export function readZipEntry(data: Buffer, entry: ZipEntry, maxOutputBytes: number): Buffer {
  if (entry.uncompressedSize > maxOutputBytes) throw new ZipValidationError("declared_size");
  const { dataStart } = checkLocalHeader(data, entry, data.length);
  const compressed = data.subarray(dataStart, dataStart + entry.compressedSize);

  let out: Buffer;
  if (entry.uncompressedSize === 0) {
    // `inflateRawSync` rejects maxOutputLength 0, and an empty member is
    // legitimate (e.g. an empty `__init__.py`): never inflate it.
    if (entry.method === 0 ? compressed.length !== 0 : compressed.length > 2) {
      throw new ZipValidationError("local_central_size_mismatch");
    }
    out = Buffer.alloc(0);
  } else if (entry.method === 0) {
    if (compressed.length !== entry.uncompressedSize) {
      throw new ZipValidationError("local_central_size_mismatch");
    }
    out = compressed;
  } else {
    try {
      out = inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ERR_BUFFER_TOO_LARGE") throw new ZipValidationError("declared_size");
      throw new ZipValidationError("corrupt_entry");
    }
    if (out.length !== entry.uncompressedSize) throw new ZipValidationError("declared_size");
  }
  if (crc32(out) !== entry.crc32) throw new ZipValidationError("crc_mismatch");
  return out;
}

/** Short, fixed, path-free human reason for a rejection code. */
export function describeZipRejection(code: ZipRejectionCode): string {
  switch (code) {
    case "encrypted":
      return "encrypted entries are not supported";
    case "traversal":
      return "an entry name tries to leave the archive directory";
    case "absolute_path":
      return "an entry name is an absolute path";
    case "duplicate_entry":
      return "duplicate entry names";
    case "symlink":
      return "symbolic-link entries are refused";
    case "compression_ratio":
      return "compression ratio exceeds the safety limit";
    case "declared_size":
      return "declared or actual size exceeds the safety limit";
    case "crc_mismatch":
      return "an entry failed its CRC-32 check";
    case "local_central_name_mismatch":
      return "local and central entry names disagree";
    case "local_central_size_mismatch":
      return "local and central entry sizes disagree";
    case "local_central_method_mismatch":
      return "local and central compression methods disagree";
    case "multi_disk_unsupported":
      return "multi-disk archives are not supported";
    case "zip64_unsupported":
      return "ZIP64 archives are not supported";
    case "truncated":
      return "the archive is truncated or malformed";
    case "corrupt_entry":
      return "an entry's compressed data is corrupt";
    case "unsupported_method":
      return "an entry uses an unsupported compression method";
  }
}

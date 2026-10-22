// ZIP inventory plus bounded supported text-entry content. SYNCHRONOUS and
// meant to run only inside the resource-limited, terminable worker.
//
// Scope:
//   1. Validate the whole archive through `zipCore` (entry/size/ratio caps,
//      traversal/absolute/duplicate/symlink/encrypted/multi-disk/ZIP64
//      refusal).
//   2. Inventory at most 64 entries. Nothing in an inventory line ever
//      reaches a filesystem call.
//   3. Read ONLY supported text-like entries (each at most 128 KiB, each
//      CRC- and header-verified) until the shared character budget runs out.
//   4. Never recurse: a nested archive, and any binary/unsupported entry, is
//      listed as excluded and its bytes are never read. Nothing is written
//      to disk and nothing is executed (source files are read as inert text).

import fs from "node:fs";
import { ATTACHMENT_POLICY, sniffMime } from "../attachments.js";
import type { ExtractionResult } from "../attachmentExtraction.js";
import {
  describeZipRejection,
  parseZipCentralDirectory,
  readZipEntry,
  ZipValidationError,
} from "./zipCore.js";

const ZIP_ENTRY_READ_BYTES = 128 * 1024;
const INVENTORY_LIMIT = 64;

export const ZIP_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "ndjson", "jsonl", "log",
  "xml", "yml", "yaml", "ini", "cfg", "toml", "sql",
  "py", "js", "ts", "tsx", "jsx", "java", "c", "cc", "cpp", "h", "hpp",
  "go", "rs", "rb", "php", "sh",
]);

const NESTED_ARCHIVE_EXTENSIONS: ReadonlySet<string> = new Set([
  "zip", "jar", "war", "apk", "docx", "xlsx", "pptx", "odt", "ods", "odp",
  "7z", "rar", "tar", "gz", "tgz", "bz2", "xz",
]);

export interface ZipExtractionInput {
  blob_path: string;
  byte_size: number;
}

function extOf(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

function displayName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 160);
}

const NON_TEXT_KINDS: ReadonlySet<string> = new Set(["archive", "image", "pdf", "audio", "video"]);

function decodeStrictUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** `slice(0, max)` that never leaves half of a surrogate pair at the end. */
function sliceWithoutSplitSurrogate(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

function printable(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
}

export function extractZipArchiveSync(input: ZipExtractionInput): ExtractionResult {
  const charCap = ATTACHMENT_POLICY.max_extracted_chars;
  let data: Buffer;
  try {
    data = fs.readFileSync(input.blob_path);
  } catch {
    return failed("ZIP could not be read");
  }
  try {
    const zip = parseZipCentralDirectory(data);
    if (zip.entries.length === 0) {
      return {
        status: "none",
        coverage: { extracted_chars: 0, truncated: false, label: "empty ZIP (0 entries)" },
        extractedText: null,
      };
    }
    const lines: string[] = [
      `ZIP archive, ${plural(zip.entries.length)} (metadata only unless the entry text is shown below).`,
    ];
    const excluded: string[] = [];
    const shown = Math.min(zip.entries.length, INVENTORY_LIMIT);
    for (let i = 0; i < shown; i += 1) {
      const e = zip.entries[i]!;
      lines.push(
        `- ${displayName(e.name)} · ${e.compressedSize} B compressed · ${e.uncompressedSize} B declared`,
      );
    }
    if (zip.entries.length > shown) {
      lines.push(`… and ${zip.entries.length - shown} more entries not listed.`);
      excluded.push(`${zip.entries.length - shown} entries beyond the ${INVENTORY_LIMIT}-entry inventory limit`);
    }
    // An OOXML/ODF package renamed to .zip: its XML parts are internal
    // document structure, never dumped as raw text.
    const looksLikePackage = zip.entries.some(
      (e) => e.name === "[Content_Types].xml" || e.name === "mimetype",
    );
    let text = lines.join("\n");
    let overflowed = false;

    for (const entry of zip.entries) {
      if (entry.name.endsWith("/")) continue; // directory
      const ext = extOf(entry.name);
      const label = displayName(entry.name);
      if (NESTED_ARCHIVE_EXTENSIONS.has(ext)) {
        excluded.push(`${label} — nested archive, not recursed`);
        continue;
      }
      if (looksLikePackage && ext === "xml") {
        excluded.push(`${label} — Office/ODF package part, not read as raw text`);
        continue;
      }
      if (!ZIP_TEXT_EXTENSIONS.has(ext)) {
        excluded.push(`${label} — unsupported or binary entry type, not read`);
        continue;
      }
      if (entry.uncompressedSize === 0) continue;
      if (entry.uncompressedSize > ZIP_ENTRY_READ_BYTES) {
        excluded.push(`${label} — exceeds the ${ZIP_ENTRY_READ_BYTES}-byte per-entry read cap`);
        continue;
      }
      if (overflowed) {
        excluded.push(`${label} — text budget exhausted`);
        continue;
      }
      const bytes = readZipEntry(data, entry, ZIP_ENTRY_READ_BYTES);
      // The extension is only a hint: a nested archive or binary renamed
      // `.txt`/`.json`/`.py` must not be dumped as text.
      const kind = sniffMime(bytes.subarray(0, 64)).kind;
      const decodedStrict = bytes.indexOf(0) >= 0 || NON_TEXT_KINDS.has(kind) ? null : decodeStrictUtf8(bytes);
      if (decodedStrict === null) {
        excluded.push(`${label} — content is not UTF-8 text (binary or archive bytes), not shown`);
        continue;
      }
      const decoded = printable(decodedStrict);
      const header = `\n--- ${label} (${entry.uncompressedSize} B) ---\n`;
      const room = charCap - text.length - header.length;
      if (room <= 0) {
        overflowed = true;
        excluded.push(`${label} — text budget exhausted`);
        continue;
      }
      text += header + sliceWithoutSplitSurrogate(decoded, room);
      if (decoded.length > room) {
        overflowed = true;
        excluded.push(`${label} — content truncated at the text budget`);
      }
    }
    if (excluded.length > 0) {
      const footer = `\n--- excluded ---\n${excluded.map((s) => `- ${s}`).join("\n")}`;
      const room = charCap - text.length;
      if (room > 0) text += sliceWithoutSplitSurrogate(footer, room);
    }
    text = sliceWithoutSplitSurrogate(text, charCap);
    const truncated = excluded.length > 0 || overflowed;
    return {
      status: truncated ? "truncated" : "text_extracted",
      coverage: {
        extracted_chars: text.length,
        truncated,
        label: `ZIP inventory + bounded text entries (${plural(zip.entries.length)}, ${excluded.length} excluded)`,
      },
      extractedText: text,
    };
  } catch (err) {
    if (err instanceof ZipValidationError) {
      return {
        status: err.code === "encrypted" ? "encrypted" : "failed",
        coverage: {
          extracted_chars: 0,
          truncated: false,
          label: `ZIP rejected (${err.code}): ${describeZipRejection(err.code)}`,
        },
        extractedText: null,
      };
    }
    return failed("ZIP extraction failed");
  }
}

function plural(n: number): string {
  return `${n} ${n === 1 ? "entry" : "entries"}`;
}

function failed(label: string): ExtractionResult {
  return {
    status: "failed",
    coverage: { extracted_chars: 0, truncated: false, label },
    extractedText: null,
  };
}

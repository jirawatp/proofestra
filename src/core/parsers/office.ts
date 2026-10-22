// Bounded Office document text extraction (DOCX / XLSX / PPTX / ODT / ODS /
// ODP). SYNCHRONOUS and meant to run only inside the resource-limited,
// terminable worker (`attachmentWorker.ts`); never call it on the server's
// main thread.
//
// Pipeline:
//   1. `zipCore` validates the archive (bounds, names, ratios, ...).
//   2. Only the documented text parts are read, each through
//      `readZipEntry` (local-header cross-check, bounded raw inflate, CRC).
//   3. A part containing `<!DOCTYPE` or `<!ENTITY` (any case) is refused and
//      the WHOLE document becomes `unsupported`. No DTD, entity or external
//      reference is ever resolved, fetched or read; only the five XML
//      built-in entities are decoded.
//   4. A small namespace-aware tokenizer keeps character data that sits
//      inside the text elements of the recognized namespaces (matched by
//      namespace URI + local name, so `doc:` and `w:` prefixes both work).
//      It builds no DOM. XLSX formulas are never evaluated: only shared and
//      inline strings are harvested. Macros/VBA parts are never read.

import fs from "node:fs";
import type { ExtractionResult } from "../attachmentExtraction.js";
import { ATTACHMENT_POLICY } from "../attachments.js";
import { scanXml, XmlLimitError } from "./xmlScan.js";
import {
  describeZipRejection,
  parseZipCentralDirectory,
  readZipEntry,
  ZipValidationError,
  type ZipEntry,
} from "./zipCore.js";

const OFFICE_MAX_ENTRY_BYTES = 32 * 1024 * 1024;
// Total inflated bytes across the selected parts of one document. V8
// `resourceLimits` do not cap Buffer memory, so this is an explicit bound.
const OFFICE_MAX_TOTAL_INFLATED_BYTES = 64 * 1024 * 1024;

const NS_WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const NS_DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_SHEET = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_ODF_TEXT = "urn:oasis:names:tc:opendocument:xmlns:text:1.0";

export type OfficeKind = "docx" | "xlsx" | "pptx" | "odt" | "ods" | "odp";

export interface OfficeExtractionInput {
  blob_path: string;
  byte_size: number;
  office_kind: OfficeKind;
  /** Macro-enabled/template variant: the label says macros are not executed. */
  macro_variant?: boolean;
}

/** Macro-enabled or template OOXML extensions: parsed as text, macros never run. */
export function isMacroOrTemplateVariant(sanitizedDisplayName: string): boolean {
  return /\.(docm|dotx|dotm|xlsm|xltx|xltm|pptm|potx|potm|ppsx|ppsm)$/.test(
    sanitizedDisplayName.toLowerCase(),
  );
}

/**
 * Decide the office kind from a sanitized display name extension. ZIP magic
 * alone cannot distinguish DOCX from a plain ZIP, so the extension routes to
 * the Office path and everything else is handled as a plain ZIP.
 */
export function officeKindFromName(sanitizedDisplayName: string): OfficeKind | null {
  const lower = sanitizedDisplayName.toLowerCase();
  if (/\.(docx|docm|dotx|dotm)$/.test(lower)) return "docx";
  if (/\.(xlsx|xlsm|xltx|xltm)$/.test(lower)) return "xlsx";
  if (/\.(pptx|pptm|potx|potm|ppsx|ppsm)$/.test(lower)) return "pptx";
  if (lower.endsWith(".odt")) return "odt";
  if (lower.endsWith(".ods")) return "ods";
  if (lower.endsWith(".odp")) return "odp";
  return null;
}

export function extractOfficeTextSync(input: OfficeExtractionInput): ExtractionResult {
  const kindLabel = input.office_kind.toUpperCase();
  const macroNote =
    (input.macro_variant ? "; macros not executed" : "") +
    (input.office_kind === "xlsx" ? "; cached values, formulas not evaluated" : "");
  const charCap = ATTACHMENT_POLICY.max_extracted_chars;
  let data: Buffer;
  try {
    data = fs.readFileSync(input.blob_path);
  } catch {
    return failedResult(`${kindLabel} could not be read`);
  }
  try {
    const zip = parseZipCentralDirectory(data);
    const wanted = pickWantedEntries(input.office_kind, zip.entries);
    if (wanted.length === 0) {
      return {
        status: "unsupported",
        coverage: {
          extracted_chars: 0,
          truncated: false,
          label: `${kindLabel} contains no recognized text parts`,
        },
        extractedText: null,
      };
    }
    const sink = new TextSink(charCap);
    let skippedOversize = false;
    let inflatedTotal = 0;
    let shared: SharedStrings = { strings: [], firstAffected: Number.POSITIVE_INFINITY };
    const sheetState: SheetState = { sharedOmitted: false };
    for (const entry of wanted) {
      if (sink.full) break;
      if (
        entry.uncompressedSize > OFFICE_MAX_ENTRY_BYTES ||
        inflatedTotal + entry.uncompressedSize > OFFICE_MAX_TOTAL_INFLATED_BYTES
      ) {
        skippedOversize = true;
        continue;
      }
      inflatedTotal += entry.uncompressedSize;
      const bytes = readZipEntry(data, entry, OFFICE_MAX_ENTRY_BYTES);
      if (isNotUtf8Xml(bytes)) return notUtf8(kindLabel);
      if (hasDtdOrEntity(bytes)) {
        return {
          status: "unsupported",
          coverage: {
            extracted_chars: 0,
            truncated: false,
            label: `${kindLabel} refused: XML DTD or entity declarations are not processed`,
          },
          extractedText: null,
        };
      }
      const xml = decodeStrictUtf8(bytes);
      if (xml === null) return notUtf8(kindLabel);
      if (input.office_kind === "xlsx" && entry.name === "xl/sharedStrings.xml") {
        // Indexed by sheet cells; never emitted on its own.
        shared = parseSharedStrings(xml);
        continue;
      }
      sink.startPart();
      if (input.office_kind === "xlsx") harvestSheet(xml, shared, sink, sheetState);
      else harvestXml(xml, input.office_kind, sink);
    }
    const text = sink.text();
    if (text.length === 0) {
      return {
        status: "unsupported",
        coverage: {
          extracted_chars: 0,
          truncated: false,
          label: `${kindLabel}: no extractable text (likely image-only)`,
        },
        extractedText: null,
      };
    }
    const sharedOmitted = sheetState.sharedOmitted;
    const truncated = sink.overflowed || skippedOversize || sharedOmitted;
    // A shared-string limit hit that a cell actually depends on is partial
    // coverage, never a silent success.
    const reasons =
      (sink.overflowed ? ` at ${charCap} chars` : "") +
      (skippedOversize ? "; oversized part not read" : "") +
      (sharedOmitted ? "; shared-string limit reached, some cached text omitted" : "");
    return {
      status: truncated ? "truncated" : "text_extracted",
      coverage: {
        extracted_chars: text.length,
        truncated,
        label: truncated
          ? `${kindLabel} text (truncated${reasons}${macroNote})`
          : `${kindLabel} text (${text.length} chars${macroNote})`,
      },
      extractedText: text,
    };
  } catch (err) {
    if (err instanceof XmlLimitError) {
      return {
        status: "unsupported",
        coverage: {
          extracted_chars: 0,
          truncated: false,
          label: `${kindLabel} refused: XML nesting or tag too large`,
        },
        extractedText: null,
      };
    }
    if (err instanceof ZipValidationError) {
      return {
        status: err.code === "encrypted" ? "encrypted" : "failed",
        coverage: {
          extracted_chars: 0,
          truncated: false,
          label: `${kindLabel} rejected (${err.code}): ${describeZipRejection(err.code)}`,
        },
        extractedText: null,
      };
    }
    return failedResult(`${kindLabel} extraction failed`);
  }
}

function notUtf8(kindLabel: string): ExtractionResult {
  return {
    status: "unsupported",
    coverage: { extracted_chars: 0, truncated: false, label: `${kindLabel} refused: XML part is not UTF-8` },
    extractedText: null,
  };
}

function failedResult(label: string): ExtractionResult {
  return {
    status: "failed",
    coverage: { extracted_chars: 0, truncated: false, label },
    extractedText: null,
  };
}

/** UTF-16 BOMs or NUL bytes in the first 4 bytes: never decode as UTF-8. */
function isNotUtf8Xml(bytes: Buffer): boolean {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    return true;
  }
  return bytes.subarray(0, 4).includes(0);
}

function hasDtdOrEntity(bytes: Buffer): boolean {
  return /<!(doctype|entity)/i.test(bytes.toString("latin1"));
}

function numericSuffix(name: string): number {
  const m = /(\d+)\.xml$/.exec(name);
  return m ? Number.parseInt(m[1]!, 10) : 0;
}

/** Exact-layout lookup; PPTX/XLSX/DOCX numbered parts sort numerically. */
function pickWantedEntries(kind: OfficeKind, entries: ZipEntry[]): ZipEntry[] {
  const byName = new Map(entries.map((e) => [e.name, e] as const));
  const numbered = (re: RegExp): ZipEntry[] =>
    entries.filter((e) => re.test(e.name)).sort((a, b) => numericSuffix(a.name) - numericSuffix(b.name));
  const names: ZipEntry[] = [];
  const add = (e: ZipEntry | undefined): void => {
    if (e) names.push(e);
  };
  if (kind === "docx") {
    add(byName.get("word/document.xml"));
    numbered(/^word\/header\d+\.xml$/).forEach(add);
    numbered(/^word\/footer\d+\.xml$/).forEach(add);
    add(byName.get("word/footnotes.xml"));
    add(byName.get("word/endnotes.xml"));
  } else if (kind === "xlsx") {
    add(byName.get("xl/sharedStrings.xml"));
    numbered(/^xl\/worksheets\/sheet\d+\.xml$/).forEach(add);
  } else if (kind === "pptx") {
    numbered(/^ppt\/slides\/slide\d+\.xml$/).forEach(add);
    numbered(/^ppt\/notesSlides\/notesSlide\d+\.xml$/).forEach(add);
  } else {
    add(byName.get("content.xml"));
  }
  return names;
}

class TextSink {
  private readonly parts: string[] = [];
  private used = 0;
  private lastChar = "";
  overflowed = false;
  constructor(private readonly cap: number) {}

  get full(): boolean {
    return this.overflowed;
  }

  /** Parts are separated by a newline. */
  startPart(): void {
    if (this.used > 0) this.newline();
  }

  push(text: string): void {
    if (this.overflowed || text.length === 0) return;
    const room = this.cap - this.used;
    let take = text;
    if (text.length > room) {
      take = text.slice(0, room);
      const last = take.charCodeAt(take.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) take = take.slice(0, -1);
      this.overflowed = true;
    }
    if (take.length === 0) return;
    this.parts.push(take);
    this.used += take.length;
    this.lastChar = take[take.length - 1]!;
  }

  newline(): void {
    if (this.used === 0 || this.lastChar === "\n" || this.overflowed) return;
    this.push("\n");
  }

  text(): string {
    return this.parts.join("").trim();
  }
}

const BUILTIN_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

/** Single-pass decode of the five XML built-ins; nothing else is expanded. */
function decodeBuiltinEntities(raw: string): string {
  if (raw.indexOf("&") < 0) return raw;
  return raw.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => BUILTIN_ENTITIES[m] ?? m);
}

function decodeStrictUtf8(bytes: Buffer): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // An XML declaration naming any other encoding is refused outright.
    const decl = /^\s*<\?xml[^>]*?encoding\s*=\s*["']([^"']+)["']/i.exec(text.slice(0, 256));
    if (decl && !/^utf-?8$/i.test(decl[1]!)) return null;
    return text;
  } catch {
    return null;
  }
}

function decodedOrNothing(raw: string, isCdata: boolean): string {
  return isCdata ? raw : decodeBuiltinEntities(raw);
}

/** Text-bearing elements for DOCX, PPTX and ODF (no DOM, no entity resolution). */
function harvestXml(xml: string, kind: OfficeKind, sink: TextSink): void {
  const odf = kind === "odt" || kind === "ods" || kind === "odp";
  let inTextElement = 0; // OOXML: inside the text element. ODF: inside text:p/h.

  scanXml(
    xml,
    {
      text(raw, isCdata) {
        if (inTextElement === 0) return;
        sink.push(decodedOrNothing(raw, isCdata));
      },
      start(uri, local) {
        if (odf) {
          if (uri !== NS_ODF_TEXT) return;
          if (local === "p" || local === "h") inTextElement += 1;
          else if (inTextElement > 0) {
            if (local === "tab") sink.push("\t");
            else if (local === "line-break") sink.push("\n");
            else if (local === "s") sink.push(" ");
          }
          return;
        }
        if (kind === "docx") {
          if (uri !== NS_WORD) return;
          if (local === "t") inTextElement += 1;
          else if (local === "tab") sink.push("\t");
          else if (local === "br" || local === "cr") sink.newline();
          return;
        }
        // pptx
        if (uri !== NS_DRAWING) return;
        if (local === "t") inTextElement += 1;
        else if (local === "br") sink.newline();
      },
      end(uri, local) {
        if (odf) {
          if (uri === NS_ODF_TEXT && (local === "p" || local === "h")) {
            inTextElement = Math.max(0, inTextElement - 1);
            sink.newline();
          }
          return;
        }
        if (kind === "docx" && uri === NS_WORD) {
          if (local === "t") inTextElement = Math.max(0, inTextElement - 1);
          else if (local === "p") sink.newline();
          return;
        }
        if (kind === "pptx" && uri === NS_DRAWING) {
          if (local === "t") inTextElement = Math.max(0, inTextElement - 1);
          else if (local === "p") sink.newline();
        }
      },
    },
    () => sink.full,
  );
}

const MAX_SHARED_STRINGS = 200_000;
const MAX_SHARED_STRING_CHARS = 8 * 1024 * 1024;

interface SharedStrings {
  strings: string[];
  /**
   * Lowest shared-string index that is missing or cut short because
   * MAX_SHARED_STRINGS or MAX_SHARED_STRING_CHARS was reached (Infinity when
   * neither limit was hit). Both limits are monotone, so every index at or
   * above it is affected.
   */
  firstAffected: number;
}

interface SheetState {
  /** A cell read a shared string that the limits dropped or truncated. */
  sharedOmitted: boolean;
}

/** `xl/sharedStrings.xml` -> strings by index (phonetic runs skipped). */
function parseSharedStrings(xml: string): SharedStrings {
  const out: string[] = [];
  let firstAffected = Number.POSITIVE_INFINITY;
  let totalChars = 0;
  let cur: string | null = null;
  let inT = 0;
  let inPhonetic = 0;
  scanXml(
    xml,
    {
      text(raw, isCdata) {
        if (cur === null || inT === 0 || inPhonetic > 0) return;
        const t = decodedOrNothing(raw, isCdata);
        totalChars += t.length;
        if (totalChars <= MAX_SHARED_STRING_CHARS) cur += t;
        else firstAffected = Math.min(firstAffected, out.length, MAX_SHARED_STRINGS);
      },
      start(uri, local) {
        if (uri !== NS_SHEET) return;
        if (local === "si") cur = "";
        else if (local === "t") inT += 1;
        else if (local === "rPh") inPhonetic += 1;
      },
      end(uri, local) {
        if (uri !== NS_SHEET) return;
        if (local === "t") inT = Math.max(0, inT - 1);
        else if (local === "rPh") inPhonetic = Math.max(0, inPhonetic - 1);
        else if (local === "si") {
          if (cur !== null) {
            if (out.length < MAX_SHARED_STRINGS) out.push(cur);
            else firstAffected = Math.min(firstAffected, MAX_SHARED_STRINGS);
          }
          cur = null;
        }
      },
    },
    () => false,
  );
  return { strings: out, firstAffected };
}

/**
 * One worksheet: STORED cell values only. Numbers, booleans, errors, cached
 * formula results (`t="str"` and numeric `<v>` beside `<f>`), inline strings,
 * and shared strings by index. Formulas are never evaluated and `<f>` text is
 * never emitted; dates stay the stored serial numbers (no number-format
 * interpretation).
 */
function harvestSheet(xml: string, shared: SharedStrings, sink: TextSink, state: SheetState): void {
  let cellType = "n";
  let inCell = false;
  let vText = "";
  let isText = "";
  let inV = 0;
  let inIs = 0;
  let inT = 0;
  let inPhonetic = 0;
  let rowHasCell = false;
  scanXml(
    xml,
    {
      text(raw, isCdata) {
        if (!inCell) return;
        if (inV > 0) vText += decodedOrNothing(raw, isCdata);
        else if (inIs > 0 && inT > 0 && inPhonetic === 0) isText += decodedOrNothing(raw, isCdata);
      },
      start(uri, local, attrs) {
        if (uri !== NS_SHEET) return;
        if (local === "c") {
          inCell = true;
          cellType = attrs().get("t") ?? "n";
          vText = "";
          isText = "";
        } else if (!inCell) {
          return;
        } else if (local === "v") inV += 1;
        else if (local === "is") inIs += 1;
        else if (local === "t") inT += 1;
        else if (local === "rPh") inPhonetic += 1;
      },
      end(uri, local) {
        if (uri !== NS_SHEET) return;
        if (local === "v") inV = Math.max(0, inV - 1);
        else if (local === "is") inIs = Math.max(0, inIs - 1);
        else if (local === "t") inT = Math.max(0, inT - 1);
        else if (local === "rPh") inPhonetic = Math.max(0, inPhonetic - 1);
        else if (local === "c" && inCell) {
          inCell = false;
          let value: string;
          if (cellType === "s") {
            const index = Number.parseInt(vText.trim(), 10);
            if (index >= shared.firstAffected) state.sharedOmitted = true;
            value = shared.strings[index] ?? "";
          } else if (cellType === "inlineStr") value = isText;
          else if (cellType === "b") value = vText.trim() === "1" ? "TRUE" : "FALSE";
          else value = vText.trim();
          if (value !== "") {
            if (rowHasCell) sink.push("\t");
            sink.push(value);
            rowHasCell = true;
          }
        } else if (local === "row") {
          rowHasCell = false;
          sink.newline();
        }
      },
    },
    () => sink.full,
  );
}

// Bounded PDF text extraction via a fixed, pre-discovered Poppler
// install. Subprocess invocation and resource bounds live in
// `boundedProc.ts`; this file only encodes the Poppler-specific argv
// layout, exit-code classification, and the honest partial-text policy.
//
// Rules:
//   - Fixed absolute binary from `discoverPopplerPair()`.
//   - `shell: false`, no user filename seen by any child process. The
//     child receives the UUID blob path and the `-l N` page cap.
//   - Hard wallclock timeout and byte caps on stdout / stderr.
//   - External AbortSignal propagates: on abort we SIGKILL and AWAIT
//     the child's `close` before returning, so the upload gate's
//     release observes a dead child (no stray subprocess).
//   - A `pdftotext` TIMEOUT that already produced non-empty UTF-8-safe
//     text returns that prefix as `truncated` (label says it timed out);
//     with no safe text it is `failed`. A `pdfinfo` timeout is always a
//     failure because page/encryption metadata is then incomplete.
//   - Stdout OVERFLOW is treated as a bounded PARTIAL success, not a
//     failure. Poppler's `-layout` output is a valid UTF-8 prefix at
//     any byte position (the layout algorithm is page-local and
//     line-local; truncation mid-line is still readable). We mark
//     `truncated: true` and return the captured prefix.
//   - Encrypted PDFs classify via BOTH the `Encrypted: yes` line in
//     pdfinfo stdout AND any stderr fragment that includes
//     "Incorrect password" / "Encryption" / "encrypted". The honest
//     label never contains the raw stderr; the PDF stays downloadable.
//   - Scanned PDFs (positive page count, no printable text after
//     extraction) classify as `unsupported` with a scanned label.

import type { ChildProcess } from "node:child_process";
import type { ExtractionResult } from "../attachmentExtraction.js";
import { ATTACHMENT_POLICY } from "../attachments.js";
import { discoverPopplerPair } from "./binaryTools.js";
import { runBoundedProc } from "./boundedProc.js";

const PDF_SPAWN_TIMEOUT_MS = 5_000;
const PDF_TEXT_CAPTURE_BYTES = 256 * 1024;
const PDF_STDERR_CAPTURE_BYTES = 8 * 1024;
const PDF_MAX_PAGES_FOR_TEXT = 20;

export interface PdfExtractionInput {
  blob_path: string;
  byte_size: number;
  signal?: AbortSignal;
  /** Test hook: receives every spawned Poppler child (pdfinfo, pdftotext). */
  onChild?: (child: ChildProcess) => void;
}

export interface PdfExtractionResult extends ExtractionResult {
  pdf_pages?: number;
  pdf_encrypted?: boolean;
  pdf_scanned_no_text?: boolean;
}

export async function extractPdfText(input: PdfExtractionInput): Promise<PdfExtractionResult> {
  const bins = discoverPopplerPair();
  if (!bins) {
    return {
      status: "unsupported",
      coverage: {
        extracted_chars: 0,
        truncated: false,
        label: "PDF text extraction unavailable (Poppler not installed on this server)",
      },
      extractedText: null,
    };
  }
  if (input.signal?.aborted) return cancelled();

  const info = await runPdfInfo(bins.pdfinfo.path, input.blob_path, input.signal, input.onChild);
  if (info.aborted) return cancelled();
  if (info.encrypted) {
    return {
      status: "encrypted",
      coverage: {
        extracted_chars: 0,
        truncated: false,
        label: "encrypted PDF (password required; text extraction refused)",
      },
      extractedText: null,
      pdf_encrypted: true,
      ...(info.pages !== null ? { pdf_pages: info.pages } : {}),
    };
  }
  if (info.failed || info.pages === null) {
    return {
      status: "failed",
      coverage: {
        extracted_chars: 0,
        truncated: false,
        label: info.ambiguous ? "PDF metadata ambiguous" : "PDF metadata parse failed",
      },
      extractedText: null,
    };
  }

  const pageCap = Math.min(info.pages, PDF_MAX_PAGES_FOR_TEXT);
  const text = await runPdfToText(bins.pdftotext.path, input.blob_path, pageCap, input.signal, input.onChild);
  if (text.aborted) return cancelled();
  if (text.encrypted) {
    // pdfinfo did not detect encryption but pdftotext stderr did (some
    // owner-password PDFs permit metadata read without password but
    // refuse text extraction).
    return {
      status: "encrypted",
      coverage: {
        extracted_chars: 0,
        truncated: false,
        label: "encrypted PDF (text extraction refused by pdftotext)",
      },
      extractedText: null,
      pdf_encrypted: true,
      pdf_pages: info.pages,
    };
  }

  // Honest partial-text policy: if the stdout bound was hit we DO NOT
  // discard the prefix. The bytes we have are a valid UTF-8 prefix of
  // the real page text — the user still gets the first N chars of
  // actual page content and the `truncated` flag flags the overflow.
  // We only classify as `failed` when there is NO text at all and the
  // run also failed (exit code non-zero after overflow handling).
  const haveAnyText = text.text !== null && text.text.length > 0;
  if (text.timedOut && !(text.text ?? "").trim()) {
    return {
      status: "failed",
      coverage: {
        extracted_chars: 0,
        truncated: false,
        label: `PDF text extraction timed out after ${PDF_SPAWN_TIMEOUT_MS / 1000} s`,
      },
      extractedText: null,
      pdf_pages: info.pages,
    };
  }
  if (text.failed && !haveAnyText) {
    return {
      status: "failed",
      coverage: { extracted_chars: 0, truncated: false, label: "PDF text extraction failed" },
      extractedText: null,
      pdf_pages: info.pages,
    };
  }

  const printable = (text.text ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]+/g, " ");
  const trimmed = printable.trim();
  if (trimmed.length === 0) {
    return {
      status: "unsupported",
      coverage: {
        extracted_chars: 0,
        truncated: false,
        label: `scanned PDF or image-only text (${info.pages} pages — no selectable text)`,
      },
      extractedText: null,
      pdf_pages: info.pages,
      pdf_scanned_no_text: true,
    };
  }

  const charCap = ATTACHMENT_POLICY.max_extracted_chars;
  const extracted = sliceWithoutSplitSurrogate(trimmed, charCap);
  const truncatedByChar = trimmed.length > charCap;
  const truncatedByPage = info.pages > PDF_MAX_PAGES_FOR_TEXT;
  const truncatedByBytes = text.truncatedByBytes;
  const truncatedByTimeout = text.timedOut;
  const truncated = truncatedByChar || truncatedByPage || truncatedByBytes || truncatedByTimeout;
  const labelParts: string[] = [`PDF (${info.pages} pages)`];
  if (truncatedByPage) labelParts.push(`first ${PDF_MAX_PAGES_FOR_TEXT} pages`);
  if (truncatedByChar) labelParts.push(`truncated at ${charCap} chars`);
  else if (truncatedByBytes) labelParts.push(`stdout truncated at ${PDF_TEXT_CAPTURE_BYTES} bytes`);
  if (truncatedByTimeout) {
    labelParts.push(`text extraction timed out after ${PDF_SPAWN_TIMEOUT_MS / 1000} s; partial text`);
  }

  return {
    status: truncated ? "truncated" : "text_extracted",
    coverage: {
      extracted_chars: extracted.length,
      truncated,
      label: labelParts.join(" · "),
    },
    extractedText: extracted,
    pdf_pages: info.pages,
  };
}

interface PdfInfoResult {
  pages: number | null;
  encrypted: boolean;
  failed: boolean;
  aborted?: boolean;
  /** The stdout had zero or several `Pages:`/`Encrypted:` lines. */
  ambiguous?: boolean;
}

async function runPdfInfo(
  bin: string,
  path: string,
  signal?: AbortSignal,
  onChild?: (child: ChildProcess) => void,
): Promise<PdfInfoResult> {
  const r = await runBoundedProc(bin, [path], {
    timeoutMs: PDF_SPAWN_TIMEOUT_MS,
    captureStdoutBytes: 32 * 1024,
    captureStderrBytes: PDF_STDERR_CAPTURE_BYTES,
    ...(signal ? { signal } : {}),
    ...(onChild ? { onChild } : {}),
  });
  if (r.aborted) return { pages: null, encrypted: false, failed: false, aborted: true };
  if (r.spawnError) return { pages: null, encrypted: false, failed: true };
  // Page/encryption metadata is incomplete after a timeout: always a failure.
  if (r.timedOut) return { pages: null, encrypted: false, failed: true };
  if (r.exitCode !== 0) {
    if (looksEncrypted(r.stderr)) {
      return { pages: null, encrypted: true, failed: false };
    }
    return { pages: null, encrypted: false, failed: true };
  }
  // `pdfinfo` prints Info-dictionary strings verbatim BEFORE its own
  // `Pages:` / `Encrypted:` lines, newlines included, so a document can
  // plant look-alike lines. Accept the output only when each key appears on
  // exactly one line; otherwise fail closed.
  const lines = r.stdout.split(/\r?\n/);
  const pagesLines = lines.filter((l) => l.startsWith("Pages:"));
  const encryptedLines = lines.filter((l) => l.startsWith("Encrypted:"));
  if (pagesLines.length !== 1 || encryptedLines.length !== 1) {
    return { pages: null, encrypted: false, failed: true, ambiguous: true };
  }
  const encryptedMatch = /^Encrypted:\s*(yes|no)\b/.exec(encryptedLines[0]!);
  const pagesMatch = /^Pages:\s*(\d+)\s*$/.exec(pagesLines[0]!);
  if (!encryptedMatch || !pagesMatch) {
    return { pages: null, encrypted: false, failed: true, ambiguous: true };
  }
  if (encryptedMatch[1] === "yes") {
    return { pages: null, encrypted: true, failed: false };
  }
  const n = Number.parseInt(pagesMatch[1]!, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) {
    return { pages: null, encrypted: false, failed: true };
  }
  return { pages: n, encrypted: false, failed: false };
}

interface PdfTextResult {
  text: string | null;
  failed: boolean;
  encrypted: boolean;
  aborted?: boolean;
  timedOut: boolean;
  truncatedByBytes: boolean;
}

async function runPdfToText(
  bin: string,
  path: string,
  pageCap: number,
  signal?: AbortSignal,
  onChild?: (child: ChildProcess) => void,
): Promise<PdfTextResult> {
  const argv = [
    "-layout",
    "-nopgbrk",
    "-enc", "UTF-8",
    "-eol", "unix",
    "-q",
    "-l", String(pageCap),
    path,
    "-",
  ];
  const r = await runBoundedProc(bin, argv, {
    timeoutMs: PDF_SPAWN_TIMEOUT_MS,
    captureStdoutBytes: PDF_TEXT_CAPTURE_BYTES,
    captureStderrBytes: PDF_STDERR_CAPTURE_BYTES,
    ...(signal ? { signal } : {}),
    ...(onChild ? { onChild } : {}),
  });
  const base = { aborted: false, timedOut: false, truncatedByBytes: r.truncatedStdoutBytes };
  if (r.aborted) return { ...base, text: null, failed: false, encrypted: false, aborted: true };
  if (r.spawnError) return { ...base, text: null, failed: true, encrypted: false };
  // Encryption trumps everything else.
  if (looksEncrypted(r.stderr)) return { ...base, text: null, failed: false, encrypted: true };
  if (r.timedOut) {
    // Whatever was captured before the kill is a valid UTF-8-safe prefix.
    return { ...base, text: r.stdout, failed: false, encrypted: false, timedOut: true };
  }
  // Stdout overflow is a bounded SUCCESS — the captured prefix is still
  // valid page text.
  if (r.exitCode === 0 || r.truncatedStdoutBytes) {
    return { ...base, text: r.stdout, failed: false, encrypted: false };
  }
  return { ...base, text: null, failed: true, encrypted: false };
}

/**
 * True iff the sanitized stderr fragment suggests the PDF was
 * encrypted. Poppler emits phrases like:
 *   - "Error: PDF file is damaged - attempting to reconstruct xref table..."
 *   - "Command Line Error: Incorrect password"
 *   - "Encrypted"
 *   - "owner password"
 *   - "user password"
 * We match conservatively on the known-safe tokens. The raw stderr is
 * never surfaced to the UI; this check only drives classification.
 */
function looksEncrypted(stderr: string): boolean {
  if (!stderr) return false;
  const s = stderr.toLowerCase();
  return (
    s.includes("incorrect password") ||
    s.includes("owner password") ||
    s.includes("user password") ||
    s.includes("encrypted") ||
    s.includes("encryption")
  );
}

function sliceWithoutSplitSurrogate(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

function cancelled(): PdfExtractionResult {
  return {
    status: "failed",
    coverage: { extracted_chars: 0, truncated: false, label: "PDF extraction cancelled" },
    extractedText: null,
  };
}

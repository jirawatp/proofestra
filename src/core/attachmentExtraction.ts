// Safe, bounded content extraction for uploaded attachments.
//
// Rules every extractor obeys:
//   - Never shell out via `/bin/sh`; subprocess parsers (`pdfinfo`,
//     `pdftotext`, `ffprobe`) are spawned with a FIXED pre-discovered
//     absolute path, `shell: false`, bounded argv, bounded stdio,
//     wallclock timeout, honored AbortSignal, and sanitized labels.
//   - Never pass a user-supplied filename to any OS call. The subprocess
//     only ever receives the UUID blob path from the attachment store.
//   - Hard byte / char / page / entry / inflated-size / ratio / nesting /
//     time caps BEFORE allocation; a malicious file is rejected cheaply.
//   - A file we cannot safely extract is NOT silently dropped: it becomes
//     `unsupported` / `encrypted` / `failed` with a short honest label
//     and the attachment remains available for download.
//   - Document body text is quoted into the model prompt as UNTRUSTED
//     data. Nothing in a parsed PDF / DOCX / spreadsheet / archive can
//     grant tool permissions, invoke subagents, or override system
//     instructions — the coordinator's framing already labels these
//     blocks as attached file content and the model's output remains
//     subject to the normal permission boundary.

import fs from "node:fs";
import type {
  AttachmentExtractionCoverage,
  AttachmentExtractionStatus,
  AttachmentKind,
} from "../shared/types.js";
import { ATTACHMENT_POLICY } from "./attachments.js";
import { extractPdfText, type PdfExtractionResult } from "./parsers/pdf.js";
import { isMacroOrTemplateVariant, officeKindFromName } from "./parsers/office.js";
import { runAttachmentWorker } from "./workerExtraction.js";
import { probeMedia, type MediaProbeResult } from "./parsers/ffprobe.js";

/** Exact coverage label for validated audio/video: never a transcript. */
export const MEDIA_METADATA_ONLY_LABEL = "Metadata only — no transcription";

export interface ExtractionResult {
  status: AttachmentExtractionStatus;
  coverage: AttachmentExtractionCoverage;
  extractedText: string | null;
  /**
   * Validated metadata harvested as a side-effect of extraction. The
   * attachment-upload route persists these fields into the attachment
   * row so the native-routing path can enforce per-page / per-duration
   * caps at admission AND dispatch time. Null means "not available"
   * (either the extractor does not probe this field, or the probe
   * refused), NOT "zero".
   */
  pdf_pages?: number | null;
  pdf_encrypted?: boolean | null;
  media_duration_seconds?: number | null;
  media_streams_json?: string | null;
  /** Sanitized ffprobe `format_name` of a validated media file. */
  validated_media_format?: string | null;
  /** Wire-normalized media MIME, set only after a successful probe. */
  normalized_media_mime?: string | null;
}

export interface ExtractionInput {
  kind: AttachmentKind;
  sniffed_mime: string;
  byte_size: number;
  blob_path: string;
  /**
   * Only used for office extraction (DOCX / XLSX / PPTX / ODF). The
   * sanitized display name's extension disambiguates OOXML containers
   * from plain ZIPs (ZIP magic alone cannot). Null for non-office
   * uploads.
   */
  sanitized_display_name?: string;
  /**
   * Honoured by every bounded extractor. The upload route pipes the
   * per-request deadline + the gate's abort signal in here so a
   * misbehaving file cannot block the server beyond the configured
   * window; the response path also re-checks `signal.aborted` before
   * calling `markReady` so a late success is thrown away.
   */
  signal?: AbortSignal;
}

export async function extractAttachment(input: ExtractionInput): Promise<ExtractionResult> {
  if (input.byte_size === 0) {
    return {
      status: "none",
      coverage: { extracted_chars: 0, truncated: false, label: "empty file" },
      extractedText: null,
    };
  }
  if (input.signal?.aborted) return cancelled("extraction cancelled");
  if (input.kind === "text") {
    return extractText(input);
  }
  if (input.kind === "pdf") {
    const r: PdfExtractionResult = await extractPdfText({
      blob_path: input.blob_path,
      byte_size: input.byte_size,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return {
      status: r.status,
      coverage: r.coverage,
      extractedText: r.extractedText,
      pdf_pages: r.pdf_pages ?? null,
      pdf_encrypted: r.pdf_encrypted ?? null,
    };
  }
  if (input.kind === "archive") {
    // DOCX / XLSX / PPTX / ODF arrive here as `archive` (ZIP magic cannot
    // tell them from a plain ZIP). The sanitized display name's extension
    // routes to the Office path; everything else is a bounded ZIP inventory
    // plus supported text entries. Both run in the terminable worker.
    const officeKind = input.sanitized_display_name
      ? officeKindFromName(input.sanitized_display_name)
      : null;
    return officeKind
      ? runAttachmentWorker(
          {
            operation: "office",
            blob_path: input.blob_path,
            byte_size: input.byte_size,
            office_kind: officeKind,
            ...(isMacroOrTemplateVariant(input.sanitized_display_name ?? "")
              ? { macro_variant: true }
              : {}),
          },
          workerOptions(input),
        )
      : runAttachmentWorker(
          { operation: "zip", blob_path: input.blob_path, byte_size: input.byte_size },
          workerOptions(input),
        );
  }
  if (input.kind === "audio" || input.kind === "video") {
    // Media never yields extractable text (no OCR, no transcription). A
    // bounded FD-only ffprobe pass records validated duration, streams,
    // container format and a wire-normalized MIME. Routing, not
    // extraction, applies provider/profile caps: a valid 121 s file is
    // still metadata-only here and is refused natively by policy later.
    const probe: MediaProbeResult = await probeMedia({
      blob_path: input.blob_path,
      sniffed_mime: input.sniffed_mime,
      byte_size: input.byte_size,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (probe.aborted) return cancelled("media probe cancelled");
    if (
      probe.normalized_mime === null ||
      probe.duration_seconds === null ||
      probe.streams.length === 0
    ) {
      return {
        status: "unsupported",
        coverage: {
          extracted_chars: 0,
          truncated: false,
          label: `${input.kind} metadata unavailable (${probe.reason ?? "not validated"})`,
        },
        extractedText: null,
        // Keep whatever structure the probe DID report so routing can name
        // the specific defect; without a normalized MIME nothing here can be
        // previewed or sent natively.
        media_duration_seconds: probe.duration_seconds,
        media_streams_json: probe.streams.length > 0 ? JSON.stringify(probe.streams) : null,
        // The container name is recorded only for a validated file.
        validated_media_format: null,
        normalized_media_mime: null,
      };
    }
    return {
      status: "none",
      coverage: {
        extracted_chars: 0,
        truncated: false,
        label: `${MEDIA_METADATA_ONLY_LABEL} (${summarizeMedia(probe)})`,
      },
      extractedText: null,
      media_duration_seconds: probe.duration_seconds,
      media_streams_json: JSON.stringify(probe.streams),
      validated_media_format: probe.format_name,
      normalized_media_mime: probe.normalized_mime,
    };
  }
  if (input.kind === "image") {
    // Native routing is handled separately. We do NOT run OCR on images.
    return {
      status: "none",
      coverage: {
        extracted_chars: 0,
        truncated: false,
        label: "image (native routing depends on profile and dimensions)",
      },
      extractedText: null,
    };
  }
  return {
    status: "unsupported",
    coverage: {
      extracted_chars: 0,
      truncated: false,
      label: `${input.kind} attachment-only (no extractor)`,
    },
    extractedText: null,
  };
}

function summarizeMedia(probe: MediaProbeResult): string {
  const bits: string[] = [`${probe.duration_seconds!.toFixed(2)} s`];
  for (const s of probe.streams.slice(0, 3)) {
    if (s.codec_type === "audio") {
      bits.push(
        `audio ${s.codec_name}${s.sample_rate ? ` ${s.sample_rate} Hz` : ""}${s.channels ? `/${s.channels}ch` : ""}`,
      );
    } else {
      bits.push(`video ${s.codec_name}${s.width && s.height ? ` ${s.width}x${s.height}` : ""}`);
    }
  }
  return bits.join(" · ");
}

function workerOptions(input: ExtractionInput): { signal?: AbortSignal } {
  return input.signal ? { signal: input.signal } : {};
}

function cancelled(label: string): ExtractionResult {
  return {
    status: "failed",
    coverage: { extracted_chars: 0, truncated: false, label },
    extractedText: null,
  };
}

async function extractText(input: ExtractionInput): Promise<ExtractionResult> {
  const cap = ATTACHMENT_POLICY.max_extracted_chars;
  const maxBytes = Math.min(input.byte_size, cap * 4 + 16);
  const fd = await fs.promises.open(input.blob_path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await fd.read(buffer, 0, maxBytes, 0);
    if (input.signal?.aborted) return cancelled("text extraction cancelled");
    const sample = buffer.subarray(0, bytesRead);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: false }).decode(sample);
    } catch {
      return {
        status: "failed",
        coverage: { extracted_chars: 0, truncated: false, label: "text decode failed" },
        extractedText: null,
      };
    }
    const truncated = bytesRead < input.byte_size || text.length > cap;
    const extracted = text.slice(0, cap);
    return {
      status: truncated ? "truncated" : "text_extracted",
      coverage: {
        extracted_chars: extracted.length,
        truncated,
        label: truncated
          ? `text (truncated at ${cap} chars)`
          : `text (${extracted.length} chars)`,
      },
      extractedText: extracted,
    };
  } finally {
    await fd.close();
  }
}

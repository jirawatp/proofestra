// Pure presentation helpers for attachment analysis state. Kept free of
// React and the DOM so they are unit-testable and so the preview predicate
// can mirror the server guard exactly (the server stays authoritative).

import { isMediaPreviewValidated } from "../shared/attachmentMetadata.js";
import type {
  AttachmentDto,
  AttachmentRoute,
  RunAttachmentCoverage,
  RunSnapshot,
} from "./api";

type CoverageInput = Pick<
  AttachmentDto,
  "kind" | "extraction_status" | "sniffed_media_duration_ms" | "normalized_media_mime"
> & {
  sniffed_pdf_pages?: number | null | undefined;
  sniffed_width?: number | null | undefined;
  sniffed_height?: number | null | undefined;
  extraction_coverage?: { label?: string } | undefined;
};

/** Short semantic label for how much of a file the app actually analyzed. */
export function attachmentCoverageLabel(dto: CoverageInput): string {
  switch (dto.extraction_status) {
    case "text_extracted":
      return "Full text";
    case "truncated":
      return "Partial (truncated)";
    case "encrypted":
      return "Encrypted";
    case "failed":
      return "Analysis failed";
    case "pending":
      return "Analyzing…";
    case "unsupported":
      // A scanned PDF has validated pages but no text layer; a provider may
      // still receive it natively, so do not call it generically unsupported.
      if (dto.kind === "pdf" && (dto.sniffed_pdf_pages ?? 0) > 0) return "No text layer (scanned)";
      return "Unsupported";
    default:
      break;
  }
  if (
    (dto.kind === "audio" || dto.kind === "video") &&
    dto.sniffed_media_duration_ms != null &&
    dto.sniffed_media_duration_ms > 0 &&
    dto.normalized_media_mime
  ) {
    return "Metadata only — no transcription";
  }
  if (dto.kind === "image") {
    // JPEG dimensions are never sniffed, so a JPEG is never sent natively.
    return dto.sniffed_width == null || dto.sniffed_height == null
      ? "Image (not sent natively: dimensions unknown)"
      : "Image (sent natively only to models that accept it)";
  }
  if (dto.kind === "audio" || dto.kind === "video") return "Not analyzed";
  return "Attachment only";
}

/**
 * Composer upload line. After the browser has written the whole body the file
 * may still be QUEUED behind another upload or being analyzed, so the label is
 * the neutral "Processing on server…". A row rehydrated from the server (no
 * local upload in this tab) also shows it, never a fake "Uploading… 0%".
 */
export function composerUploadLabel(
  state: "uploading" | "ready" | "failed",
  progress: number,
  hasLocalUpload = true,
): string | null {
  if (state !== "uploading") return null;
  if (!hasLocalUpload || progress >= 1) return "Processing on server…";
  return `Uploading… ${Math.round(progress * 100)}%`;
}

/**
 * A server row left behind by a cancelled upload (the client went away, so
 * the server recorded `client_closed_request`). The composer hides these and
 * deletes them best-effort, so a cancel never comes back as a "Failed" row
 * that blocks Send.
 */
export function isCancelledUploadRow(dto: Pick<AttachmentDto, "state" | "failure">): boolean {
  return dto.state === "failed" && dto.failure?.code === "client_closed_request";
}

export function splitCancelledUploads<T extends Pick<AttachmentDto, "state" | "failure">>(
  items: readonly T[],
): { visible: T[]; cancelled: T[] } {
  const visible: T[] = [];
  const cancelled: T[] = [];
  for (const item of items) (isCancelledUploadRow(item) ? cancelled : visible).push(item);
  return { visible, cancelled };
}

/**
 * Client gate for `<audio>`/`<video>`: the SAME rule the server's `/preview`
 * enforces (`isMediaPreviewValidated`, shared). No media element is created
 * unless it holds; this never implies provider support.
 */
export function isMediaPreviewValidatedClient(
  dto: Pick<
    AttachmentDto,
    "kind" | "sniffed_media_duration_ms" | "normalized_media_mime" | "sniffed_media_streams_json"
  >,
): boolean {
  return isMediaPreviewValidated(dto);
}

export function routeLabel(route: AttachmentRoute): "Native" | "Extracted text" | "Attachment only" {
  if (route === "extracted_text") return "Extracted text";
  if (route === "attachment_only") return "Attachment only";
  return "Native";
}

export interface AgentRouteRow {
  agentId: string;
  agentName: string;
  files: Array<{ attachmentId: string; name: string; label: ReturnType<typeof routeLabel>; reason: string }>;
}

/**
 * Per-agent routing rows for a run: exact route and the non-empty reason, so
 * unsupported OpenAI/Anthropic media is never shown as analyzed.
 */
export function agentRouteRows(
  run: Pick<RunSnapshot, "agents" | "context">,
  nameById: ReadonlyMap<string, string>,
): AgentRouteRow[] {
  const coverage: RunAttachmentCoverage[] = run.context?.attachment_coverage ?? [];
  const own = new Map((run.context?.attachments ?? []).map((a) => [a.id, a.sanitized_display_name] as const));
  return coverage.map((entry) => ({
    agentId: entry.agent_id,
    agentName: run.agents.find((a) => a.agent_id === entry.agent_id)?.name ?? entry.agent_id,
    files: entry.routes.map((r) => ({
      attachmentId: r.attachment_id,
      name: nameById.get(r.attachment_id) ?? own.get(r.attachment_id) ?? "attachment",
      label: routeLabel(r.route),
      reason: r.reason,
    })),
  }));
}

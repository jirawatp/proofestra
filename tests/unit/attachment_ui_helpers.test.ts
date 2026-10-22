import { describe, expect, it } from "vitest";
import {
  agentRouteRows,
  attachmentCoverageLabel,
  composerUploadLabel,
  isCancelledUploadRow,
  splitCancelledUploads,
  isMediaPreviewValidatedClient,
  routeLabel,
} from "../../src/web/attachmentUi.js";
import type { AttachmentDto, RunSnapshot } from "../../src/web/api.js";

type Cov = Parameters<typeof attachmentCoverageLabel>[0];
const dto = (o: Partial<Cov>): Cov => ({
  kind: "text",
  extraction_status: "none",
  sniffed_media_duration_ms: null,
  normalized_media_mime: null,
  ...o,
});

describe("attachmentCoverageLabel", () => {
  it("maps each extraction outcome to a semantic label", () => {
    expect(attachmentCoverageLabel(dto({ extraction_status: "text_extracted" }))).toBe("Full text");
    expect(attachmentCoverageLabel(dto({ extraction_status: "truncated" }))).toBe("Partial (truncated)");
    expect(attachmentCoverageLabel(dto({ extraction_status: "unsupported" }))).toBe("Unsupported");
    expect(attachmentCoverageLabel(dto({ extraction_status: "encrypted" }))).toBe("Encrypted");
    expect(attachmentCoverageLabel(dto({ extraction_status: "failed" }))).toBe("Analysis failed");
  });
  it("a scanned PDF (validated pages, no text) says so instead of a generic Unsupported", () => {
    expect(
      attachmentCoverageLabel(dto({ kind: "pdf", extraction_status: "unsupported", sniffed_pdf_pages: 3 })),
    ).toBe("No text layer (scanned)");
    expect(attachmentCoverageLabel(dto({ kind: "pdf", extraction_status: "unsupported" }))).toBe("Unsupported");
  });
  it("validated audio/video without text is 'Metadata only — no transcription'", () => {
    for (const kind of ["audio", "video"] as const) {
      expect(
        attachmentCoverageLabel(
          dto({ kind, sniffed_media_duration_ms: 1000, normalized_media_mime: kind === "audio" ? "audio/wav" : "video/mp4" }),
        ),
      ).toBe("Metadata only — no transcription");
    }
    // Unvalidated media never claims metadata.
    expect(attachmentCoverageLabel(dto({ kind: "video" }))).toBe("Not analyzed");
  });
  it("other 'none' files get a short honest attachment-only label", () => {
    expect(attachmentCoverageLabel(dto({ kind: "binary" }))).toBe("Attachment only");
  });
});

describe("composerUploadLabel", () => {
  it("reads Uploading… N% below 100%, then the neutral Processing on server… (queued or analyzing)", () => {
    expect(composerUploadLabel("uploading", 0.42)).toBe("Uploading… 42%");
    expect(composerUploadLabel("uploading", 0.999)).toBe("Uploading… 100%");
    expect(composerUploadLabel("uploading", 1)).toBe("Processing on server…");
    expect(composerUploadLabel("ready", 1)).toBeNull();
    expect(composerUploadLabel("failed", 1)).toBeNull();
  });
  it("a row rehydrated from the server (no local upload) never shows a fake Uploading… 0%", () => {
    expect(composerUploadLabel("uploading", 0, false)).toBe("Processing on server…");
  });
});

describe("cancelled uploads are hidden from the composer", () => {
  const row = (state: "failed" | "ready" | "uploading", code?: string) => ({
    state,
    failure: code ? { code, message: "m" } : null,
  });
  it("splits only failed client_closed_request rows", () => {
    const items = [
      { id: "a", ...row("ready") },
      { id: "b", ...row("failed", "client_closed_request") },
      { id: "c", ...row("failed", "upload_failed") },
      { id: "d", ...row("uploading") },
    ];
    const { visible, cancelled } = splitCancelledUploads(items);
    expect(cancelled.map((i) => i.id)).toEqual(["b"]);
    expect(visible.map((i) => i.id)).toEqual(["a", "c", "d"]);
    expect(isCancelledUploadRow(row("failed", "client_closed_request"))).toBe(true);
    expect(isCancelledUploadRow(row("failed", "upload_failed"))).toBe(false);
  });
});

describe("image coverage label", () => {
  it("a JPEG (dimensions never sniffed) does not imply native sending", () => {
    expect(attachmentCoverageLabel(dto({ kind: "image", sniffed_width: null, sniffed_height: null }))).toBe(
      "Image (not sent natively: dimensions unknown)",
    );
    expect(attachmentCoverageLabel(dto({ kind: "image", sniffed_width: 10, sniffed_height: 10 }))).toMatch(
      /sent natively only to models/,
    );
  });
});

describe("isMediaPreviewValidatedClient (mirrors the server guard)", () => {
  type P = Parameters<typeof isMediaPreviewValidatedClient>[0];
  const video = (o: Partial<P>): P => ({
    kind: "video",
    sniffed_media_duration_ms: 1000,
    normalized_media_mime: "video/mp4",
    sniffed_media_streams_json: JSON.stringify([{ codec_type: "video", codec_name: "h264", width: 160, height: 90 }]),
    ...o,
  });
  it("accepts validated audio (duration + MIME + an audio stream) and validated video (+ bounded streams)", () => {
    expect(
      isMediaPreviewValidatedClient({
        kind: "audio",
        sniffed_media_duration_ms: 1000,
        normalized_media_mime: "audio/wav",
        sniffed_media_streams_json: JSON.stringify([{ codec_type: "audio", codec_name: "pcm_s16le" }]),
      }),
    ).toBe(true);
    expect(isMediaPreviewValidatedClient(video({}))).toBe(true);
  });
  it("audio without any persisted audio stream is NOT previewable (the server answers 422 too)", () => {
    for (const streams of [null, "[]", JSON.stringify([{ codec_type: "video", codec_name: "h264", width: 2, height: 2 }])]) {
      expect(
        isMediaPreviewValidatedClient({
          kind: "audio",
          sniffed_media_duration_ms: 1000,
          normalized_media_mime: "audio/wav",
          sniffed_media_streams_json: streams,
        }),
      ).toBe(false);
    }
  });
  it("one bounded video track does not excuse an unbounded second track", () => {
    const two = JSON.stringify([
      { codec_type: "video", codec_name: "h264", width: 160, height: 90 },
      { codec_type: "video", codec_name: "h264", width: 60000, height: 60000 },
    ]);
    expect(isMediaPreviewValidatedClient(video({ sniffed_media_streams_json: two }))).toBe(false);
  });
  it("refuses the huge-dimensions header, unknown duration, a missing MIME, and unbounded streams", () => {
    const hostile = JSON.stringify([{ codec_type: "video", codec_name: "mjpeg" }]);
    expect(isMediaPreviewValidatedClient(video({ sniffed_media_streams_json: hostile }))).toBe(false);
    expect(isMediaPreviewValidatedClient(video({ sniffed_media_duration_ms: null }))).toBe(false);
    expect(isMediaPreviewValidatedClient(video({ normalized_media_mime: null }))).toBe(false);
    const huge = JSON.stringify([{ codec_type: "video", codec_name: "h264", width: 65535, height: 65535 }]);
    expect(isMediaPreviewValidatedClient(video({ sniffed_media_streams_json: huge }))).toBe(false);
    expect(isMediaPreviewValidatedClient(video({ sniffed_media_streams_json: "{not json" }))).toBe(false);
    expect(isMediaPreviewValidatedClient({ ...video({}), kind: "image" } as P)).toBe(false);
  });
});

describe("per-agent route rows", () => {
  const run = {
    agents: [
      { agent_id: "a1", name: "OpenAI Writer" },
      { agent_id: "a2", name: "Gemini Challenger" },
    ],
    context: {
      attachments: [{ id: "cur", sanitized_display_name: "now.mp4" }],
      attachment_coverage: [
        {
          agent_id: "a1",
          profile_id: "openai-default",
          provider: "openai",
          aggregate_note: "",
          routes: [
            { attachment_id: "old", route: "native_pdf", reason: "" },
            { attachment_id: "cur", route: "attachment_only", reason: "native audio/video is not supported for openai in this app" },
          ],
        },
        {
          agent_id: "a2",
          profile_id: "gemini-default",
          provider: "gemini",
          aggregate_note: "",
          routes: [{ attachment_id: "cur", route: "native_video", reason: "" }],
        },
      ],
    },
  } as unknown as Pick<RunSnapshot, "agents" | "context">;

  it("shows each agent's exact route and non-empty reason, never implying unsupported media was analyzed", () => {
    const rows = agentRouteRows(run, new Map([["old", "report.pdf"]]));
    expect(rows.map((r) => r.agentName)).toEqual(["OpenAI Writer", "Gemini Challenger"]);
    expect(rows[0]!.files).toEqual([
      { attachmentId: "old", name: "report.pdf", label: "Native", reason: "" },
      {
        attachmentId: "cur",
        name: "now.mp4",
        label: "Attachment only",
        reason: "native audio/video is not supported for openai in this app",
      },
    ]);
    expect(rows[1]!.files[0]!.label).toBe("Native");
  });
  it("route labels", () => {
    expect(routeLabel("native_image")).toBe("Native");
    expect(routeLabel("extracted_text")).toBe("Extracted text");
    expect(routeLabel("attachment_only")).toBe("Attachment only");
  });
  it("has no rows when a run has no attachments", () => {
    expect(agentRouteRows({ agents: [], context: undefined } as never, new Map())).toEqual([]);
  });
});

// Type-level guard: the helper accepts the real DTO.
const _typecheck = (d: AttachmentDto) => attachmentCoverageLabel(d);
void _typecheck;

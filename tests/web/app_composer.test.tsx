// @vitest-environment jsdom
// Composer attachment behavior of the App: picker / paste / drop, progress,
// cancel, retry, caps, rehydration after reload or chat switch, previews and
// send gating. Intercepted-wire component tests against a mocked API module;
// not a native-browser or live-provider run.
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  const names = [
    "attachmentDownloadUrl",
    "attachmentPreviewUrl",
    "cancelRun",
    "createConversation",
    "createRun",
    "deleteAttachment",
    "deleteConversation",
    "exportConversation",
    "getAttachmentPolicy",
    "getConversation",
    "getConversationRuns",
    "getMessages",
    "getProviders",
    "getRun",
    "getRuntimePolicy",
    "listAttachments",
    "listConversations",
    "subscribeRunEvents",
    "uploadAttachment",
  ];
  const obj: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const n of names) obj[n] = vi.fn();
  let n = 0;
  obj.newIdempotencyKey = vi.fn(() => `init-${(n += 1)}-0000-4000-8000-000000000000`);
  return obj;
});
vi.mock("../../src/web/api.js", () => api);

import { App } from "../../src/web/App.js";
import {
  CONV_A,
  CONV_B,
  attachment,
  attachmentPolicy,
  conv,
  deferred,
  newWorld,
  run,
  wireApi,
  type World,
} from "./_kit.js";
import type { AttachmentDto } from "../../src/web/api.js";

const ORDER_KEY = "proofestra:composer-order:v1";
const MIB = 1024 * 1024;
let world: World;
let container: HTMLElement;

beforeEach(() => {
  world = newWorld();
  world.convs = [conv(CONV_A, "Alpha chat"), conv(CONV_B, "Beta chat")];
  wireApi(api, world);
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderApp(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  ({ container } = render(<App />));
  await screen.findByText(/catalog/);
  return user;
}

async function openChat(user: ReturnType<typeof userEvent.setup>, title: string): Promise<void> {
  await user.click(screen.getByRole("button", { name: new RegExp(`^${title}`) }));
}

function fileInput(): HTMLInputElement {
  return container.querySelector('input[type="file"]') as HTMLInputElement;
}

function pick(...files: File[]): void {
  fireEvent.change(fileInput(), { target: { files } });
}

function textFile(name: string, size = 12): File {
  return new File([new Uint8Array(size).fill(97)], name, { type: "text/plain" });
}

async function settle(ms = 25): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

interface PendingUpload {
  conversationId: string;
  file: File;
  signal: AbortSignal;
  onProgress: (loaded: number, total: number) => void;
  resolve: (dto: AttachmentDto) => void;
  reject: (err: Error) => void;
}

function controlUploads(): PendingUpload[] {
  const pending: PendingUpload[] = [];
  api.uploadAttachment!.mockImplementation(
    (
      conversationId: string,
      file: File,
      handlers: { onProgress: (l: number, t: number) => void; signal: AbortSignal },
    ) => {
      const d = deferred<AttachmentDto>();
      pending.push({
        conversationId,
        file,
        signal: handlers.signal,
        onProgress: handlers.onProgress,
        resolve: d.resolve,
        reject: d.reject,
      });
      return d.promise;
    },
  );
  return pending;
}

describe("picking files", () => {
  it("uploads with progress, settles to ready cards in order, and sends them without a prompt", async () => {
    const pending = controlUploads();
    api.createRun!.mockResolvedValue(run({ id: "run-1", conversation_id: CONV_A, status: "running" }));
    api.getConversationRuns!.mockResolvedValue({ items: [], active_run_id: null });
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    pick(textFile("one.txt"), textFile("two.txt"));
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0]!.conversationId).toBe(CONV_A);
    expect(pending[0]!.signal.aborted).toBe(false);
    expect(fileInput().value).toBe("");

    // Uploading: Send is gated, progress is shown, zero-total progress ignored.
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    act(() => pending[0]!.onProgress(5, 10));
    expect(screen.getByText("Uploading… 50%")).toBeTruthy();
    act(() => pending[0]!.onProgress(1, 0));
    expect(screen.getByText("Uploading… 50%")).toBeTruthy();
    act(() => pending[0]!.onProgress(10, 10));
    expect(screen.getAllByText("Processing on server…").length).toBeGreaterThan(0);

    // Resolve out of order; the composer order stays the pick order.
    const two = attachment({ id: "srv-two", sanitized_display_name: "two.txt", byte_size: 2048 });
    const one = attachment({
      id: "srv-one",
      sanitized_display_name: "one.txt",
      extraction_status: "truncated",
      extraction_coverage: { extracted_chars: 5, truncated: true, label: "first 5 chars" },
    });
    api.getMessages!.mockResolvedValue({ items: [] });
    await act(async () => pending[1]!.resolve(two));
    await act(async () => pending[0]!.resolve(one));
    const list = await screen.findByRole("list", { name: "Attachments" });
    const names = within(list)
      .getAllByRole("listitem")
      .map((li) => li.querySelector(".composer-attachment-name")?.textContent);
    expect(names).toEqual(["one.txt", "two.txt"]);
    expect(within(list).getByText(/Partial \(truncated\)/).getAttribute("title")).toBe("first 5 chars");
    expect(within(list).getByText(/text\/plain · 2\.0 KiB/)).toBeTruthy();
    const links = within(list).getAllByRole("link", { name: "Download" });
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/api/v1/attachments/srv-one/download",
      "/api/v1/attachments/srv-two/download",
    ]);

    // Ready attachments alone are enough to send.
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    await user.click(send);
    await waitFor(() => expect(api.createRun).toHaveBeenCalled());
    const input = api.createRun!.mock.calls[0]![0];
    expect(input.attachmentIds).toEqual(["srv-one", "srv-two"]);
    expect(input.prompt).toBe("");
    await waitFor(() => expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull());
  });

  it("creates a conversation when files are added before any chat exists", async () => {
    const pending = controlUploads();
    const user = await renderApp();
    expect(user).toBeTruthy();
    pick(textFile("first.txt"));
    await waitFor(() => expect(pending).toHaveLength(1));
    expect(api.createConversation).toHaveBeenCalledTimes(1);
    const created = (await api.createConversation!.mock.results[0]!.value) as { id: string };
    expect(pending[0]!.conversationId).toBe(created.id);
  });

  it("reports a conversation-creation failure without uploading", async () => {
    api.createConversation!.mockRejectedValue(new Error("no space for chat"));
    await renderApp();
    pick(textFile("first.txt"));
    expect((await screen.findByRole("alert")).textContent).toBe("no space for chat");
    expect(api.uploadAttachment).not.toHaveBeenCalled();
  });

  it("ignores an empty selection", async () => {
    const pending = controlUploads();
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    pick();
    await settle();
    expect(pending).toHaveLength(0);
    expect(api.createConversation).not.toHaveBeenCalled();
  });
});

describe("paste and drop", () => {
  it("uploads pasted files but leaves ordinary text pastes alone", async () => {
    const pending = controlUploads();
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    const box = screen.getByLabelText("Message your team");

    const textPaste = fireEvent.paste(box, {
      clipboardData: { items: [{ kind: "string", getAsFile: () => null }] },
    });
    expect(textPaste).toBe(true); // not default-prevented
    await settle();
    expect(pending).toHaveLength(0);

    const nullFile = fireEvent.paste(box, {
      clipboardData: { items: [{ kind: "file", getAsFile: () => null }] },
    });
    expect(nullFile).toBe(true);

    const img = new File([new Uint8Array(4)], "shot.png", { type: "image/png" });
    const filePaste = fireEvent.paste(box, {
      clipboardData: { items: [{ kind: "file", getAsFile: () => img }] },
    });
    expect(filePaste).toBe(false); // default prevented: we took the file
    await waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0]!.file.name).toBe("shot.png");

    // No clipboard data at all is a no-op.
    fireEvent.paste(box);
    await settle();
    expect(pending).toHaveLength(1);
  });

  it("highlights the composer for file drags and uploads dropped files", async () => {
    const pending = controlUploads();
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    const form = container.querySelector("form")!;
    const composer = container.querySelector(".composer")!;

    // A drag that carries no files is not claimed.
    expect(fireEvent.dragOver(form, { dataTransfer: { types: ["text/plain"] } })).toBe(true);
    expect(composer.className).not.toContain("drag-over");

    expect(fireEvent.dragOver(form, { dataTransfer: { types: ["Files"] } })).toBe(false);
    expect(composer.className).toContain("drag-over");
    fireEvent.dragLeave(form);
    expect(composer.className).not.toContain("drag-over");

    // A drop without files is ignored; one with files uploads.
    expect(fireEvent.drop(form, { dataTransfer: { files: [], types: [] } })).toBe(true);
    fireEvent.dragOver(form, { dataTransfer: { types: ["Files"] } });
    expect(fireEvent.drop(form, { dataTransfer: { files: [textFile("dropped.txt")], types: ["Files"] } })).toBe(false);
    expect(composer.className).not.toContain("drag-over");
    await waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0]!.file.name).toBe("dropped.txt");
  });
});

describe("caps", () => {
  it("rejects over-cap files and stops at the per-turn and composer limits, using the server policy", async () => {
    world.attachmentPolicy = attachmentPolicy({
      max_files_per_turn: 3,
      max_file_bytes: 1 * MIB,
      max_composer_bytes: 2 * MIB,
    });
    const pending = controlUploads();
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    await waitFor(() => expect(api.getAttachmentPolicy).toHaveBeenCalled());
    await settle();

    pick(textFile("huge.bin", Math.floor(1.5 * MIB)));
    expect((await screen.findByRole("alert")).textContent).toContain('"huge.bin" is larger than the 1 MiB per-file cap.');
    expect(pending).toHaveLength(0);

    // Two files fit under the composer total; the third would exceed it.
    const big = Math.floor(0.9 * MIB);
    pick(textFile("a.txt", big), textFile("b.txt", big), textFile("c.txt", big));
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(screen.getByRole("alert").textContent).toContain('Adding "c.txt" would exceed the 2 MiB composer total.');
  });

  it("stops at the per-turn file count", async () => {
    world.attachmentPolicy = attachmentPolicy({ max_files_per_turn: 2 });
    const pending = controlUploads();
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    await settle();
    pick(textFile("1.txt"), textFile("2.txt"), textFile("3.txt"));
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(screen.getByRole("alert").textContent).toBe("Maximum 2 files per turn — remove one before adding more.");
  });

  it("falls back to built-in caps when the policy cannot be fetched", async () => {
    api.getAttachmentPolicy!.mockRejectedValue(new Error("policy down"));
    const pending = controlUploads();
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    await settle();
    pick(textFile("ok.txt"));
    await waitFor(() => expect(pending).toHaveLength(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("remove, retry and failure", () => {
  it("removing an in-flight upload aborts it without touching the server", async () => {
    const pending = controlUploads();
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    pick(textFile("slow.txt"));
    await waitFor(() => expect(pending).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(pending[0]!.signal.aborted).toBe(true);
    expect(api.deleteAttachment).not.toHaveBeenCalled();
    expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
    // The aborted upload's late rejection does not resurrect the card as a ghost
    // that could block Send forever once it is removed.
    await act(async () => pending[0]!.reject(new Error("upload canceled")));
  });

  it("removing a ready card deletes it on the server and swallows a delete conflict", async () => {
    const pending = controlUploads();
    api.deleteAttachment!.mockRejectedValue(new Error("attachment already bound"));
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    pick(textFile("keep.txt"));
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => pending[0]!.resolve(attachment({ id: "srv-keep", sanitized_display_name: "keep.txt" })));
    await screen.findByText("keep.txt");
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(api.deleteAttachment).toHaveBeenCalledWith("srv-keep"));
    expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a failed upload, blocks Send, and Retry re-uploads the same file", async () => {
    const pending = controlUploads();
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    const file = textFile("flaky.txt");
    pick(file);
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => pending[0]!.reject(new Error("File is too large.")));
    expect(await screen.findByText("Failed: File is too large.")).toBeTruthy();
    await user.type(screen.getByLabelText("Message your team"), "text too");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1]!.file).toBe(file);
    expect(pending[1]!.signal.aborted).toBe(false);
    expect(screen.queryByText(/Failed:/)).toBeNull();
    await act(async () => pending[1]!.resolve(attachment({ id: "srv-flaky", sanitized_display_name: "flaky.txt" })));
    await screen.findByRole("link", { name: "Download" });
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("blocks Ctrl+Enter sends with a clear reason while uploading or failed", async () => {
    const pending = controlUploads();
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    pick(textFile("a.txt"), textFile("b.txt"));
    await waitFor(() => expect(pending).toHaveLength(2));
    const box = screen.getByLabelText("Message your team");
    await user.type(box, "go{Control>}{Enter}{/Control}");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Wait for all attachments to finish uploading before sending.",
    );
    await act(async () => pending[0]!.reject(new Error("bad file")));
    await act(async () => pending[1]!.resolve(attachment({ id: "srv-b", sanitized_display_name: "b.txt" })));
    await user.type(box, "{Control>}{Enter}{/Control}");
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Remove or retry failed attachments before sending."),
    );
    expect(api.createRun).not.toHaveBeenCalled();
  });
});

describe("rehydration", () => {
  it("restores server drafts in the saved local order and hides cancelled upload leftovers", async () => {
    world.attachmentsByConv[CONV_A] = [
      attachment({ id: "srv-aaaa1111", sanitized_display_name: "first.txt" }),
      attachment({ id: "srv-bbbb2222", sanitized_display_name: "second.txt" }),
      attachment({
        id: "srv-cccc3333",
        sanitized_display_name: "gone.txt",
        state: "failed",
        failure: { code: "client_closed_request", message: "client went away" },
      }),
      attachment({
        id: "srv-dddd4444",
        sanitized_display_name: "broken.txt",
        state: "failed",
        failure: { code: "extraction_failed", message: "Could not read" },
      }),
    ];
    window.localStorage.setItem(
      ORDER_KEY,
      JSON.stringify({ version: 1, byConversation: { [CONV_A]: ["srv-bbbb2222", "srv-aaaa1111"] } }),
    );
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    const list = await screen.findByRole("list", { name: "Attachments" });
    const names = within(list)
      .getAllByRole("listitem")
      .map((li) => li.querySelector(".composer-attachment-name")?.textContent);
    expect(names).toEqual(["second.txt", "first.txt", "broken.txt"]);
    await waitFor(() => expect(api.deleteAttachment).toHaveBeenCalledWith("srv-cccc3333"));
    // A reloaded failed draft cannot be retried in place (bytes are gone).
    expect(within(list).getByText("Failed: Could not read")).toBeTruthy();
    expect(within(list).getByText("Re-select to retry")).toBeTruthy();
    expect(within(list).queryByRole("button", { name: "Retry" })).toBeNull();
    // Hydration persists only opaque ready ids, in the shown order.
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem(ORDER_KEY)!);
      expect(stored.byConversation[CONV_A]).toEqual(["srv-bbbb2222", "srv-aaaa1111"]);
    });
    expect(window.localStorage.getItem(ORDER_KEY)).not.toContain("first.txt");
  });

  it("does not clobber a saved order with an empty composer before hydration finishes", async () => {
    window.localStorage.setItem(
      ORDER_KEY,
      JSON.stringify({ version: 1, byConversation: { [CONV_A]: ["srv-aaaa1111"] } }),
    );
    const slow = deferred<{ items: AttachmentDto[] }>();
    api.listAttachments!.mockImplementation(() => slow.promise);
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    await settle();
    expect(JSON.parse(window.localStorage.getItem(ORDER_KEY)!).byConversation[CONV_A]).toEqual(["srv-aaaa1111"]);
    await act(async () => slow.resolve({ items: [attachment({ id: "srv-aaaa1111", sanitized_display_name: "kept.txt" })] }));
    expect(await screen.findByText("kept.txt")).toBeTruthy();
  });

  it("keeps working when the draft list cannot be loaded", async () => {
    api.listAttachments!.mockRejectedValue(new Error("list failed"));
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("shows only the opened chat's drafts after switching and ignores a slow response for the other chat", async () => {
    world.attachmentsByConv[CONV_B] = [attachment({ id: "srv-beta0001", conversation_id: CONV_B, sanitized_display_name: "beta.txt" })];
    const slowA = deferred<{ items: AttachmentDto[] }>();
    api.listAttachments!.mockImplementation((id: string) =>
      id === CONV_A
        ? slowA.promise
        : Promise.resolve({ items: world.attachmentsByConv[id] ?? [] }),
    );
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    await openChat(user, "Beta chat");
    expect(await screen.findByText("beta.txt")).toBeTruthy();
    await act(async () =>
      slowA.resolve({ items: [attachment({ id: "srv-alpha001", sanitized_display_name: "alpha.txt" })] }),
    );
    await settle();
    expect(screen.queryByText("alpha.txt")).toBeNull();
    expect(screen.getByText("beta.txt")).toBeTruthy();
  });

  it("follows a still-processing server draft until it becomes ready", async () => {
    world.attachmentsByConv[CONV_A] = [
      attachment({
        id: "srv-proc0001",
        sanitized_display_name: "slow.pdf",
        state: "uploading",
        extraction_status: "pending",
      }),
    ];
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    expect(await screen.findByText("Processing on server…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    world.attachmentsByConv[CONV_A] = [
      attachment({ id: "srv-proc0001", sanitized_display_name: "slow.pdf", sniffed_mime: "application/pdf", kind: "pdf" }),
    ];
    await waitFor(() => expect(screen.getByRole("link", { name: "Download" })).toBeTruthy(), { timeout: 4000 });
    expect(screen.queryByText("Processing on server…")).toBeNull();
    expect(screen.getByText("No inline preview for application/pdf. Use Download to open this file.")).toBeTruthy();
  });

  it("keeps polling through a failed refresh and hides cancelled rows it finds", async () => {
    world.attachmentsByConv[CONV_A] = [
      attachment({ id: "srv-proc0002", sanitized_display_name: "slow.txt", state: "uploading", extraction_status: "pending" }),
    ];
    const user = await renderApp();
    let calls = 0;
    api.listAttachments!.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return { items: world.attachmentsByConv[CONV_A]! };
      if (calls === 2) throw new Error("blip");
      return {
        items: [
          attachment({
            id: "srv-proc0002",
            sanitized_display_name: "slow.txt",
            state: "failed",
            failure: { code: "client_closed_request", message: "closed" },
          }),
        ],
      };
    });
    await openChat(user, "Alpha chat");
    await screen.findByText("Processing on server…");
    await waitFor(() => expect(api.deleteAttachment).toHaveBeenCalledWith("srv-proc0002"), { timeout: 6000 });
    await waitFor(() => expect(screen.queryByText("slow.txt")).toBeNull());
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});

describe("previews", () => {
  async function openWith(...dtos: AttachmentDto[]): Promise<void> {
    world.attachmentsByConv[CONV_A] = dtos;
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    await screen.findByRole("list", { name: "Attachments" });
  }

  it("renders an image inline only when its sniffed dimensions are safe", async () => {
    const png = (id: string, w: number | null, h: number | null): AttachmentDto =>
      attachment({
        id,
        sanitized_display_name: `${id}.png`,
        sniffed_mime: "image/png",
        kind: "image",
        sniffed_width: w,
        sniffed_height: h,
      });
    await openWith(
      png("img-safe0001", 640, 480),
      png("img-nodim001", null, null),
      png("img-huge0001", 5000, 100),
      png("img-pixels01", 4096, 4096),
      png("img-nonint01", 10.5, 10),
      png("img-zero0001", 0, 10),
      png("img-nan00001", Number.NaN, 10),
      attachment({
        id: "img-jpeg0001",
        sanitized_display_name: "photo.jpg",
        sniffed_mime: "image/jpeg",
        kind: "image",
        sniffed_width: null,
        sniffed_height: null,
      }),
    );
    const imgs = container.querySelectorAll("img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.getAttribute("src")).toBe("/api/v1/attachments/img-safe0001/preview");
    expect(imgs[0]!.getAttribute("alt")).toBe("img-safe0001.png");
    expect(screen.getAllByText(/No inline preview — image dimensions unavailable or exceed safe bounds/)).toHaveLength(7);
  });

  it("creates media elements only for validated audio/video", async () => {
    const audioStreams = JSON.stringify([{ codec_type: "audio", codec_name: "pcm_s16le" }]);
    const videoStreams = JSON.stringify([{ codec_type: "video", codec_name: "h264", width: 320, height: 240 }]);
    await openWith(
      attachment({
        id: "aud-ok000001",
        sanitized_display_name: "tone.wav",
        sniffed_mime: "audio/wav",
        kind: "audio",
        sniffed_media_duration_ms: 1000,
        normalized_media_mime: "audio/wav",
        sniffed_media_streams_json: audioStreams,
      }),
      attachment({
        id: "vid-ok000001",
        sanitized_display_name: "clip.mp4",
        sniffed_mime: "video/mp4",
        kind: "video",
        sniffed_media_duration_ms: 2000,
        normalized_media_mime: "video/mp4",
        sniffed_media_streams_json: videoStreams,
      }),
      attachment({
        id: "aud-bad00001",
        sanitized_display_name: "bad.mp3",
        sniffed_mime: "audio/mpeg",
        kind: "audio",
        sniffed_media_duration_ms: null,
      }),
      attachment({
        id: "vid-bad00001",
        sanitized_display_name: "bad.webm",
        sniffed_mime: "video/webm",
        kind: "video",
        sniffed_media_duration_ms: 1000,
        normalized_media_mime: "video/webm",
        sniffed_media_streams_json: JSON.stringify([{ codec_type: "video", codec_name: "vp9", width: 100000, height: 10 }]),
      }),
    );
    expect(container.querySelector("audio")!.getAttribute("src")).toBe("/api/v1/attachments/aud-ok000001/preview");
    expect(container.querySelectorAll("audio")).toHaveLength(1);
    expect(container.querySelector("video")!.getAttribute("src")).toBe("/api/v1/attachments/vid-ok000001/preview");
    expect(container.querySelectorAll("video")).toHaveLength(1);
    expect(screen.getAllByText("No inline preview — this media was not validated. Use Download to open this file.")).toHaveLength(2);
  });

  function textDto(): AttachmentDto {
    return attachment({ id: "txt-preview1", sanitized_display_name: "note.txt" });
  }

  function streamed(chunks: Uint8Array[], cancelThrows = false): unknown {
    let i = 0;
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
          cancel: async () => {
            if (cancelThrows) throw new Error("cancel failed");
          },
        }),
      },
    };
  }

  it("previews text as inert, size-bounded plain text from a streamed body", async () => {
    const fetchSpy = vi.fn(async () =>
      streamed([new TextEncoder().encode("a".repeat(6000)), new TextEncoder().encode("b".repeat(6000))], true),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await openWith(textDto());
    const pre = await waitFor(() => {
      const el = container.querySelector("pre.composer-attachment-preview-text") as HTMLElement;
      expect(el.textContent!.length).toBeGreaterThan(0);
      return el;
    });
    expect(fetchSpy).toHaveBeenCalledWith("/api/v1/attachments/txt-preview1/preview", { credentials: "include" });
    expect(pre.textContent!.length).toBe(8 * 1024);
    expect(pre.textContent!.startsWith("a")).toBe(true);
    expect(pre.textContent!.endsWith("b")).toBe(true);
  });

  it("does not execute markup in a text preview", async () => {
    vi.stubGlobal("fetch", async () =>
      streamed([new TextEncoder().encode('<img src=x onerror="window.pwned=1"><script>window.pwned=2</script>')]),
    );
    await openWith(textDto());
    const pre = await waitFor(() => {
      const el = container.querySelector("pre.composer-attachment-preview-text") as HTMLElement;
      expect(el.textContent).toContain("<script>");
      return el;
    });
    expect(pre.querySelector("script")).toBeNull();
    expect(pre.querySelector("img")).toBeNull();
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it("falls back to text() when the response has no streaming body", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, body: null, text: async () => "x".repeat(9000) }));
    await openWith(textDto());
    const pre = await waitFor(() => {
      const el = container.querySelector("pre.composer-attachment-preview-text") as HTMLElement;
      expect(el.textContent!.length).toBeGreaterThan(0);
      return el;
    });
    expect(pre.textContent!.length).toBe(8 * 1024);
  });

  it("shows a neutral message when the preview request fails", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 422 }));
    await openWith(textDto());
    expect(await screen.findByText("Preview unavailable.")).toBeTruthy();
  });

  it("does not update state after the card is removed mid-preview", async () => {
    const gate = deferred<unknown>();
    vi.stubGlobal("fetch", () => gate.promise);
    await openWith(textDto());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await act(async () => gate.resolve(streamed([new TextEncoder().encode("late")])));
    await settle();
    expect(screen.queryByText("late")).toBeNull();
  });
});

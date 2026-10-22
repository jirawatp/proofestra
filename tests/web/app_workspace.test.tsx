// @vitest-environment jsdom
// App shell behavior: boot/error states, selection persistence, conversation
// lifecycle, team configuration, export. Intercepted-wire component tests
// against a mocked API module; not a native browser run.
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  conv,
  deferred,
  message,
  newWorld,
  run,
  wireApi,
  type World,
} from "./_kit.js";

let world: World;

beforeEach(() => {
  world = newWorld();
  wireApi(api, world);
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderApp(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText(/catalog/);
  return user;
}

const SELECTED_KEY = "proofestra:selected-conversation-id:v1";

describe("boot", () => {
  it("renders an empty workspace with server-provided runtime metadata", async () => {
    await renderApp();
    expect(screen.getByText("No saved chats yet.")).toBeTruthy();
    expect(screen.getByText(/Live mode disabled · catalog/)).toBeTruthy();
    expect(screen.getByText("Live disabled on server")).toBeTruthy();
    expect(screen.getByText("Local v1 · Mock mode")).toBeTruthy();
    expect(screen.getByText(/Mock mode: no provider calls are made/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Room for another/ })).toBeTruthy();
    expect(screen.getByText("Runtime policy")).toBeTruthy();
    expect(screen.getByText(/Harness invocations: 20/)).toBeTruthy();
    expect(screen.getByText("Tools are not implemented in v1.")).toBeTruthy();
    // Default team: three agents, base plan 2n+1.
    expect(screen.getByText("3 agents · base plan 7")).toBeTruthy();
  });

  it("shows a boot banner when the API is unreachable and still hydrates", async () => {
    api.getProviders!.mockRejectedValue(new Error("connection refused"));
    render(<App />);
    expect(await screen.findByText(/Could not reach the local API: connection refused/)).toBeTruthy();
  });

  it("offers a Live toggle only when the server enables live mode", async () => {
    world.live = true;
    const user = await renderApp();
    const toggle = screen.getByRole("checkbox", { name: /Live mode/ });
    await user.click(toggle);
    expect(screen.getByText("Local v1 · Live mode (opt-in)")).toBeTruthy();
    expect(screen.getByText(/Live: the selected providers each receive/)).toBeTruthy();
    await user.click(toggle);
    expect(screen.getByText("Local v1 · Mock mode")).toBeTruthy();
  });

  it("reports unknown profile readiness honestly", async () => {
    await renderApp();
    expect(screen.getAllByText(/profile unavailable/).length).toBeGreaterThan(0);
  });
});

describe("conversation selection and persistence", () => {
  beforeEach(() => {
    world.convs = [conv(CONV_A, "Alpha chat"), conv(CONV_B, "Beta chat")];
    world.messagesByConv[CONV_A] = [
      message({ id: "m1", conversation_id: CONV_A, role: "user", text: "question one", run_id: "run-a" }),
      message({
        id: "m2",
        conversation_id: CONV_A,
        role: "assistant",
        text: "## Answer\n**bold** text",
        run_id: "run-a",
        sequence: 2,
      }),
    ];
    world.runsByConv[CONV_A] = {
      items: [
        run({
          id: "run-a",
          conversation_id: CONV_A,
          status: "completed",
          presentation: "team_synthesis",
          final_answer: "## Answer\n**bold** text",
          steps: [
            {
              step_id: "s1",
              agent_id: "ag-1",
              stage: "draft",
              provider: "mock",
              status: "completed",
              attempts: 1,
              invocations: [],
              output: "draft body",
              findings: [{ agent_id: "ag-1", step_id: "s1", text: "finding text" }],
              failure: null,
            },
            {
              step_id: "s2",
              agent_id: "ag-1",
              stage: "review",
              provider: "mock",
              status: "failed",
              attempts: 1,
              invocations: [],
              output: null,
              findings: [],
              failure: { code: "provider_error", message: "boom detail" },
            },
          ],
        }),
      ],
      active_run_id: null,
    };
    world.messagesByConv[CONV_B] = [];
  });

  it("opens a conversation, renders history with run details, and persists only the opaque id", async () => {
    const user = await renderApp();
    await user.click(screen.getByRole("button", { name: /^Alpha chat/ }));
    expect(await screen.findByText("question one")).toBeTruthy();
    const answer = await screen.findByRole("heading", { name: "Answer" });
    expect(answer.tagName).toBe("H2");
    expect(screen.getByText(/Inspect run · team · 2 steps · Done/)).toBeTruthy();
    expect(screen.getByText("draft body")).toBeTruthy();
    expect(screen.getByText("finding text")).toBeTruthy();
    expect(screen.getByText(/provider_error — boom detail/)).toBeTruthy();
    expect(screen.getByText("No output.")).toBeTruthy();
    expect(screen.getByText(/reported in unknown · reported out 12/)).toBeTruthy();
    expect(window.localStorage.getItem(SELECTED_KEY)).toBe(CONV_A);
    expect(screen.getByRole("button", { name: /Export JSON/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Alpha chat/ }).getAttribute("aria-current")).toBe("true");
  });

  it("restores the stored selection after a reload", async () => {
    window.localStorage.setItem(SELECTED_KEY, CONV_A);
    render(<App />);
    expect(await screen.findByText("question one")).toBeTruthy();
    expect(window.localStorage.getItem(SELECTED_KEY)).toBe(CONV_A);
  });

  it("splices a stored conversation missing from the first page instead of clearing it", async () => {
    window.localStorage.setItem(SELECTED_KEY, CONV_A);
    api.listConversations!.mockResolvedValue({ items: [conv(CONV_B, "Beta chat")], next_cursor: "more" });
    render(<App />);
    expect(await screen.findByText("question one")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Alpha chat/ })).toBeTruthy();
    expect(window.localStorage.getItem(SELECTED_KEY)).toBe(CONV_A);
  });

  it("clears a stored selection the server confirms was deleted", async () => {
    window.localStorage.setItem(SELECTED_KEY, CONV_A);
    api.listConversations!.mockResolvedValue({ items: [conv(CONV_B, "Beta chat")], next_cursor: null });
    api.getConversation!.mockResolvedValue(null);
    api.getMessages!.mockImplementation(async () => {
      const err = new Error("not found") as Error & { status?: number };
      err.status = 404;
      throw err;
    });
    render(<App />);
    await waitFor(() => expect(window.localStorage.getItem(SELECTED_KEY)).toBeNull());
    expect(screen.queryByText("question one")).toBeNull();
  });

  it("keeps the stored selection through a transient validation failure", async () => {
    window.localStorage.setItem(SELECTED_KEY, CONV_A);
    api.listConversations!.mockResolvedValue({ items: [conv(CONV_B, "Beta chat")], next_cursor: null });
    api.getConversation!.mockRejectedValue(new Error("temporary"));
    render(<App />);
    expect(await screen.findByText("question one")).toBeTruthy();
    expect(window.localStorage.getItem(SELECTED_KEY)).toBe(CONV_A);
  });

  it("ignores and removes a malformed stored id", async () => {
    window.localStorage.setItem(SELECTED_KEY, "not-a-uuid<script>");
    await renderApp();
    expect(window.localStorage.getItem(SELECTED_KEY)).toBeNull();
    expect(screen.getByRole("heading", { name: /Room for another/ })).toBeTruthy();
  });

  it("degrades silently when storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const user = await renderApp();
    await user.click(screen.getByRole("button", { name: /^Beta chat/ }));
    expect(screen.getByRole("button", { name: /^Beta chat/ }).getAttribute("aria-current")).toBe("true");
  });

  it("surfaces a non-404 history load failure as an alert", async () => {
    api.getMessages!.mockRejectedValue(new Error("history exploded"));
    const user = await renderApp();
    await user.click(screen.getByRole("button", { name: /^Alpha chat/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("history exploded");
  });

  it("drops a conversation that disappears (404) while loading it", async () => {
    api.getMessages!.mockImplementation(async () => {
      const err = new Error("gone") as Error & { status?: number };
      err.status = 404;
      throw err;
    });
    const user = await renderApp();
    await user.click(screen.getByRole("button", { name: /^Alpha chat/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Alpha chat/ })).toBeNull());
    expect(window.localStorage.getItem(SELECTED_KEY)).toBeNull();
  });

  it("ignores a history response that arrives after the user switched chats", async () => {
    const slow = deferred<{ items: ReturnType<typeof message>[] }>();
    api.getMessages!.mockImplementation((id: string) =>
      id === CONV_A ? slow.promise : Promise.resolve({ items: [] }),
    );
    const user = await renderApp();
    await user.click(screen.getByRole("button", { name: /^Alpha chat/ }));
    await user.click(screen.getByRole("button", { name: /^Beta chat/ }));
    slow.resolve({ items: world.messagesByConv[CONV_A]! });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("question one")).toBeNull();
  });

  it("recovers a running run after reload and subscribes to its events", async () => {
    const live = run({ id: "run-live", conversation_id: CONV_A, status: "running" });
    world.runsByConv[CONV_A] = { items: [live], active_run_id: "run-live" };
    world.runById["run-live"] = live;
    const user = await renderApp();
    await user.click(screen.getByRole("button", { name: /^Alpha chat/ }));
    expect(await screen.findByText("Your team is considering the question")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    await waitFor(() => expect(world.subs.map((s) => s.runId)).toEqual(["run-live"]));
  });

  it("shows a recovered terminal run without subscribing", async () => {
    const done = run({ id: "run-done", conversation_id: CONV_A, status: "completed", final_answer: "ok" });
    world.runsByConv[CONV_A] = { items: [done], active_run_id: "run-done" };
    world.runById["run-done"] = done;
    const user = await renderApp();
    await user.click(screen.getByRole("button", { name: /^Alpha chat/ }));
    await screen.findByText("Done", { selector: ".status-pill" });
    expect(world.subs).toHaveLength(0);
  });

  it("tolerates a failed active-run recovery fetch", async () => {
    world.runsByConv[CONV_A] = { items: [], active_run_id: "missing-run" };
    const user = await renderApp();
    await user.click(screen.getByRole("button", { name: /^Alpha chat/ }));
    expect(await screen.findByText("question one")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows sent attachment references (with honest coverage) on user messages", async () => {
    world.messagesByConv[CONV_A] = [
      message({
        id: "m1",
        conversation_id: CONV_A,
        role: "user",
        text: "",
        attachments: [
          {
            id: "att-1",
            sanitized_display_name: "notes.txt",
            sniffed_mime: "text/plain",
            kind: "text",
            byte_size: 2048,
            content_sha256: "x",
            extraction_status: "truncated",
            extraction_coverage: { extracted_chars: 10, truncated: true, label: "first 10 chars" },
          },
          {
            id: "att-2",
            sanitized_display_name: "blob.bin",
            sniffed_mime: "application/octet-stream",
            kind: "binary",
            byte_size: 3 * 1024 * 1024,
            content_sha256: "y",
            extraction_status: "none",
            extraction_coverage: { extracted_chars: 0, truncated: false, label: "" },
          },
        ],
      }),
    ];
    const user = await renderApp();
    await user.click(screen.getByRole("button", { name: /^Alpha chat/ }));
    const link = await screen.findByRole("link", { name: "notes.txt" });
    expect(link.getAttribute("href")).toBe("/api/v1/attachments/att-1/download");
    expect(screen.getByText(/2\.0 KiB/)).toBeTruthy();
    expect(screen.getByText("Partial (truncated)").getAttribute("title")).toBe("first 10 chars");
    expect(screen.getByText(/3\.0 MiB/)).toBeTruthy();
    expect(screen.getByText("Attachment only")).toBeTruthy();
  });

  it("shows how each agent received attachments in run details", async () => {
    world.runsByConv[CONV_A]!.items[0] = run({
      id: "run-a",
      conversation_id: CONV_A,
      status: "completed",
      context: {
        attachments: [{ id: "att-9", sanitized_display_name: "scan.pdf" }],
        attachment_coverage: [
          {
            agent_id: "ag-1",
            profile_id: "mock-balanced",
            provider: "mock",
            routes: [
              { attachment_id: "att-9", route: "attachment_only", reason: "no PDF support" },
              { attachment_id: "att-8", route: "native_image", reason: "" },
            ],
            aggregate_note: "",
          },
        ],
      },
    });
    const user = await renderApp();
    await user.click(screen.getByRole("button", { name: /^Alpha chat/ }));
    const section = await screen.findByLabelText("How each agent received the attachments");
    expect(within(section).getByText("scan.pdf")).toBeTruthy();
    expect(within(section).getByText("Attachment only")).toBeTruthy();
    expect(within(section).getByText(/no PDF support/)).toBeTruthy();
    expect(within(section).getByText("Native")).toBeTruthy();
  });
});

describe("conversation lifecycle", () => {
  beforeEach(() => {
    world.convs = [conv(CONV_A, "Alpha chat"), conv(CONV_B, "Beta chat")];
  });

  it("creates and selects a new chat", async () => {
    const user = await renderApp();
    await user.click(screen.getByRole("button", { name: /New chat/ }));
    expect(await screen.findByRole("button", { name: /^New conversation/ })).toBeTruthy();
    expect(api.createConversation).toHaveBeenCalledWith("New conversation");
    expect(document.activeElement?.id).toBe("prompt");
  });

  it("reports a failed new chat", async () => {
    api.createConversation!.mockRejectedValue(new Error("db locked"));
    const user = await renderApp();
    await user.click(screen.getByRole("button", { name: /New chat/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("db locked");
  });

  it("deleting the open chat returns to the empty state and clears the stored id", async () => {
    const user = await renderApp();
    await user.click(screen.getByRole("button", { name: /^Alpha chat/ }));
    await waitFor(() => expect(window.localStorage.getItem(SELECTED_KEY)).toBe(CONV_A));
    await user.click(screen.getByRole("button", { name: "Delete conversation Alpha chat" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Alpha chat/ })).toBeNull());
    expect(api.deleteConversation).toHaveBeenCalledWith(CONV_A);
    expect(screen.getByRole("heading", { name: /Room for another/ })).toBeTruthy();
    expect(window.localStorage.getItem(SELECTED_KEY)).toBeNull();
  });

  it("deleting another chat leaves the open chat alone", async () => {
    const user = await renderApp();
    await user.click(screen.getByRole("button", { name: /^Alpha chat/ }));
    await user.click(screen.getByRole("button", { name: "Delete conversation Beta chat" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Beta chat/ })).toBeNull());
    expect(screen.getByRole("button", { name: /^Alpha chat/ }).getAttribute("aria-current")).toBe("true");
  });

  it("reports a failed delete and keeps the chat listed", async () => {
    api.deleteConversation!.mockRejectedValue(new Error("cannot delete: run active"));
    const user = await renderApp();
    await user.click(screen.getByRole("button", { name: "Delete conversation Beta chat" }));
    expect((await screen.findByRole("alert")).textContent).toBe("cannot delete: run active");
    expect(screen.getByRole("button", { name: /^Beta chat/ })).toBeTruthy();
  });

  it("a delete that resolves after the user opened the doomed chat clears that selection", async () => {
    const pending = deferred<void>();
    api.deleteConversation!.mockImplementation(() => pending.promise);
    const user = await renderApp();
    await user.click(screen.getByRole("button", { name: /^Alpha chat/ }));
    await user.click(screen.getByRole("button", { name: "Delete conversation Beta chat" }));
    await user.click(screen.getByRole("button", { name: /^Beta chat/ }));
    pending.resolve();
    // Beta (now open) was the deleted chat: its view must be cleared and it
    // must not stay selected.
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Beta chat/ })).toBeNull());
    await waitFor(() => expect(window.localStorage.getItem(SELECTED_KEY)).toBeNull());
  });

  it("a delete of the open chat that resolves after switching away keeps the new chat open", async () => {
    const pending = deferred<void>();
    api.deleteConversation!.mockImplementation(() => pending.promise);
    const user = await renderApp();
    await user.click(screen.getByRole("button", { name: /^Alpha chat/ }));
    // Start deleting Alpha (open), then move to Beta before the delete resolves.
    await user.click(screen.getByRole("button", { name: "Delete conversation Alpha chat" }));
    await user.click(screen.getByRole("button", { name: /^Beta chat/ }));
    pending.resolve();
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Alpha chat/ })).toBeNull());
    expect(screen.getByRole("button", { name: /^Beta chat/ }).getAttribute("aria-current")).toBe("true");
    expect(window.localStorage.getItem(SELECTED_KEY)).toBe(CONV_B);
  });
});

describe("export", () => {
  it("downloads a JSON snapshot via a transient object URL", async () => {
    world.convs = [conv(CONV_A, "Alpha chat")];
    const created: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return "blob:fake";
    });
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });
    const user = await renderApp();
    await user.click(screen.getByRole("button", { name: /^Alpha chat/ }));
    await user.click(await screen.findByRole("button", { name: /Export JSON/ }));
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake"));
    expect(api.exportConversation).toHaveBeenCalledWith(CONV_A);
    expect(clicked[0]!.download).toBe(`proofestra-${CONV_A}.json`);
    expect(created[0]!.type).toBe("application/json");
    expect(await created[0]!.text()).toContain(CONV_A);
    // The anchor is removed from the document after the click.
    expect(document.querySelector("a[download]")).toBeNull();
  });

  it("reports an export failure", async () => {
    world.convs = [conv(CONV_A, "Alpha chat")];
    api.exportConversation!.mockRejectedValue(new Error("export denied"));
    const user = await renderApp();
    await user.click(screen.getByRole("button", { name: /^Alpha chat/ }));
    await user.click(await screen.findByRole("button", { name: /Export JSON/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("export denied");
  });
});

describe("team configuration", () => {
  it("Quick keeps exactly one enabled root; Team re-enables all", async () => {
    const user = await renderApp();
    await user.click(screen.getByRole("button", { name: "Quick" }));
    expect(screen.getByText("One selected root")).toBeTruthy();
    expect(screen.getByText("1 agent · base plan 1")).toBeTruthy();
    expect(screen.getByPlaceholderText("Ask one agent…")).toBeTruthy();
    expect(screen.queryByText("Final answer by")).toBeNull();
    const checks = screen.getAllByRole("checkbox", { name: /^Enable / });
    expect(checks.filter((c) => (c as HTMLInputElement).checked)).toHaveLength(1);

    // Selecting another root in Quick moves the single selection.
    await user.click(checks[1]!);
    const after = screen.getAllByRole("checkbox", { name: /^Enable / });
    expect(after.map((c) => (c as HTMLInputElement).checked)).toEqual([false, true, false]);

    await user.click(screen.getByRole("button", { name: "Team" }));
    expect(screen.getByText("3 enabled roots")).toBeTruthy();
    expect(
      screen.getAllByRole("checkbox", { name: /^Enable / }).every((c) => (c as HTMLInputElement).checked),
    ).toBe(true);
    expect(screen.getByText("Independent drafts, cross-review, synthesis")).toBeTruthy();
  });

  it("requires at least two roots in Team and exactly one in Quick before Send enables", async () => {
    const user = await renderApp();
    await user.type(screen.getByLabelText("Message your team"), "hello");
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    const checks = screen.getAllByRole("checkbox", { name: /^Enable / });
    await user.click(checks[0]!);
    await user.click(checks[1]!);
    expect(send.disabled).toBe(true); // 1 enabled root in Team
    await user.click(checks[1]!);
    expect(send.disabled).toBe(false);
    await user.click(screen.getByRole("button", { name: "Quick" }));
    expect(send.disabled).toBe(false);
  });

  it("adds, renames, re-profiles and removes agents, repairing the synthesizer", async () => {
    const user = await renderApp();
    await user.click(screen.getByRole("button", { name: "+ Add agent" }));
    const added = screen.getByDisplayValue("Agent 4");
    fireEvent.change(added, { target: { value: "Fourth" } });
    expect(screen.getByDisplayValue("Fourth")).toBeTruthy();

    const profileSelect = screen.getByLabelText("Profile for Fourth") as HTMLSelectElement;
    expect(profileSelect.value).toBe("mock-balanced");
    await user.selectOptions(profileSelect, "mock-fast");
    expect(screen.getByText(/Mock · model unset · needs_key/)).toBeTruthy();

    // Choose the added agent as synthesizer, then remove it.
    const synth = screen.getByLabelText("Final answer by") as HTMLSelectElement;
    const fourthOption = within(synth).getByRole("option", { name: "Fourth" }) as HTMLOptionElement;
    await user.selectOptions(synth, fourthOption.value);
    expect(synth.value).toBe(fourthOption.value);
    await user.click(screen.getByRole("button", { name: "Remove Fourth" }));
    expect(screen.queryByDisplayValue("Fourth")).toBeNull();
    const repaired = screen.getByLabelText("Final answer by") as HTMLSelectElement;
    expect(within(repaired).queryByRole("option", { name: "Fourth" })).toBeNull();
    expect(repaired.value).not.toBe("");
  });

  it("uses the first available profile id when the catalog is missing", async () => {
    api.getProviders!.mockResolvedValue({ live_enabled: false, catalog_version: "c", items: [] });
    const user = await renderApp();
    await user.click(screen.getByRole("button", { name: "+ Add agent" }));
    expect(screen.getByLabelText("Profile for Agent 4")).toBeTruthy();
  });

  it("lets the user pick a different synthesizer and enable toggles in Team", async () => {
    const user = await renderApp();
    const checks = screen.getAllByRole("checkbox", { name: /^Enable / });
    await user.click(checks[2]!);
    expect(within(screen.getByLabelText("Final answer by")).getAllByRole("option")).toHaveLength(2);
    expect(screen.getByText("2 enabled roots")).toBeTruthy();
  });

  it("shows the server's draft attachments when a chat is opened", async () => {
    world.convs = [conv(CONV_A, "Alpha chat")];
    world.attachmentsByConv[CONV_A] = [attachment({ id: "att-ready", conversation_id: CONV_A })];
    const user = await renderApp();
    await user.click(screen.getByRole("button", { name: /^Alpha chat/ }));
    expect(await screen.findByText("att-ready.txt")).toBeTruthy();
  });
});

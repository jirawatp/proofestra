// @vitest-environment jsdom
// Send / cancel / live-update behavior of the App, including the deferred
// response races that follow a chat switch. Intercepted-wire component tests
// against a mocked API module; not a native browser run and not a live
// provider run.
import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
  conv,
  deferred,
  message,
  newWorld,
  run,
  wireApi,
  type World,
} from "./_kit.js";
import type { RunSnapshot } from "../../src/web/api.js";

const RUN_ID = "run-1";
let world: World;

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
});

async function renderApp(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText(/catalog/);
  return user;
}

async function openChat(user: ReturnType<typeof userEvent.setup>, title: string): Promise<void> {
  await user.click(screen.getByRole("button", { name: new RegExp(`^${title}`) }));
}

async function send(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
  await user.type(screen.getByLabelText("Message your team"), text);
  await user.click(screen.getByRole("button", { name: "Send" }));
}

function runningRun(convId: string, over: Partial<RunSnapshot> = {}): RunSnapshot {
  return run({ id: RUN_ID, conversation_id: convId, status: "running", ...over });
}

function completedRun(convId: string, over: Partial<RunSnapshot> = {}): RunSnapshot {
  return run({
    id: RUN_ID,
    conversation_id: convId,
    status: "completed",
    presentation: "team_synthesis",
    final_answer: "Final **answer**",
    finished_at: "2026-10-21T10:05:00.000Z",
    last_event_sequence: 9,
    ...over,
  });
}

async function settle(ms = 25): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

describe("sending", () => {
  it("submits the trimmed prompt with a pinned payload and then follows live events to completion", async () => {
    api.createRun!.mockResolvedValue(runningRun(CONV_A));
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    await send(user, "  hello team  ");

    await waitFor(() => expect(api.createRun).toHaveBeenCalledTimes(1));
    const input = api.createRun!.mock.calls[0]![0];
    expect(input).toMatchObject({
      conversationId: CONV_A,
      prompt: "hello team",
      mode: "team",
      executionMode: "mock",
      expectedCatalogVersion: "cat-v1",
      expectedRuntimePolicyVersion: "pol-v1",
    });
    expect(input.agents).toHaveLength(3);
    expect(input.agents.map((a: { name: string }) => a.name)).toEqual([
      "OpenAI Writer",
      "Anthropic Reviewer",
      "Gemini Challenger",
    ]);
    expect(input.synthesizerAgentId).toBe(input.agents[0].agent_id);
    expect(typeof input.idempotencyKey).toBe("string");
    expect("attachmentIds" in input).toBe(false);

    expect(await screen.findByText("Your team is considering the question")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect((screen.getByLabelText("Message your team") as HTMLTextAreaElement).value).toBe("");
    expect(world.subs.map((s) => s.runId)).toEqual([RUN_ID]);

    // A live event triggers an authoritative snapshot refresh; the terminal
    // snapshot then reloads the persisted history.
    world.runById[RUN_ID] = completedRun(CONV_A);
    world.messagesByConv[CONV_A] = [
      message({ id: "u1", conversation_id: CONV_A, role: "user", text: "hello team", run_id: RUN_ID }),
      message({ id: "a1", conversation_id: CONV_A, role: "assistant", text: "Final **answer**", run_id: RUN_ID, sequence: 2 }),
    ];
    world.runsByConv[CONV_A] = { items: [world.runById[RUN_ID]!], active_run_id: null };
    await act(async () => world.subs[0]!.onEvent());
    expect((await screen.findByText("answer")).tagName).toBe("STRONG");
    expect(await screen.findByRole("button", { name: "Send" })).toBeTruthy();
    expect(screen.getByText("hello team")).toBeTruthy();
  });

  it("sends with Ctrl+Enter", async () => {
    api.createRun!.mockResolvedValue(runningRun(CONV_A));
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    await user.type(screen.getByLabelText("Message your team"), "via keyboard{Control>}{Enter}{/Control}");
    await waitFor(() => expect(api.createRun).toHaveBeenCalledTimes(1));
    expect(api.createRun!.mock.calls[0]![0].prompt).toBe("via keyboard");
  });

  it("does not send an empty prompt", async () => {
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    const sendButton = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
    await user.type(screen.getByLabelText("Message your team"), "   {Control>}{Enter}{/Control}");
    expect(api.createRun).not.toHaveBeenCalled();
  });

  it("creates a conversation on first send when none is open", async () => {
    api.createRun!.mockImplementation(async (input: { conversationId: string }) => {
      await new Promise((r) => setTimeout(r, 20));
      return runningRun(input.conversationId);
    });
    const user = await renderApp();
    await send(user, "start fresh");
    await waitFor(() => expect(api.createRun).toHaveBeenCalled());
    expect(api.createConversation).toHaveBeenCalledWith("New conversation");
    const created = (await api.createConversation!.mock.results[0]!.value) as { id: string };
    expect(api.createRun!.mock.calls[0]![0].conversationId).toBe(created.id);
    expect(await screen.findByText("Your team is considering the question")).toBeTruthy();
  });

  it("sends in Quick mode with exactly one agent and no synthesizer", async () => {
    api.createRun!.mockResolvedValue(runningRun(CONV_A, { mode: "quick" }));
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    await user.click(screen.getByRole("button", { name: "Quick" }));
    await send(user, "one agent please");
    await waitFor(() => expect(api.createRun).toHaveBeenCalled());
    const input = api.createRun!.mock.calls[0]![0];
    expect(input.mode).toBe("quick");
    expect(input.agents).toHaveLength(1);
    expect(input.synthesizerAgentId).toBeNull();
    expect(await screen.findByText("Working")).toBeTruthy();
  });

  it("falls back to the first enabled agent when the chosen synthesizer is disabled", async () => {
    api.createRun!.mockResolvedValue(runningRun(CONV_A));
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    await user.click(screen.getByRole("checkbox", { name: "Enable OpenAI Writer" }));
    await send(user, "synth fallback");
    await waitFor(() => expect(api.createRun).toHaveBeenCalled());
    const input = api.createRun!.mock.calls[0]![0];
    expect(input.agents).toHaveLength(2);
    expect(input.synthesizerAgentId).toBe(input.agents[0].agent_id);
    expect(input.agents.map((a: { name: string }) => a.name)).not.toContain("OpenAI Writer");
  });

  it("reuses the idempotency key for a retried identical payload and mints a new one when it changes", async () => {
    api.createRun!.mockRejectedValue(new Error("network flake"));
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    await send(user, "same text");
    expect((await screen.findByRole("alert")).textContent).toBe("network flake");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(api.createRun).toHaveBeenCalledTimes(2));
    const [first, second] = api.createRun!.mock.calls.map((c) => c[0].idempotencyKey);
    expect(second).toBe(first);

    await user.type(screen.getByLabelText("Message your team"), " plus more");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(api.createRun).toHaveBeenCalledTimes(3));
    expect(api.createRun!.mock.calls[2]![0].idempotencyKey).not.toBe(first);
  });

  it("reports unavailable server metadata instead of sending", async () => {
    api.getProviders!.mockRejectedValue(new Error("down"));
    const user = await renderApp();
    await send(user, "hello");
    expect((await screen.findByRole("alert")).textContent).toBe("Server metadata unavailable; try reloading");
    expect(api.createRun).not.toHaveBeenCalled();
    expect(api.createConversation).not.toHaveBeenCalled();
  });

  it("shows an already-terminal run's persisted answer without subscribing", async () => {
    api.createRun!.mockResolvedValue(completedRun(CONV_A));
    world.messagesByConv[CONV_A] = [
      message({ id: "u1", conversation_id: CONV_A, role: "user", text: "q", run_id: RUN_ID }),
      message({ id: "a1", conversation_id: CONV_A, role: "assistant", text: "Persisted answer", run_id: RUN_ID, sequence: 2 }),
    ];
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    await send(user, "q");
    expect(await screen.findByText("Persisted answer")).toBeTruthy();
    expect(world.subs).toHaveLength(0);
    // The sidebar list is refreshed after a send.
    expect(api.listConversations!.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("labels fallback and unreviewed presentations honestly", async () => {
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    api.createRun!.mockResolvedValue(
      runningRun(CONV_A, {
        presentation: "draft_fallback",
        final_answer: "draft only",
        limitations: ["review skipped", "synthesis failed"],
      }),
    );
    await send(user, "x");
    expect(await screen.findByText(/Synthesis failed; this is a draft fallback/)).toBeTruthy();
    expect(screen.getByText("Limitations (2)")).toBeTruthy();
    expect(screen.getByText("review skipped")).toBeTruthy();
  });

  it("labels Quick runs as not peer reviewed", async () => {
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    await user.click(screen.getByRole("button", { name: "Quick" }));
    api.createRun!.mockResolvedValue(
      runningRun(CONV_A, { mode: "quick", presentation: "quick_unreviewed", final_answer: "quick text" }),
    );
    await send(user, "x");
    expect(await screen.findByText("Quick: no peer review was performed.")).toBeTruthy();
  });
});

describe("live updates", () => {
  async function startRunningChat(): Promise<ReturnType<typeof userEvent.setup>> {
    const running = runningRun(CONV_A, {
      last_event_sequence: 5,
      usage: { ...runningRun(CONV_A).usage, harness_invocations: 3 },
    });
    api.createRun!.mockResolvedValue(running);
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    await send(user, "go");
    await screen.findByText(/3 \/ base 7/);
    return user;
  }

  it("never regresses to an older snapshot, and adopts a newer one", async () => {
    await startRunningChat();
    world.runById[RUN_ID] = runningRun(CONV_A, {
      last_event_sequence: 1,
      usage: { ...runningRun(CONV_A).usage, harness_invocations: 1 },
    });
    await act(async () => world.subs[0]!.onEvent());
    await settle();
    expect(screen.getByText(/3 \/ base 7/)).toBeTruthy();

    world.runById[RUN_ID] = runningRun(CONV_A, {
      last_event_sequence: 6,
      usage: { ...runningRun(CONV_A).usage, harness_invocations: 4 },
    });
    await act(async () => world.subs[0]!.onFallback!());
    expect(await screen.findByText(/4 \/ base 7/)).toBeTruthy();
  });

  it("ignores a failed snapshot refresh", async () => {
    await startRunningChat();
    api.getRun!.mockRejectedValue(new Error("blip"));
    await act(async () => world.subs[0]!.onFallback!());
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/3 \/ base 7/)).toBeTruthy();
  });

  it("drops a snapshot refresh that resolves after the user switched chats", async () => {
    await startRunningChat();
    const slow = deferred<RunSnapshot>();
    api.getRun!.mockImplementation(() => slow.promise);
    await act(async () => world.subs[0]!.onEvent());
    const user = userEvent.setup();
    await openChat(user, "Beta chat");
    slow.resolve(completedRun(CONV_A));
    await settle();
    expect(screen.queryByText("Done", { selector: ".status-pill" })).toBeNull();
    expect(screen.queryByText("Your team is considering the question")).toBeNull();
  });

  it("closes the live subscription when the user leaves the chat", async () => {
    await startRunningChat();
    const sub = world.subs[0]!;
    const user = userEvent.setup();
    await openChat(user, "Beta chat");
    await waitFor(() => expect(sub.close).toHaveBeenCalled());
  });
});

describe("cancelling", () => {
  async function openRunningChat(): Promise<ReturnType<typeof userEvent.setup>> {
    const live = runningRun(CONV_A);
    world.runsByConv[CONV_A] = { items: [live], active_run_id: RUN_ID };
    world.runById[RUN_ID] = live;
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    await screen.findByRole("button", { name: "Stop" });
    return user;
  }

  it("stops the active run and reloads the saved history", async () => {
    const canceled = runningRun(CONV_A, { status: "canceled", finished_at: "2026-10-21T10:06:00.000Z", last_event_sequence: 4 });
    api.cancelRun!.mockResolvedValue(canceled);
    world.messagesByConv[CONV_A] = [
      message({ id: "u1", conversation_id: CONV_A, role: "user", text: "stopped prompt", run_id: RUN_ID }),
    ];
    const user = await openRunningChat();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(api.cancelRun).toHaveBeenCalledWith(RUN_ID);
    expect(await screen.findByText("Canceled", { selector: ".status-pill" })).toBeTruthy();
    expect(await screen.findByText("stopped prompt")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("reports a cancel failure and keeps the run visible", async () => {
    api.cancelRun!.mockRejectedValue(new Error("cancel refused"));
    const user = await openRunningChat();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect((await screen.findByRole("alert")).textContent).toBe("cancel refused");
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("a cancel that resolves after the user switched chats never paints the other chat", async () => {
    const pending = deferred<RunSnapshot>();
    api.cancelRun!.mockImplementation(() => pending.promise);
    world.messagesByConv[CONV_B] = [
      message({ id: "b1", conversation_id: CONV_B, role: "user", text: "beta history", run_id: "run-b" }),
    ];
    const user = await openRunningChat();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await openChat(user, "Beta chat");
    expect(await screen.findByText("beta history")).toBeTruthy();
    pending.resolve(runningRun(CONV_A, { status: "canceled", last_event_sequence: 4 }));
    await settle();
    expect(screen.queryByText("Canceled", { selector: ".status-pill" })).toBeNull();
    expect(screen.queryByText("Working")).toBeNull();
    expect(screen.queryByText("Your team is considering the question")).toBeNull();
    expect(screen.getByText("beta history")).toBeTruthy();
    // No history reload was issued on behalf of the abandoned chat.
    expect(api.getMessages!.mock.calls.filter((c) => c[0] === CONV_A).length).toBe(1);
  });
});

describe("a send that resolves after the user switched chats", () => {
  it("does not repaint or re-subscribe the chat the user is now viewing, and the run is recovered on return", async () => {
    const pending = deferred<RunSnapshot>();
    api.createRun!.mockImplementation(() => pending.promise);
    world.messagesByConv[CONV_B] = [
      message({ id: "b1", conversation_id: CONV_B, role: "user", text: "beta history", run_id: "run-b" }),
    ];
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    await send(user, "long running question");
    await waitFor(() => expect(api.createRun).toHaveBeenCalled());

    await openChat(user, "Beta chat");
    expect(await screen.findByText("beta history")).toBeTruthy();
    const subsBefore = world.subs.length;

    const running = runningRun(CONV_A);
    world.runById[RUN_ID] = running;
    pending.resolve(running);
    await settle(50);

    // Beta's view is untouched: no run card, no new live subscription.
    expect(screen.queryByText("Your team is considering the question")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByText("beta history")).toBeTruthy();
    expect(world.subs.length).toBe(subsBefore);

    // Returning to Alpha recovers the server-side active run and tails it.
    world.runsByConv[CONV_A] = { items: [running], active_run_id: RUN_ID };
    await openChat(user, "Alpha chat");
    expect(await screen.findByText("Your team is considering the question")).toBeTruthy();
    await waitFor(() => expect(world.subs.map((s) => s.runId)).toContain(RUN_ID));
  });

  it("an already-terminal send for a chat the user left does not overwrite the visible history", async () => {
    const pending = deferred<RunSnapshot>();
    api.createRun!.mockImplementation(() => pending.promise);
    world.messagesByConv[CONV_B] = [
      message({ id: "b1", conversation_id: CONV_B, role: "user", text: "beta history", run_id: "run-b" }),
    ];
    world.messagesByConv[CONV_A] = [
      message({ id: "a-user", conversation_id: CONV_A, role: "user", text: "alpha only", run_id: RUN_ID }),
    ];
    const user = await renderApp();
    await openChat(user, "Alpha chat");
    await send(user, "q");
    await waitFor(() => expect(api.createRun).toHaveBeenCalled());
    await openChat(user, "Beta chat");
    await screen.findByText("beta history");
    pending.resolve(completedRun(CONV_A));
    await settle(50);
    expect(screen.getByText("beta history")).toBeTruthy();
    expect(screen.queryByText("alpha only")).toBeNull();
    expect(world.subs).toHaveLength(0);
  });
});

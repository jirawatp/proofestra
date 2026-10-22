// @vitest-environment jsdom
// Browser API client behavior against stubbed fetch / XMLHttpRequest /
// EventSource. These are intercepted-wire tests, not a live server run.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../src/web/api.js";

type FetchCall = { url: string; init: RequestInit };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let calls: FetchCall[];
let handler: (url: string, init: RequestInit) => Response | Promise<Response>;

function installFetch(): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return handler(url, init);
    }),
  );
}

function sessionOk(token = "csrf-1"): Response {
  return jsonResponse(200, { csrf_token: token });
}

beforeEach(() => {
  api.resetAuthForTests();
  installFetch();
  handler = (url) => (url === "/api/v1/session" ? sessionOk() : jsonResponse(200, { ok: true }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function headerOf(call: FetchCall, name: string): string | null {
  return new Headers(call.init.headers).get(name);
}

describe("session bootstrap", () => {
  it("shares one in-flight bootstrap between concurrent requests", async () => {
    await Promise.all([api.getProviders(), api.getRuntimePolicy(), api.listConversations()]);
    expect(calls.filter((c) => c.url === "/api/v1/session")).toHaveLength(1);
    expect(calls).toHaveLength(4);
  });

  it("does not bootstrap again once a token is cached", async () => {
    await api.getProviders();
    await api.getProviders();
    expect(calls.filter((c) => c.url === "/api/v1/session")).toHaveLength(1);
  });

  it("retries a failing bootstrap with backoff and then succeeds", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    handler = (url) => {
      if (url !== "/api/v1/session") return jsonResponse(200, { ok: true });
      attempts += 1;
      if (attempts === 1) return jsonResponse(503, { error: { code: "x", message: "down" } });
      if (attempts === 2) throw new TypeError("network down");
      return sessionOk("after-retry");
    };
    const p = api.getProviders();
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(500);
    await expect(p).resolves.toEqual({ ok: true });
    expect(attempts).toBe(3);
  });

  it("gives up after the bounded retries and allows a later fresh attempt", async () => {
    vi.useFakeTimers();
    handler = () => jsonResponse(500, {});
    const p = api.getProviders();
    const assertion = expect(p).rejects.toThrow("session bootstrap failed (500)");
    await vi.advanceTimersByTimeAsync(250 + 500 + 1000 + 2000);
    await assertion;
    expect(calls).toHaveLength(5);

    handler = (url) => (url === "/api/v1/session" ? sessionOk() : jsonResponse(200, { recovered: true }));
    await expect(api.getProviders()).resolves.toEqual({ recovered: true });
  });
});

describe("request handling", () => {
  it("sends the CSRF token only on mutating requests", async () => {
    await api.listConversations();
    await api.createConversation("hello");
    await api.deleteConversation("c1");
    const [, list, create, del] = calls;
    expect(headerOf(list!, "x-csrf-token")).toBeNull();
    expect(headerOf(create!, "x-csrf-token")).toBe("csrf-1");
    expect(headerOf(create!, "content-type")).toBe("application/json");
    expect(create!.init.body).toBe(JSON.stringify({ title: "hello" }));
    expect(del!.url).toBe("/api/v1/conversations/c1");
    expect(del!.init.method).toBe("DELETE");
    expect(headerOf(del!, "x-csrf-token")).toBe("csrf-1");
    expect(create!.init.credentials).toBe("include");
  });

  it("returns undefined for 204 and null for an empty body", async () => {
    handler = (url) => (url === "/api/v1/session" ? sessionOk() : new Response(null, { status: 204 }));
    await expect(api.deleteConversation("c1")).resolves.toBeUndefined();
    handler = (url) => (url === "/api/v1/session" ? sessionOk() : new Response("", { status: 200 }));
    await expect(api.getRun("r1")).resolves.toBeNull();
  });

  it("surfaces a typed error from the server envelope", async () => {
    handler = (url) =>
      url === "/api/v1/session"
        ? sessionOk()
        : jsonResponse(409, { error: { code: "run_in_progress", message: "A run is active." } });
    const err = (await api.cancelRun("r1").catch((e: unknown) => e)) as Error & { code?: string; status?: number };
    expect(err.message).toBe("A run is active.");
    expect(err.code).toBe("run_in_progress");
    expect(err.status).toBe(409);
    expect(calls.at(-1)!.url).toBe("/api/v1/runs/r1/cancellation");
    expect(calls.at(-1)!.init.method).toBe("PUT");
  });

  it("uses a generic message when the error body has no envelope", async () => {
    handler = (url) => (url === "/api/v1/session" ? sessionOk() : jsonResponse(500, { nope: true }));
    const err = (await api.getRun("r9").catch((e: unknown) => e)) as Error & { code?: string; status?: number };
    expect(err.message).toBe("GET /api/v1/runs/r9 failed (500)");
    expect(err.code).toBeUndefined();
    expect(err.status).toBe(500);
  });

  it("rejects non-JSON response bodies without leaking the body", async () => {
    handler = (url) => (url === "/api/v1/session" ? sessionOk() : new Response("<html>secret</html>", { status: 200 }));
    const err = (await api.getProviders().catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("invalid JSON from /api/v1/providers");
    expect(err.message).not.toContain("secret");
  });

  it("drops the cached session on 401 so the next call re-bootstraps", async () => {
    let tokens = 0;
    let unauthorized = true;
    handler = (url) => {
      if (url === "/api/v1/session") {
        tokens += 1;
        return sessionOk(`tok-${tokens}`);
      }
      if (unauthorized) {
        unauthorized = false;
        return jsonResponse(401, { error: { code: "unauthorized", message: "no session" } });
      }
      return jsonResponse(200, { ok: true });
    };
    await expect(api.getProviders()).rejects.toThrow("no session");
    await api.createConversation("again");
    expect(tokens).toBe(2);
    expect(headerOf(calls.at(-1)!, "x-csrf-token")).toBe("tok-2");
  });
});

describe("endpoint wrappers", () => {
  it("targets the documented routes", async () => {
    await api.getConversationRuns("c1");
    await api.getMessages("c1");
    await api.exportConversation("c1");
    await api.getRuntimePolicy();
    await api.getAttachmentPolicy();
    await api.listAttachments("c1");
    await api.deleteAttachment("a1");
    const urls = calls.filter((c) => c.url !== "/api/v1/session").map((c) => `${c.init.method ?? "GET"} ${c.url}`);
    expect(urls).toEqual([
      "GET /api/v1/conversations/c1/runs",
      "GET /api/v1/conversations/c1/messages",
      "GET /api/v1/conversations/c1/export",
      "GET /api/v1/runtime-policy",
      "GET /api/v1/attachments/policy",
      "GET /api/v1/conversations/c1/attachments",
      "DELETE /api/v1/attachments/a1",
    ]);
    expect(api.attachmentPreviewUrl("a1")).toBe("/api/v1/attachments/a1/preview");
    expect(api.attachmentDownloadUrl("a1")).toBe("/api/v1/attachments/a1/download");
  });

  it("returns null for a missing conversation but rethrows other failures", async () => {
    handler = (url) =>
      url === "/api/v1/session" ? sessionOk() : jsonResponse(404, { error: { code: "not_found", message: "gone" } });
    await expect(api.getConversation("c1")).resolves.toBeNull();
    handler = (url) =>
      url === "/api/v1/session" ? sessionOk() : jsonResponse(500, { error: { code: "boom", message: "bad" } });
    await expect(api.getConversation("c1")).rejects.toThrow("bad");
    handler = (url) => (url === "/api/v1/session" ? sessionOk() : jsonResponse(200, { id: "c1", title: "t" }));
    await expect(api.getConversation("c1")).resolves.toMatchObject({ id: "c1" });
  });

  it("createRun pins tools/delegation off, versions and idempotency; omits empty attachments", async () => {
    const base: api.CreateRunInput = {
      conversationId: "c1",
      prompt: "hi",
      mode: "team",
      executionMode: "mock",
      agents: [{ agent_id: "a", name: "A", profile_id: "mock.fast" }],
      synthesizerAgentId: "a",
      idempotencyKey: "key-1",
      expectedCatalogVersion: "cat-1",
      expectedRuntimePolicyVersion: "pol-1",
    };
    await api.createRun({ ...base, attachmentIds: [] });
    await api.createRun({ ...base, attachmentIds: ["x", "y"] });
    const [, first, second] = calls;
    expect(first!.url).toBe("/api/v1/conversations/c1/runs");
    expect(headerOf(first!, "idempotency-key")).toBe("key-1");
    const firstBody = JSON.parse(first!.init.body as string);
    expect(firstBody).toMatchObject({
      prompt: "hi",
      mode: "team",
      execution_mode: "mock",
      synthesizer_agent_id: "a",
      tool_policy: { mode: "off" },
      delegation: { enabled: false },
      expected_catalog_version: "cat-1",
      expected_runtime_policy_version: "pol-1",
    });
    expect("attachment_ids" in firstBody).toBe(false);
    expect(JSON.parse(second!.init.body as string).attachment_ids).toEqual(["x", "y"]);
  });
});

describe("newIdempotencyKey", () => {
  it("uses crypto.randomUUID when available", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "fixed-uuid" });
    expect(api.newIdempotencyKey()).toBe("fixed-uuid");
  });

  it("falls back to a well-formed v4 UUID without crypto", () => {
    vi.stubGlobal("crypto", undefined);
    const a = api.newIdempotencyKey();
    const b = api.newIdempotencyKey();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// EventSource
// ---------------------------------------------------------------------------

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  init: unknown;
  closed = false;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  constructor(url: string, init?: unknown) {
    this.url = url;
    this.init = init;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data: string): void {
    const event = { data } as MessageEvent;
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

function evt(sequence: number, type = "run.updated"): string {
  return JSON.stringify({ type, run_id: "r1", sequence, at: "t", data: {} });
}

describe("subscribeRunEvents", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.useFakeTimers();
  });

  it("opens an authenticated stream and forwards typed events once, in order", () => {
    const seen: number[] = [];
    api.subscribeRunEvents("r1", (e) => seen.push(e.sequence));
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe("/api/v1/runs/r1/events");
    expect(es.init).toEqual({ withCredentials: true });
    es.emit("run.created", evt(1, "run.created"));
    es.emit("step.started", evt(2, "step.started"));
    es.emit("step.started", evt(2, "step.started")); // duplicate
    es.emit("run.updated", evt(1)); // regress
    es.onmessage!({ data: evt(3) } as MessageEvent);
    es.emit("run.terminal", evt(4, "run.terminal"));
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it("ignores malformed frames without breaking the stream", () => {
    const seen: number[] = [];
    api.subscribeRunEvents("r1", (e) => seen.push(e.sequence));
    const es = FakeEventSource.instances[0]!;
    es.emit("run.updated", "not json");
    es.emit("run.updated", evt(1));
    expect(seen).toEqual([1]);
  });

  it("reconnects with exponential backoff, signalling fallback each time", () => {
    const fallback = vi.fn();
    api.subscribeRunEvents("r1", () => undefined, fallback);
    const first = FakeEventSource.instances[0]!;
    first.onerror!();
    expect(first.closed).toBe(true);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(299);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.instances[1]!.onerror!();
    vi.advanceTimersByTime(599);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(3);
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it("resets the backoff after a successful event", () => {
    api.subscribeRunEvents("r1", () => undefined);
    FakeEventSource.instances[0]!.onerror!();
    vi.advanceTimersByTime(300);
    const second = FakeEventSource.instances[1]!;
    second.emit("run.updated", evt(1));
    second.onerror!();
    vi.advanceTimersByTime(300); // back to base delay, not 600
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it("stops reconnecting after the bounded number of attempts but keeps calling fallback", () => {
    const fallback = vi.fn();
    api.subscribeRunEvents("r1", () => undefined, fallback);
    let opened = 1;
    for (let i = 0; i < 20; i += 1) {
      const es = FakeEventSource.instances.at(-1)!;
      if (es.closed) break;
      es.onerror!();
      vi.advanceTimersByTime(10_000);
      if (FakeEventSource.instances.length > opened) opened = FakeEventSource.instances.length;
    }
    // 1 initial + 6 reconnects, then it gives up.
    expect(FakeEventSource.instances).toHaveLength(7);
    expect(fallback).toHaveBeenCalledTimes(7);
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(7);
  });

  it("close() cancels a pending reconnect and ignores later errors", () => {
    const fallback = vi.fn();
    const sub = api.subscribeRunEvents("r1", () => undefined, fallback);
    const es = FakeEventSource.instances[0]!;
    es.onerror!();
    sub.close();
    vi.advanceTimersByTime(10_000);
    expect(FakeEventSource.instances).toHaveLength(1);

    const sub2 = api.subscribeRunEvents("r1", () => undefined, fallback);
    const es2 = FakeEventSource.instances[1]!;
    sub2.close();
    expect(es2.closed).toBe(true);
    const before = fallback.mock.calls.length;
    es2.onerror!();
    expect(fallback.mock.calls.length).toBe(before);
  });

  it("tolerates a missing fallback callback", () => {
    api.subscribeRunEvents("r1", () => undefined);
    expect(() => FakeEventSource.instances[0]!.onerror!()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// XMLHttpRequest upload
// ---------------------------------------------------------------------------

class Target {
  listeners = new Map<string, Set<(e?: unknown) => void>>();
  addEventListener(type: string, fn: (e?: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, fn: (e?: unknown) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type: string, event?: unknown): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakeXHR extends Target {
  static last: FakeXHR | null = null;
  static abortThrows = false;
  upload = new Target();
  status = 0;
  responseText = "";
  withCredentials = false;
  headers: Array<[string, string]> = [];
  opened: { method: string; url: string } | null = null;
  sent: unknown = null;
  abortCalls = 0;
  constructor() {
    super();
    FakeXHR.last = this;
  }
  open(method: string, url: string): void {
    this.opened = { method, url };
  }
  setRequestHeader(k: string, v: string): void {
    this.headers.push([k, v]);
  }
  send(body: unknown): void {
    this.sent = body;
  }
  abort(): void {
    this.abortCalls += 1;
    if (FakeXHR.abortThrows) throw new Error("abort failed");
    // Real XHR semantics: abort() while UNSENT, or OPENED with send() not yet
    // called, changes nothing observable and fires NO abort event. Only a
    // request that was actually sent emits "abort".
    if (this.opened && this.sent !== null) this.emit("abort");
  }
  finish(status: number, body: string): void {
    this.status = status;
    this.responseText = body;
    this.emit("load");
  }
}

const sampleFile = (): File => new File(["hello"], "note.txt", { type: "text/plain" });
const attachmentDto = { id: "a1", sanitized_display_name: "note.txt" };

async function flush(): Promise<void> {
  // A macrotask turn drains every pending microtask (fetch stub, json, boot).
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("uploadAttachment", () => {
  beforeEach(() => {
    FakeXHR.last = null;
    FakeXHR.abortThrows = false;
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
  });

  it("uploads multipart with the CSRF header set exactly once and reports progress", async () => {
    const progress: Array<[number, number]> = [];
    const p = api.uploadAttachment("c1", sampleFile(), { onProgress: (l, t) => progress.push([l, t]) });
    await flush();
    const xhr = FakeXHR.last!;
    expect(xhr.opened).toEqual({ method: "POST", url: "/api/v1/conversations/c1/attachments" });
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.headers.filter(([k]) => k === "x-csrf-token")).toEqual([["x-csrf-token", "csrf-1"]]);
    expect(xhr.headers.some(([k]) => k.toLowerCase() === "content-type")).toBe(false);
    expect(xhr.sent).toBeInstanceOf(FormData);
    expect((xhr.sent as FormData).get("file")).toBeInstanceOf(File);

    xhr.upload.emit("progress", { lengthComputable: true, loaded: 2, total: 5 });
    xhr.upload.emit("progress", { lengthComputable: false, loaded: 3, total: 0 });
    xhr.finish(201, JSON.stringify({ attachment: attachmentDto }));
    await expect(p).resolves.toEqual(attachmentDto);
    expect(progress).toEqual([[2, 5]]);
    // listeners are all detached after settle
    expect(xhr.count("load")).toBe(0);
    expect(xhr.upload.count("progress")).toBe(0);
  });

  it("ignores progress without a handler", async () => {
    const p = api.uploadAttachment("c1", sampleFile());
    await flush();
    FakeXHR.last!.upload.emit("progress", { lengthComputable: true, loaded: 1, total: 2 });
    FakeXHR.last!.finish(200, JSON.stringify({ attachment: attachmentDto }));
    await expect(p).resolves.toEqual(attachmentDto);
  });

  it("rejects a 2xx response with an unparseable body", async () => {
    const p = api.uploadAttachment("c1", sampleFile());
    await flush();
    FakeXHR.last!.finish(200, "<<<");
    await expect(p).rejects.toThrow("invalid JSON from upload");
  });

  it("maps a server error envelope to a typed error", async () => {
    const p = api.uploadAttachment("c1", sampleFile());
    await flush();
    FakeXHR.last!.finish(
      413,
      JSON.stringify({ error: { code: "file_too_large", message: "File is too large." } }),
    );
    const err = (await p.catch((e: unknown) => e)) as Error & { code?: string; status?: number };
    expect(err.message).toBe("File is too large.");
    expect(err.code).toBe("file_too_large");
    expect(err.status).toBe(413);
  });

  it("falls back to a generic message for non-JSON or envelope-less failures", async () => {
    const p1 = api.uploadAttachment("c1", sampleFile());
    await flush();
    FakeXHR.last!.finish(502, "<html>proxy</html>");
    const e1 = (await p1.catch((e: unknown) => e)) as Error & { code?: string; status?: number };
    expect(e1.message).toBe("upload failed (502)");
    expect(e1.code).toBe("upload_failed");
    expect(e1.status).toBe(502);

    const p2 = api.uploadAttachment("c1", sampleFile());
    await flush();
    FakeXHR.last!.finish(500, JSON.stringify({ unrelated: true }));
    const e2 = (await p2.catch((e: unknown) => e)) as Error & { code?: string };
    expect(e2.message).toBe("upload failed (500)");
    expect(e2.code).toBe("upload_failed");
  });

  it("drops the cached session after a 401 upload so the next upload re-bootstraps without auto-resubmitting", async () => {
    let tokens = 0;
    handler = (url) => {
      if (url === "/api/v1/session") {
        tokens += 1;
        return sessionOk(`tok-${tokens}`);
      }
      return jsonResponse(200, {});
    };
    const p = api.uploadAttachment("c1", sampleFile());
    await flush();
    const first = FakeXHR.last!;
    first.finish(401, JSON.stringify({ error: { code: "unauthorized", message: "Session expired." } }));
    await expect(p).rejects.toThrow("Session expired.");

    const p2 = api.uploadAttachment("c1", sampleFile());
    await flush();
    const second = FakeXHR.last!;
    expect(second).not.toBe(first);
    expect(second.headers.find(([k]) => k === "x-csrf-token")![1]).toBe("tok-2");
    expect(tokens).toBe(2);
    second.finish(201, JSON.stringify({ attachment: attachmentDto }));
    await expect(p2).resolves.toEqual(attachmentDto);
  });

  it("reports network errors", async () => {
    const p = api.uploadAttachment("c1", sampleFile());
    await flush();
    FakeXHR.last!.emit("error");
    await expect(p).rejects.toThrow("network error");
  });

  it("reports an xhr abort event as a cancel", async () => {
    const p = api.uploadAttachment("c1", sampleFile());
    await flush();
    FakeXHR.last!.emit("abort");
    await expect(p).rejects.toThrow("upload canceled");
  });

  it("rejects immediately for an already-aborted signal without touching XHR or the session", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(api.uploadAttachment("c1", sampleFile(), { signal: controller.signal })).rejects.toThrow(
      "upload canceled",
    );
    expect(FakeXHR.last).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("aborts an in-flight upload when the signal fires", async () => {
    const controller = new AbortController();
    const p = api.uploadAttachment("c1", sampleFile(), { signal: controller.signal });
    await flush();
    const xhr = FakeXHR.last!;
    controller.abort();
    await expect(p).rejects.toThrow("upload canceled");
    expect(xhr.abortCalls).toBe(1);
  });

  it("still rejects as canceled if xhr.abort() itself throws", async () => {
    FakeXHR.abortThrows = true;
    const controller = new AbortController();
    const p = api.uploadAttachment("c1", sampleFile(), { signal: controller.signal });
    await flush();
    controller.abort();
    expect(FakeXHR.last!.abortCalls).toBe(1);
    // abort() threw before emitting; the late server response must not resolve a canceled upload twice.
    FakeXHR.last!.emit("abort");
    await expect(p).rejects.toThrow("upload canceled");
  });

  it("cancels promptly while the session bootstrap is still pending and never opens the request", async () => {
    let releaseBoot!: (r: Response) => void;
    handler = (url) =>
      url === "/api/v1/session"
        ? new Promise<Response>((resolve) => {
            releaseBoot = resolve;
          })
        : jsonResponse(200, {});
    const controller = new AbortController();
    const settled = vi.fn();
    const p = api.uploadAttachment("c1", sampleFile(), { signal: controller.signal });
    p.then(settled, settled);
    await flush();
    controller.abort();
    await flush();
    // Settled as canceled BEFORE the session bootstrap resolves.
    expect(settled).toHaveBeenCalledTimes(1);
    await expect(p).rejects.toThrow("upload canceled");
    releaseBoot(sessionOk());
    await flush();
    expect(FakeXHR.last!.opened).toBeNull();
    expect(FakeXHR.last!.sent).toBeNull();
  });

  it("does not open the request if the signal fires between bootstrap and open", async () => {
    const controller = new AbortController();
    const p = api.uploadAttachment("c1", sampleFile(), { signal: controller.signal });
    // Abort synchronously after the call; boot() resolves on a later microtask.
    controller.abort();
    await expect(p).rejects.toThrow("upload canceled");
    await flush();
    expect(FakeXHR.last!.opened).toBeNull();
  });

  it("reports session bootstrap failure", async () => {
    vi.useFakeTimers();
    handler = () => jsonResponse(500, {});
    const p = api.uploadAttachment("c1", sampleFile());
    const assertion = expect(p).rejects.toThrow("session bootstrap failed: session bootstrap failed (500)");
    await vi.advanceTimersByTimeAsync(250 + 500 + 1000 + 2000);
    await assertion;
    expect(FakeXHR.last!.opened).toBeNull();
  });

  it("refuses to send without a CSRF token", async () => {
    handler = (url) => (url === "/api/v1/session" ? jsonResponse(200, {}) : jsonResponse(200, {}));
    const p = api.uploadAttachment("c1", sampleFile());
    await expect(p).rejects.toThrow("session not ready; csrf token missing");
    expect(FakeXHR.last!.opened).toBeNull();
  });
});

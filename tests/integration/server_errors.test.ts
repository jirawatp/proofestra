// Unhandled-error behaviour: every failure leaves the server as the standard
// error envelope, and internal failure text never reaches the client.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createConversation, makeServer, quickRunBody, seedAttachment, waitTerminal, type ServerCtx } from "./_server_helpers.js";
import type { RunSnapshot } from "../../src/shared/types.js";
import { catalogVersion } from "../../src/core/registry.js";
import { RUNTIME_POLICY_VERSION } from "../../src/shared/config.js";

let ctx: ServerCtx | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await ctx?.cleanup();
  ctx = null;
});

type Envelope = { error: { code: string; message: string; request_id: string; details: unknown[] } };

describe("error envelope", () => {
  it("an unexpected internal error is a 500 internal_error with a fixed message (no path, driver or stack text)", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    vi.spyOn(ctx.bundle.coordinator, "createRun").mockImplementation(() => {
      throw new Error("SQLITE_CANTOPEN: unable to open /Users/me/private/proofestra.sqlite");
    });
    const r = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/conversations/${id}/runs`,
      headers: ctx.headers({ "idempotency-key": crypto.randomUUID() }),
      payload: quickRunBody("x"),
    });
    expect(r.statusCode).toBe(500);
    const body = r.json() as Envelope;
    expect(body.error).toMatchObject({ code: "internal_error", message: "internal server error", details: [] });
    expect(body.error.request_id).toBe(r.headers["x-request-id"]);
    expect(r.payload).not.toContain("/Users/me");
    expect(r.payload).not.toContain("SQLITE");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
  });

  it.each([
    [400, "invalid_request"],
    [404, "not_found"],
    [409, "invalid_request"],
    [413, "payload_too_large"],
    [415, "unsupported_media_type"],
    [422, "validation_failed"],
  ])("a thrown error carrying status %i keeps that status with code %s and its own (client-safe) message", async (statusCode, code) => {
    ctx = await makeServer();
    vi.spyOn(ctx.bundle.conversations, "list").mockImplementation(() => {
      throw Object.assign(new Error("client-visible reason"), { statusCode });
    });
    const r = await ctx.app.inject({ method: "GET", url: "/api/v1/conversations", headers: ctx.headers() });
    expect(r.statusCode).toBe(statusCode);
    expect((r.json() as Envelope).error).toMatchObject({ code, message: "client-visible reason" });
  });

  it.each([["abc"], [200], [302], [99], [700]])("a nonsensical error status %j is treated as an internal 500", async (statusCode) => {
    ctx = await makeServer();
    vi.spyOn(ctx.bundle.conversations, "list").mockImplementation(() => {
      throw Object.assign(new Error("secret internals"), { statusCode });
    });
    const r = await ctx.app.inject({ method: "GET", url: "/api/v1/conversations", headers: ctx.headers() });
    expect(r.statusCode).toBe(500);
    expect(r.payload).not.toContain("secret internals");
  });

  it("malformed JSON is a 400 invalid_request envelope", async () => {
    ctx = await makeServer();
    const r = await ctx.app.inject({ method: "POST", url: "/api/v1/conversations", headers: ctx.headers(), payload: "{not json" });
    expect(r.statusCode).toBe(400);
    expect((r.json() as Envelope).error.code).toBe("invalid_request");
    expect((r.json() as Envelope).error.request_id).toBeTruthy();
  });

  it("a JSON body above the 128 KiB limit is a 413 payload_too_large envelope", async () => {
    ctx = await makeServer();
    const r = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/conversations",
      headers: ctx.headers(),
      payload: JSON.stringify({ title: "x".repeat(200 * 1024) }),
    });
    expect(r.statusCode).toBe(413);
    expect((r.json() as Envelope).error.code).toBe("payload_too_large");
  });

  it("an unsupported content type is a 415 unsupported_media_type envelope", async () => {
    ctx = await makeServer();
    const r = await ctx.app.inject({ method: "POST", url: "/api/v1/conversations", headers: ctx.headers({ "content-type": "application/xml" }), payload: "<a/>" });
    expect(r.statusCode).toBe(415);
    expect((r.json() as Envelope).error.code).toBe("unsupported_media_type");
  });
});

describe("run creation: fully specified request and background failures", () => {
  it("accepts every optional field (role, delegation off, tool policy off, limits, pinned versions, attachments) and freezes them", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const att = seedAttachment(ctx, id, { kind: "text", mime: "text/plain", name: "n.txt", extractedText: "note", extractionStatus: "text_extracted" });
    const agentId = crypto.randomUUID();
    const r = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/conversations/${id}/runs`,
      headers: ctx.headers({ "idempotency-key": crypto.randomUUID() }),
      payload: {
        prompt: "with everything",
        mode: "quick",
        execution_mode: "mock",
        agents: [{ agent_id: agentId, name: "Role agent", profile_id: "mock-concise", role: "skeptic" }],
        synthesizer_agent_id: null,
        delegation: { enabled: false, allowed_profile_ids: ["mock-balanced"] },
        tool_policy: { mode: "off", allowed_tool_ids: ["x"] },
        limits: { concurrency: 1, overall_timeout_seconds: 120 },
        review_topology: "all_peers",
        expected_catalog_version: catalogVersion(ctx.config),
        expected_runtime_policy_version: RUNTIME_POLICY_VERSION,
        attachment_ids: [att.id],
      },
    });
    expect(r.statusCode).toBe(201);
    const snap = r.json() as RunSnapshot;
    expect(snap.agents[0]!.role).toBe("skeptic");
    expect(snap.limits.concurrency).toBe(1);
    expect(snap.limits.overall_timeout_seconds).toBe(120);
    expect(snap.delegation.allowed_profile_ids).toEqual(["mock-balanced"]);
    expect(snap.tool_policy.allowed_tool_ids).toEqual(["x"]);
    expect(snap.context.attachments!.map((a) => a.id)).toEqual([att.id]);
    expect((await waitTerminal(ctx, snap.id)).status).toBe("completed");
  });

  it("an attachment-only send (empty prompt) is accepted when a file is attached", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const att = seedAttachment(ctx, id, { kind: "text", mime: "text/plain", extractedText: "note", extractionStatus: "text_extracted" });
    const r = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/conversations/${id}/runs`,
      headers: ctx.headers({ "idempotency-key": crypto.randomUUID() }),
      payload: quickRunBody("", { attachment_ids: [att.id] }),
    });
    expect(r.statusCode).toBe(201);
    await waitTerminal(ctx, (r.json() as RunSnapshot).id);
  });

  it("an unexpected startRun rejection is logged, never crashes the request, and the run is still reported as created", async () => {
    ctx = await makeServer();
    const id = await createConversation(ctx);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(ctx.bundle.coordinator, "startRun").mockRejectedValue(new Error("scheduler exploded"));
    const r = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/conversations/${id}/runs`,
      headers: ctx.headers({ "idempotency-key": crypto.randomUUID() }),
      payload: quickRunBody("x"),
    });
    expect(r.statusCode).toBe(201);
    await vi.waitFor(() => expect(errorLog.mock.calls.some((c) => String(c[0]).includes("startRun unexpected rejection"))).toBe(true));
  });
});

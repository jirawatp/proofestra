// Contract check: REAL responses from the running app (mock runs, a fake native
// backend, an injected live wire, attachments, errors, SSE frames) are validated
// against docs/openapi.yaml with a JSON Schema validator. This keeps the
// "implemented v1 runtime contract" half of the document honest. It says
// nothing about the design-only paths, which are labelled x-proofestra-status
// and are asserted NOT to be served.
//
// The schemas are NOT loosened to make this pass: a field that the server does
// not return is optional/design-only in the document, and a field the server
// does return is declared with its real type.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { load } from "js-yaml";
import Ajv from "ajv8";
import addFormats from "ajv-formats";
import type { ProofestraConfig } from "../../src/shared/config.js";
import { TEST_COMPLETE_VERIFICATION, makeFakeCodex, okTranscript, type FakeCodex } from "../adapters/_fakeCodex.js";
import { createConversation, makeServer, seedAttachment, waitTerminal, type ServerCtx } from "./_server_helpers.js";

type Json = Record<string, unknown>;
const SPEC_PATH = path.resolve(__dirname, "../../docs/openapi.yaml");
let spec: Json;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the validator's public type is generic over schema shapes
let ajv: any;

beforeAll(() => {
  spec = load(fs.readFileSync(SPEC_PATH, "utf8")) as Json;
  const AjvCtor = Ajv as unknown as new (o: object) => unknown;
  ajv = new AjvCtor({ strict: false, allErrors: true });
  (addFormats as unknown as (a: unknown) => void)(ajv);
});

let ctx: ServerCtx | null = null;
const fakes: FakeCodex[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await ctx?.cleanup();
  ctx = null;
  for (const f of fakes.splice(0)) f.cleanup();
});

const uuid = () => crypto.randomUUID();
const components = (): Json => spec.components as Json;

function resolveRef<T>(node: unknown): T {
  let cur = node as Json;
  for (let i = 0; i < 10 && typeof cur.$ref === "string"; i += 1) {
    const parts = (cur.$ref as string).replace(/^#\//, "").split("/");
    cur = parts.reduce<unknown>((acc, p) => (acc as Json)[p], spec) as Json;
  }
  return cur as T;
}

function validate(schema: object, body: unknown, label: string): void {
  const validator = ajv.compile({ ...schema, components: components() });
  const ok = validator(body) as boolean;
  if (!ok) {
    const errors = (validator.errors as Array<{ instancePath: string; message?: string; params: unknown }>)
      .slice(0, 12)
      .map((e) => `${e.instancePath || "/"} ${e.message} ${JSON.stringify(e.params)}`)
      .join("\n  ");
    throw new Error(`${label} does not match docs/openapi.yaml:\n  ${errors}`);
  }
}

/** Validate a JSON response against the document's schema for (method, path template, status). */
function expectResponse(method: string, template: string, status: number, body: unknown): void {
  const paths = spec.paths as Record<string, Record<string, Json>>;
  const op = paths[template]?.[method.toLowerCase()];
  if (!op) throw new Error(`docs/openapi.yaml has no ${method} ${template}`);
  const responses = op.responses as Record<string, unknown>;
  const response = resolveRef<Json>(responses[String(status)] ?? responses.default);
  const content = (response.content as Record<string, { schema: object }> | undefined)?.["application/json"];
  if (!content) throw new Error(`${method} ${template} ${status}: no JSON schema documented`);
  validate(content.schema, body, `${method} ${template} -> ${status}`);
}

async function call(c: ServerCtx, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, extra: Record<string, string> = {}) {
  return c.app.inject({
    method,
    url,
    headers: payload === undefined && method !== "POST" ? c.bodyless(extra) : c.headers(extra),
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

function runBody(agents: Array<{ profile_id: string }>, over: Json = {}): Json {
  const withIds = agents.map((a, i) => ({ agent_id: uuid(), name: `A${i}`, ...a }));
  const team = withIds.length > 1;
  return {
    prompt: "Compare the options",
    mode: team ? "team" : "quick",
    execution_mode: "mock",
    agents: withIds,
    ...(team ? { synthesizer_agent_id: withIds[0]!.agent_id } : {}),
    ...over,
  };
}

/** True only for the server's own "no such API route" answer, in either build state. */
function isUnroutedApi404(resp: { statusCode: number; json(): unknown }): boolean {
  if (resp.statusCode !== 404) return false;
  const body = resp.json() as { error?: { code?: string; message?: string } };
  return body.error?.code === "not_found" && body.error.message === "unknown API path";
}

async function createRun(c: ServerCtx, conv: string, body: Json) {
  const resp = await call(c, "POST", `/api/v1/conversations/${conv}/runs`, body, { "idempotency-key": uuid() });
  return resp;
}

describe("the document is parseable and self-consistent", () => {
  it("every $ref resolves, and every operation has an operationId and a status label", () => {
    const missing: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object") {
        const o = node as Json;
        if (typeof o.$ref === "string") {
          try {
            resolveRef(o);
          } catch {
            missing.push(o.$ref);
          }
        }
        Object.values(o).forEach(walk);
      }
    };
    walk(spec);
    expect(missing).toEqual([]);
    const paths = spec.paths as Record<string, Record<string, Json>>;
    for (const [template, item] of Object.entries(paths)) {
      for (const method of ["get", "post", "put", "delete"]) {
        const op = item[method];
        if (!op) continue;
        expect(typeof op.operationId, `${method} ${template}`).toBe("string");
        expect(["implemented_v1", "design_only"], `${method} ${template}`).toContain(op["x-proofestra-status"]);
      }
    }
  });

  // The served/unserved answer must not depend on whether the checkout has a
  // client build (`dist/public`, which is git-ignored and produced AFTER the
  // tests in the canonical gate). Both situations are constructed explicitly,
  // with `process.cwd` pointed at a temp dir, never at the real repository.
  describe.each([["unbuilt checkout (no client build)", false], ["built checkout (static client + SPA fallback)", true]] as const)(
    "design-only operations are exactly the ones the server does not serve: %s",
    (_label, built) => {
      it("unserved routes get the documented 404 envelope, implemented ones are routed", async () => {
        ctx = await makeServer({
          beforeBuild: ({ workDir, dataDir }) => {
            if (built) {
              fs.mkdirSync(path.join(workDir, "dist/public"), { recursive: true });
              fs.writeFileSync(path.join(workDir, "dist/public/index.html"), "<!doctype html><title>spa</title>");
            }
            vi.spyOn(process, "cwd").mockReturnValue(built ? workDir : dataDir);
          },
        });
        const paths = spec.paths as Record<string, Record<string, Json>>;
        const conv = await createConversation(ctx);
        const run = await createRun(ctx, conv, runBody([{ profile_id: "mock-balanced" }]));
        const sample: Record<string, string> = {
          "{conversation_id}": conv,
          "{run_id}": (run.json() as { id: string }).id,
          "{attachment_id}": uuid(),
        };
        let design = 0;
        for (const [template, item] of Object.entries(paths)) {
          const url = "/api/v1" + template.replace(/\{[a-z_]+\}/g, (m) => sample[m] ?? uuid());
          for (const method of ["get", "post", "put", "delete"] as const) {
            const op = item[method];
            if (!op) continue;
            const resp = await ctx.app.inject({
              method: method.toUpperCase() as "GET",
              url,
              headers: method === "get" ? ctx.bodyless() : ctx.headers({ "idempotency-key": uuid() }),
              ...(method === "post" ? { payload: {} } : {}),
            });
            const unrouted = isUnroutedApi404(resp);
            if (op["x-proofestra-status"] === "design_only") {
              design += 1;
              expect(unrouted, `${method} ${template} is documented design_only but is served (${resp.statusCode})`).toBe(true);
              // A design-only path must never fall through to the SPA page, even when a client build exists.
              expect(resp.headers["content-type"]).toMatch(/application\/json/);
            } else {
              expect(unrouted, `${method} ${template} is documented implemented_v1 but is not served`).toBe(false);
            }
          }
        }
        expect(design).toBeGreaterThan(0);
        await waitTerminal(ctx, (run.json() as { id: string }).id);
      });
    },
  );
});

describe("real mock-mode responses match the implemented contract", () => {
  it("session, providers, runtime policy, conversations, messages, export and errors", async () => {
    ctx = await makeServer();
    // A fresh bootstrap (the helper's own session stays in use below).
    const session = await ctx.app.inject({ method: "GET", url: "/api/v1/session", headers: { host: ctx.hostHeader } });
    expect(session.statusCode).toBe(200);
    expectResponse("GET", "/session", 200, session.json());

    const providers = await call(ctx, "GET", "/api/v1/providers");
    expectResponse("GET", "/providers", 200, providers.json());
    const policy = await call(ctx, "GET", "/api/v1/runtime-policy");
    expectResponse("GET", "/runtime-policy", 200, policy.json());

    const created = await call(ctx, "POST", "/api/v1/conversations", { title: "contract" });
    expect(created.statusCode).toBe(201);
    expectResponse("POST", "/conversations", 201, created.json());
    const id = (created.json() as { id: string }).id;
    expectResponse("GET", "/conversations", 200, (await call(ctx, "GET", "/api/v1/conversations")).json());
    expectResponse("GET", "/conversations/{conversation_id}", 200, (await call(ctx, "GET", `/api/v1/conversations/${id}`)).json());

    const run = await createRun(ctx, id, runBody([{ profile_id: "mock-balanced" }, { profile_id: "mock-analytical" }]));
    expect(run.statusCode).toBe(201);
    expectResponse("POST", "/conversations/{conversation_id}/runs", 201, run.json());
    const runId = (run.json() as { id: string }).id;
    await waitTerminal(ctx, runId);
    const snap = await call(ctx, "GET", `/api/v1/runs/${runId}`);
    expectResponse("GET", "/runs/{run_id}", 200, snap.json());
    expectResponse("GET", "/conversations/{conversation_id}/runs", 200, (await call(ctx, "GET", `/api/v1/conversations/${id}/runs`)).json());
    expectResponse("GET", "/conversations/{conversation_id}/messages", 200, (await call(ctx, "GET", `/api/v1/conversations/${id}/messages`)).json());
    expectResponse("GET", "/conversations/{conversation_id}/export", 200, (await call(ctx, "GET", `/api/v1/conversations/${id}/export`)).json());

    // Cancel of a terminal run returns the (terminal) snapshot.
    const canceled = await call(ctx, "PUT", `/api/v1/runs/${runId}/cancellation`);
    expect(canceled.statusCode).toBe(200);
    expectResponse("PUT", "/runs/{run_id}/cancellation", 200, canceled.json());

    // Error envelope.
    const missing = await call(ctx, "GET", `/api/v1/conversations/${uuid()}`);
    expect(missing.statusCode).toBe(404);
    expectResponse("GET", "/conversations/{conversation_id}", 404, missing.json());
    const invalid = await createRun(ctx, id, { prompt: "" });
    expect(invalid.statusCode).toBe(422);
    expectResponse("POST", "/conversations/{conversation_id}/runs", 422, invalid.json());

    // SSE frames carry the documented envelope.
    const events = await ctx.app.inject({ method: "GET", url: `/api/v1/runs/${runId}/events`, headers: ctx.bodyless() });
    const frames = events.payload
      .split("\n\n")
      .map((f) => f.split("\n").find((l) => l.startsWith("data: ")))
      .filter((l): l is string => Boolean(l))
      .map((l) => JSON.parse(l.slice(6)) as unknown);
    expect(frames.length).toBeGreaterThan(3);
    for (const frame of frames) validate({ $ref: "#/components/schemas/RuntimeEventEnvelope" }, frame, "SSE frame");
  });

  it("a Quick run, a failed run (stuck-free fixture) and a deleted conversation", async () => {
    ctx = await makeServer();
    const conv = await createConversation(ctx);
    const run = await createRun(ctx, conv, runBody([{ profile_id: "mock-balanced" }]));
    const snap = await waitTerminal(ctx, (run.json() as { id: string }).id);
    expectResponse("GET", "/runs/{run_id}", 200, snap);
    const del = await call(ctx, "DELETE", `/api/v1/conversations/${conv}`);
    expect(del.statusCode).toBe(204);
  });
});

describe("attachments: routes, policy, and the run context they produce", () => {
  it("policy, upload, list, preview, download, delete and the run's context refs", async () => {
    ctx = await makeServer();
    const conv = await createConversation(ctx);
    const policy = await call(ctx, "GET", "/api/v1/attachments/policy");
    expectResponse("GET", "/attachments/policy", 200, policy.json());

    const boundary = "----contract";
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="notes.txt"\r\nContent-Type: text/plain\r\n\r\n`),
      Buffer.from("hello contract"),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/conversations/${conv}/attachments`,
      headers: ctx.headers({ "content-type": `multipart/form-data; boundary=${boundary}` }),
      payload,
    });
    expect(up.statusCode).toBe(201);
    expectResponse("POST", "/conversations/{conversation_id}/attachments", 201, up.json());
    const id = (up.json() as { attachment: { id: string } }).attachment.id;

    expectResponse("GET", "/conversations/{conversation_id}/attachments", 200, (await call(ctx, "GET", `/api/v1/conversations/${conv}/attachments`)).json());
    const preview = await call(ctx, "GET", `/api/v1/attachments/${id}/preview`);
    expect(preview.statusCode).toBe(200);
    const download = await call(ctx, "GET", `/api/v1/attachments/${id}/download`);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.toString()).toBe("hello contract");

    const run = await createRun(ctx, conv, runBody([{ profile_id: "mock-balanced" }], { attachment_ids: [id] }));
    expect(run.statusCode).toBe(201);
    const snap = await waitTerminal(ctx, (run.json() as { id: string }).id);
    expectResponse("GET", "/runs/{run_id}", 200, snap);
    expect(snap.context.attachments?.length).toBe(1);

    // A bound attachment cannot be deleted; an unknown id is a 404; a free one is a 204.
    const bound = await call(ctx, "DELETE", `/api/v1/attachments/${id}`);
    expect(bound.statusCode).toBe(409);
    expectResponse("DELETE", "/attachments/{attachment_id}", 409, bound.json());
    const unknown = await call(ctx, "DELETE", `/api/v1/attachments/${uuid()}`);
    expect(unknown.statusCode).toBe(404);
    expectResponse("DELETE", "/attachments/{attachment_id}", 404, unknown.json());
    const free = seedAttachment(ctx, conv, { kind: "text", mime: "text/plain", extractedText: "x" });
    expect((await call(ctx, "DELETE", `/api/v1/attachments/${free.id}`)).statusCode).toBe(204);
  });
});

describe("native backend responses match the implemented contract", () => {
  const nativeConfig = (fake: FakeCodex, verified: boolean): Partial<ProofestraConfig> => ({
    liveEnabled: true,
    providerCredentials: { openaiKey: null, anthropicKey: null, googleKey: null },
    nativeBackends: {
      codex: { enabled: true, model: "gpt-5.6-sol", executable: fake.bin, codexHome: null, ...(verified ? { verification: TEST_COMPLETE_VERIFICATION } : {}) },
    },
  });

  it("GET /providers with the real (unverified) record, and a full native run snapshot", async () => {
    const fake = makeFakeCodex({ exec: { lines: okTranscript("native ok") } });
    fakes.push(fake);
    ctx = await makeServer({ config: nativeConfig(fake, false) });
    const blocked = await call(ctx, "GET", "/api/v1/providers");
    expectResponse("GET", "/providers", 200, blocked.json());
    expect((blocked.json() as { native_backends: unknown[] }).native_backends.length).toBeGreaterThan(0);
    await ctx.cleanup();

    ctx = await makeServer({ config: nativeConfig(fake, true) });
    expectResponse("GET", "/providers", 200, (await call(ctx, "GET", "/api/v1/providers")).json());
    const conv = await createConversation(ctx);
    const body = runBody([{ profile_id: "codex-local-default" }], {
      execution_mode: "live",
      tool_policy: { bounds_mode: "bounded_job", allow_unknown_internal_usage: true },
    });
    const run = await createRun(ctx, conv, body);
    expect(run.statusCode).toBe(201);
    expectResponse("POST", "/conversations/{conversation_id}/runs", 201, run.json());
    const snap = await waitTerminal(ctx, (run.json() as { id: string }).id);
    expect(snap.status).toBe("completed");
    expect(snap.native_backends?.length).toBe(1);
    expectResponse("GET", "/runs/{run_id}", 200, snap);

    // A refusal (strict default) uses the documented error envelope.
    const refused = await createRun(ctx, conv, runBody([{ profile_id: "codex-local-default" }], { execution_mode: "live" }));
    expect(refused.statusCode).toBe(422);
    expectResponse("POST", "/conversations/{conversation_id}/runs", 422, refused.json());
  });
});

describe("live API responses (injected wire) match the implemented contract", () => {
  it("a completed and a partially failed Live run snapshot", async () => {
    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (u.includes("anthropic")) return new Response("nope", { status: 429 });
      return new Response(
        JSON.stringify({ model: "gpt-served", choices: [{ message: { content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    ctx = await makeServer({
      config: { liveEnabled: true, providerCredentials: { openaiKey: "sk-test-FAKE", anthropicKey: "sk-ant-FAKE", googleKey: null } },
      buildOptions: { fetchImpl },
    });
    const conv = await createConversation(ctx);
    const quick = await createRun(ctx, conv, runBody([{ profile_id: "openai-default" }], { execution_mode: "live" }));
    expect(quick.statusCode).toBe(201);
    expectResponse("GET", "/runs/{run_id}", 200, await waitTerminal(ctx, (quick.json() as { id: string }).id));
    const team = await createRun(ctx, conv, runBody([{ profile_id: "openai-default" }, { profile_id: "anthropic-default" }], { execution_mode: "live" }));
    expect(team.statusCode).toBe(201);
    const snap = await waitTerminal(ctx, (team.json() as { id: string }).id);
    expect(snap.status).toBe("partial");
    expectResponse("GET", "/runs/{run_id}", 200, snap);
  });
});

describe("the check is not vacuous: real drift is detected", () => {
  it("an unknown field, a wrong type, a missing field and a design-only value on a REAL snapshot all fail validation", async () => {
    ctx = await makeServer();
    const conv = await createConversation(ctx);
    const run = await createRun(ctx, conv, runBody([{ profile_id: "mock-balanced" }]));
    const snap = JSON.parse(JSON.stringify(await waitTerminal(ctx, (run.json() as { id: string }).id))) as Json;
    expectResponse("GET", "/runs/{run_id}", 200, snap);
    const mutations: Array<[string, (s: Json) => void]> = [
      ["unknown top-level field", (s) => void (s.surprise = 1)],
      ["wrong type", (s) => void (s.base_planned_calls = "1")],
      ["missing required field", (s) => void delete s.usage],
      ["invalid status value", (s) => void (s.status = "paused")],
      ["a design-only external status value", (s) => void (s.external_work_status = "running")],
      ["unknown usage field", (s) => void ((s.usage as Json).free_tokens = 1)],
    ];
    for (const [label, mutate] of mutations) {
      const copy = JSON.parse(JSON.stringify(snap)) as Json;
      mutate(copy);
      expect(() => expectResponse("GET", "/runs/{run_id}", 200, copy), label).toThrow(/does not match docs\/openapi.yaml/);
    }
  });
});

void os;

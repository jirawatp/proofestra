// Coordinator-level proof that uploaded content actually reaches each live
// adapter's request body at EVERY stage (draft, review, synthesis) and again
// on a follow-up turn, per provider. No live call is possible:
//
//   - the app is built from an explicit ProofestraConfig literal (never
//     `loadConfig(process.env)`), with literal FAKE keys;
//   - the adapters get an injected `fetchImpl` that rejects any URL other
//     than the three known provider endpoints and answers with a
//     deterministic vendor-shaped success body;
//   - the global `fetch` is stubbed to throw, so a code path that ignored the
//     injected transport would fail loudly instead of reaching the network.
//
// Real parsers (Poppler / ffprobe / worker threads) produce the validated
// metadata the routing uses; when a tool is absent the dependent provider
// case is skipped with a visible title.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp, type AppBundle } from "../../src/server/app.js";
import { resetProfileCache } from "../../src/core/registry.js";
import { evaluateCapacity } from "../../src/core/context.js";
import { describeBinaryToolCapabilities } from "../../src/core/parsers/binaryTools.js";
import {
  frameExtractedAttachment,
  UNTRUSTED_ATTACHMENT_CONTENT_NOTICE,
} from "../../src/providers/attachmentFraming.js";
import type { ProofestraConfig } from "../../src/shared/config.js";
import type { RunSnapshot } from "../../src/shared/types.js";

// Spy on capacity evaluation (real implementation) so admission and every
// dispatch stage can be compared for attachment-token drift.
vi.mock("../../src/core/context.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/core/context.js")>();
  return { ...original, evaluateCapacity: vi.fn(original.evaluateCapacity) };
});

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures/content");
const caps = describeBinaryToolCapabilities();

const FAKE = {
  openai: "FAKE_OPENAI_KEY_FOR_CONTRACT_TEST",
  anthropic: "FAKE_ANTHROPIC_KEY_FOR_CONTRACT_TEST",
  google: "FAKE_GOOGLE_KEY_FOR_CONTRACT_TEST",
};

type Provider = "openai" | "anthropic" | "gemini";

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

function fixture(rel: string): Buffer {
  return fs.readFileSync(path.join(FIXTURES, rel));
}

// 1×1 PNG, 68 bytes.
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f00050" +
    "0010191a1b1a60000000049454e44ae426082",
  "hex",
);

interface Harness {
  bundle: AppBundle;
  config: ProofestraConfig;
  cookie: string;
  csrf: string;
  captured: Captured[];
  networkEscapes: { count: number };
  cleanup: () => Promise<void>;
}

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

async function startHarness(): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofestra-delivery-"));
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const config: ProofestraConfig = {
    host: "127.0.0.1",
    port: 3000,
    origin: "http://127.0.0.1:3000",
    extraOrigins: [],
    apiPrefix: "/api/v1",
    dataDir,
    liveEnabled: true,
    providerCredentials: {
      openaiKey: FAKE.openai,
      anthropicKey: FAKE.anthropic,
      googleKey: FAKE.google,
    },
    providerDefaultModels: {
      openai: "fake-openai-model",
      anthropic: "fake-anthropic-model",
      gemini: "fake-gemini-model",
    },
  };
  const captured: Captured[] = [];
  const networkEscapes = { count: 0 };
  // A path that ignores the injected transport must fail loudly.
  vi.stubGlobal("fetch", () => {
    networkEscapes.count += 1;
    throw new Error("real fetch must never be used in this test");
  });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    let kind: Provider;
    if (url === OPENAI_URL) kind = "openai";
    else if (url === ANTHROPIC_URL) kind = "anthropic";
    else if (
      url.startsWith("https://generativelanguage.googleapis.com/") &&
      url.endsWith(":generateContent")
    ) {
      kind = "gemini";
    } else {
      throw new Error(`unexpected URL in contract test: ${new URL(url).host}`);
    }
    captured.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    const text = `deterministic ${kind} reply ${captured.length}`;
    const json =
      kind === "openai"
        ? {
            model: "fake-openai-model",
            choices: [{ message: { content: text }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 3 },
          }
        : kind === "anthropic"
          ? {
              model: "fake-anthropic-model",
              content: [{ type: "text", text }],
              stop_reason: "end_turn",
              usage: { input_tokens: 10, output_tokens: 3 },
            }
          : {
              candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, thoughtsTokenCount: 0 },
            };
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  resetProfileCache();
  const bundle = await buildApp({
    config,
    dbPath: path.join(dataDir, "proofestra.sqlite"),
    logger: false,
    fetchImpl,
  });
  await bundle.app.ready();
  const session = await bundle.app.inject({
    method: "GET",
    url: "/api/v1/session",
    headers: { host: "127.0.0.1:3000" },
  });
  const setCookie = session.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie!).split(";")[0]!;
  const csrf = (session.json() as { csrf_token: string }).csrf_token;
  return {
    bundle,
    config,
    cookie,
    csrf,
    captured,
    networkEscapes,
    cleanup: async () => {
      await bundle.close();
      vi.unstubAllGlobals();
      resetProfileCache();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function headers(h: Harness, extra: Record<string, string> = {}): Record<string, string> {
  return {
    host: "127.0.0.1:3000",
    cookie: h.cookie,
    origin: "http://127.0.0.1:3000",
    "x-csrf-token": h.csrf,
    "content-type": "application/json",
    ...extra,
  };
}

async function upload(h: Harness, conversationId: string, rel: string, mime: string, name?: string) {
  const boundary = "----proofestra-delivery";
  const bytes = rel === "png" ? PNG : fixture(rel);
  const filename = name ?? path.basename(rel);
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const resp = await h.bundle.app.inject({
    method: "POST",
    url: `/api/v1/conversations/${conversationId}/attachments`,
    headers: headers(h, { "content-type": `multipart/form-data; boundary=${boundary}` }),
    payload,
  });
  expect(resp.statusCode).toBe(201);
  return (resp.json() as { attachment: { id: string; state: string } }).attachment.id;
}

const TERMINAL = new Set(["completed", "partial", "failed", "canceled", "interrupted"]);

async function runToTerminal(h: Harness, runId: string): Promise<RunSnapshot> {
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    const resp = await h.bundle.app.inject({ method: "GET", url: `/api/v1/runs/${runId}`, headers: headers(h) });
    const snap = resp.json() as RunSnapshot;
    if (TERMINAL.has(snap.status)) return snap;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("run did not finish");
}

async function team(
  h: Harness,
  conversationId: string,
  provider: Provider,
  prompt: string,
  attachmentIds: string[],
  agents: Array<{ agent_id: string; name: string }>,
): Promise<RunSnapshot> {
  const resp = await h.bundle.app.inject({
    method: "POST",
    url: `/api/v1/conversations/${conversationId}/runs`,
    headers: headers(h, { "idempotency-key": randomUUID() }),
    payload: {
      prompt,
      mode: "team",
      execution_mode: "live",
      agents: agents.map((a) => ({ ...a, profile_id: `${provider}-default` })),
      synthesizer_agent_id: agents[0]!.agent_id,
      ...(attachmentIds.length > 0 ? { attachment_ids: attachmentIds } : {}),
    },
  });
  expect(resp.statusCode).toBe(201);
  return runToTerminal(h, (resp.json() as RunSnapshot).id);
}

// --- provider body normalization -----------------------------------------

type Block =
  | { kind: "text"; text: string }
  | { kind: "image" | "pdf" | "audio" | "video"; mime: string; data: Buffer };
interface Turn {
  role: string;
  blocks: Block[];
}
interface Normalized {
  system: string;
  turns: Turn[];
}

function dataUrl(url: string): { mime: string; data: Buffer } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (!m) throw new Error("not a base64 data URL");
  return { mime: m[1]!, data: Buffer.from(m[2]!, "base64") };
}

function kindOfMime(mime: string): "image" | "pdf" | "audio" | "video" {
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  throw new Error(`unexpected native mime ${mime}`);
}

function normalize(provider: Provider, body: Record<string, unknown>): Normalized {
  if (provider === "openai") {
    const messages = body["messages"] as Array<{ role: string; content: unknown }>;
    const system = String(messages.find((m) => m.role === "system")?.content ?? "");
    const turns = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role,
        blocks:
          typeof m.content === "string"
            ? [{ kind: "text" as const, text: m.content }]
            : (m.content as Array<Record<string, unknown>>).map((p): Block => {
                if (p["type"] === "text") return { kind: "text", text: String(p["text"]) };
                if (p["type"] === "image_url") {
                  const d = dataUrl((p["image_url"] as { url: string }).url);
                  return { kind: kindOfMime(d.mime), mime: d.mime, data: d.data };
                }
                const d = dataUrl((p["file"] as { file_data: string }).file_data);
                return { kind: kindOfMime(d.mime), mime: d.mime, data: d.data };
              }),
      }));
    return { system, turns };
  }
  if (provider === "anthropic") {
    const messages = body["messages"] as Array<{ role: string; content: unknown }>;
    const turns = messages.map((m) => ({
      role: m.role,
      blocks:
        typeof m.content === "string"
          ? [{ kind: "text" as const, text: m.content }]
          : (m.content as Array<Record<string, unknown>>).map((p): Block => {
              if (p["type"] === "text") return { kind: "text", text: String(p["text"]) };
              const src = p["source"] as { media_type: string; data: string };
              return { kind: kindOfMime(src.media_type), mime: src.media_type, data: Buffer.from(src.data, "base64") };
            }),
    }));
    return { system: String(body["system"] ?? ""), turns };
  }
  const contents = body["contents"] as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  const sys = body["systemInstruction"] as { parts: Array<{ text: string }> };
  return {
    system: sys.parts.map((p) => p.text).join("\n"),
    turns: contents.map((c) => ({
      role: c.role,
      blocks: c.parts.map((p): Block => {
        if ("text" in p) return { kind: "text", text: String(p["text"]) };
        const inline = p["inlineData"] as { mimeType: string; data: string };
        return { kind: kindOfMime(inline.mimeType), mime: inline.mimeType, data: Buffer.from(inline.data, "base64") };
      }),
    })),
  };
}

function stageOf(system: string): "draft" | "review" | "synthesis" {
  if (system.includes("You are reviewing peer drafts")) return "review";
  if (system.includes("You are synthesizing a final answer")) return "synthesis";
  return "draft";
}

// --- the contract ---------------------------------------------------------

interface Expectation {
  provider: Provider;
  png: Buffer;
  pdf: Buffer;
  mp3: Buffer;
  mp4: Buffer;
  framedDocx: string;
  docxMarker: string;
  storageKeys: string[];
  dataDir: string;
}

function assertPayload(
  call: Captured,
  e: Expectation,
  expectedStage: "draft" | "review" | "synthesis",
  label: string,
  firstPrompt: string,
): void {
  const n = normalize(e.provider, call.body);
  expect(stageOf(n.system), `${label}: stage`).toBe(expectedStage);
  const flat = n.turns.flatMap((t) => t.blocks);
  const natives = flat.filter((b): b is Extract<Block, { data: Buffer }> => b.kind !== "text");
  const texts = flat.filter((b): b is Extract<Block, { kind: "text" }> => b.kind === "text").map((b) => b.text);

  // Native bytes: exactly one of each supported kind, byte-exact, right MIME.
  const byKind = (k: string) => natives.filter((b) => b.kind === k);
  expect(byKind("image"), `${label}: image`).toHaveLength(1);
  expect(byKind("image")[0]!.mime).toBe("image/png");
  expect(byKind("image")[0]!.data.equals(e.png)).toBe(true);
  expect(byKind("pdf"), `${label}: pdf`).toHaveLength(1);
  expect(byKind("pdf")[0]!.mime).toBe("application/pdf");
  expect(byKind("pdf")[0]!.data.equals(e.pdf)).toBe(true);
  if (e.provider === "gemini") {
    expect(byKind("audio"), `${label}: audio`).toHaveLength(1);
    expect(byKind("audio")[0]!.mime).toBe("audio/mpeg");
    expect(byKind("audio")[0]!.data.equals(e.mp3)).toBe(true);
    expect(byKind("video"), `${label}: video`).toHaveLength(1);
    expect(byKind("video")[0]!.mime).toBe("video/mp4");
    expect(byKind("video")[0]!.data.equals(e.mp4)).toBe(true);
  } else {
    // OpenAI/Anthropic carry no audio/video bytes and say exactly why.
    expect(byKind("audio")).toHaveLength(0);
    expect(byKind("video")).toHaveLength(0);
    const reason = `native audio/video is not supported for ${e.provider} in this app`;
    expect(texts.filter((t) => t.includes(reason))).toHaveLength(2);
  }

  // Natives and the extracted text belong to the HISTORICAL turn that carried
  // the files, never to a later turn (no re-attachment to the follow-up).
  const fileTurns = n.turns.filter((t) => t.blocks.some((b) => b.kind !== "text"));
  expect(fileTurns, `${label}: exactly one turn carries native parts`).toHaveLength(1);
  const fileTurnTexts = fileTurns[0]!.blocks.filter((b) => b.kind === "text").map((b) => (b as { text: string }).text);
  expect(fileTurnTexts).toContain(firstPrompt);
  expect(fileTurnTexts).toContain(e.framedDocx);
  // The extraction really contains the marker (not a vacuous empty match).
  expect(texts.some((t) => t.includes(e.docxMarker)), `${label}: docx marker present`).toBe(true);

  // Every native part is introduced by the untrusted-content notice.
  for (const turn of n.turns) {
    turn.blocks.forEach((b, i) => {
      if (b.kind === "text") return;
      const prev = turn.blocks[i - 1];
      expect(prev?.kind, `${label}: block before native`).toBe("text");
      expect((prev as { text: string }).text.startsWith(UNTRUSTED_ATTACHMENT_CONTENT_NOTICE)).toBe(true);
    });
  }

  // Extracted text: exact bounded text, exactly once, framed.
  expect(texts.filter((t) => t === e.framedDocx), `${label}: framed docx`).toHaveLength(1);
  for (const t of texts) {
    if (t.includes(e.docxMarker)) expect(t.startsWith(UNTRUSTED_ATTACHMENT_CONTENT_NOTICE)).toBe(true);
  }

  // Reference material: exactly once on review/synthesis, never on drafts.
  const refs = texts.filter((t) => t.startsWith("Reference material for this stage:"));
  expect(refs, `${label}: reference material`).toHaveLength(expectedStage === "draft" ? 0 : 1);

  // No path, storage key, fake key or server secret in the wire body.
  const json = JSON.stringify(call.body);
  expect(json.includes(e.dataDir)).toBe(false);
  for (const k of e.storageKeys) expect(json.includes(k)).toBe(false);
  for (const k of Object.values(FAKE)) expect(json.includes(k)).toBe(false);
}

/** Agent identity from the system instruction ("You are \"<name>\" ..."). */
function identityOf(provider: Provider, call: Captured): string {
  const m = /You are "([^"]+)"/.exec(normalize(provider, call.body).system);
  return m ? m[1]! : "";
}

function partition(calls: Captured[], provider: Provider): Record<"draft" | "review" | "synthesis", Captured[]> {
  const out = { draft: [] as Captured[], review: [] as Captured[], synthesis: [] as Captured[] };
  for (const c of calls) out[stageOf(normalize(provider, c.body).system)].push(c);
  return out;
}

describe("provider payload contracts through the coordinator (injected transport, fake keys)", () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
      harness = null;
    }
  });

  const cases: Array<{ provider: Provider; needs: string; ok: boolean }> = [
    { provider: "openai", needs: "poppler", ok: caps.pdf_text_extraction },
    { provider: "anthropic", needs: "poppler", ok: caps.pdf_text_extraction },
    { provider: "gemini", needs: "poppler + ffprobe", ok: caps.pdf_text_extraction && caps.media_metadata_probe },
  ];

  for (const c of cases) {
    it.skipIf(!c.ok)(
      `${c.provider}: every draft, review, synthesis and follow-up payload carries the files (requires ${c.needs})`,
      async () => {
        const h = (harness = await startHarness());
        const created = await h.bundle.app.inject({
          method: "POST",
          url: "/api/v1/conversations",
          headers: headers(h),
          payload: { title: `delivery ${c.provider}` },
        });
        const conversationId = (created.json() as { id: string }).id;
        const ids = {
          png: await upload(h, conversationId, "png", "image/png", "pixel.png"),
          pdf: await upload(h, conversationId, "pdf/text-one-page.pdf", "application/pdf"),
          docx: await upload(
            h,
            conversationId,
            "office/proofestra-content.docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          ),
          mp3: await upload(h, conversationId, "media/valid-tone.mp3", "audio/mpeg"),
          mp4: await upload(h, conversationId, "media/valid-clip.mp4", "video/mp4"),
        };
        const { attachments } = h.bundle;
        const docxRow = attachments.get(ids.docx)!;
        expect(docxRow.extracted_text).toContain("PROOFESTRA_DOCX_BODY_ORCHID_42");
        const dto = attachments.toDto(docxRow);
        const framedDocx = frameExtractedAttachment({
          sanitized_display_name: docxRow.sanitized_display_name,
          sniffed_mime: docxRow.sniffed_mime,
          byte_size: docxRow.byte_size,
          text: docxRow.extracted_text ?? "",
          truncated: dto.extraction_coverage.truncated,
        });
        const e: Expectation = {
          provider: c.provider,
          png: PNG,
          pdf: fixture("pdf/text-one-page.pdf"),
          mp3: fixture("media/valid-tone.mp3"),
          mp4: fixture("media/valid-clip.mp4"),
          framedDocx,
          docxMarker: "PROOFESTRA_DOCX_BODY_ORCHID_42",
          storageKeys: Object.values(ids).map((id) => attachments.get(id)!.storage_key),
          dataDir: h.config.dataDir,
        };
        const agents = [
          { agent_id: randomUUID(), name: `${c.provider} Alpha` },
          { agent_id: randomUUID(), name: `${c.provider} Beta` },
        ];

        const capacityCalls = vi.mocked(evaluateCapacity);
        capacityCalls.mockClear();
        // Turn 1: attachments on the current message.
        const run1 = await team(h, conversationId, c.provider, "Summarize the attached files.", Object.values(ids), agents);
        expect(run1.status).toBe("completed");
        const turn1Capacity = capacityCalls.mock.calls.map((c) => c[1]);
        const turn1 = h.captured.slice();
        expect(turn1).toHaveLength(5); // 2 drafts + 2 reviews + 1 synthesis
        const p1 = partition(turn1, c.provider);
        expect([p1.draft.length, p1.review.length, p1.synthesis.length]).toEqual([2, 2, 1]);
        // Each root drafted once and reviewed once; the synthesizer is the first root.
        const names = agents.map((a) => a.name).sort();
        expect(p1.draft.map((x) => identityOf(c.provider, x)).sort()).toEqual(names);
        expect(p1.review.map((x) => identityOf(c.provider, x)).sort()).toEqual(names);
        expect(p1.synthesis.map((x) => identityOf(c.provider, x))).toEqual([agents[0]!.name]);
        for (const stage of ["draft", "review", "synthesis"] as const) {
          p1[stage].forEach((call, i) => assertPayload(call, e, stage, `turn1 ${stage}#${i}`, "Summarize the attached files."));
        }

        // Turn 2: follow-up with NO new attachments. History must re-send the
        // same bytes and extracted text under the frozen routes.
        capacityCalls.mockClear();
        const run2 = await team(h, conversationId, c.provider, "What was in the PDF?", [], agents);
        const turn2Capacity = capacityCalls.mock.calls.map((c) => c[1]);
        expect(run2.status).toBe("completed");
        const turn2 = h.captured.slice(turn1.length);
        expect(turn2).toHaveLength(5);
        const p2 = partition(turn2, c.provider);
        expect([p2.draft.length, p2.review.length, p2.synthesis.length]).toEqual([2, 2, 1]);
        for (const stage of ["draft", "review", "synthesis"] as const) {
          p2[stage].forEach((call, i) => {
            assertPayload(call, e, stage, `follow-up ${stage}#${i}`, "Summarize the attached files.");
            // The follow-up question itself is present, after the history.
            const n = normalize(c.provider, call.body);
            expect(
              n.turns.some((t) => t.blocks.some((b) => b.kind === "text" && b.text === "What was in the PDF?")),
            ).toBe(true);
          });
        }

        // Admission and every dispatch stage charge the SAME attachment tokens,
        // for the new files (turn 1) and for the historical ones (follow-up).
        for (const [name, inputs] of [["turn1", turn1Capacity], ["follow-up", turn2Capacity]] as const) {
          const admission = inputs.filter((i) => i.referenceMaterialTokens !== undefined);
          const dispatch = inputs.filter((i) => i.referenceMaterialTokens === undefined);
          expect(admission.length, `${name}: admission checks (one per agent)`).toBe(agents.length);
          expect(dispatch.length, `${name}: dispatch checks (5 stages)`).toBe(5);
          const reserve = admission[0]!.attachmentTokens!;
          expect(reserve).toBeGreaterThan(0);
          for (const i of [...admission, ...dispatch]) expect(i.attachmentTokens, `${name} drift`).toBe(reserve);
        }
        expect(turn1Capacity.find((i) => i.referenceMaterialTokens !== undefined)!.attachmentTokens).toBe(
          turn2Capacity.find((i) => i.referenceMaterialTokens !== undefined)!.attachmentTokens,
        );

        // Frozen routing: the follow-up covers the historical files too, with
        // the same decisions as turn 1 and an exact per-agent reason.
        const cov1 = run1.context.attachment_coverage!;
        const cov2 = run2.context.attachment_coverage!;
        expect(cov2).toHaveLength(2);
        for (const entry of cov2) {
          expect(entry.routes.map((r) => r.attachment_id).sort()).toEqual(Object.values(ids).sort());
          const same = cov1.find((x) => x.agent_id === entry.agent_id)!;
          expect(entry.routes.map((r) => [r.attachment_id, r.route])).toEqual(
            same.routes.map((r) => [r.attachment_id, r.route]),
          );
          const routeOf = (id: string) => entry.routes.find((r) => r.attachment_id === id)!;
          expect(routeOf(ids.png).route).toBe("native_image");
          expect(routeOf(ids.pdf).route).toBe("native_pdf");
          expect(routeOf(ids.docx).route).toBe("extracted_text");
          if (c.provider === "gemini") {
            expect(routeOf(ids.mp3).route).toBe("native_audio");
            expect(routeOf(ids.mp4).route).toBe("native_video");
          } else {
            for (const id of [ids.mp3, ids.mp4]) {
              expect(routeOf(id).route).toBe("attachment_only");
              expect(routeOf(id).reason).toBe(
                `native audio/video is not supported for ${c.provider} in this app`,
              );
            }
          }
        }

        // The persisted run JSON and export never contain bytes or paths.
        const exported = await h.bundle.app.inject({
          method: "GET",
          url: `/api/v1/conversations/${conversationId}/export`,
          headers: headers(h),
        });
        const exportText = exported.payload;
        expect(exportText.includes(e.png.toString("base64"))).toBe(false);
        expect(exportText.includes(h.config.dataDir)).toBe(false);
        for (const k of Object.values(FAKE)) expect(exportText.includes(k)).toBe(false);

        // Nothing reached the real network.
        expect(h.networkEscapes.count).toBe(0);
      },
    );
  }

  it.skipIf(!caps.pdf_text_extraction)(
    "a corrupted persisted PDF page count never becomes a native route on a later turn (requires poppler)",
    async () => {
      const h = (harness = await startHarness());
      const created = await h.bundle.app.inject({
        method: "POST",
        url: "/api/v1/conversations",
        headers: headers(h),
        payload: { title: "corrupt metadata" },
      });
      const conversationId = (created.json() as { id: string }).id;
      const pdfId = await upload(h, conversationId, "pdf/text-one-page.pdf", "application/pdf");
      const agents = [
        { agent_id: randomUUID(), name: "Solo A" },
        { agent_id: randomUUID(), name: "Solo B" },
      ];
      const run1 = await team(h, conversationId, "openai", "first", [pdfId], agents);
      expect(run1.context.attachment_coverage![0]!.routes[0]!.route).toBe("native_pdf");
      h.bundle.db.prepare("UPDATE attachments SET sniffed_pdf_pages = -3 WHERE id = ?").run(pdfId);
      const before = h.captured.length;
      const run2 = await team(h, conversationId, "openai", "second", [], agents);
      expect(run2.status).toBe("completed");
      const route = run2.context.attachment_coverage![0]!.routes[0]!;
      expect(route.route).toBe("extracted_text");
      expect(route.reason).toMatch(/page count not validated/);
      const pdfRow = h.bundle.attachments.get(pdfId)!;
      const framedPdf = frameExtractedAttachment({
        sanitized_display_name: pdfRow.sanitized_display_name,
        sniffed_mime: pdfRow.sniffed_mime,
        byte_size: pdfRow.byte_size,
        text: pdfRow.extracted_text ?? "",
        truncated: h.bundle.attachments.toDto(pdfRow).extraction_coverage.truncated,
      });
      expect(framedPdf).toContain("PDF_QUARTZ_ALPHA_2718");
      const followUpCalls = h.captured.slice(before);
      expect(followUpCalls).toHaveLength(5);
      for (const call of followUpCalls) {
        const n = normalize("openai", call.body);
        const blocks = n.turns.flatMap((t) => t.blocks);
        expect(blocks.some((b) => b.kind === "pdf")).toBe(false);
        const texts = blocks.filter((b) => b.kind === "text").map((b) => (b as { text: string }).text);
        expect(texts.filter((t) => t === framedPdf)).toHaveLength(1);
      }
    },
  );
});

// Test helpers for server/storage/coordinator behaviour tests. Unlike
// `_helpers.ts` (which reads the process environment through `loadConfig`),
// these helpers build an explicit config literal so no real credential or
// ambient PROOFESTRA_* variable can leak into a test. Every app lives in its
// own temp dir; nothing touches ./data or binds a real listener.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp, type AppBundle, type BuildAppOptions } from "../../src/server/app.js";
import type { ProofestraConfig } from "../../src/shared/config.js";
import { resetProfileCache } from "../../src/core/registry.js";

export function makeConfig(
  dataDir: string,
  overrides: Partial<ProofestraConfig> = {},
): ProofestraConfig {
  return {
    host: "127.0.0.1",
    port: 3000,
    origin: "http://127.0.0.1:3000",
    extraOrigins: [],
    apiPrefix: "/api/v1",
    dataDir,
    liveEnabled: false,
    providerCredentials: { openaiKey: null, anthropicKey: null, googleKey: null },
    providerDefaultModels: {
      openai: "gpt-test",
      anthropic: "claude-test",
      gemini: "gemini-test",
    },
    ...overrides,
  };
}

export interface ServerCtx {
  bundle: AppBundle;
  app: AppBundle["app"];
  config: ProofestraConfig;
  workDir: string;
  dataDir: string;
  dbPath: string;
  hostHeader: string;
  // Cookie string ("proofestra_session=...") and CSRF for an authenticated
  // session; only populated when `bootstrap` was true (default).
  cookie: string;
  csrf: string;
  headers(extra?: Record<string, string>): Record<string, string>;
  // Same as headers() but without content-type, for bodyless PUT/DELETE.
  bodyless(extra?: Record<string, string>): Record<string, string>;
  cleanup(): Promise<void>;
}

export interface ServerOptions {
  config?: Partial<ProofestraConfig>;
  profilesJson?: unknown;
  buildOptions?: Pick<BuildAppOptions, "extractAttachmentImpl" | "fetchImpl">;
  // Skip the GET /session bootstrap (security tests do this themselves).
  bootstrap?: boolean;
  // Hook that runs after the work dir exists but BEFORE buildApp, e.g. to seed
  // the SQLite DB / blobs for startup reconciliation tests.
  beforeBuild?: (ctx: { workDir: string; dataDir: string; dbPath: string }) => Promise<void> | void;
}

export async function makeServer(options: ServerOptions = {}): Promise<ServerCtx> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "proofestra-srv-"));
  const dataDir = path.join(workDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "proofestra.sqlite");

  const savedProfilesFile = process.env.PROOFESTRA_PROFILES_FILE;
  if (options.profilesJson !== undefined) {
    const profilesPath = path.join(workDir, "profiles.json");
    fs.writeFileSync(profilesPath, JSON.stringify(options.profilesJson, null, 2));
    process.env.PROOFESTRA_PROFILES_FILE = profilesPath;
  } else {
    delete process.env.PROOFESTRA_PROFILES_FILE;
  }
  resetProfileCache();

  await options.beforeBuild?.({ workDir, dataDir, dbPath });
  const config = makeConfig(dataDir, options.config);
  const bundle = await buildApp({
    config,
    dbPath,
    logger: false,
    ...(options.buildOptions ?? {}),
  });
  await bundle.app.ready();
  const hostHeader = `127.0.0.1:${config.port}`;

  let cookie = "";
  let csrf = "";
  if (options.bootstrap !== false) {
    const resp = await bundle.app.inject({
      method: "GET",
      url: "/api/v1/session",
      headers: { host: hostHeader },
    });
    if (resp.statusCode !== 200) throw new Error(`bootstrap failed ${resp.statusCode}`);
    const setCookie = resp.headers["set-cookie"];
    const raw = Array.isArray(setCookie) ? setCookie[0]! : (setCookie as string);
    cookie = raw.split(";")[0]!;
    csrf = (resp.json() as { csrf_token: string }).csrf_token;
  }

  return {
    bundle,
    app: bundle.app,
    config,
    workDir,
    dataDir,
    dbPath,
    hostHeader,
    cookie,
    csrf,
    headers(extra = {}) {
      return {
        host: hostHeader,
        cookie,
        origin: config.origin,
        "x-csrf-token": csrf,
        "content-type": "application/json",
        ...extra,
      };
    },
    bodyless(extra = {}) {
      const h: Record<string, string> = {
        host: hostHeader,
        cookie,
        origin: config.origin,
        "x-csrf-token": csrf,
        ...extra,
      };
      return h;
    },
    async cleanup() {
      // Never leave a slow fixture run executing after a failed test.
      for (const id of bundle.runs.activeRunIds()) {
        try {
          bundle.coordinator.cancelAndFinalize(id);
        } catch {
          // best effort
        }
      }
      try {
        await bundle.close();
      } catch {
        // a test may already have closed the bundle
      }
      if (savedProfilesFile === undefined) delete process.env.PROOFESTRA_PROFILES_FILE;
      else process.env.PROOFESTRA_PROFILES_FILE = savedProfilesFile;
      resetProfileCache();
      fs.rmSync(workDir, { recursive: true, force: true });
    },
  };
}

// Quick mock-profile run payload.
export function quickRunBody(
  prompt: string,
  extra: Record<string, unknown> = {},
  profileId = "mock-balanced",
): Record<string, unknown> {
  return {
    prompt,
    mode: "quick",
    agents: [{ agent_id: crypto.randomUUID(), name: "A", profile_id: profileId }],
    ...extra,
  };
}

export function teamRunBody(
  prompt: string,
  profileIds: string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const agents = profileIds.map((p, i) => ({
    agent_id: crypto.randomUUID(),
    name: `Agent ${i + 1}`,
    profile_id: p,
  }));
  return {
    prompt,
    mode: "team",
    agents,
    synthesizer_agent_id: (agents[0] as { agent_id: string }).agent_id,
    ...extra,
  };
}

export async function createConversation(ctx: ServerCtx, title?: string): Promise<string> {
  const resp = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/conversations",
    headers: ctx.headers(),
    payload: title ? { title } : {},
  });
  if (resp.statusCode !== 201) throw new Error(`create conversation ${resp.statusCode}`);
  return (resp.json() as { id: string }).id;
}

export async function waitFor<T>(
  fn: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  timeoutMs = 10_000,
  stepMs = 15,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export async function waitTerminal(ctx: ServerCtx, runId: string, timeoutMs = 15_000) {
  return waitFor(() => {
    const snap = ctx.bundle.runs.get(runId);
    return snap && snap.finished_at ? snap : null;
  }, timeoutMs);
}

export interface SeedAttachmentOptions {
  kind: "image" | "pdf" | "audio" | "video" | "text" | "archive" | "document" | "binary";
  mime: string;
  name?: string;
  bytes?: Buffer;
  state?: "ready" | "failed" | "uploading" | "bound";
  width?: number | null;
  height?: number | null;
  pdfPages?: number | null;
  durationMs?: number | null;
  streamsJson?: string | null;
  normalizedMime?: string | null;
  extractedText?: string | null;
  extractionStatus?: "none" | "text_extracted";
  byteSizeOverride?: number;
  writeBlob?: boolean;
}

// Insert an attachment row (and optionally its blob) without any parser.
export function seedAttachment(
  c: ServerCtx,
  conversationId: string,
  o: SeedAttachmentOptions,
): { id: string; key: string; file: string } {
  const bytes = o.bytes ?? Buffer.from("seeded");
  const key = c.bundle.blobStore.mintStorageKey();
  const file = c.bundle.blobStore.pathFor(key);
  if (o.writeBlob !== false) fs.writeFileSync(file, bytes);
  const id = c.bundle.attachments.insertUploading({
    conversationId,
    storageKey: key,
    sanitizedDisplayName: o.name ?? "seed.bin",
    declaredMime: o.mime,
    createdAt: new Date().toISOString(),
  });
  const state = o.state ?? "ready";
  if (state === "uploading") return { id, key, file };
  c.bundle.attachments.markReady({
    id,
    sniffedMime: o.mime,
    kind: o.kind,
    byteSize: o.byteSizeOverride ?? bytes.length,
    contentSha256: "b".repeat(64),
    extractionStatus: o.extractionStatus ?? "none",
    extractionCoverage: {
      extracted_chars: o.extractedText?.length ?? 0,
      truncated: false,
      label: o.extractedText ? "text" : "attachment-only",
    },
    extractedText: o.extractedText ?? null,
    sniffedWidth: o.width ?? null,
    sniffedHeight: o.height ?? null,
    sniffedPdfPages: o.pdfPages ?? null,
    sniffedMediaDurationMs: o.durationMs ?? null,
    sniffedMediaStreamsJson: o.streamsJson ?? null,
    validatedMediaFormat: null,
    normalizedMediaMime: o.normalizedMime ?? null,
  });
  if (state === "failed") {
    c.bundle.db.prepare("UPDATE attachments SET state='failed' WHERE id=?").run(id);
  } else if (state === "bound") {
    const m = {
      id: crypto.randomUUID(),
      conversation_id: conversationId,
      run_id: crypto.randomUUID(),
      role: "user" as const,
      text: "bound",
      sequence: c.bundle.messages.nextSequence(conversationId),
      created_at: new Date().toISOString(),
    };
    c.bundle.messages.insert(m);
    c.bundle.attachments.bindToMessage(m.id, [id]);
  }
  return { id, key, file };
}

// buildApp startup behaviour: restart interruption of running runs and
// reconciliation of attachment rows against blobs on disk. State is seeded
// into a temp SQLite file / temp attachments directory BEFORE the app is
// built, then the effects of startup are asserted.

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../src/storage/db.js";
import { AttachmentRepo, ConversationRepo, MessageRepo } from "../../src/storage/repos.js";
import { buildApp } from "../../src/server/app.js";
import {
  createConversation,
  makeConfig,
  makeServer,
  quickRunBody,
  waitFor,
  waitTerminal,
  type ServerCtx,
} from "./_server_helpers.js";
import type { RunSnapshot } from "../../src/shared/types.js";

let ctx: ServerCtx | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await ctx?.cleanup();
  ctx = null;
});

function seedRow(
  repo: AttachmentRepo,
  msgs: MessageRepo,
  conversationId: string,
  dataDir: string,
  o: { state: "uploading" | "ready" | "bound"; blob: boolean; name: string },
): { id: string; file: string } {
  const key = crypto.randomUUID();
  const file = path.join(dataDir, "attachments", key);
  if (o.blob) fs.writeFileSync(file, "blob bytes");
  const id = repo.insertUploading({
    conversationId,
    storageKey: key,
    sanitizedDisplayName: o.name,
    declaredMime: "text/plain",
    createdAt: new Date().toISOString(),
  });
  if (o.state !== "uploading") {
    repo.markReady({
      id,
      sniffedMime: "text/plain",
      kind: "text",
      byteSize: 10,
      contentSha256: "c".repeat(64),
      extractionStatus: "none",
      extractionCoverage: { extracted_chars: 0, truncated: false, label: "attachment-only" },
      extractedText: null,
      sniffedWidth: null,
      sniffedHeight: null,
      sniffedPdfPages: null,
      sniffedMediaDurationMs: null,
      sniffedMediaStreamsJson: null,
      validatedMediaFormat: null,
      normalizedMediaMime: null,
    });
  }
  if (o.state === "bound") {
    const m = {
      id: crypto.randomUUID(),
      conversation_id: conversationId,
      run_id: crypto.randomUUID(),
      role: "user" as const,
      text: "sent",
      sequence: msgs.nextSequence(conversationId),
      created_at: new Date().toISOString(),
    };
    msgs.insert(m);
    repo.bindToMessage(m.id, [id]);
  }
  return { id, file };
}

describe("attachment reconciliation at startup", () => {
  it("fails interrupted uploads, fails ready rows with missing blobs, flags bound rows, keeps healthy rows and prunes orphan blobs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const seeded: Record<string, { id: string; file: string }> = {};
    let orphan = "";
    ctx = await makeServer({
      bootstrap: false,
      beforeBuild: ({ dataDir, dbPath }) => {
        fs.mkdirSync(path.join(dataDir, "attachments"), { recursive: true });
        const db = openDatabase(dbPath);
        const convs = new ConversationRepo(db);
        const repo = new AttachmentRepo(db);
        const msgs = new MessageRepo(db);
        const c = convs.create("seeded");
        seeded.uploading = seedRow(repo, msgs, c.id, dataDir, { state: "uploading", blob: true, name: "partial.txt" });
        seeded.readyMissing = seedRow(repo, msgs, c.id, dataDir, { state: "ready", blob: false, name: "gone.txt" });
        seeded.readyOk = seedRow(repo, msgs, c.id, dataDir, { state: "ready", blob: true, name: "ok.txt" });
        seeded.boundMissing = seedRow(repo, msgs, c.id, dataDir, { state: "bound", blob: false, name: "sent-gone.txt" });
        seeded.boundOk = seedRow(repo, msgs, c.id, dataDir, { state: "bound", blob: true, name: "sent-ok.txt" });
        orphan = path.join(dataDir, "attachments", crypto.randomUUID());
        fs.writeFileSync(orphan, "orphan");
        db.close();
      },
    });
    const repo = ctx.bundle.attachments;

    const uploading = repo.get(seeded.uploading!.id)!;
    expect(uploading.state).toBe("failed");
    expect(uploading.failure_code).toBe("upload_interrupted");
    expect(fs.existsSync(seeded.uploading!.file)).toBe(false);

    const readyMissing = repo.get(seeded.readyMissing!.id)!;
    expect(readyMissing.state).toBe("failed");
    expect(readyMissing.failure_code).toBe("blob_missing");

    expect(repo.get(seeded.readyOk!.id)!.state).toBe("ready");
    expect(fs.existsSync(seeded.readyOk!.file)).toBe(true);

    // Bound rows are never auto-mutated, only reported.
    expect(repo.get(seeded.boundMissing!.id)!.state).toBe("bound");
    expect(repo.get(seeded.boundOk!.id)!.state).toBe("bound");
    expect(fs.existsSync(seeded.boundOk!.file)).toBe(true);

    expect(fs.existsSync(orphan)).toBe(false);

    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages).toContain("[proofestra] marked 1 interrupted attachment uploads as failed");
    expect(messages).toContain("[proofestra] marked 1 ready attachments with missing blobs as failed");
    expect(messages.some((m) => m.includes("1 bound attachments have missing blobs"))).toBe(true);
    expect(messages).toContain("[proofestra] pruned 1 orphan attachment blobs");
    // Messages never include blob paths or storage keys.
    expect(messages.join("\n")).not.toContain(ctx.dataDir);
  });

  it("is silent and non-destructive on a clean data directory", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    ctx = await makeServer({ bootstrap: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it("a reconciliation failure is logged as a warning and does not stop the server from starting", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    ctx = await makeServer({
      beforeBuild: ({ dbPath }) => {
        const db = openDatabase(dbPath);
        // Break the attachments table (a corrupt/partially restored database).
        db.db.exec("DROP TABLE message_attachments; DROP TABLE attachments;");
        db.close();
      },
    });
    expect(warn.mock.calls.some((c) => String(c[0]).startsWith("[proofestra] attachment reconciliation failed:"))).toBe(true);
    // The rest of the API still works.
    const id = await createConversation(ctx);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("restart interruption", () => {
  it("marks a run that was running when the process died as interrupted, warns once, and allows new runs", async () => {
    // 1. Run a slow run in a first server, then snapshot its SQLite file mid-run.
    const slow = {
      mode: "append",
      profiles: [
        {
          profile_id: "mock-glacial",
          provider: "mock",
          label: "Mock glacial",
          model_id: "mock-glacial-v1",
          safe_input_tokens: 32_000,
          max_output_tokens: 2048,
          api_shape: "mock",
          execution_backend_id: "mock-provider-api",
          fixture: { extra_latency_ms: 30_000 },
        },
      ],
    };
    const first = await makeServer({ profilesJson: slow });
    let crashed: Buffer;
    let runId: string;
    try {
      const convId = await createConversation(first);
      const created = await first.app.inject({
        method: "POST",
        url: `/api/v1/conversations/${convId}/runs`,
        headers: first.headers({ "idempotency-key": crypto.randomUUID() }),
        payload: quickRunBody("will be interrupted", {}, "mock-glacial"),
      });
      runId = (created.json() as RunSnapshot).id;
      await waitFor(() => first.bundle.runs.get(runId)?.status === "running");
      first.bundle.db.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      crashed = fs.readFileSync(first.dbPath);
    } finally {
      await first.cleanup();
    }

    // 2. "Restart": a new server over that exact database state.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    ctx = await makeServer({
      beforeBuild: ({ dbPath }) => {
        fs.writeFileSync(dbPath, crashed);
      },
    });
    expect(warn).toHaveBeenCalledWith("[proofestra] marked 1 previously-running runs as interrupted");
    const after = ctx.bundle.runs.get(runId!)!;
    expect(after.status).toBe("interrupted");
    expect(after.finished_at).not.toBeNull();
    expect(after.limitations.join(" ")).toContain("Server restart interrupted this run");
    const events = ctx.bundle.events.listAfter(runId!, 0);
    expect(events.at(-1)!.type).toBe("run.terminal");
    expect(events.at(-1)!.data).toMatchObject({ status: "interrupted", reason: "interrupted_by_restart" });

    // A fresh run is admitted (no stuck active run) and completes.
    const convId = (ctx.bundle.conversations.list(10, null).items[0]!).id;
    const next = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/conversations/${convId}/runs`,
      headers: ctx.headers({ "idempotency-key": crypto.randomUUID() }),
      payload: quickRunBody("after restart"),
    });
    expect(next.statusCode).toBe(201);
    const done = await waitTerminal(ctx, (next.json() as RunSnapshot).id);
    expect(done.status).toBe("completed");
  });
});

describe("startup resilience", () => {
  it("still starts, and still fails the interrupted row, when the partial blob cannot be removed", async () => {
    const { BlobStore } = await import("../../src/core/attachments.js");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(BlobStore.prototype, "unlinkSafely").mockRejectedValue(new Error("EACCES /secret/blob"));
    let seeded = "";
    ctx = await makeServer({
      bootstrap: false,
      beforeBuild: ({ dataDir, dbPath }) => {
        fs.mkdirSync(path.join(dataDir, "attachments"), { recursive: true });
        const db = openDatabase(dbPath);
        const c = new ConversationRepo(db).create("x");
        seeded = seedRow(new AttachmentRepo(db), new MessageRepo(db), c.id, dataDir, { state: "uploading", blob: true, name: "p.txt" }).id;
        db.close();
      },
    });
    expect(ctx.bundle.attachments.get(seeded)!.state).toBe("failed");
  });
});

describe("buildApp wiring", () => {
  it("reads its configuration from the environment when none is passed", async () => {
    const dir = fs.mkdtempSync(path.join((await import("node:os")).tmpdir(), "proofestra-env-"));
    vi.stubEnv("PROOFESTRA_DATA_DIR", path.join(dir, "d"));
    vi.stubEnv("PROOFESTRA_PORT", "3456");
    for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "PROOFESTRA_PROFILES_FILE", "PROOFESTRA_LIVE_ENABLED", "PROOFESTRA_ORIGIN", "PROOFESTRA_HOST", "PROOFESTRA_EXTRA_ORIGINS"]) {
      vi.stubEnv(k, undefined as unknown as string);
    }
    try {
      const bundle = await buildApp();
      expect(bundle.config.port).toBe(3456);
      expect(bundle.config.dataDir).toBe(path.join(dir, "d"));
      expect(bundle.db.path).toBe(path.join(dir, "d", "proofestra.sqlite"));
      await bundle.close();
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults the database to <dataDir>/proofestra.sqlite and close() shuts the database", async () => {
    const dir = fs.mkdtempSync(path.join((await import("node:os")).tmpdir(), "proofestra-app-"));
    try {
      const bundle = await buildApp({ config: makeConfig(path.join(dir, "data")) });
      expect(bundle.db.path).toBe(path.join(dir, "data", "proofestra.sqlite"));
      expect(fs.existsSync(path.join(dir, "data", "proofestra.sqlite"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "data", "attachments"))).toBe(true);
      await bundle.close();
      expect(() => bundle.db.prepare("SELECT 1")).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

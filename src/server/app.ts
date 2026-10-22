// Fastify application factory. Single entry point used by both the dev server
// bootstrap (src/server/index.ts) and the integration tests.

import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import fs from "node:fs";
import type { ProofestraConfig } from "../shared/config.js";
import { loadConfig } from "../shared/config.js";
import { openDatabase } from "../storage/db.js";
import {
  AttachmentRepo,
  ConversationRepo,
  EventRepo,
  MessageRepo,
  RunRepo,
  SessionRepo,
} from "../storage/repos.js";
import { registerSecurity } from "./security.js";
import { registerRoutes } from "./routes/index.js";
import { Coordinator } from "../core/coordinator.js";
import { BlobStore } from "../core/attachments.js";
import { describeBinaryToolCapabilities } from "../core/parsers/binaryTools.js";
import type { extractAttachment } from "../core/attachmentExtraction.js";

export interface BuildAppOptions {
  config?: ProofestraConfig;
  dbPath?: string;
  logger?: boolean;
  fetchImpl?: typeof fetch;
  // Test seam: replace the bounded attachment extractor (e.g. a slow one).
  extractAttachmentImpl?: typeof extractAttachment;
}

export interface AppBundle {
  app: FastifyInstance;
  config: ProofestraConfig;
  coordinator: Coordinator;
  // Exposed for integration tests so they can drive the storage layer
  // directly (e.g. simulating a mid-run server crash for the restart
  // interruption test). Never used from the HTTP routes themselves.
  db: ReturnType<typeof openDatabase>;
  runs: RunRepo;
  events: EventRepo;
  conversations: ConversationRepo;
  messages: MessageRepo;
  attachments: AttachmentRepo;
  blobStore: BlobStore;
  close: () => Promise<void>;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<AppBundle> {
  const config = options.config ?? loadConfig();
  const dbPath = options.dbPath ?? path.resolve(config.dataDir, "proofestra.sqlite");
  const db = openDatabase(dbPath);
  // Discover Poppler/ffprobe once at startup (blocking probes with a fixed
  // environment), never lazily inside the first request.
  describeBinaryToolCapabilities();

  const sessions = new SessionRepo(db);
  const conversations = new ConversationRepo(db);
  const messages = new MessageRepo(db);
  const runs = new RunRepo(db);
  const events = new EventRepo(db);
  const attachments = new AttachmentRepo(db);
  const blobStore = new BlobStore({ dataDir: config.dataDir });

  const interrupted = Coordinator.markInterruptedOnStartup({ runs, events, conversations, db });
  if (interrupted > 0) {
    console.warn(`[proofestra] marked ${interrupted} previously-running runs as interrupted`);
  }

  // Reconcile attachment blobs with the DB on startup. A crash during
  // multipart upload can leave three kinds of inconsistency:
  //   1. An `uploading` row whose blob was partially written. Mark the
  //      row failed and delete the partial — the user will see a clear
  //      "upload interrupted" state instead of a forever-spinning row.
  //   2. A `ready` row whose blob file is missing (manual rm, disk
  //      failure, admin cleanup). Mark the row failed; bound rows with
  //      missing blobs are flagged in logs but left in place for admin
  //      inspection.
  //   3. A blob on disk with no matching row at all. True orphan; prune.
  // Done BEFORE building `knownKeys` so step 1 moves partial blobs out
  // of the "known" set before step 3 runs.
  try {
    const interruptedRows = attachments.listInterruptedUploads();
    for (const row of interruptedRows) {
      attachments.markInterruptedOnStartup(row.id);
      await blobStore.unlinkSafely(row.storage_key).catch(() => {});
    }
    if (interruptedRows.length > 0) {
      console.warn(
        `[proofestra] marked ${interruptedRows.length} interrupted attachment uploads as failed`,
      );
    }

    let readyMissing = 0;
    let boundMissing = 0;
    for (const row of attachments.listAllStorageKeys()) {
      if (row.state !== "ready" && row.state !== "bound") continue;
      const diskPath = blobStore.pathFor(row.storage_key);
      try {
        await fs.promises.access(diskPath);
      } catch {
        if (row.state === "ready" && attachments.markReadyBlobMissing(row.id)) {
          readyMissing += 1;
        } else if (row.state === "bound") {
          boundMissing += 1;
        }
      }
    }
    if (readyMissing > 0) {
      console.warn(`[proofestra] marked ${readyMissing} ready attachments with missing blobs as failed`);
    }
    if (boundMissing > 0) {
      console.warn(
        `[proofestra] WARNING: ${boundMissing} bound attachments have missing blobs (manual investigation required)`,
      );
    }

    // Only now compute the authoritative known-key set. Rows failed in
    // step 1 above have been reset, their blobs removed; the remaining
    // storage keys are everything the DB currently believes it owns.
    const knownKeys = new Set<string>(
      attachments.listAllStorageKeys().map((r) => r.storage_key),
    );
    const pruned = await blobStore.pruneOrphans(knownKeys);
    if (pruned > 0) {
      console.warn(`[proofestra] pruned ${pruned} orphan attachment blobs`);
    }
  } catch (err) {
    console.warn(`[proofestra] attachment reconciliation failed: ${(err as Error).message}`);
  }

  const coordinator = new Coordinator({
    config,
    db,
    conversations,
    messages,
    runs,
    events,
    attachments,
    blobStore,
    fetchImpl: options.fetchImpl ?? fetch,
  });

  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 128 * 1024,
    trustProxy: false,
    // `disableRequestLogging` is marked [FSTDEP023] deprecated in Fastify
    // 5.12; the replacement (log controller) is not yet shipped as a
    // concrete API in the 5.x line, so we keep the deprecated flag until
    // Fastify 6. The warning is loud at startup but functionally benign.
    disableRequestLogging: true,
  });

  // One error envelope for everything the routes do not handle themselves.
  // Client errors (4xx, e.g. malformed JSON or an oversize body) keep their
  // framework message; anything else is an internal failure whose text may
  // contain paths or driver details, so it is replaced by a fixed message.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const raw = error.statusCode;
    const status = typeof raw === "number" && raw >= 400 && raw <= 599 ? raw : 500;
    const clientError = status < 500;
    if (!clientError) request.log.error({ err: error }, "unhandled request error");
    void reply.status(status).send({
      error: {
        code: clientError ? clientErrorCode(status) : "internal_error",
        message: clientError ? error.message : "internal server error",
        request_id: String(request.id),
        details: [],
      },
    });
  });

  // Register security hooks at the app root scope so they also apply to
  // static assets, SPA fallback, and any route added later.
  registerSecurity(app, { sessions, config });

  await registerRoutes(app, {
    config,
    sessions,
    conversations,
    messages,
    runs,
    events,
    attachments,
    blobStore,
    coordinator,
    ...(options.extractAttachmentImpl ? { extractAttachmentImpl: options.extractAttachmentImpl } : {}),
  });

  // Serve the built client when it exists; dev mode uses the Vite dev server.
  const publicDir = path.resolve(path.dirname(dbPath), "..", "public");
  const builtDir = path.resolve(process.cwd(), "dist/public");
  const staticDir = fs.existsSync(builtDir) ? builtDir : publicDir;
  const hasStatic = fs.existsSync(staticDir);
  if (hasStatic) {
    await app.register(fastifyStatic, {
      root: staticDir,
      prefix: "/",
      decorateReply: true,
      index: ["index.html"],
    });
  }
  // An unknown API path ALWAYS gets the documented error envelope, whether or
  // not a client build is present (an unbuilt checkout used to fall through to
  // Fastify's default 404 body). Only non-API paths depend on the build: with
  // one they fall back to the SPA; without one they are a plain envelope 404.
  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url.startsWith("/api/");
    if (isApi || !hasStatic) {
      return reply.status(404).send({
        error: {
          code: "not_found",
          message: isApi ? "unknown API path" : "not found",
          request_id: String(request.id),
          details: [],
        },
      });
    }
    // SPA fallback.
    return reply.sendFile("index.html");
  });

  return {
    app,
    config,
    coordinator,
    db,
    runs,
    events,
    conversations,
    messages,
    attachments,
    blobStore,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}

function clientErrorCode(status: number): string {
  switch (status) {
    case 404:
      return "not_found";
    case 413:
      return "payload_too_large";
    case 415:
      return "unsupported_media_type";
    case 422:
      return "validation_failed";
    default:
      return "invalid_request";
  }
}

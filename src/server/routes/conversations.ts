import type { FastifyInstance } from "fastify";
import type { RouteDeps } from "./index.js";
import { ConversationCreateSchema, CursorQuerySchema } from "../../shared/schema.js";
import { errorBody } from "../security.js";
import { InvalidCursorError } from "../../storage/repos.js";
import { abortConversationUploads } from "./attachments.js";
import type { ConversationExport } from "../../shared/types.js";

export function registerConversationRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get("/api/v1/conversations", async (request, reply) => {
    const parsed = CursorQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400).send({
        error: errorBody("invalid_cursor", parsed.error.issues[0]!.message, request.id),
      });
      return;
    }
    try {
      return deps.conversations.list(parsed.data.limit, parsed.data.cursor ?? null);
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        reply.status(400).send({
          error: errorBody("invalid_cursor", "cursor is not valid", request.id),
        });
        return;
      }
      throw err;
    }
  });

  app.post("/api/v1/conversations", async (request, reply) => {
    const parsed = ConversationCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.status(422).send({
        error: errorBody("validation_failed", parsed.error.issues[0]!.message, request.id),
      });
      return;
    }
    const created = deps.conversations.create(parsed.data.title);
    reply.status(201).header("location", `/api/v1/conversations/${created.id}`);
    return created;
  });

  app.get("/api/v1/conversations/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const conversation = deps.conversations.get(id);
    if (!conversation) {
      reply.status(404).send({ error: errorBody("not_found", "conversation not found", request.id) });
      return;
    }
    return conversation;
  });

  app.delete("/api/v1/conversations/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (deps.conversations.hasActiveRun(id)) {
      reply.status(409).send({
        error: errorBody("run_in_progress", "cancel the active run before deleting", request.id),
      });
      return;
    }
    // Abort and await this conversation's in-flight uploads first: their
    // parsers are terminated, partial blobs removed, and each upload request
    // ends 409 `attachment_removed` instead of racing the cascade.
    await abortConversationUploads(id);
    // Collect blob storage keys FIRST so we can unlink the on-disk files
    // after the SQLite cascade removes their rows. If this process dies
    // between the DELETE and the unlink, the orphan blobs are cleaned up
    // on the next server boot by `blobStore.pruneOrphans()`.
    const blobKeys = deps.attachments.storageKeysForConversation(id);
    deps.conversations.delete(id);
    for (const key of blobKeys) {
      await deps.blobStore.unlinkSafely(key).catch(() => {});
    }
    reply.status(204).send();
  });

  app.get("/api/v1/conversations/:id/messages", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const conversation = deps.conversations.get(id);
    if (!conversation) {
      reply.status(404).send({ error: errorBody("not_found", "conversation not found", request.id) });
      return;
    }
    return { items: deps.messages.list(id), next_cursor: null };
  });

  app.get("/api/v1/conversations/:id/export", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const conversation = deps.conversations.get(id);
    if (!conversation) {
      reply.status(404).send({ error: errorBody("not_found", "conversation not found", request.id) });
      return;
    }
    if (deps.conversations.hasActiveRun(id)) {
      reply.status(409).send({
        error: errorBody("run_in_progress", "cancel the active run before exporting", request.id),
      });
      return;
    }
    const bundle: ConversationExport = {
      export_version: 1,
      exported_at: new Date().toISOString(),
      conversation,
      messages: deps.messages.list(id),
      runs: deps.runs.listByConversation(id),
    };
    reply.header(
      "content-disposition",
      `attachment; filename="proofestra-${conversation.id}.json"`,
    );
    return bundle;
  });
}

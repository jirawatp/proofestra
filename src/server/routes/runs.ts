import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { RouteDeps } from "./index.js";
import { RunCreateSchema } from "../../shared/schema.js";
import { CoordinatorError, isTerminal } from "../../core/coordinator.js";
import { errorBody } from "../security.js";
import { SseWriter } from "../sse.js";
import type { EventEnvelope } from "../../shared/types.js";

export function registerRunRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.post("/api/v1/conversations/:id/runs", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const idempotencyHeader = request.headers["idempotency-key"];
    const idempotencyKey = Array.isArray(idempotencyHeader) ? idempotencyHeader[0] : idempotencyHeader;
    if (!idempotencyKey || !/^[0-9a-f-]{36}$/i.test(idempotencyKey)) {
      reply.status(400).send({
        error: errorBody("invalid_request", "Idempotency-Key must be a UUID", request.id),
      });
      return;
    }
    const parsed = RunCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.status(422).send({
        error: errorBody(
          "validation_failed",
          parsed.error.issues[0]!.message,
          request.id,
        ),
      });
      return;
    }
    try {
      const result = deps.coordinator.createRun({
        conversationId: id,
        prompt: parsed.data.prompt,
        mode: parsed.data.mode,
        executionMode: parsed.data.execution_mode,
        agents: parsed.data.agents.map((a) => ({
          agent_id: a.agent_id,
          name: a.name,
          profile_id: a.profile_id,
          role: a.role ?? null,
        })),
        synthesizerAgentId: parsed.data.synthesizer_agent_id ?? null,
        ...(parsed.data.delegation ? { delegation: parsed.data.delegation } : {}),
        ...(parsed.data.tool_policy ? { tool_policy: parsed.data.tool_policy } : {}),
        ...(parsed.data.limits ? { limits: parsed.data.limits } : {}),
        reviewTopology: parsed.data.review_topology,
        idempotencyKey,
        ...(parsed.data.expected_catalog_version
          ? { expectedCatalogVersion: parsed.data.expected_catalog_version }
          : {}),
        ...(parsed.data.expected_runtime_policy_version
          ? { expectedRuntimePolicyVersion: parsed.data.expected_runtime_policy_version }
          : {}),
        ...(parsed.data.attachment_ids && parsed.data.attachment_ids.length > 0
          ? { attachmentIds: parsed.data.attachment_ids }
          : {}),
      });
      if (!result.replayed) {
        // Fire-and-forget the coordinator. startRun() wraps internal errors so
        // it never rejects; the terminal commit atomically writes the
        // assistant message with the terminal event.
        void deps.coordinator.startRun(result.snapshot.id).catch((err) => {
          // Belt-and-braces: should never fire because startRun catches.
          console.error(`[proofestra] startRun unexpected rejection for ${result.snapshot.id}:`, err);
        });
        reply.status(201).header("location", `/api/v1/runs/${result.snapshot.id}`);
      } else {
        reply.status(200).header("location", `/api/v1/runs/${result.snapshot.id}`);
      }
      return result.snapshot;
    } catch (err) {
      if (err instanceof CoordinatorError) {
        reply.status(err.httpStatus).send({ error: errorBody(err.code, err.message, request.id) });
        return;
      }
      throw err;
    }
  });

  app.get("/api/v1/runs/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const snapshot = deps.runs.get(id);
    if (!snapshot) {
      reply.status(404).send({ error: errorBody("not_found", "run not found", request.id) });
      return;
    }
    return snapshot;
  });

  app.put("/api/v1/runs/:id/cancellation", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const snapshot = deps.coordinator.cancelAndFinalize(id);
    if (!snapshot) {
      reply.status(404).send({ error: errorBody("not_found", "run not found", request.id) });
      return;
    }
    return snapshot;
  });

  app.get("/api/v1/conversations/:id/runs", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const conversation = deps.conversations.get(id);
    if (!conversation) {
      reply.status(404).send({ error: errorBody("not_found", "conversation not found", request.id) });
      return;
    }
    const items = deps.runs.listByConversation(id);
    const active = items.find((r) => !isTerminal(r.status)) ?? null;
    return { items, active_run_id: active?.id ?? null };
  });

  app.get("/api/v1/runs/:id/events", (request, reply) => {
    const id = (request.params as { id: string }).id;
    const snapshot = deps.runs.get(id);
    if (!snapshot) {
      reply.status(404).send({ error: errorBody("not_found", "run not found", request.id) });
      return;
    }
    streamEvents(request, reply, id, deps);
  });
}

function streamEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  runId: string,
  deps: RouteDeps,
): void {
  const lastHeader = request.headers["last-event-id"];
  const lastRaw = Array.isArray(lastHeader) ? lastHeader[0] : lastHeader;
  let lastSeen = 0;
  if (lastRaw !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(lastRaw)) {
      reply.status(400).send({
        error: errorBody("invalid_event_id", "Last-Event-ID must be a non-negative integer", request.id),
      });
      return;
    }
    lastSeen = Number(lastRaw);
  }

  const snapshot = deps.runs.get(runId)!;
  const maxSequence = snapshot.last_event_sequence;

  // Future Last-Event-ID: the client is asking for events the server never
  // produced. That is a client/server mismatch; refuse with 400 so the client
  // falls back to a fresh snapshot fetch.
  if (lastSeen > maxSequence) {
    reply.status(400).send({
      error: errorBody(
        "invalid_event_id",
        `Last-Event-ID ${lastSeen} is past the latest server sequence ${maxSequence}`,
        request.id,
      ),
    });
    return;
  }

  // Terminal + caught up: nothing more will ever be produced.
  if (isTerminal(snapshot.status) && lastSeen >= maxSequence) {
    reply.status(204).send();
    return;
  }

  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "x-request-id": String(request.id),
    "x-accel-buffering": "no",
    connection: "keep-alive",
  });
  // Flush headers now so a client that is already caught up (nothing to
  // replay yet) sees the stream open instead of waiting for the first event
  // or heartbeat.
  reply.raw.flushHeaders();

  const writer = new SseWriter((chunk) => reply.raw.write(chunk));
  let closed = false;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    deps.coordinator.bus.off(`run:${runId}`, onEvent);
    writer.close();
    try {
      reply.raw.end();
    } catch {
      // ignore
    }
  };

  const onEvent = (envelope: EventEnvelope): void => {
    if (envelope.run_id !== runId) return;
    writer.send(envelope);
    if (envelope.type === "run.terminal") {
      cleanup();
    }
  };

  // Clean up when the client disconnects. Both IncomingMessage and
  // ServerResponse emit `close`; attach to the response because that fires
  // reliably for long-lived SSE on client disconnect in Node 22.
  reply.raw.on("close", cleanup);
  request.raw.on("close", cleanup);

  // Replay persisted events strictly after lastSeen.
  for (const event of deps.events.listAfter(runId, lastSeen)) {
    writer.send(event);
  }

  // If the run is terminal we're done; otherwise subscribe for live tail.
  const latestSnapshot = deps.runs.get(runId)!;
  if (isTerminal(latestSnapshot.status)) {
    cleanup();
    return;
  }
  deps.coordinator.bus.on(`run:${runId}`, onEvent);
}

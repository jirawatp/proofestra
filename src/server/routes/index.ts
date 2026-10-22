import type { FastifyInstance } from "fastify";
import type { ProofestraConfig } from "../../shared/config.js";
import type {
  AttachmentRepo,
  ConversationRepo,
  EventRepo,
  MessageRepo,
  RunRepo,
  SessionRepo,
} from "../../storage/repos.js";
import type { Coordinator } from "../../core/coordinator.js";
import type { BlobStore } from "../../core/attachments.js";
import type { extractAttachment } from "../../core/attachmentExtraction.js";
import { registerSessionRoute } from "./session.js";
import { registerProvidersRoute } from "./providers.js";
import { registerRuntimePolicyRoute } from "./runtimePolicy.js";
import { registerConversationRoutes } from "./conversations.js";
import { registerRunRoutes } from "./runs.js";
import { registerAttachmentRoutes } from "./attachments.js";

export interface RouteDeps {
  config: ProofestraConfig;
  sessions: SessionRepo;
  conversations: ConversationRepo;
  messages: MessageRepo;
  runs: RunRepo;
  events: EventRepo;
  attachments: AttachmentRepo;
  blobStore: BlobStore;
  coordinator: Coordinator;
  extractAttachmentImpl?: typeof extractAttachment;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  registerSessionRoute(app, deps);
  registerProvidersRoute(app, deps);
  registerRuntimePolicyRoute(app, deps);
  registerConversationRoutes(app, deps);
  registerRunRoutes(app, deps);
  await registerAttachmentRoutes(app, {
    config: deps.config,
    conversations: deps.conversations,
    attachments: deps.attachments,
    blobStore: deps.blobStore,
    ...(deps.extractAttachmentImpl ? { extractAttachmentImpl: deps.extractAttachmentImpl } : {}),
  });
}

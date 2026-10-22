// Zod schemas for request/response validation. These derive from
// docs/openapi.yaml and docs/api.md and are enforced at the HTTP boundary.

import { z } from "zod";

export const UuidSchema = z.string().uuid();
export const ProfileIdSchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const AgentNameSchema = z.string().min(1).max(80);

export const AgentDefinitionSchema = z.object({
  agent_id: UuidSchema,
  name: AgentNameSchema,
  profile_id: ProfileIdSchema,
  role: z.string().min(1).max(500).optional(),
});

export const DelegationInputSchema = z.object({
  enabled: z.boolean().default(false),
  allowed_profile_ids: z.array(ProfileIdSchema).max(32).optional(),
});

export const ToolPolicyInputSchema = z.object({
  mode: z.enum(["auto", "off"]).default("off"),
  allowed_tool_ids: z.array(z.string().min(1).max(160)).max(64).optional(),
  allowed_backend_ids: z.array(z.string().min(1).max(100)).max(32).optional(),
  allowed_profile_ids: z.array(ProfileIdSchema).max(32).optional(),
  grant_refs: z.array(UuidSchema).max(32).optional(),
  missing_grant: z.enum(["pause", "block"]).optional(),
  bounds_mode: z.enum(["strict", "bounded_job"]).optional(),
  required_controls: z.array(z.string().min(1).max(100)).max(32).optional(),
  allow_unknown_internal_usage: z.boolean().optional(),
});

export const RunLimitsInputSchema = z.object({
  max_harness_invocations: z.number().int().min(1).max(256).optional(),
  max_tool_operations: z.number().int().min(0).max(256).optional(),
  max_native_jobs: z.number().int().min(0).max(32).optional(),
  concurrency: z.number().int().min(1).max(16).optional(),
  per_provider_concurrency: z.number().int().min(1).max(16).optional(),
  overall_timeout_seconds: z.number().int().min(15).max(1800).optional(),
  per_call_timeout_seconds: z.number().int().min(5).max(300).optional(),
  max_native_job_seconds: z.number().int().min(1).max(600).optional(),
  max_output_tokens_per_call: z.number().int().min(32).max(32768).optional(),
  total_output_tokens: z.number().int().min(32).max(524288).optional(),
  max_retries_per_step: z.number().int().min(0).max(1).optional(),
  max_root_agents: z.number().int().min(1).max(12).optional(),
  max_total_agents: z.number().int().min(1).max(24).optional(),
  max_spawned_agents: z.number().int().min(0).max(24).optional(),
  max_children_per_agent: z.number().int().min(0).max(8).optional(),
  max_depth: z.number().int().min(0).max(3).optional(),
});

export const RunCreateSchema = z
  .object({
    // v1 allows an empty prompt WHEN at least one attachment is included
    // (attachment-only send). The refine below enforces that semantics
    // because zod cannot cross-check the two fields in a single rule.
    prompt: z.string().max(16000).default(""),
    mode: z.enum(["quick", "team"]),
    execution_mode: z.enum(["mock", "live"]).default("mock"),
    agents: z.array(AgentDefinitionSchema).min(1).max(12),
    synthesizer_agent_id: UuidSchema.nullable().optional(),
    // Default to the explicit safe shape when the client omits either field so
    // the coordinator always sees a concrete policy and never has to invent
    // one from thin air.
    delegation: DelegationInputSchema.default({ enabled: false }),
    tool_policy: ToolPolicyInputSchema.default({ mode: "off" }),
    limits: RunLimitsInputSchema.optional(),
    review_topology: z.enum(["all_peers"]).default("all_peers"),
    expected_catalog_version: z.string().min(1).max(100).optional(),
    expected_runtime_policy_version: z.string().min(1).max(100).optional(),
    // Ordered list of attachment ids the composer confirmed are `ready`.
    // The coordinator re-validates ownership + state + readiness and binds
    // them atomically to the user message.
    attachment_ids: z.array(UuidSchema).max(8).optional(),
  })
  .superRefine((value, ctx) => {
    // Attachment-only send requires at least one attachment; a non-empty
    // prompt requires nothing else. Mixed is allowed.
    const promptEmpty = value.prompt.trim().length === 0;
    const attachmentCount = value.attachment_ids?.length ?? 0;
    if (promptEmpty && attachmentCount === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "prompt is required unless at least one attachment is included",
        path: ["prompt"],
      });
    }
    const ids = new Set<string>();
    for (const agent of value.agents) {
      if (ids.has(agent.agent_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "duplicate agent_id in agents",
          path: ["agents"],
        });
      }
      ids.add(agent.agent_id);
    }
    if (value.mode === "quick") {
      if (value.agents.length !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "quick mode requires exactly one agent",
          path: ["agents"],
        });
      }
      if (value.synthesizer_agent_id != null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "quick mode does not use a synthesizer",
          path: ["synthesizer_agent_id"],
        });
      }
    } else {
      if (value.agents.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "team mode requires at least two agents",
          path: ["agents"],
        });
      }
      if (!value.synthesizer_agent_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "team mode requires synthesizer_agent_id",
          path: ["synthesizer_agent_id"],
        });
      } else if (!ids.has(value.synthesizer_agent_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "synthesizer_agent_id must reference a configured agent",
          path: ["synthesizer_agent_id"],
        });
      }
    }
  });

export const ConversationCreateSchema = z.object({
  title: z.string().min(1).max(200).default("New conversation"),
});

export const CursorQuerySchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Deployment limit ceilings and personal defaults. These are configurable per
// install but must not be exceeded. See docs/requirements.md CT-01/02 and
// docs/openapi.yaml RunLimitCeilings.

import type { RunLimits, RuntimePolicySnapshot } from "../shared/types.js";
import { RUNTIME_POLICY_VERSION } from "../shared/config.js";

export const DEPLOYMENT_CEILINGS: RunLimits = {
  max_harness_invocations: 64,
  max_tool_operations: 128,
  max_native_jobs: 8,
  concurrency: 6,
  per_provider_concurrency: 4,
  overall_timeout_seconds: 900,
  per_call_timeout_seconds: 180,
  max_native_job_seconds: 300,
  max_output_tokens_per_call: 8192,
  total_output_tokens: 131_072,
  max_retries_per_step: 1,
  max_root_agents: 6,
  max_total_agents: 24,
  max_spawned_agents: 12,
  max_children_per_agent: 2,
  max_depth: 2,
};

export const DEFAULT_LIMITS: RunLimits = {
  max_harness_invocations: 32,
  max_tool_operations: 64,
  max_native_jobs: 4,
  concurrency: 3,
  per_provider_concurrency: 2,
  overall_timeout_seconds: 300,
  per_call_timeout_seconds: 45,
  max_native_job_seconds: 120,
  max_output_tokens_per_call: 2048,
  total_output_tokens: 65_536,
  max_retries_per_step: 1,
  max_root_agents: 6,
  max_total_agents: 12,
  max_spawned_agents: 6,
  max_children_per_agent: 2,
  max_depth: 2,
};

export const QUICK_BARE_LIMITS: RunLimits = {
  ...DEFAULT_LIMITS,
  max_harness_invocations: 1,
  max_retries_per_step: 0,
};

export function mergeLimits(
  requested: Partial<Record<keyof RunLimits, number | undefined>> | undefined,
  defaults: RunLimits,
): RunLimits {
  const merged: RunLimits = { ...defaults };
  if (!requested) return merged;
  for (const key of Object.keys(defaults) as (keyof RunLimits)[]) {
    const value = requested[key];
    if (typeof value === "number") {
      const ceiling = DEPLOYMENT_CEILINGS[key];
      if (value > ceiling) {
        const err = new Error(`${String(key)}=${value} exceeds deployment ceiling ${ceiling}`);
        (err as { code?: string }).code = "validation_failed";
        throw err;
      }
      merged[key] = value;
    }
  }
  return merged;
}

export function runtimePolicy(options: { liveEnabled: boolean }): RuntimePolicySnapshot {
  return {
    policy_version: RUNTIME_POLICY_VERSION,
    updated_at: "2026-10-21T00:00:00Z",
    defaults: DEFAULT_LIMITS,
    deployment_ceilings: DEPLOYMENT_CEILINGS,
    // v1 implements neither tool execution nor subagent delegation, so both
    // defaults are honestly "off"/false. The documented aspirational
    // `team:auto` default lives in docs/decisions.md.
    default_tool_modes: { quick: "off", team: "off" },
    default_delegation: { quick: false, team: false },
    review_topologies: ["all_peers"],
    required_controls: ["context_isolation", "harness_invocations", "deadline"],
    live_enabled: options.liveEnabled,
    implementation_notes: [
      "Delegation, bounded helpers, tool execution, approvals, and shared extensions are design scope.",
      "This v1 implementation does not accept delegation.enabled=true or tool_policy.mode=auto; both are rejected with 422.",
      "Live calls additionally require per-request execution_mode='live' and configured credentials.",
    ],
  };
}

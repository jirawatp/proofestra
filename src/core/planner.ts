// Planner for the `all_peers` review topology (docs/experience.md).
// Quick mode: 1 observable request. Team mode: 2n + 1 base root requests.

import type { RunMode } from "../shared/types.js";

export interface PlanInput {
  mode: RunMode;
  rootAgentCount: number;
  toolsOn: boolean;
  helpersOn: boolean;
}

export interface Plan {
  base_planned_calls: number;
  description: string;
}

export function basePlan(input: PlanInput): Plan {
  if (input.mode === "quick") {
    const base = 1;
    return {
      base_planned_calls: base,
      description: input.toolsOn || input.helpersOn
        ? `Quick (one unreviewed root; opt-ins may add work within shared limits)`
        : `Quick (one request, no retries)`,
    };
  }
  const n = Math.max(2, input.rootAgentCount);
  const base = 2 * n + 1;
  return {
    base_planned_calls: base,
    description: `Team all_peers: ${n} drafts + ${n} reviews + 1 synthesis = ${base}`,
  };
}

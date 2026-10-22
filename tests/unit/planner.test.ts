import { describe, it, expect } from "vitest";
import { basePlan } from "../../src/core/planner.js";

describe("basePlan", () => {
  it("quick-bare collapses to one call", () => {
    expect(
      basePlan({ mode: "quick", rootAgentCount: 1, toolsOn: false, helpersOn: false })
        .base_planned_calls,
    ).toBe(1);
  });

  it("team of n yields 2n+1", () => {
    expect(
      basePlan({ mode: "team", rootAgentCount: 2, toolsOn: false, helpersOn: false })
        .base_planned_calls,
    ).toBe(5);
    expect(
      basePlan({ mode: "team", rootAgentCount: 3, toolsOn: false, helpersOn: false })
        .base_planned_calls,
    ).toBe(7);
    expect(
      basePlan({ mode: "team", rootAgentCount: 4, toolsOn: false, helpersOn: false })
        .base_planned_calls,
    ).toBe(9);
  });

  it("team floors to n>=2 so single-agent team still costs 2n+1=5", () => {
    const plan = basePlan({ mode: "team", rootAgentCount: 1, toolsOn: false, helpersOn: false });
    // The schema separately rejects team-mode-with-1-agent at the HTTP
    // boundary; the planner itself remains safe by flooring n to 2.
    expect(plan.base_planned_calls).toBe(5);
  });
});

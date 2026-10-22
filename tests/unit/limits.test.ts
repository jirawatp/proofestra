import { describe, it, expect } from "vitest";
import {
  DEFAULT_LIMITS,
  DEPLOYMENT_CEILINGS,
  QUICK_BARE_LIMITS,
  mergeLimits,
  runtimePolicy,
} from "../../src/core/limits.js";

describe("mergeLimits", () => {
  it("applies defaults when no override is supplied", () => {
    expect(mergeLimits(undefined, DEFAULT_LIMITS)).toEqual(DEFAULT_LIMITS);
  });

  it("accepts lower values than ceilings", () => {
    const merged = mergeLimits({ max_harness_invocations: 4 }, DEFAULT_LIMITS);
    expect(merged.max_harness_invocations).toBe(4);
    expect(merged.max_total_agents).toBe(DEFAULT_LIMITS.max_total_agents);
  });

  it("rejects a value above the deployment ceiling", () => {
    expect(() =>
      mergeLimits({ max_harness_invocations: DEPLOYMENT_CEILINGS.max_harness_invocations + 1 }, DEFAULT_LIMITS),
    ).toThrow(/exceeds deployment ceiling/);
  });

  it("quick-bare limits allow exactly one harness invocation and no retries", () => {
    expect(QUICK_BARE_LIMITS.max_harness_invocations).toBe(1);
    expect(QUICK_BARE_LIMITS.max_retries_per_step).toBe(0);
  });
});

describe("runtimePolicy", () => {
  it("defaults tool modes and delegation to off/false in v1", () => {
    const policy = runtimePolicy({ liveEnabled: false });
    expect(policy.default_tool_modes).toEqual({ quick: "off", team: "off" });
    expect(policy.default_delegation).toEqual({ quick: false, team: false });
    expect(policy.live_enabled).toBe(false);
    expect(policy.implementation_notes.some((n) => n.includes("delegation.enabled=true"))).toBe(true);
  });
});

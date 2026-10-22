import { describe, it, expect } from "vitest";
import { RunCreateSchema, ToolPolicyInputSchema, DelegationInputSchema } from "../../src/shared/schema.js";
import { randomUUID } from "node:crypto";

describe("RunCreateSchema", () => {
  const baseAgent = (name: string) => ({
    agent_id: randomUUID(),
    name,
    profile_id: "openai-default",
  });

  it("accepts a valid quick run with one agent and no synthesizer", () => {
    const agent = baseAgent("alpha");
    const parsed = RunCreateSchema.safeParse({
      prompt: "hello",
      mode: "quick",
      agents: [agent],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tool_policy.mode).toBe("off");
      expect(parsed.data.delegation.enabled).toBe(false);
      expect(parsed.data.review_topology).toBe("all_peers");
      expect(parsed.data.execution_mode).toBe("mock");
    }
  });

  it("rejects quick mode with more than one agent", () => {
    const parsed = RunCreateSchema.safeParse({
      prompt: "hello",
      mode: "quick",
      agents: [baseAgent("alpha"), baseAgent("beta")],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects quick mode with a synthesizer agent", () => {
    const a = baseAgent("alpha");
    const parsed = RunCreateSchema.safeParse({
      prompt: "hello",
      mode: "quick",
      agents: [a],
      synthesizer_agent_id: a.agent_id,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects team mode without synthesizer_agent_id", () => {
    const parsed = RunCreateSchema.safeParse({
      prompt: "hello",
      mode: "team",
      agents: [baseAgent("alpha"), baseAgent("beta")],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects team mode with synthesizer id not in the agent set", () => {
    const parsed = RunCreateSchema.safeParse({
      prompt: "hello",
      mode: "team",
      agents: [baseAgent("alpha"), baseAgent("beta")],
      synthesizer_agent_id: randomUUID(),
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects duplicate agent_id in team mode", () => {
    const a = baseAgent("alpha");
    const parsed = RunCreateSchema.safeParse({
      prompt: "hello",
      mode: "team",
      agents: [a, { ...a, name: "duplicate" }],
      synthesizer_agent_id: a.agent_id,
    });
    expect(parsed.success).toBe(false);
  });

  it("defaults tool_policy.mode to 'off'", () => {
    const parsed = ToolPolicyInputSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.mode).toBe("off");
  });

  it("defaults delegation.enabled to false", () => {
    const parsed = DelegationInputSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.enabled).toBe(false);
  });
});

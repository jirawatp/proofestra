// Shared id/serialization helpers and request-schema edge cases not covered
// by the happy-path suites.

import { describe, expect, it } from "vitest";
import { digestOf, newUuid, sha256Hex, stableStringify } from "../../src/shared/ids.js";
import {
  ConversationCreateSchema,
  CursorQuerySchema,
  RunCreateSchema,
  RunLimitsInputSchema,
  ToolPolicyInputSchema,
} from "../../src/shared/schema.js";

describe("ids", () => {
  it("newUuid returns distinct RFC-4122 v4 ids", () => {
    const a = newUuid();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newUuid()).not.toBe(a);
  });

  it("sha256Hex matches the known digest of 'abc' and hashes UTF-8 bytes", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("ก")).not.toBe(sha256Hex("a"));
  });

  it("digestOf is prefixed and stable under key order", () => {
    expect(digestOf({ b: 1, a: [1, { y: 2, x: 1 }] })).toBe(digestOf({ a: [1, { x: 1, y: 2 }], b: 1 }));
    expect(digestOf({})).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("stableStringify handles every JSON primitive, undefined and nesting", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(true)).toBe("true");
    expect(stableStringify("a\"b")).toBe('"a\\"b"');
    expect(stableStringify(1.5)).toBe("1.5");
    expect(stableStringify(undefined)).toBe("null");
    expect(stableStringify([undefined, "x", [], {}])).toBe('[null,"x",[],{}]');
    expect(stableStringify({ z: undefined, a: 1 })).toBe('{"a":1,"z":null}');
  });

  it("stableStringify refuses values JSON cannot represent", () => {
    expect(() => stableStringify(() => 1)).toThrow(/cannot stably serialize function/);
    expect(() => stableStringify(10n)).toThrow(/bigint/);
    expect(() => stableStringify(Symbol("s"))).toThrow(/symbol/);
  });
});

describe("CursorQuerySchema and ConversationCreateSchema", () => {
  it("defaults the limit to 20 and coerces numeric strings", () => {
    expect(CursorQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(CursorQuerySchema.parse({ limit: "7", cursor: "abc" })).toEqual({ limit: 7, cursor: "abc" });
  });

  it.each([{ limit: "0" }, { limit: "101" }, { limit: "1.5" }, { limit: "abc" }, { cursor: "" }, { cursor: "x".repeat(2049) }])(
    "rejects %j",
    (q) => {
      expect(CursorQuerySchema.safeParse(q).success).toBe(false);
    },
  );

  it("defaults a conversation title and bounds its length", () => {
    expect(ConversationCreateSchema.parse({}).title).toBe("New conversation");
    expect(ConversationCreateSchema.safeParse({ title: "" }).success).toBe(false);
    expect(ConversationCreateSchema.safeParse({ title: "x".repeat(201) }).success).toBe(false);
  });
});

describe("RunLimitsInputSchema and ToolPolicyInputSchema", () => {
  it("rejects out-of-range or non-integer limits", () => {
    expect(RunLimitsInputSchema.safeParse({ overall_timeout_seconds: 14 }).success).toBe(false);
    expect(RunLimitsInputSchema.safeParse({ max_retries_per_step: 2 }).success).toBe(false);
    expect(RunLimitsInputSchema.safeParse({ concurrency: 1.5 }).success).toBe(false);
    expect(RunLimitsInputSchema.safeParse({ max_depth: 3, max_root_agents: 12 }).success).toBe(true);
  });

  it("validates tool policy enums and uuid grant refs", () => {
    expect(ToolPolicyInputSchema.safeParse({ mode: "auto", grant_refs: ["nope"] }).success).toBe(false);
    expect(ToolPolicyInputSchema.safeParse({ mode: "maybe" }).success).toBe(false);
    expect(ToolPolicyInputSchema.parse({}).mode).toBe("off");
  });
});

describe("RunCreateSchema cross-field rules", () => {
  const agent = (n: number) => ({ agent_id: crypto.randomUUID(), name: `a${n}`, profile_id: "mock-balanced" });

  it("requires a prompt unless an attachment is present", () => {
    expect(RunCreateSchema.safeParse({ prompt: "   ", mode: "quick", agents: [agent(1)] }).success).toBe(false);
    expect(RunCreateSchema.safeParse({ mode: "quick", agents: [agent(1)] }).success).toBe(false);
    expect(
      RunCreateSchema.safeParse({ prompt: "", mode: "quick", agents: [agent(1)], attachment_ids: [crypto.randomUUID()] }).success,
    ).toBe(true);
  });

  it("rejects a duplicate agent_id", () => {
    const a = agent(1);
    const parsed = RunCreateSchema.safeParse({ prompt: "x", mode: "team", agents: [a, { ...a, name: "b" }], synthesizer_agent_id: a.agent_id });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.map((i) => i.message)).toContain("duplicate agent_id in agents");
  });

  it("team mode needs two agents and a synthesizer that references one of them", () => {
    const a = agent(1);
    const r = RunCreateSchema.safeParse({ prompt: "x", mode: "team", agents: [a], synthesizer_agent_id: a.agent_id });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.message)).toContain("team mode requires at least two agents");
    const b = agent(2);
    const ok = RunCreateSchema.safeParse({ prompt: "x", mode: "team", agents: [a, b], synthesizer_agent_id: b.agent_id });
    expect(ok.success).toBe(true);
  });

  it("limits attachment ids to eight valid uuids and agents to twelve", () => {
    const many = Array.from({ length: 9 }, () => crypto.randomUUID());
    expect(RunCreateSchema.safeParse({ prompt: "x", mode: "quick", agents: [agent(1)], attachment_ids: many }).success).toBe(false);
    expect(RunCreateSchema.safeParse({ prompt: "x", mode: "quick", agents: [agent(1)], attachment_ids: ["x"] }).success).toBe(false);
    const agents = Array.from({ length: 13 }, (_, i) => agent(i));
    expect(RunCreateSchema.safeParse({ prompt: "x", mode: "team", agents, synthesizer_agent_id: agents[0]!.agent_id }).success).toBe(false);
  });

  it("rejects bad profile ids and over-long prompts", () => {
    expect(RunCreateSchema.safeParse({ prompt: "x", mode: "quick", agents: [{ ...agent(1), profile_id: "Bad Id" }] }).success).toBe(false);
    expect(RunCreateSchema.safeParse({ prompt: "x".repeat(16001), mode: "quick", agents: [agent(1)] }).success).toBe(false);
  });
});

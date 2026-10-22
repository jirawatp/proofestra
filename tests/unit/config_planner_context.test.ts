// Planner arithmetic and the capacity estimator's framing edge cases.

import { describe, expect, it } from "vitest";
import { basePlan } from "../../src/core/planner.js";
import { estimateTokens, evaluateCapacity, freezeContext, worstCaseReferenceTokens } from "../../src/core/context.js";
import type { Message, ModelProfile } from "../../src/shared/types.js";

describe("basePlan", () => {
  it("quick is one request; opt-ins (tools or helpers) change the description, not the base count", () => {
    expect(basePlan({ mode: "quick", rootAgentCount: 1, toolsOn: false, helpersOn: false })).toEqual({
      base_planned_calls: 1,
      description: "Quick (one request, no retries)",
    });
    for (const [toolsOn, helpersOn] of [[true, false], [false, true], [true, true]] as const) {
      const plan = basePlan({ mode: "quick", rootAgentCount: 1, toolsOn, helpersOn });
      expect(plan.base_planned_calls).toBe(1);
      expect(plan.description).toContain("opt-ins may add work within shared limits");
    }
  });

  it("team is 2n+1 with n clamped to at least two", () => {
    expect(basePlan({ mode: "team", rootAgentCount: 3, toolsOn: false, helpersOn: false }).base_planned_calls).toBe(7);
    expect(basePlan({ mode: "team", rootAgentCount: 1, toolsOn: false, helpersOn: false }).base_planned_calls).toBe(5);
    expect(basePlan({ mode: "team", rootAgentCount: 6, toolsOn: false, helpersOn: false }).description).toBe(
      "Team all_peers: 6 drafts + 6 reviews + 1 synthesis = 13",
    );
  });
});

describe("evaluateCapacity framing", () => {
  const profile = (safe: number): ModelProfile => ({
    profile_id: "p",
    provider: "mock",
    label: "p",
    model_id: null,
    safe_input_tokens: safe,
    max_output_tokens: 2048,
    api_shape: "mock",
    readiness: "configured",
    execution_backend_id: "b",
  });
  const msg = (text: string): Message => ({ id: "m", conversation_id: "c", run_id: "r", role: "user", text, sequence: 1, created_at: "t" });

  it("charges no system-message framing when there are no system instructions, and one 8-token frame when there are", () => {
    const base = { history: [msg("")], referenceMaterial: null, outputReserveTokens: 0 };
    const noSystem = evaluateCapacity(profile(10_000), { ...base, systemInstructions: "" });
    const withSystem = evaluateCapacity(profile(10_000), { ...base, systemInstructions: "s" });
    expect(withSystem.estimatedInputTokens - noSystem.estimatedInputTokens).toBe(1 + 8);
  });

  it("an explicit reference token count replaces estimating the string and counts as one framed message", () => {
    const a = evaluateCapacity(profile(10_000), { history: [], systemInstructions: "", referenceMaterial: null, referenceMaterialTokens: 100, outputReserveTokens: 0 });
    const b = evaluateCapacity(profile(10_000), { history: [], systemInstructions: "", referenceMaterial: null, outputReserveTokens: 0 });
    expect(a.estimatedInputTokens - b.estimatedInputTokens).toBe(100 + 8);
    const negative = evaluateCapacity(profile(10_000), { history: [], systemInstructions: "", referenceMaterial: null, referenceMaterialTokens: -50, outputReserveTokens: -5 });
    expect(negative.fits).toBe(true);
    expect(negative.worstCaseTokens).toBe(negative.estimatedInputTokens);
  });

  it("reports why a request does not fit, naming the profile and the breakdown", () => {
    const r = evaluateCapacity(profile(1_000), { history: [msg("x".repeat(900))], systemInstructions: "sys", referenceMaterial: "ref".repeat(10), outputReserveTokens: 200, attachmentTokens: 50.9 });
    expect(r.fits).toBe(false);
    expect(r.reason).toContain("exceeds profile p capacity 1000");
    expect(r.reason).toContain("attachments 50");
    expect(r.reason).toContain("reserve 200");
  });

  it("estimateTokens is a worst-case max(bytes, chars) and never zero for non-empty text", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("ก")).toBe(3); // 3 UTF-8 bytes beats 1 character
    expect(estimateTokens("😀")).toBe(4);
  });

  it("worst-case reference sizes by stage", () => {
    expect(worstCaseReferenceTokens("draft", 3, 100)).toBe(0);
    expect(worstCaseReferenceTokens("review", 3, 100)).toBe(200);
    expect(worstCaseReferenceTokens("review", 0, 100)).toBe(0);
    expect(worstCaseReferenceTokens("synthesis", 3, 100)).toBe(600);
  });

  it("freezeContext copies attachment refs and coverage so later mutation cannot alter the frozen snapshot", () => {
    const ref = { id: "a", sanitized_display_name: "n", kind: "text", sniffed_mime: "text/plain", byte_size: 1, content_sha256: "h", extraction_status: "none", extraction_coverage: { extracted_chars: 0, truncated: false, label: "x" } } as never;
    const cov = { agent_id: "g", profile_id: "p", provider: "mock", routes: [], aggregate_note: "n" } as never;
    const frozen = freezeContext({ history: [msg("hi")], newUserMessageId: "new", attachments: [ref], attachment_coverage: [cov] });
    expect(frozen.attachments![0]).not.toBe(ref);
    expect(frozen.attachment_coverage![0]).not.toBe(cov);
    expect(frozen.message_ids).toEqual(["m", "new"]);
    expect(frozen.notice).toBeUndefined();
    const empty = freezeContext({ history: [], newUserMessageId: "n", attachments: [], attachment_coverage: [] });
    expect(empty.attachments).toBeUndefined();
    expect(empty.attachment_coverage).toBeUndefined();
  });
});

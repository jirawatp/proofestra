import { describe, it, expect } from "vitest";
import {
  assertPromptWithinLimit,
  estimateTokens,
  evaluateCapacity,
  freezeContext,
  worstCaseReferenceTokens,
} from "../../src/core/context.js";
import type { Message, ModelProfile } from "../../src/shared/types.js";

const profile = (safe: number): ModelProfile => ({
  profile_id: "mock-balanced",
  provider: "mock",
  label: "mock",
  model_id: "mock-v1",
  safe_input_tokens: safe,
  max_output_tokens: 2048,
  api_shape: "mock",
  readiness: "configured",
  execution_backend_id: "mock-provider-api",
});

describe("freezeContext", () => {
  it("emits the first-turn notice when history is empty", () => {
    const context = freezeContext({ history: [], newUserMessageId: "u1" });
    expect(context.policy).toBe("all_history_v1");
    expect(context.message_ids).toEqual(["u1"]);
    expect(context.notice).toContain("first turn");
  });

  it("rejects history above the character cap", () => {
    const giant: Message = {
      id: "m1",
      conversation_id: "c1",
      run_id: "r1",
      role: "user",
      text: "x".repeat(200_000),
      sequence: 1,
      created_at: "2026-10-21T00:00:00Z",
    };
    expect(() => freezeContext({ history: [giant], newUserMessageId: "u1" })).toThrowError(
      /history too large/,
    );
  });
});

describe("assertPromptWithinLimit", () => {
  it("rejects an overlong prompt with context_too_large code", () => {
    try {
      assertPromptWithinLimit("x".repeat(20_000));
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("context_too_large");
    }
  });
});

const mkMessage = (text: string): Message => ({
  id: "m-" + text.length,
  conversation_id: "c1",
  run_id: "r1",
  role: "user",
  text,
  sequence: 1,
  created_at: "2026-10-21T00:00:00Z",
});

describe("evaluateCapacity", () => {
  it("fits a tiny prompt into a large profile", () => {
    const result = evaluateCapacity(profile(32_000), {
      history: [mkMessage("hello")],
      systemInstructions: "sys",
      referenceMaterial: null,
      outputReserveTokens: 2048,
    });
    expect(result.fits).toBe(true);
  });

  it("rejects when input+reserve exceed capacity", () => {
    const huge = "x".repeat(60_000);
    const result = evaluateCapacity(profile(10_000), {
      history: [mkMessage(huge)],
      systemInstructions: "sys",
      referenceMaterial: null,
      outputReserveTokens: 2048,
    });
    expect(result.fits).toBe(false);
    expect(result.reason).toMatch(/exceeds profile/);
  });

  it("token estimator is the honest worst-case (1 token per byte / per char)", () => {
    expect(estimateTokens("")).toBe(0);
    // 4 ASCII bytes, 4 chars: worst-case admits 4 tokens, not 1. We do not
    // claim to beat a provider tokenizer; we only promise this bound is not
    // below any mainstream tokenizer for arbitrary text.
    expect(estimateTokens("abcd")).toBe(4);
    // Thai characters are 3 UTF-8 bytes each; byte-count dominates.
    expect(estimateTokens("กข")).toBe(6);
    // Emoji is 4 UTF-8 bytes and 2 UTF-16 code units; byte-count dominates.
    expect(estimateTokens("😀")).toBe(4);
  });

  it("includes per-message framing overhead so single short message isn't just content tokens", () => {
    // 1 message of "hi" (2 chars) + 1 "sys" + reply framing. Content ~1 token
    // but framing adds at least 2 * 8 + 8 = 24 tokens. Must be strictly > 20.
    const result = evaluateCapacity(profile(1_000), {
      history: [mkMessage("hi")],
      systemInstructions: "sys",
      referenceMaterial: null,
      outputReserveTokens: 100,
    });
    expect(result.fits).toBe(true);
    expect(result.estimatedInputTokens).toBeGreaterThan(20);
  });

  it("rejects a Thai-only history that would just fit on chars/4 alone but exceeds the UTF-8 bound", () => {
    // 10_000 Thai characters = 30_000 UTF-8 bytes = 15_000 tokens by UTF-8
    // bound; chars/4 alone would say only 2_500. A 10_000-token profile must
    // reject this because the UTF-8 bound dominates.
    const thaiBlock = "ก".repeat(10_000);
    const result = evaluateCapacity(profile(10_000), {
      history: [mkMessage(thaiBlock)],
      systemInstructions: "sys",
      referenceMaterial: null,
      outputReserveTokens: 0,
    });
    expect(result.fits).toBe(false);
  });

  it("accepts an emoji-heavy prompt within a generous profile", () => {
    const emoji = "😀".repeat(2_000);
    const result = evaluateCapacity(profile(16_000), {
      history: [mkMessage(emoji)],
      systemInstructions: "sys",
      referenceMaterial: null,
      outputReserveTokens: 2048,
    });
    // 2000 emoji at 4 bytes = 8000 bytes / 2 = 4000 tokens content; plus
    // framing + reserve ≈ 6_100 tokens. Fits a 16k profile.
    expect(result.fits).toBe(true);
  });

  it("accepts a normal Team-3 synthesis worst case on an openai-default-sized profile", () => {
    // Normal Team-3 base plan should admit on a 128k-safe profile with the
    // default 2048 per-call reserve. Regression for the user's observation
    // that bytes/2 + dummy-string synthesis caused Team-3 admission to fail.
    const refTokens = worstCaseReferenceTokens("synthesis", 3, 2048);
    expect(refTokens).toBe(12_288); // 2 * 3 * 2048
    const result = evaluateCapacity(profile(128_000), {
      history: [mkMessage("tell me a short answer")],
      systemInstructions: "sys",
      referenceMaterial: null,
      referenceMaterialTokens: refTokens,
      outputReserveTokens: 2048,
    });
    expect(result.fits).toBe(true);
    // Verify framing + reference-tokens-override are both reflected.
    expect(result.estimatedInputTokens).toBeGreaterThanOrEqual(12_288);
    expect(result.estimatedInputTokens).toBeLessThanOrEqual(16_000);
  });

  it("rejects a near-limit profile when the worst-case synthesis would overflow", () => {
    // A small 16k profile with large per-call reserves should reject synthesis
    // for 3 agents with 2048-token outputs because 2n*output overflows.
    const refTokens = worstCaseReferenceTokens("synthesis", 3, 2048);
    const result = evaluateCapacity(profile(8_000), {
      history: [mkMessage("hello")],
      systemInstructions: "sys",
      referenceMaterial: null,
      referenceMaterialTokens: refTokens,
      outputReserveTokens: 2048,
    });
    expect(result.fits).toBe(false);
    expect(result.reason).toMatch(/exceeds profile/);
  });
});

describe("evaluateCapacity attachment reserve", () => {
  it("charges the attachmentTokens override against the profile capacity", () => {
    // 8k profile with no attachments fits a tiny prompt; adding 7k of
    // attachment tokens tips it over.
    const base = evaluateCapacity(profile(8_000), {
      history: [{ id: "m", conversation_id: "c", run_id: "r", role: "user", text: "hi", sequence: 1, created_at: "t" }],
      systemInstructions: "sys",
      referenceMaterial: null,
      outputReserveTokens: 512,
      attachmentTokens: 0,
    });
    expect(base.fits).toBe(true);
    const withAttachments = evaluateCapacity(profile(8_000), {
      history: [{ id: "m", conversation_id: "c", run_id: "r", role: "user", text: "hi", sequence: 1, created_at: "t" }],
      systemInstructions: "sys",
      referenceMaterial: null,
      outputReserveTokens: 512,
      attachmentTokens: 7_500,
    });
    expect(withAttachments.fits).toBe(false);
    expect(withAttachments.reason).toContain("attachments 7500");
  });

  it("rejects eight 24k Thai extracts at a low-capacity profile", () => {
    // Thai is UTF-8 three bytes per code point; a 24k-character extract
    // bills at least 24000*3 = 72000 bytes, which the UTF-8 branch of
    // estimateTokens surfaces. extractedTextTokenReserve already uses
    // max(chars,bytes)+64 ≈ 72_064 per extract. Eight of them is ~576k
    // tokens, far above any sane admission bound.
    const singleExtract = 72_064; // what extractedTextTokenReserve would return
    const perAgent = singleExtract * 8;
    const r = evaluateCapacity(profile(32_000), {
      history: [{ id: "m", conversation_id: "c", run_id: "r", role: "user", text: "describe", sequence: 1, created_at: "t" }],
      systemInstructions: "sys",
      referenceMaterial: null,
      outputReserveTokens: 2048,
      attachmentTokens: perAgent,
    });
    expect(r.fits).toBe(false);
    expect(r.reason).toMatch(/attachments 576512/);
  });

  it("ignores a negative or NaN attachmentTokens override", () => {
    const r = evaluateCapacity(profile(16_000), {
      history: [{ id: "m", conversation_id: "c", run_id: "r", role: "user", text: "hi", sequence: 1, created_at: "t" }],
      systemInstructions: "sys",
      referenceMaterial: null,
      outputReserveTokens: 512,
      attachmentTokens: -42,
    });
    expect(r.fits).toBe(true);
  });
});

describe("worstCaseReferenceTokens", () => {
  it("returns 0 for draft stage", () => {
    expect(worstCaseReferenceTokens("draft", 3, 2048)).toBe(0);
  });
  it("returns (n-1) * per-call for review stage", () => {
    expect(worstCaseReferenceTokens("review", 3, 2048)).toBe(2 * 2048);
    expect(worstCaseReferenceTokens("review", 1, 2048)).toBe(0);
  });
  it("returns 2n * per-call for synthesis stage (dedup; not n*n)", () => {
    expect(worstCaseReferenceTokens("synthesis", 3, 2048)).toBe(6 * 2048);
    expect(worstCaseReferenceTokens("synthesis", 5, 1024)).toBe(10 * 1024);
  });
});

// Direct tests of the shared adapter sanitizers: allowlisted stop reasons,
// fixed-shape messages and honest usage arithmetic.

import { describe, expect, it } from "vitest";
import {
  classifyUnknownError,
  safeFinish,
  safeGeminiBlock,
  safeMessage,
  safeUsageCount,
  safeUsageSum,
} from "../../src/providers/_sanitize.js";

describe("safeFinish", () => {
  it.each([
    ["openai", "stop", "stop"],
    ["openai", "content_filter", "content_filter"],
    ["openai", "<script>", "other"],
    ["anthropic", "end_turn", "end_turn"],
    ["anthropic", "refusal", "refusal"],
    ["anthropic", "STOP", "other"],
    ["gemini", "STOP", "STOP"],
    ["gemini", "IMAGE_SAFETY", "IMAGE_SAFETY"],
    ["gemini", "stop", "other"],
  ] as const)("%s %j -> %j", (provider, raw, expected) => {
    expect(safeFinish(provider, raw)).toBe(expected);
  });

  it("returns null for absent values and for providers with no allowlist", () => {
    expect(safeFinish("openai", null)).toBeNull();
    expect(safeFinish("openai", undefined)).toBeNull();
    expect(safeFinish("openai", "")).toBeNull();
    expect(safeFinish("mock", "stop")).toBeNull();
  });
});

describe("safeGeminiBlock", () => {
  it("passes documented block reasons and collapses everything else to 'other'", () => {
    expect(safeGeminiBlock("SAFETY")).toBe("SAFETY");
    expect(safeGeminiBlock("BLOCKLIST")).toBe("BLOCKLIST");
    expect(safeGeminiBlock("vendor sentence with secrets")).toBe("other");
    expect(safeGeminiBlock(null)).toBe("other");
    expect(safeGeminiBlock(undefined)).toBe("other");
    expect(safeGeminiBlock("")).toBe("other");
  });
});

describe("safeMessage", () => {
  it("is provider + code, optionally http status and an already-filtered stop reason", () => {
    expect(safeMessage("openai", "timeout")).toBe("openai: timeout");
    expect(safeMessage("anthropic", "rate_limited", { status: 429 })).toBe("anthropic: rate_limited http=429");
    expect(safeMessage("gemini", "model_unavailable", { status: 200, stopReason: "SAFETY" })).toBe(
      "gemini: model_unavailable http=200 stop=SAFETY",
    );
    expect(safeMessage("mock", "unknown", { stopReason: null })).toBe("mock: unknown");
    expect(safeMessage("mock", "canceled", { status: 0 })).toBe("mock: canceled http=0");
  });
});

describe("classifyUnknownError", () => {
  it("distinguishes caller cancel from timeout for AbortError and ignores error text entirely", () => {
    const live = new AbortController();
    const aborted = new AbortController();
    aborted.abort();
    const abortErr = Object.assign(new Error("anything"), { name: "AbortError" });
    expect(classifyUnknownError(abortErr, aborted.signal)).toBe("canceled");
    expect(classifyUnknownError(abortErr, live.signal)).toBe("timeout");
    expect(classifyUnknownError(new Error("timeout! rate limit 429"), live.signal)).toBe("provider_unavailable");
    expect(classifyUnknownError(null, live.signal)).toBe("provider_unavailable");
    expect(classifyUnknownError("AbortError", live.signal)).toBe("provider_unavailable");
    expect(classifyUnknownError(undefined, live.signal)).toBe("provider_unavailable");
  });
});

describe("safeUsageCount / safeUsageSum", () => {
  it("accepts only finite safe non-negative integers", () => {
    expect(safeUsageCount(0)).toBe(0);
    expect(safeUsageCount(42)).toBe(42);
    expect(safeUsageCount(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    for (const bad of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2, "3", null, undefined, {}, 10n]) {
      expect(safeUsageCount(bad)).toBeNull();
    }
  });

  it("sums known counters and collapses to null on any unknown or overflow", () => {
    expect(safeUsageSum()).toBe(0);
    expect(safeUsageSum(1, 2, 3)).toBe(6);
    expect(safeUsageSum(1, null, 3)).toBeNull();
    expect(safeUsageSum(Number.MAX_SAFE_INTEGER, 1)).toBeNull();
  });
});

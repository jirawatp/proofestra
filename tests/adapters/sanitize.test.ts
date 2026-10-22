// Executable regression evidence for adapter error sanitization.
// Verifies that NO upstream text, body content, or thrown Error.message is
// ever surfaced through any adapter failure path. The marker constants below
// are arbitrary (not sk-*/API-key patterns) because the user's independent
// reproduction showed regex-based redaction was insufficient and all three
// adapters were echoing the fixture marker through `e.message`.
//
// The test configures each adapter with a fake API key, then runs it through
// four categories of upstream behaviour (HTTP 400 with marker body, HTTP 500
// with marker body, network error throwing a marker in e.message, and
// response.json() returning non-JSON garbage containing the marker). For each
// outcome we scan the thrown AdapterFailure, its .message, its JSON
// serialization, and the normalized `failure.message` for ANY occurrence of
// the marker. All must be clean.

import { describe, it, expect } from "vitest";
import { OpenAiAdapter } from "../../src/providers/openai.js";
import { AnthropicAdapter } from "../../src/providers/anthropic.js";
import { GeminiAdapter } from "../../src/providers/gemini.js";
import { AdapterFailure } from "../../src/providers/types.js";
import type {
  AdapterRequest,
  ProviderAdapter,
} from "../../src/providers/types.js";
import type { ModelProfile } from "../../src/shared/types.js";

const MARKERS = [
  "PRIVATE_UPSTREAM_TEXT_FIXTURE",
  "QUACKQUACK_LEAKED_BODY_TOKEN",
  "zephyr_internal_trace_42",
  "<<<CUSTOMER_PII_SHOULD_NEVER_LEAK>>>",
];

const FAKE_KEY = "FAKE_KEY_DO_NOT_USE";

function profileFor(provider: "openai" | "anthropic" | "gemini"): ModelProfile {
  return {
    profile_id: `${provider}-fixture`,
    provider,
    label: `${provider}-fixture`,
    model_id: provider === "openai" ? "gpt-fixture" : provider === "anthropic" ? "claude-fixture" : "gemini-fixture",
    safe_input_tokens: 32_000,
    max_output_tokens: 2048,
    api_shape:
      provider === "openai"
        ? "openai_chat_completions"
        : provider === "anthropic"
        ? "anthropic_messages_v1"
        : "gemini_generate_content",
    readiness: "configured",
    execution_backend_id: `${provider}-provider-api`,
  };
}

function requestFor(provider: "openai" | "anthropic" | "gemini", signal: AbortSignal): AdapterRequest {
  return {
    profile: profileFor(provider),
    stage: "draft",
    agent: { agent_id: "a1", name: "fixture", role: null },
    system_instructions: "fixture",
    user_messages: [{ role: "user", content: "hello" }],
    reference_material: null,
    max_output_tokens: 256,
    per_call_timeout_ms: 5_000,
    signal,
  };
}

function makeAdapter(
  provider: "openai" | "anthropic" | "gemini",
  fetchImpl: typeof fetch,
): ProviderAdapter {
  if (provider === "openai") {
    return new OpenAiAdapter({ apiKey: FAKE_KEY, fetchImpl });
  }
  if (provider === "anthropic") {
    return new AnthropicAdapter({ apiKey: FAKE_KEY, fetchImpl });
  }
  return new GeminiAdapter({ apiKey: FAKE_KEY, fetchImpl });
}

function assertClean(err: unknown, marker: string, label: string): void {
  expect(err).toBeInstanceOf(AdapterFailure);
  const failure = (err as AdapterFailure).failure;
  const message = (err as Error).message;
  const scanTargets = [
    { what: "err.message", value: message },
    { what: "failure.message", value: failure.message },
    { what: "JSON(failure)", value: JSON.stringify(failure) },
    { what: "JSON(err)", value: JSON.stringify({ name: (err as Error).name, message, failure }) },
  ];
  for (const scan of scanTargets) {
    if (scan.value.includes(marker)) {
      throw new Error(
        `${label}: marker "${marker}" leaked into ${scan.what}: ${scan.value}`,
      );
    }
    // Also assert the key doesn't leak.
    if (scan.value.includes(FAKE_KEY)) {
      throw new Error(
        `${label}: fake API key leaked into ${scan.what}: ${scan.value}`,
      );
    }
  }
}

const providers: Array<"openai" | "anthropic" | "gemini"> = [
  "openai",
  "anthropic",
  "gemini",
];

describe("adapter sanitization: upstream body / thrown Error.message leakage", () => {
  for (const provider of providers) {
    for (const marker of MARKERS) {
      it(`${provider}: HTTP 400 with marker body is suppressed [${marker}]`, async () => {
        const fetchImpl: typeof fetch = async () =>
          new Response(`upstream error page: ${marker}`, {
            status: 400,
            headers: { "content-type": "text/plain" },
          });
        const adapter = makeAdapter(provider, fetchImpl);
        const ac = new AbortController();
        try {
          await adapter.generate(requestFor(provider, ac.signal));
          throw new Error("expected failure");
        } catch (err) {
          assertClean(err, marker, `${provider} http400`);
        }
      });

      it(`${provider}: HTTP 500 with marker body is suppressed [${marker}]`, async () => {
        const fetchImpl: typeof fetch = async () =>
          new Response(`{"error":{"message":"${marker}"}}`, {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        const adapter = makeAdapter(provider, fetchImpl);
        const ac = new AbortController();
        try {
          await adapter.generate(requestFor(provider, ac.signal));
          throw new Error("expected failure");
        } catch (err) {
          assertClean(err, marker, `${provider} http500`);
        }
      });

      it(`${provider}: thrown network error with marker in message is suppressed [${marker}]`, async () => {
        const fetchImpl: typeof fetch = async () => {
          const err = new Error(`socket hangup: ${marker}`);
          err.name = "FetchError";
          throw err;
        };
        const adapter = makeAdapter(provider, fetchImpl);
        const ac = new AbortController();
        try {
          await adapter.generate(requestFor(provider, ac.signal));
          throw new Error("expected failure");
        } catch (err) {
          assertClean(err, marker, `${provider} network-err`);
        }
      });

      it(`${provider}: non-JSON success body with marker is suppressed [${marker}]`, async () => {
        const fetchImpl: typeof fetch = async () =>
          new Response(`not-json: ${marker}`, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        const adapter = makeAdapter(provider, fetchImpl);
        const ac = new AbortController();
        try {
          await adapter.generate(requestFor(provider, ac.signal));
          throw new Error("expected failure");
        } catch (err) {
          assertClean(err, marker, `${provider} non-json`);
        }
      });
    }
  }
});

describe("adapter sanitization: only allowlisted enums reach the message", () => {
  it("openai does not echo an unknown finish_reason", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: "hi" },
              finish_reason: "WEIRD_INTERNAL_ENUM_XYZZY",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const adapter = new OpenAiAdapter({ apiKey: FAKE_KEY, fetchImpl });
    const ac = new AbortController();
    try {
      await adapter.generate(requestFor("openai", ac.signal));
      throw new Error("expected failure");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterFailure);
      expect((err as Error).message).not.toContain("WEIRD_INTERNAL_ENUM_XYZZY");
      expect((err as Error).message).toContain("stop=other");
    }
  });

  it("anthropic does not echo an unknown stop_reason", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "hi" }],
          stop_reason: "SOME_NEW_VENDOR_STRING",
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const adapter = new AnthropicAdapter({ apiKey: FAKE_KEY, fetchImpl });
    const ac = new AbortController();
    try {
      await adapter.generate(requestFor("anthropic", ac.signal));
      throw new Error("expected failure");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterFailure);
      expect((err as Error).message).not.toContain("SOME_NEW_VENDOR_STRING");
      expect((err as Error).message).toContain("stop=other");
    }
  });

  it("gemini filters thought parts and thoughtSignature from the rendered text", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: "INTERNAL_REASONING_SHOULD_NEVER_LEAK", thought: true, thoughtSignature: "SIG_SHOULD_NEVER_LEAK" },
                  { text: "visible answer" },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, fetchImpl });
    const ac = new AbortController();
    const result = await adapter.generate(requestFor("gemini", ac.signal));
    expect(result.text).toContain("visible answer");
    expect(result.text).not.toContain("INTERNAL_REASONING_SHOULD_NEVER_LEAK");
    expect(result.text).not.toContain("SIG_SHOULD_NEVER_LEAK");
  });

  it("gemini maps an unknown promptFeedback.blockReason to 'other'", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          promptFeedback: { blockReason: "SOME_UNKNOWN_BLOCK_REASON" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, fetchImpl });
    const ac = new AbortController();
    try {
      await adapter.generate(requestFor("gemini", ac.signal));
      throw new Error("expected failure");
    } catch (err) {
      expect((err as Error).message).not.toContain("SOME_UNKNOWN_BLOCK_REASON");
      expect((err as Error).message).toContain("stop=other");
    }
  });
});

describe("adapter contract: supported model payloads", () => {
  it("openai sends max_completion_tokens and no temperature", async () => {
    let captured: unknown = null;
    const fetchImpl: typeof fetch = async (_url, init) => {
      captured = JSON.parse(String(init?.body ?? ""));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const adapter = new OpenAiAdapter({ apiKey: FAKE_KEY, fetchImpl });
    await adapter.generate(requestFor("openai", new AbortController().signal));
    expect(captured).toMatchObject({ model: "gpt-fixture" });
    expect(captured).toHaveProperty("max_completion_tokens", 256);
    expect(captured).not.toHaveProperty("max_tokens");
    expect(captured).not.toHaveProperty("temperature");
    expect(captured).not.toHaveProperty("top_p");
  });

  it("gemini output_tokens includes billed thoughts (prompt=10 candidate=5 thought=20 ⇒ 25)", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: "INTERNAL", thought: true, thoughtSignature: "SIG" },
                  { text: "visible answer" },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            thoughtsTokenCount: 20,
            totalTokenCount: 35,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, fetchImpl });
    const result = await adapter.generate(requestFor("gemini", new AbortController().signal));
    expect(result.usage.input_tokens).toBe(10);
    expect(result.usage.output_tokens).toBe(25);
    // Thought text and signature must never appear in the rendered output.
    expect(result.text).toContain("visible answer");
    expect(result.text).not.toContain("INTERNAL");
    expect(result.text).not.toContain("SIG");
  });

  it("gemini output_tokens is null when any usage counter is missing or invalid", async () => {
    const scenarios = [
      // Missing counters entirely.
      { usageMetadata: {} },
      // Only promptTokenCount; candidates and thoughts absent, no total.
      { usageMetadata: { promptTokenCount: 10 } },
      // Non-numeric values.
      { usageMetadata: { candidatesTokenCount: "oops", thoughtsTokenCount: 20 } },
      // Negative value.
      { usageMetadata: { candidatesTokenCount: 5, thoughtsTokenCount: -1 } },
    ];
    for (const extra of scenarios) {
      const fetchImpl: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: "visible" }] }, finishReason: "STOP" },
            ],
            ...extra,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, fetchImpl });
      const result = await adapter.generate(requestFor("gemini", new AbortController().signal));
      expect(result.usage.output_tokens, JSON.stringify(extra)).toBeNull();
    }
  });

  it("gemini derives output_tokens from totalTokenCount - promptTokenCount when thoughts are absent", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: "visible" }] }, finishReason: "STOP" },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            // thoughtsTokenCount intentionally absent (non-thinking model).
            totalTokenCount: 15,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, fetchImpl });
    const result = await adapter.generate(requestFor("gemini", new AbortController().signal));
    expect(result.usage.output_tokens).toBe(5);
  });

  it("gemini: candidate-only (thoughts absent AND no valid total) is null, not candidates", async () => {
    // Covers the explicit review finding that candidate-only cannot be
    // treated as "complete" when thoughts is absent and we cannot derive
    // generated tokens from totalTokenCount - promptTokenCount. In those
    // cases we must return null so the coordinator charges full reserve.
    const scenarios: Array<Record<string, unknown>> = [
      // No total at all.
      { promptTokenCount: 10, candidatesTokenCount: 5 },
      // Total absent, prompt absent.
      { candidatesTokenCount: 5 },
      // Total less than prompt (would yield negative) ⇒ invalid.
      { promptTokenCount: 20, candidatesTokenCount: 5, totalTokenCount: 10 },
      // Total non-numeric.
      { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: "oops" },
      // Prompt non-numeric.
      { promptTokenCount: "oops", candidatesTokenCount: 5, totalTokenCount: 15 },
    ];
    for (const usageMetadata of scenarios) {
      const fetchImpl: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "visible" }] }, finishReason: "STOP" }],
            usageMetadata,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, fetchImpl });
      const result = await adapter.generate(requestFor("gemini", new AbortController().signal));
      expect(result.usage.output_tokens, JSON.stringify(usageMetadata)).toBeNull();
    }
  });

  it("gemini: thoughts=0 is a verified zero and output_tokens equals candidates", async () => {
    // When the vendor explicitly reports `thoughtsTokenCount: 0`, we know
    // the model skipped thinking and candidates alone IS the honest total.
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "visible" }] }, finishReason: "STOP" }],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 7,
            thoughtsTokenCount: 0,
            totalTokenCount: 17,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, fetchImpl });
    const result = await adapter.generate(requestFor("gemini", new AbortController().signal));
    expect(result.usage.output_tokens).toBe(7);
  });

  it("gemini: fractional, negative, and unsafe-integer counters are rejected", async () => {
    const scenarios: Array<Record<string, unknown>> = [
      // Fractional candidate.
      { promptTokenCount: 10, candidatesTokenCount: 5.5, thoughtsTokenCount: 20 },
      // Negative thoughts.
      { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: -3 },
      // Beyond MAX_SAFE_INTEGER.
      {
        promptTokenCount: 10,
        candidatesTokenCount: Number.MAX_SAFE_INTEGER,
        thoughtsTokenCount: 1,
      },
      // Fractional prompt in the total-prompt fallback.
      { promptTokenCount: 1.5, candidatesTokenCount: 5, totalTokenCount: 7 },
    ];
    for (const usageMetadata of scenarios) {
      const fetchImpl: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "visible" }] }, finishReason: "STOP" }],
            usageMetadata,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      const adapter = new GeminiAdapter({ apiKey: FAKE_KEY, fetchImpl });
      const result = await adapter.generate(requestFor("gemini", new AbortController().signal));
      expect(result.usage.output_tokens, JSON.stringify(usageMetadata)).toBeNull();
    }
  });

  it("openai: fractional / negative / unsafe-integer usage counters are rejected", async () => {
    // Covers the review finding that `numberOrNull` previously accepted
    // negative and fractional totals which could reduce the ledger. Now
    // every provider uses `safeUsageCount` which only accepts safe
    // non-negative integers.
    const bodies: Array<Record<string, unknown>> = [
      { prompt_tokens: -1, completion_tokens: 5 },
      { prompt_tokens: 10, completion_tokens: 5.5 },
      { prompt_tokens: Number.MAX_SAFE_INTEGER + 2, completion_tokens: 5 },
    ];
    for (const usage of bodies) {
      const fetchImpl: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            usage,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      const adapter = new OpenAiAdapter({ apiKey: FAKE_KEY, fetchImpl });
      const result = await adapter.generate(requestFor("openai", new AbortController().signal));
      // At least one invalid field; the invalid one becomes null and the
      // other stays as the valid safe integer where applicable.
      const anyNull =
        result.usage.input_tokens === null || result.usage.output_tokens === null;
      expect(anyNull, JSON.stringify(usage)).toBe(true);
    }
  });

  it("anthropic: fractional / negative / unsafe-integer usage counters are rejected", async () => {
    const usages: Array<Record<string, unknown>> = [
      { input_tokens: -5, output_tokens: 10 },
      { input_tokens: 2.5, output_tokens: 10 },
      { input_tokens: 10, output_tokens: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const usage of usages) {
      const fetchImpl: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      const adapter = new AnthropicAdapter({ apiKey: FAKE_KEY, fetchImpl });
      const result = await adapter.generate(requestFor("anthropic", new AbortController().signal));
      const anyNull =
        result.usage.input_tokens === null || result.usage.output_tokens === null;
      expect(anyNull, JSON.stringify(usage)).toBe(true);
    }
  });

  it("anthropic concatenates text blocks and reports stop_reason=max_tokens truncation", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          content: [
            { type: "text", text: "part1" },
            { type: "tool_use", input: { foo: "bar" } },
            { type: "text", text: "part2" },
          ],
          stop_reason: "max_tokens",
          usage: { input_tokens: 10, output_tokens: 20 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const adapter = new AnthropicAdapter({ apiKey: FAKE_KEY, fetchImpl });
    const result = await adapter.generate(requestFor("anthropic", new AbortController().signal));
    expect(result.text).toContain("part1");
    expect(result.text).toContain("part2");
    expect(result.text).toContain("truncated");
    expect(result.findings.length).toBeGreaterThan(0);
  });
});

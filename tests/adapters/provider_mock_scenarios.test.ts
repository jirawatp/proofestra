// The deterministic mock adapter: stage output, fixture scenarios from the
// profile catalog (with stage scoping), cancellation and attachment honesty.
// Pure in-process; no network or credentials.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockAdapter, type MockScenario } from "../../src/providers/mock.js";
import { AdapterFailure } from "../../src/providers/types.js";
import type { AdapterRequest, AdapterStage, MessageContentPart } from "../../src/providers/types.js";
import type { ModelProfile } from "../../src/shared/types.js";
import { profileById, resetProfileCache } from "../../src/core/registry.js";
import { makeConfig } from "../integration/_server_helpers.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofestra-mock-"));
  vi.stubEnv("PROOFESTRA_PROFILES_FILE", undefined as unknown as string);
  resetProfileCache();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetProfileCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

const mockProfile = (id: string): ModelProfile => ({
  profile_id: id,
  provider: "mock",
  label: id,
  model_id: `${id}-v1`,
  safe_input_tokens: 32_000,
  max_output_tokens: 2048,
  api_shape: "mock",
  readiness: "configured",
  execution_backend_id: "mock-provider-api",
});

function req(over: Partial<AdapterRequest> & { stage?: AdapterStage; profileId?: string } = {}): AdapterRequest {
  const { profileId = "mock-balanced", ...rest } = over;
  return {
    profile: mockProfile(profileId),
    stage: "draft",
    agent: { agent_id: "a1", name: "Ada", role: null },
    system_instructions: "sys",
    user_messages: [{ role: "user", content: "What is a lighthouse?" }],
    reference_material: null,
    max_output_tokens: 512,
    per_call_timeout_ms: 5_000,
    signal: new AbortController().signal,
    ...rest,
  };
}

const adapter = (scenario?: MockScenario, extra = {}) => new MockAdapter({ latencyMs: 1, ...(scenario ? { scenarioOverride: scenario } : {}), ...extra });

async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AdapterFailure);
    return (e as AdapterFailure).failure;
  }
  throw new Error("expected failure");
}

describe("mock stage output", () => {
  it("draft: deterministic, voice depends on profile, no provider claim, honest about being a mock", async () => {
    const a = await adapter().generate(req({ profileId: "mock-analytical" }));
    const b = await adapter().generate(req({ profileId: "mock-analytical" }));
    expect(a.text).toBe(b.text);
    expect(a.text).toContain("Ada draft (analytical, mock");
    expect(a.text).toContain("no provider call was made");
    expect(a.findings).toEqual([]);
    const concise = await adapter().generate(req({ profileId: "mock-concise" }));
    const unknownProfile = await adapter().generate(req({ profileId: "custom-thing" }));
    expect(concise.text).toContain("concise");
    expect(unknownProfile.text).toContain("balanced");
    expect(new Set([a.text, concise.text, unknownProfile.text]).size).toBe(3);
    expect(a.usage.output_tokens).toBeLessThanOrEqual(512);
    expect(a.provider).toBe("mock");
    expect(a.model_id).toBe("mock-analytical-v1");
  });

  it("falls back to a generic model id when the profile has none, and reports an empty prompt honestly", async () => {
    const r = await adapter().generate(req({ profile: { ...mockProfile("x"), model_id: null }, user_messages: [{ role: "assistant", content: "hi" }] }));
    expect(r.model_id).toBe("mock-text-v1");
    expect(r.text).toContain("did not supply text");
  });

  it("review: counts peer drafts from the reference material and records disagreement findings", async () => {
    const ref = "# Peer draft by A\ntext\n\n# Peer draft by B\ntext";
    for (const profileId of ["mock-balanced", "mock-analytical", "mock-concise"]) {
      const r = await adapter().generate(req({ stage: "review", reference_material: ref, profileId }));
      expect(r.text).toContain("Read 2 peer draft(s)");
      expect(r.text).toContain("review (");
      expect(r.findings).toHaveLength(2);
    }
    const single = await adapter().generate(req({ stage: "review", reference_material: "# Peer draft by A\nx", profileId: "mock-balanced" }));
    expect(single.text).toContain("the peer draft");
  });

  it("synthesis: reports the drafts/reviews it saw, or says there was nothing to combine", async () => {
    const ref = "# Draft by A\nx\n# Draft by B\ny\n# Review by A\nr";
    const r = await adapter().generate(req({ stage: "synthesis", reference_material: ref }));
    expect(r.text).toContain("Synthesized from 2 draft(s) and 1 review(s)");
    expect(r.text).toContain("Agreement across drafts is not proof of correctness");
    expect(r.findings.length).toBeGreaterThan(0);
    const none = await adapter().generate(req({ stage: "synthesis", reference_material: null }));
    expect(none.text).toContain("No draft material was available");
    const draftsOnly = await adapter().generate(req({ stage: "synthesis", reference_material: "# Draft by A\nx" }));
    expect(draftsOnly.text).toContain("Synthesized from 1 draft(s).");
  });
});

describe("mock scenarios (explicit override)", () => {
  it.each([
    ["fail", "provider_unavailable"],
    ["timeout", "timeout"],
    ["safety_block", "invalid_request"],
  ] as const)("%s throws a fixed %s failure", async (scenario, code) => {
    const f = await failure(adapter(scenario).generate(req()));
    expect(f.code).toBe(code);
    expect(f.message).toBe(`mock fixture scenario=${scenario}`);
  });

  it("empty returns an empty string with zero output tokens", async () => {
    const r = await adapter("empty").generate(req());
    expect(r.text).toBe("");
    expect(r.usage.output_tokens).toBe(0);
    expect(r.usage.input_tokens).toBeGreaterThan(0);
  });

  it("unknown_usage succeeds but reports null usage", async () => {
    const r = await adapter("unknown_usage").generate(req());
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.usage).toEqual({ input_tokens: null, output_tokens: null });
  });

  it("truncated returns text with a truncation marker and finding, charging the full output budget", async () => {
    const r = await adapter("truncated").generate(req({ max_output_tokens: 99 }));
    expect(r.text).toContain("_[truncated: mock fixture stopped on max_tokens");
    expect(r.findings[0]).toContain("truncated at the output budget");
    expect(r.usage.output_tokens).toBe(99);
  });

  it("late_success ignores abort and still resolves after its latency", async () => {
    const controller = new AbortController();
    const pending = adapter("late_success").generate(req({ signal: controller.signal }));
    controller.abort();
    const r = await pending;
    expect(r.text.length).toBeGreaterThan(0);
  });

  it("never_settle never settles, even when aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let settled = false;
    void adapter("never_settle")
      .generate(req({ signal: controller.signal }))
      .then(
        () => (settled = true),
        () => (settled = true),
      );
    controller.abort();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).toBe(false);
  });
});

describe("mock cancellation and latency", () => {
  it("rejects canceled when already aborted before dispatch", async () => {
    const controller = new AbortController();
    controller.abort();
    const f = await failure(adapter().generate(req({ signal: controller.signal })));
    expect(f).toEqual({ code: "canceled", message: "canceled before dispatch" });
  });

  it("rejects canceled when aborted mid-latency and does not wait out the delay", async () => {
    const controller = new AbortController();
    const slow = new MockAdapter({ latencyMs: 60_000 });
    const started = Date.now();
    const pending = failure(slow.generate(req({ signal: controller.signal })));
    setTimeout(() => controller.abort(), 10);
    const f = await pending;
    expect(f).toEqual({ code: "canceled", message: "canceled mid-dispatch" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("uses PROOFESTRA_MOCK_LATENCY_MS and falls back to 50 ms for missing, invalid or non-positive values", async () => {
    vi.useFakeTimers();
    const resolvesWithin = async (ms: number): Promise<boolean> => {
      let done = false;
      void new MockAdapter().generate(req()).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(ms);
      return done;
    };
    vi.stubEnv("PROOFESTRA_MOCK_LATENCY_MS", "200.9");
    expect(await resolvesWithin(150)).toBe(false);
    expect(await resolvesWithin(300)).toBe(true);
    for (const bad of ["", "abc", "0", "-5"]) {
      vi.stubEnv("PROOFESTRA_MOCK_LATENCY_MS", bad);
      expect(await resolvesWithin(60)).toBe(true);
    }
  });

  it("supports every profile and is always configured", () => {
    const a = adapter();
    expect(a.supports(mockProfile("anything"))).toBe(true);
    expect(a.readiness(mockProfile("anything"))).toBe("configured");
  });

  it("can masquerade as another provider id (used for per-provider dispatch tables)", async () => {
    const r = await new MockAdapter({ latencyMs: 1, provider: "openai" }).generate(req());
    expect(r.provider).toBe("openai");
  });
});

describe("mock fixtures from the profile catalog", () => {
  function withCatalog(profiles: unknown[]) {
    const file = path.join(dir, "profiles.json");
    fs.writeFileSync(file, JSON.stringify({ profiles }));
    vi.stubEnv("PROOFESTRA_PROFILES_FILE", file);
    resetProfileCache();
    const config = makeConfig(dir);
    const catalog = (id: string) => profileById(config, id)!;
    return { config, catalog };
  }
  const mockEntry = (id: string, fixture: unknown) => ({
    profile_id: id,
    provider: "mock",
    label: id,
    model_id: null,
    safe_input_tokens: 8_000,
    max_output_tokens: 512,
    api_shape: "mock",
    execution_backend_id: "mock-provider-api",
    fixture,
  });

  it("applies a scenario to every stage when no stage is given, and to only the named stage when only_on_stage is set", async () => {
    const { config, catalog } = withCatalog([
      mockEntry("always-timeout", { scenario: "timeout" }),
      mockEntry("synth-empty", { scenario: "empty", only_on_stage: "synthesis" }),
      mockEntry("draft-unknown", { scenario: "unknown_usage", only_on_stage: "draft" }),
    ]);
    const a = new MockAdapter({ latencyMs: 1, config });
    for (const stage of ["draft", "review", "synthesis"] as const) {
      expect((await failure(a.generate(req({ stage, profile: catalog("always-timeout") })))).code).toBe("timeout");
    }
    expect((await a.generate(req({ stage: "draft", profile: catalog("synth-empty") }))).text.length).toBeGreaterThan(0);
    expect((await a.generate(req({ stage: "review", profile: catalog("synth-empty") }))).text.length).toBeGreaterThan(0);
    expect((await a.generate(req({ stage: "synthesis", profile: catalog("synth-empty") }))).text).toBe("");
    expect((await a.generate(req({ stage: "draft", profile: catalog("draft-unknown") }))).usage.output_tokens).toBeNull();
    expect((await a.generate(req({ stage: "review", profile: catalog("draft-unknown") }))).usage.output_tokens).not.toBeNull();
  });

  it("legacy 'fail' without a stage fails ONLY the review stage; with only_on_stage it fails exactly that stage", async () => {
    const { config, catalog } = withCatalog([
      mockEntry("legacy-fail", { scenario: "fail" }),
      mockEntry("draft-fail", { scenario: "fail", only_on_stage: "draft" }),
    ]);
    const a = new MockAdapter({ latencyMs: 1, config });
    expect((await failure(a.generate(req({ stage: "review", profile: catalog("legacy-fail") })))).code).toBe("provider_unavailable");
    expect((await a.generate(req({ stage: "draft", profile: catalog("legacy-fail") }))).text).toContain("draft");
    expect((await a.generate(req({ stage: "synthesis", profile: catalog("legacy-fail") }))).text).toContain("Final answer");
    expect((await failure(a.generate(req({ stage: "draft", profile: catalog("draft-fail") })))).code).toBe("provider_unavailable");
    expect((await a.generate(req({ stage: "review", profile: catalog("draft-fail") }))).text).toContain("review");
  });

  it("explicit scenarioOverride beats a catalog fixture, and a profile without a fixture behaves normally", async () => {
    const { config, catalog } = withCatalog([mockEntry("fx", { scenario: "timeout" })]);
    const override = new MockAdapter({ latencyMs: 1, config, scenarioOverride: "empty" });
    expect((await override.generate(req({ profile: catalog("fx") }))).text).toBe("");
    const plain = new MockAdapter({ latencyMs: 1, config });
    expect((await plain.generate(req({ profile: mockProfile("mock-balanced") }))).text).toContain("draft");
    // A profile id that is not in the catalog has no fixture.
    expect((await plain.generate(req({ profile: mockProfile("not-in-catalog") }))).text).toContain("draft");
  });

  it("adds fixture extra latency (cancelable)", async () => {
    const { config, catalog } = withCatalog([mockEntry("laggy", { extra_latency_ms: 40_000 })]);
    const a = new MockAdapter({ latencyMs: 1, config });
    const controller = new AbortController();
    const pending = failure(a.generate(req({ profile: catalog("laggy"), signal: controller.signal })));
    setTimeout(() => controller.abort(), 10);
    expect((await pending).code).toBe("canceled");
  });
});

describe("mock attachment honesty", () => {
  const parts = (): MessageContentPart[] => [
    { kind: "text", text: "see files" },
    {
      kind: "attachment_native",
      native_route: "native_image",
      attachment_id: "1",
      sniffed_mime: "image/png",
      wire_mime: "image/png",
      byte_size: 68,
      sanitized_display_name: "pic.png",
      blob_path: "/definitely/not/read.png",
    },
    { kind: "attachment_extracted_text", attachment_id: "2", sanitized_display_name: "n.txt", sniffed_mime: "text/plain", byte_size: 9, text: "abcdef", truncated: true },
    { kind: "attachment_only", attachment_id: "3", sanitized_display_name: "x.bin", sniffed_mime: "application/octet-stream", byte_size: 2, reason: "unsupported" },
  ];

  it("lists every attachment without reading bytes and never claims native analysis", async () => {
    const withFiles = await adapter().generate(req({ user_messages: [{ role: "user", content: "see files", parts: parts() }] }));
    expect(withFiles.text).toContain("_Attachments (3):_");
    expect(withFiles.text).toContain("pic.png (image/png, 68 B) — route=native_image but mock does not read bytes; shown as attachment-only.");
    expect(withFiles.text).toContain("Extracted 6 chars (truncated); the mock never follows file content.");
    expect(withFiles.text).toContain("x.bin (application/octet-stream, 2 B) — attachment-only: unsupported");
    // The digest of the answer depends on the attachment set.
    const without = await adapter().generate(req({ user_messages: [{ role: "user", content: "see files" }] }));
    expect(without.text).not.toContain("_Attachments");
    expect(without.text).not.toBe(withFiles.text);
  });

  it("text-only parts add no attachment section", async () => {
    const r = await adapter().generate(req({ user_messages: [{ role: "user", content: "x", parts: [{ kind: "text", text: "x" }] }] }));
    expect(r.text).not.toContain("_Attachments");
  });
});

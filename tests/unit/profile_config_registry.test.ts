// Server-side profile catalog (built-ins, file append/replace, validation) and
// the registry that derives providers, readiness and the content-addressed
// catalog version from it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProfileCatalogError,
  loadProfileCatalog,
  readinessFor,
  toModelProfile,
  type ProfileEntry,
} from "../../src/core/profileConfig.js";
import {
  buildProfiles,
  buildProviders,
  catalogSource,
  catalogVersion,
  profileById,
  profileEntries,
  profileEntryById,
  readinessOfProfile,
  resetProfileCache,
} from "../../src/core/registry.js";
import { CATALOG_VERSION_PREFIX } from "../../src/shared/config.js";
import { makeConfig } from "../integration/_server_helpers.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofestra-prof-"));
  vi.stubEnv("PROOFESTRA_PROFILES_FILE", undefined as unknown as string);
  resetProfileCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetProfileCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

const cfg = (over = {}) => makeConfig(dir, over);

const openai = (id: string, extra: Record<string, unknown> = {}) => ({
  profile_id: id,
  provider: "openai",
  label: "OpenAI X",
  model_id: "gpt-x",
  safe_input_tokens: 64_000,
  max_output_tokens: 1024,
  api_shape: "openai_chat_completions",
  execution_backend_id: "openai-chat-completions",
  ...extra,
});
const mock = (id: string, extra: Record<string, unknown> = {}) => ({
  profile_id: id,
  provider: "mock",
  label: "Mock X",
  model_id: null,
  safe_input_tokens: 8_000,
  max_output_tokens: 256,
  api_shape: "mock",
  execution_backend_id: "mock-provider-api",
  ...extra,
});

function load(json: unknown, mode?: string) {
  const body = typeof json === "string" ? json : JSON.stringify(mode ? { mode, ...(json as object) } : json);
  return () => loadProfileCatalog(cfg(), { fileContents: body, filePath: "/virtual/profiles.json" });
}

describe("loadProfileCatalog: built-ins", () => {
  it("returns the mock seeds plus env-derived live profiles with no file", () => {
    const cat = loadProfileCatalog(cfg());
    expect(cat.source).toBe("built_in");
    expect(cat.file_path).toBeNull();
    const ids = cat.profiles.map((p) => p.profile_id);
    expect(ids).toEqual(
      expect.arrayContaining(["mock-balanced", "mock-analytical", "mock-concise", "mock-fail-review", "mock-slow", "openai-default", "anthropic-default", "gemini-default"]),
    );
    expect(cat.profiles.find((p) => p.profile_id === "openai-default")!.model_id).toBe("gpt-test");
  });

  it("omits a provider's default profile when its default model is empty", () => {
    const c = cfg({ providerDefaultModels: { openai: "", anthropic: "", gemini: "g" } });
    const ids = loadProfileCatalog(c).profiles.map((p) => p.profile_id);
    expect(ids).not.toContain("openai-default");
    expect(ids).not.toContain("anthropic-default");
    expect(ids).toContain("gemini-default");
  });

  it("omits every env-derived live profile when no default model is configured", () => {
    const c = cfg({ providerDefaultModels: { openai: "", anthropic: "", gemini: "" } });
    const ids = loadProfileCatalog(c).profiles.map((p) => p.profile_id);
    expect(ids.some((id) => id.endsWith("-default"))).toBe(false);
    expect(ids).toContain("mock-balanced");
  });

  it("rejects a built-in seed that violates the schema (e.g. over-long model id)", () => {
    const c = cfg({ providerDefaultModels: { openai: "m".repeat(201), anthropic: "a", gemini: "g" } });
    expect(() => loadProfileCatalog(c)).toThrow(ProfileCatalogError);
    expect(() => loadProfileCatalog(c)).toThrow(/built-in profile seeds failed validation/);
  });
});

describe("loadProfileCatalog: profile files", () => {
  it("append mode (the default) adds profiles after the built-ins", () => {
    const cat = load({ profiles: [openai("my-openai")] })();
    expect(cat.source).toBe("file_append");
    expect(cat.file_path).toBe("/virtual/profiles.json");
    expect(cat.profiles.map((p) => p.profile_id)).toEqual(expect.arrayContaining(["mock-balanced", "my-openai"]));
  });

  it("replace mode drops the built-ins and requires a mock profile", () => {
    const cat = load({ profiles: [mock("only-mock"), openai("o")] }, "replace")();
    expect(cat.source).toBe("file_replace");
    expect(cat.profiles.map((p) => p.profile_id)).toEqual(["only-mock", "o"]);
    expect(load({ profiles: [openai("o")] }, "replace")).toThrow(/at least one mock profile/);
  });

  it.each([
    ["not json", /not valid JSON/],
    ["[]", /validation failed/],
    [JSON.stringify({ profiles: [] }), /validation failed/],
    [JSON.stringify({ mode: "merge", profiles: [mock("m")] }), /validation failed/],
    [JSON.stringify({ profiles: [{ ...mock("Bad Id") }] }), /validation failed/],
    [JSON.stringify({ profiles: [openai("x", { api_shape: "mock" })] }), /requires api_shape=openai_chat_completions/],
    [JSON.stringify({ profiles: [openai("x", { model_id: null })] }), /non-null model_id/],
    [JSON.stringify({ profiles: [openai("x", { safe_input_tokens: 10 })] }), /validation failed/],
    [JSON.stringify({ profiles: [openai("x", { fixture: { scenario: "explode" } })] }), /validation failed/],
  ])("rejects an invalid file: %s", (text, pattern) => {
    expect(load(text)).toThrow(ProfileCatalogError);
    expect(load(text)).toThrow(pattern);
  });

  it("names the origin generically when the duplicate is found in inline contents without a path", () => {
    const body = JSON.stringify({ profiles: [mock("same"), mock("same")] });
    expect(() => loadProfileCatalog(cfg(), { fileContents: body })).toThrow('duplicate profile_id "same" in profile file');
  });

  it("rejects duplicate profile ids within the file and against the built-ins", () => {
    expect(load({ profiles: [openai("dup"), openai("dup")] })).toThrow(/duplicate profile_id "dup"/);
    expect(load({ profiles: [mock("mock-balanced")] })).toThrow(/duplicate profile_id "mock-balanced"/);
    expect(load({ profiles: [mock("a"), mock("a")] }, "replace")).toThrow(/duplicate profile_id "a"/);
  });

  it("accepts full capability overrides and mock fixture controls", () => {
    const cat = load({
      profiles: [
        openai("caps", { capabilities: { image: false, image_mime_whitelist: ["image/png"], max_native_image_bytes: 1024, audio_codec_whitelist: ["aac"] } }),
        mock("fx", { fixture: { scenario: "truncated", extra_latency_ms: 5, only_on_stage: "draft" } }),
      ],
    })();
    expect(cat.profiles.find((p) => p.profile_id === "caps")!.capabilities).toMatchObject({ image: false, max_native_image_bytes: 1024 });
    expect(cat.profiles.find((p) => p.profile_id === "fx")!.fixture).toMatchObject({ scenario: "truncated", only_on_stage: "draft" });
    expect(load({ profiles: [openai("c", { capabilities: { audio_codec_whitelist: ["bad codec!"] } })] })).toThrow(/validation failed/);
  });

  it("reads PROOFESTRA_PROFILES_FILE from the environment and reports a clear error when unreadable", () => {
    const file = path.join(dir, "profiles.json");
    fs.writeFileSync(file, JSON.stringify({ profiles: [openai("from-env")] }));
    vi.stubEnv("PROOFESTRA_PROFILES_FILE", file);
    const cat = loadProfileCatalog(cfg());
    expect(cat.profiles.map((p) => p.profile_id)).toContain("from-env");
    expect(cat.file_path).toBe(file);

    vi.stubEnv("PROOFESTRA_PROFILES_FILE", path.join(dir, "missing.json"));
    let caught: unknown;
    try {
      loadProfileCatalog(cfg());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProfileCatalogError);
    expect((caught as Error).message).toContain("cannot read PROOFESTRA_PROFILES_FILE");
    expect((caught as ProfileCatalogError).path).toBe(path.join(dir, "missing.json"));
  });

  it("treats an empty profiles file as 'no file configured' and falls back to the built-ins", () => {
    const file = path.join(dir, "empty.json");
    fs.writeFileSync(file, "");
    vi.stubEnv("PROOFESTRA_PROFILES_FILE", file);
    const cat = loadProfileCatalog(cfg());
    expect(cat.source).toBe("built_in");
    expect(cat.file_path).toBeNull();
  });
});

describe("readiness", () => {
  const entry = (provider: ProfileEntry["provider"]) => ({ provider }) as ProfileEntry;

  it("mock profiles are always configured; live providers need the live flag then a key", () => {
    expect(readinessFor(entry("mock"), cfg())).toBe("configured");
    for (const provider of ["openai", "anthropic", "gemini"] as const) {
      expect(readinessFor(entry(provider), cfg())).toBe("disabled");
      expect(readinessFor(entry(provider), cfg({ liveEnabled: true }))).toBe("missing_auth");
    }
    const keys = { openaiKey: "sk-test-FAKE", anthropicKey: "sk-ant-FAKE", googleKey: "g-FAKE" };
    for (const provider of ["openai", "anthropic", "gemini"] as const) {
      expect(readinessFor(entry(provider), cfg({ liveEnabled: true, providerCredentials: keys }))).toBe("configured");
    }
  });

  it("only the provider whose key is present becomes configured", () => {
    const c = cfg({ liveEnabled: true, providerCredentials: { openaiKey: null, anthropicKey: "sk-ant-FAKE", googleKey: null } });
    expect(readinessOfProfile(c, "openai-default")).toBe("missing_auth");
    expect(readinessOfProfile(c, "anthropic-default")).toBe("configured");
    expect(readinessOfProfile(c, "gemini-default")).toBe("missing_auth");
    expect(readinessOfProfile(c, "no-such-profile")).toBe("unsupported");
  });

  it("an unknown provider id is unsupported", () => {
    expect(readinessFor({ provider: "weird" } as unknown as ProfileEntry, cfg({ liveEnabled: true }))).toBe("unsupported");
  });

  it("toModelProfile copies capabilities and never exposes fixtures", () => {
    const e = { ...(openai("p") as unknown as ProfileEntry), capabilities: { pdf: false }, fixture: { scenario: "fail" as const } };
    const mp = toModelProfile(e, cfg({ liveEnabled: true }));
    expect(mp.capabilities).toEqual({ pdf: false });
    expect(mp.capabilities).not.toBe(e.capabilities);
    expect(mp).not.toHaveProperty("fixture");
    expect(mp.readiness).toBe("missing_auth");
    expect(toModelProfile(openai("q") as unknown as ProfileEntry, cfg())).not.toHaveProperty("capabilities");
  });
});

describe("registry", () => {
  it("caches per config object and refreshes after resetProfileCache", () => {
    const c = cfg();
    expect(profileEntries(c)).toBe(profileEntries(c));
    const first = profileEntries(c);
    resetProfileCache();
    expect(profileEntries(c)).not.toBe(first);
    // A different config object forces a reload even without a reset.
    expect(profileEntries(cfg())).not.toBe(profileEntries(c));
  });

  it("groups profiles by provider in a fixed order with labels and the adapter manifest", () => {
    const providers = buildProviders(cfg());
    expect(providers.map((p) => p.provider)).toEqual(["mock", "openai", "anthropic", "gemini"]);
    expect(providers.map((p) => p.label)).toEqual(["Deterministic mock", "OpenAI", "Anthropic", "Google Gemini"]);
    expect(providers.every((p) => p.adapter_manifest_version === "proofestra-local-v1-20261021")).toBe(true);
    expect(providers[0]!.profiles.length).toBeGreaterThanOrEqual(5);
    expect(providers[1]!.profiles.map((p) => p.profile_id)).toEqual(["openai-default"]);
  });

  it("an empty provider group is still listed (e.g. replace mode with mock only)", () => {
    const file = path.join(dir, "p.json");
    fs.writeFileSync(file, JSON.stringify({ mode: "replace", profiles: [mock("solo")] }));
    vi.stubEnv("PROOFESTRA_PROFILES_FILE", file);
    resetProfileCache();
    const providers = buildProviders(cfg());
    expect(providers.find((p) => p.provider === "openai")!.profiles).toEqual([]);
    expect(buildProfiles(cfg()).map((p) => p.profile_id)).toEqual(["solo"]);
  });

  it("reports only whether a profiles file is configured, never its path", () => {
    expect(catalogSource(cfg())).toEqual({ source: "built_in", file_configured: false });
    const file = path.join(dir, "p.json");
    fs.writeFileSync(file, JSON.stringify({ profiles: [openai("extra")] }));
    vi.stubEnv("PROOFESTRA_PROFILES_FILE", file);
    resetProfileCache();
    const src = catalogSource(cfg());
    expect(src).toEqual({ source: "file_append", file_configured: true });
    expect(JSON.stringify(src)).not.toContain(dir);
  });

  it("looks profiles up by id", () => {
    expect(profileById(cfg(), "mock-balanced")!.provider).toBe("mock");
    expect(profileById(cfg(), "nope")).toBeNull();
    expect(profileEntryById(cfg(), "mock-slow")!.fixture).toEqual({ extra_latency_ms: 400 });
    expect(profileEntryById(cfg(), "nope")).toBeNull();
  });

  it("catalogVersion is prefixed, stable, ignores labels and rotates on binding changes", () => {
    const base = catalogVersion(cfg());
    expect(base.startsWith(`${CATALOG_VERSION_PREFIX}-`)).toBe(true);
    expect(catalogVersion(cfg())).toBe(base);
    // Cosmetic: different key/liveEnabled do not rotate.
    expect(catalogVersion(cfg({ liveEnabled: true, providerCredentials: { openaiKey: "k", anthropicKey: null, googleKey: null } }))).toBe(base);
    // Behavioural: a different default model id rotates it.
    expect(catalogVersion(cfg({ providerDefaultModels: { openai: "other", anthropic: "claude-test", gemini: "gemini-test" } }))).not.toBe(base);
  });

  it("catalogVersion changes when a capability override changes but not when a label does", () => {
    const write = (profile: unknown) => {
      const file = path.join(dir, "v.json");
      fs.writeFileSync(file, JSON.stringify({ profiles: [profile] }));
      vi.stubEnv("PROOFESTRA_PROFILES_FILE", file);
      resetProfileCache();
      return catalogVersion(cfg());
    };
    const a = write(openai("v", { capabilities: { image: true } }));
    const b = write(openai("v", { capabilities: { image: false } }));
    const c = write(openai("v", { label: "Different label", capabilities: { image: true } }));
    expect(a).not.toBe(b);
    expect(c).toBe(a);
  });
});

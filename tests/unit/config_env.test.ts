// loadConfig environment parsing: defaults, trimming, flags, ports and the
// loopback-only extra-origins allow-list. Every env var the loader reads is
// stubbed per test (and restored) so ambient credentials never leak in.

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/shared/config.js";

const ENV_KEYS = [
  "PROOFESTRA_HOST",
  "PROOFESTRA_PORT",
  "PROOFESTRA_ORIGIN",
  "PROOFESTRA_DATA_DIR",
  "PROOFESTRA_EXTRA_ORIGINS",
  "PROOFESTRA_LIVE_ENABLED",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "OPENAI_MODEL",
  "ANTHROPIC_MODEL",
  "GEMINI_MODEL",
];

beforeEach(() => {
  for (const key of ENV_KEYS) vi.stubEnv(key, undefined as unknown as string);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadConfig defaults", () => {
  it("is loopback, mock-only and credential-free with no environment", () => {
    const cfg = loadConfig("/work/dir");
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(3000);
    expect(cfg.origin).toBe("http://127.0.0.1:3000");
    expect(cfg.extraOrigins).toEqual([]);
    expect(cfg.apiPrefix).toBe("/api/v1");
    expect(cfg.liveEnabled).toBe(false);
    expect(cfg.providerCredentials).toEqual({ openaiKey: null, anthropicKey: null, googleKey: null });
    expect(cfg.dataDir).toBe(path.resolve("/work/dir", "./data"));
    expect(cfg.providerDefaultModels.openai).toBeTruthy();
    expect(cfg.providerDefaultModels.anthropic).toBeTruthy();
    expect(cfg.providerDefaultModels.gemini).toBeTruthy();
  });

  it("derives the default origin from host and port", () => {
    vi.stubEnv("PROOFESTRA_HOST", "localhost");
    vi.stubEnv("PROOFESTRA_PORT", "4010");
    expect(loadConfig("/x").origin).toBe("http://localhost:4010");
  });

  it("keeps an absolute data dir and resolves a relative one against cwd", () => {
    vi.stubEnv("PROOFESTRA_DATA_DIR", "/abs/data");
    expect(loadConfig("/x").dataDir).toBe("/abs/data");
    vi.stubEnv("PROOFESTRA_DATA_DIR", "rel/data");
    expect(loadConfig("/x").dataDir).toBe(path.resolve("/x", "rel/data"));
  });

  it("trims whitespace and treats blank values as unset", () => {
    vi.stubEnv("PROOFESTRA_HOST", "   ");
    vi.stubEnv("PROOFESTRA_PORT", "  3123  ");
    vi.stubEnv("OPENAI_API_KEY", "   ");
    vi.stubEnv("ANTHROPIC_API_KEY", "  sk-ant-FAKE  ");
    const cfg = loadConfig("/x");
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(3123);
    expect(cfg.providerCredentials.openaiKey).toBeNull();
    expect(cfg.providerCredentials.anthropicKey).toBe("sk-ant-FAKE");
  });

  it("reads provider model overrides and keys from the environment", () => {
    vi.stubEnv("OPENAI_MODEL", "my-openai");
    vi.stubEnv("ANTHROPIC_MODEL", "my-claude");
    vi.stubEnv("GEMINI_MODEL", "my-gemini");
    vi.stubEnv("OPENAI_API_KEY", "sk-test-FAKE");
    vi.stubEnv("GOOGLE_API_KEY", "g-test-FAKE");
    const cfg = loadConfig("/x");
    expect(cfg.providerDefaultModels).toEqual({
      openai: "my-openai",
      anthropic: "my-claude",
      gemini: "my-gemini",
    });
    expect(cfg.providerCredentials.openaiKey).toBe("sk-test-FAKE");
    expect(cfg.providerCredentials.googleKey).toBe("g-test-FAKE");
  });
});

describe("PROOFESTRA_LIVE_ENABLED", () => {
  it.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["Yes", true],
    ["0", false],
    ["false", false],
    ["no", false],
    ["enabled", false],
    ["", false],
  ])("%j -> %s", (raw, expected) => {
    vi.stubEnv("PROOFESTRA_LIVE_ENABLED", raw);
    expect(loadConfig("/x").liveEnabled).toBe(expected);
  });
});

describe("PROOFESTRA_PORT validation", () => {
  it.each(["0", "-1", "65536", "abc", "3000.5", "1e3x", "NaN", "Infinity"])(
    "rejects %j",
    (raw) => {
      vi.stubEnv("PROOFESTRA_PORT", raw);
      expect(() => loadConfig("/x")).toThrow(/PROOFESTRA_PORT must be an integer/);
    },
  );

  it("rejects a fractional port even though it is finite and in range", () => {
    vi.stubEnv("PROOFESTRA_PORT", "3000.5");
    expect(() => loadConfig("/x")).toThrow(/integer/);
  });

  it.each([
    ["1", 1],
    ["65535", 65535],
    ["3000", 3000],
    ["3e3", 3000],
  ])("accepts %j", (raw, expected) => {
    vi.stubEnv("PROOFESTRA_PORT", raw);
    expect(loadConfig("/x").port).toBe(expected);
  });
});

describe("PROOFESTRA_EXTRA_ORIGINS", () => {
  it("parses a comma list, trims, drops blanks and normalizes to scheme://host:port", () => {
    vi.stubEnv(
      "PROOFESTRA_EXTRA_ORIGINS",
      " http://localhost:5173/some/path , ,http://127.0.0.1:5174, http://[::1]:5175 ",
    );
    expect(loadConfig("/x").extraOrigins).toEqual([
      "http://localhost:5173",
      "http://127.0.0.1:5174",
      "http://[::1]:5175",
    ]);
  });

  it("rejects a non-loopback origin", () => {
    vi.stubEnv("PROOFESTRA_EXTRA_ORIGINS", "http://evil.example:5173");
    expect(() => loadConfig("/x")).toThrow(/not loopback/);
  });

  it("rejects an entry that is not a URL", () => {
    vi.stubEnv("PROOFESTRA_EXTRA_ORIGINS", "localhost:5173,%%%");
    expect(() => loadConfig("/x")).toThrow(/not a valid origin/);
  });

  it("is empty when only separators are supplied", () => {
    vi.stubEnv("PROOFESTRA_EXTRA_ORIGINS", " , ,");
    expect(loadConfig("/x").extraOrigins).toEqual([]);
  });
});

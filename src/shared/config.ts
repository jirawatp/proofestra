// Runtime configuration resolved from environment variables.
// Default values are deliberately safe for a loopback personal install
// (see docs/decisions.md and docs/technical-design.md).

import path from "node:path";
import type { NativeVerificationRecord } from "./types.js";

export interface ProofestraConfig {
  host: string;
  port: number;
  origin: string;
  // Additional loopback origins accepted for Origin and Host checks. Only
  // populated when PROOFESTRA_EXTRA_ORIGINS is set in the environment (used
  // by the Vite dev server, which runs on 127.0.0.1:5173). All entries must
  // be loopback or `localhost`.
  extraOrigins: string[];
  apiPrefix: string;
  dataDir: string;
  liveEnabled: boolean;
  providerCredentials: {
    openaiKey: string | null;
    anthropicKey: string | null;
    googleKey: string | null;
  };
  providerDefaultModels: {
    openai: string;
    anthropic: string;
    gemini: string;
  };
  // Native (vendor CLI) backends. Optional so every pre-existing config
  // literal keeps meaning "disabled". These hold NO credential: the vendor
  // CLI owns its own login. `codexHome` is only a directory path the CLI
  // itself uses to find that login; Proofestra never opens it.
  nativeBackends?: {
    codex: {
      enabled: boolean;
      model: string | null;
      executable: string | null;
      codexHome: string | null;
      // Code-level injection point for tests and embedders only: `loadConfig`
      // never sets it, and no environment variable or profile file can.
      verification?: NativeVerificationRecord | undefined;
    };
  };
}

export interface CodexNativeSettings {
  enabled: boolean;
  model: string | null;
  executable: string | null;
  codexHome: string | null;
  verification?: NativeVerificationRecord | undefined;
}

export function codexSettings(config: Pick<ProofestraConfig, "nativeBackends">): CodexNativeSettings {
  return (
    config.nativeBackends?.codex ?? { enabled: false, model: null, executable: null, codexHome: null }
  );
}

/**
 * Stable runtime-policy version. Changes only when the runtime policy schema
 * or defaults change; stale UIs reject their next run with
 * `runtime_policy_changed` and reload.
 */
export const RUNTIME_POLICY_VERSION = "personal-v1-20261021";

/**
 * Base identifier prefix for the server profile catalog. The real published
 * catalog version is produced by `catalogVersion(config)` in
 * src/core/registry.ts, which hashes the resolved profile set so changing a
 * model id under the same profile_id rotates the version.
 */
export const CATALOG_VERSION_PREFIX = "catalog-v2-local-20261021";

function readEnv(name: string, fallback: string | undefined = undefined): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? fallback : trimmed;
}

function readNullable(name: string): string | null {
  const value = readEnv(name);
  return value === undefined ? null : value;
}

// An explicit executable/directory must be an absolute, normalized path (no
// relative lookup, no `$PATH` search, no `..`). Anything else is rejected at
// startup instead of being silently reinterpreted.
function readAbsolutePath(name: string): string | null {
  const value = readEnv(name);
  if (value === undefined) return null;
  if (!path.isAbsolute(value) || path.normalize(value) !== value || value.includes("\0")) {
    throw new Error(`${name} must be an absolute normalized path`);
  }
  return value;
}

function readFlag(name: string, fallback: boolean): boolean {
  const value = readEnv(name);
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost") return true;
  if (h === "127.0.0.1") return true;
  // URL.hostname keeps the brackets around an IPv6 literal.
  if (h === "::1" || h === "[::1]") return true;
  return false;
}

export function loadConfig(cwd: string = process.cwd()): ProofestraConfig {
  const host = readEnv("PROOFESTRA_HOST", "127.0.0.1")!;
  const port = Number(readEnv("PROOFESTRA_PORT", "3000"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PROOFESTRA_PORT must be an integer in [1,65535], got ${port}`);
  }
  const origin = readEnv("PROOFESTRA_ORIGIN", `http://${host}:${port}`)!;
  const dataDirRaw = readEnv("PROOFESTRA_DATA_DIR", "./data")!;
  const dataDir = path.isAbsolute(dataDirRaw) ? dataDirRaw : path.resolve(cwd, dataDirRaw);
  const extraOriginsRaw = readEnv("PROOFESTRA_EXTRA_ORIGINS", "") ?? "";
  const extraOrigins = extraOriginsRaw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      try {
        const url = new URL(entry);
        if (!isLoopback(url.hostname)) {
          throw new Error(`PROOFESTRA_EXTRA_ORIGINS entry ${entry} is not loopback`);
        }
        return `${url.protocol}//${url.host}`;
      } catch (err) {
        throw new Error(
          `PROOFESTRA_EXTRA_ORIGINS entry ${entry} is not a valid origin: ${(err as Error).message}`,
        );
      }
    });
  return {
    host,
    port,
    origin,
    extraOrigins,
    apiPrefix: "/api/v1",
    dataDir,
    liveEnabled: readFlag("PROOFESTRA_LIVE_ENABLED", false),
    providerCredentials: {
      openaiKey: readNullable("OPENAI_API_KEY"),
      anthropicKey: readNullable("ANTHROPIC_API_KEY"),
      googleKey: readNullable("GOOGLE_API_KEY"),
    },
    providerDefaultModels: {
      // Default model IDs are the vendor-published current IDs verified on
      // 2026-10-21 at:
      //   - https://developers.openai.com/api/docs/models/gpt-5.6-terra
      //   - https://platform.claude.com/docs/en/models/overview
      //   - https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash
      // The Gemini default is 3.8 Flash because the earlier `gemini-2.5-flash`
      // page notes that model is restricted to prior active users of
      // generativelanguage.googleapis.com. Operators can still override via
      // OPENAI_MODEL / ANTHROPIC_MODEL / GEMINI_MODEL env vars.
      openai: readEnv("OPENAI_MODEL", "gpt-5.6-terra")!,
      anthropic: readEnv("ANTHROPIC_MODEL", "claude-sonnet-5-5")!,
      gemini: readEnv("GEMINI_MODEL", "gemini-3.8-flash")!,
    },
    nativeBackends: {
      codex: {
        // Off unless the operator opts in. Even when on, execution stays
        // fail-closed until the tool surface is proven (src/core/nativeBackends.ts).
        enabled: readFlag("PROOFESTRA_CODEX_ENABLED", false),
        // No default model: a native job must run exactly the pinned model.
        model: readNullable("PROOFESTRA_CODEX_MODEL"),
        executable: readAbsolutePath("PROOFESTRA_CODEX_BIN"),
        codexHome: readAbsolutePath("PROOFESTRA_CODEX_HOME"),
      },
    },
  };
}

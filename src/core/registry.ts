// Server-configured provider/profile registry. All model IDs come from
// configuration; the browser never supplies raw IDs or credentials.

import { createHash } from "node:crypto";
import type { ProofestraConfig } from "../shared/config.js";
import type { ModelProfile, ProviderConfig, ProviderId } from "../shared/types.js";
import { CATALOG_VERSION_PREFIX } from "../shared/config.js";
import { stableStringify } from "../shared/ids.js";
import {
  loadProfileCatalog,
  readinessFor,
  toModelProfile,
  type ProfileEntry,
  type ResolvedCatalog,
} from "./profileConfig.js";

let cachedCatalog: ResolvedCatalog | null = null;
let cachedConfig: ProofestraConfig | null = null;

function resolve(config: ProofestraConfig): ResolvedCatalog {
  if (cachedConfig === config && cachedCatalog) return cachedCatalog;
  cachedCatalog = loadProfileCatalog(config);
  cachedConfig = config;
  return cachedCatalog;
}

export function resetProfileCache(): void {
  cachedCatalog = null;
  cachedConfig = null;
}

export function profileEntries(config: ProofestraConfig): ProfileEntry[] {
  return resolve(config).profiles;
}

// Reports only WHETHER a profiles file is configured: the path is a local
// filesystem detail that never leaves the server.
export function catalogSource(config: ProofestraConfig): {
  source: ResolvedCatalog["source"];
  file_configured: boolean;
} {
  const r = resolve(config);
  return { source: r.source, file_configured: r.file_path !== null };
}

export function buildProfiles(config: ProofestraConfig): ModelProfile[] {
  return profileEntries(config).map((entry) => toModelProfile(entry, config));
}

export function buildProviders(config: ProofestraConfig): ProviderConfig[] {
  const profiles = buildProfiles(config);
  const byProvider = new Map<ProviderId, ModelProfile[]>();
  for (const profile of profiles) {
    const existing = byProvider.get(profile.provider) ?? [];
    existing.push(profile);
    byProvider.set(profile.provider, existing);
  }
  const providers: ProviderConfig[] = [];
  for (const provider of ["mock", "openai", "anthropic", "gemini"] as ProviderId[]) {
    providers.push({
      provider,
      label: labelFor(provider),
      adapter_manifest_version: "proofestra-local-v1-20261021",
      profiles: byProvider.get(provider) ?? [],
    });
  }
  return providers;
}

export function profileById(config: ProofestraConfig, profileId: string): ModelProfile | null {
  const entry = profileEntries(config).find((p) => p.profile_id === profileId);
  if (!entry) return null;
  return toModelProfile(entry, config);
}

export function profileEntryById(
  config: ProofestraConfig,
  profileId: string,
): ProfileEntry | null {
  return profileEntries(config).find((p) => p.profile_id === profileId) ?? null;
}

export function readinessOfProfile(config: ProofestraConfig, profileId: string): string {
  const entry = profileEntryById(config, profileId);
  if (!entry) return "unsupported";
  return readinessFor(entry, config);
}

/**
 * Content-addressed catalog version. The hash covers only the profile fields
 * that affect behaviour (provider, api_shape, model_id, capacities, backend)
 * so cosmetic label changes do not rotate the version. Any binding change
 * (new model_id under the same profile_id, provider swap, capacity change)
 * produces a new version and invalidates stale UI pins via the
 * `expected_catalog_version` check at run creation.
 */
export function catalogVersion(config: ProofestraConfig): string {
  const profiles = profileEntries(config)
    .map((entry) => ({
      profile_id: entry.profile_id,
      provider: entry.provider,
      api_shape: entry.api_shape,
      model_id: entry.model_id,
      safe_input_tokens: entry.safe_input_tokens,
      max_output_tokens: entry.max_output_tokens,
      execution_backend_id: entry.execution_backend_id,
      // Per-profile native-attachment capability override is part of the
      // behavioural identity of this profile; a tightened image whitelist
      // or lower max_native_image_bytes changes what the UI shows for
      // coverage and what the dispatch sends. Rotate the catalog version
      // when it changes so stale UI pins are invalidated.
      capabilities: entry.capabilities ?? null,
    }))
    .sort((a, b) => a.profile_id.localeCompare(b.profile_id));
  const digest = createHash("sha256").update(stableStringify(profiles), "utf8").digest("hex");
  return `${CATALOG_VERSION_PREFIX}-${digest.slice(0, 12)}`;
}

function labelFor(provider: ProviderId): string {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "gemini":
      return "Google Gemini";
    default:
      return "Deterministic mock";
  }
}

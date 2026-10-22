// Builds the adapter table from runtime config. Mock mode always works; live
// adapters are only wired when PROOFESTRA_LIVE_ENABLED=1 and the matching
// credential is present.
//
// Native (vendor CLI) backends are a SEPARATE table keyed by backend id. They
// never share a slot with, or fall back to, the provider API adapters above.

import type { ProofestraConfig } from "../shared/config.js";
import type { ProviderAdapter } from "../providers/types.js";
import type { ProviderId } from "../shared/types.js";
import { MockAdapter } from "../providers/mock.js";
import { OpenAiAdapter } from "../providers/openai.js";
import { AnthropicAdapter } from "../providers/anthropic.js";
import { GeminiAdapter } from "../providers/gemini.js";
import { CodexCliAdapter, UnavailableNativeAdapter } from "../providers/codexCli.js";
import { ANTIGRAVITY_BACKEND_ID, CODEX_BACKEND_ID } from "./nativeBackends.js";

export interface AdapterTable {
  liveEnabled: boolean;
  adapters: Record<ProviderId, ProviderAdapter>;
  // Native backend adapters by reserved backend id. Optional so a hand-built
  // table (tests) simply has no native backends and native dispatch refuses.
  native?: Record<string, ProviderAdapter>;
}

export interface BuildAdapterOptions {
  fetchImpl?: typeof fetch | undefined;
  // Test seams for the native Codex adapter (home directory and scratch root).
  nativeHome?: string | undefined;
  nativeScratchRoot?: string | undefined;
}

export function buildAdapters(
  config: ProofestraConfig,
  options: BuildAdapterOptions = {},
): AdapterTable {
  const mock = new MockAdapter({ provider: "mock", config });
  const openaiLive = new OpenAiAdapter({
    apiKey: config.providerCredentials.openaiKey,
    fetchImpl: options.fetchImpl,
  });
  const anthropicLive = new AnthropicAdapter({
    apiKey: config.providerCredentials.anthropicKey,
    fetchImpl: options.fetchImpl,
  });
  const geminiLive = new GeminiAdapter({
    apiKey: config.providerCredentials.googleKey,
    fetchImpl: options.fetchImpl,
  });
  const openaiMock = new MockAdapter({ provider: "openai", config });
  const anthropicMock = new MockAdapter({ provider: "anthropic", config });
  const geminiMock = new MockAdapter({ provider: "gemini", config });

  const live = config.liveEnabled;
  return {
    liveEnabled: live,
    adapters: {
      mock,
      openai: live && config.providerCredentials.openaiKey ? openaiLive : openaiMock,
      anthropic: live && config.providerCredentials.anthropicKey ? anthropicLive : anthropicMock,
      gemini: live && config.providerCredentials.googleKey ? geminiLive : geminiMock,
    },
    native: {
      [CODEX_BACKEND_ID]: new CodexCliAdapter({
        config,
        home: options.nativeHome,
        scratchRoot: options.nativeScratchRoot,
      }),
      // Antigravity is unverified/disabled: this adapter can only refuse.
      [ANTIGRAVITY_BACKEND_ID]: new UnavailableNativeAdapter("gemini", ANTIGRAVITY_BACKEND_ID),
    },
  };
}

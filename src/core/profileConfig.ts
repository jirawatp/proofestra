// Validated server-side profile catalog. Built-in seeds are augmented or
// replaced by an optional JSON file pointed to by PROOFESTRA_PROFILES_FILE.
//
// Each profile pins its provider, model id, safe input capacity, max output
// per call, API shape, and execution backend id. The browser never supplies
// raw profile ids or credentials; the server-side catalog is the source of
// truth and is loaded once at process start (no provider calls occur here).

import fs from "node:fs";
import { z } from "zod";
import { codexSettings, type ProofestraConfig } from "../shared/config.js";
import type { ModelProfile, ProviderId, Readiness } from "../shared/types.js";
import {
  CODEX_BACKEND_ID,
  NATIVE_SHAPE_BACKEND,
  isNativeApiShape,
  isNativeBackendId,
  isSafeModelId,
  nativeReadinessFor,
} from "./nativeBackends.js";

export type ApiShape =
  | "mock"
  | "openai_chat_completions"
  | "anthropic_messages_v1"
  | "gemini_generate_content"
  | "codex_exec_cli"
  | "antigravity_cli";

export interface ProfileEntry {
  profile_id: string;
  provider: ProviderId;
  label: string;
  model_id: string | null;
  safe_input_tokens: number;
  max_output_tokens: number;
  api_shape: ApiShape;
  execution_backend_id: string;
  // Optional per-profile native-attachment capability override; see
  // the matching comment on `ModelProfile.capabilities`.
  capabilities?: {
    image?: boolean;
    image_mime_whitelist?: string[];
    pdf?: boolean;
    audio?: boolean;
    video?: boolean;
    max_native_image_bytes?: number;
    max_native_aggregate_bytes?: number;
    max_native_inline_media_bytes?: number;
    max_native_audio_seconds?: number;
    max_native_video_seconds?: number;
    max_native_media_aggregate_seconds?: number;
    max_native_media_aggregate_bytes?: number;
    max_native_pdf_pages?: number;
    audio_codec_whitelist?: string[];
    video_codec_whitelist?: string[];
  };
  // Optional deterministic fixture controls applied only to mock profiles.
  fixture?: {
    scenario?:
      | "normal"
      | "fail"
      | "timeout"
      | "safety_block"
      | "empty"
      | "unknown_usage"
      | "late_success"
      | "never_settle";
    extra_latency_ms?: number;
  };
}

// Allowed api shapes per provider. A native CLI shape is a DIFFERENT backend
// from the provider's metered API: it is only valid when bound to its own
// reserved backend id (enforced in `superRefine` below).
const ALLOWED_API_SHAPES: Record<"openai" | "anthropic" | "gemini" | "mock", string[]> = {
  openai: ["openai_chat_completions", "codex_exec_cli"],
  anthropic: ["anthropic_messages_v1"],
  gemini: ["gemini_generate_content", "antigravity_cli"],
  mock: ["mock"],
};

const ProfileSchema = z
  .object({
    profile_id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_-]{0,63}$/),
    provider: z.enum(["openai", "anthropic", "gemini", "mock"]),
    label: z.string().min(1).max(200),
    model_id: z.string().min(1).max(200).nullable(),
    safe_input_tokens: z.number().int().min(1_000).max(2_000_000),
    max_output_tokens: z.number().int().min(32).max(32_768),
    api_shape: z.enum([
      "mock",
      "openai_chat_completions",
      "anthropic_messages_v1",
      "gemini_generate_content",
      "codex_exec_cli",
      "antigravity_cli",
    ]),
    execution_backend_id: z.string().min(1).max(120),
    // Optional per-profile native-attachment capability override. All
    // fields optional; omitted fields fall through to
    // `defaultProviderCapabilities(provider)`. A profile can be MORE
    // conservative than the provider default (e.g. "this text-only
    // variant does not accept images") but never silently more
    // permissive; `effectiveCapabilitiesFor` CLAMPS against the
    // provider's documented inline media caps at admission.
    capabilities: z
      .object({
        image: z.boolean().optional(),
        image_mime_whitelist: z.array(z.string().min(1).max(100)).max(16).optional(),
        pdf: z.boolean().optional(),
        audio: z.boolean().optional(),
        video: z.boolean().optional(),
        max_native_image_bytes: z.number().int().min(0).max(50 * 1024 * 1024).optional(),
        max_native_aggregate_bytes: z.number().int().min(0).max(100 * 1024 * 1024).optional(),
        max_native_inline_media_bytes: z.number().int().min(0).max(100 * 1024 * 1024).optional(),
        max_native_audio_seconds: z.number().int().min(0).max(24 * 3600).optional(),
        max_native_video_seconds: z.number().int().min(0).max(24 * 3600).optional(),
        max_native_media_aggregate_seconds: z.number().int().min(0).max(24 * 3600).optional(),
        max_native_media_aggregate_bytes: z.number().int().min(0).max(100 * 1024 * 1024).optional(),
        max_native_pdf_pages: z.number().int().min(0).max(1000).optional(),
        audio_codec_whitelist: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,32}$/)).max(32).optional(),
        video_codec_whitelist: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,32}$/)).max(32).optional(),
      })
      .optional(),
    fixture: z
      .object({
        scenario: z
          .enum([
            "normal",
            "fail",
            "timeout",
            "safety_block",
            "empty",
            "unknown_usage",
            "late_success",
            "never_settle",
            // Returns a non-empty text answer AND a truncation finding, as
            // if the upstream model stopped on `length`/`max_tokens`.
            "truncated",
          ])
          .optional(),
        extra_latency_ms: z.number().int().min(0).max(60_000).optional(),
        // Scope the scenario to a single stage (draft / review / synthesis).
        // When omitted, the scenario applies to every stage, with one legacy
        // exception: `scenario: "fail"` without `only_on_stage` falls back to
        // review-only behaviour so the built-in `mock-fail-review` profile
        // keeps its documented semantics.
        only_on_stage: z.enum(["draft", "review", "synthesis"]).optional(),
      })
      .optional(),
  })
  .superRefine((profile, ctx) => {
    const allowed = ALLOWED_API_SHAPES[profile.provider];
    if (!allowed.includes(profile.api_shape)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `provider ${profile.provider} requires api_shape=${allowed.join(" or ")}; got ${profile.api_shape}`,
        path: ["api_shape"],
      });
    }
    // Native backend identity is reserved and exclusive: a native shape must
    // use its own backend id, and no other shape may claim a native id. This
    // is what stops a profile from silently swapping a subscription CLI for
    // the metered API (or the reverse) by relabeling.
    if (isNativeApiShape(profile.api_shape)) {
      if (profile.execution_backend_id !== NATIVE_SHAPE_BACKEND[profile.api_shape]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `api_shape=${profile.api_shape} requires execution_backend_id=${NATIVE_SHAPE_BACKEND[profile.api_shape]}`,
          path: ["execution_backend_id"],
        });
      }
    } else if (isNativeBackendId(profile.execution_backend_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `execution_backend_id=${profile.execution_backend_id} is reserved for its native api_shape`,
        path: ["execution_backend_id"],
      });
    }
    if (profile.provider !== "mock" && profile.model_id == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `live provider ${profile.provider} requires a non-null model_id`,
        path: ["model_id"],
      });
    }
  });

const FileSchema = z.object({
  mode: z.enum(["replace", "append"]).default("append"),
  profiles: z.array(ProfileSchema).min(1).max(64),
});

const BUILT_IN_SEEDS: ProfileEntry[] = [
  {
    profile_id: "mock-balanced",
    provider: "mock",
    label: "Mock balanced (deterministic)",
    model_id: "mock-balanced-v1",
    safe_input_tokens: 32_000,
    max_output_tokens: 2048,
    api_shape: "mock",
    execution_backend_id: "mock-provider-api",
  },
  {
    profile_id: "mock-analytical",
    provider: "mock",
    label: "Mock analytical (deterministic)",
    model_id: "mock-analytical-v1",
    safe_input_tokens: 32_000,
    max_output_tokens: 2048,
    api_shape: "mock",
    execution_backend_id: "mock-provider-api",
  },
  {
    profile_id: "mock-concise",
    provider: "mock",
    label: "Mock concise (deterministic)",
    model_id: "mock-concise-v1",
    safe_input_tokens: 32_000,
    max_output_tokens: 2048,
    api_shape: "mock",
    execution_backend_id: "mock-provider-api",
  },
  {
    // Only fails at the REVIEW stage; drafts and synthesis still succeed so
    // the coordinator exercises partial-handling without the agent silently
    // failing every call. See MockAdapter.resolveScenario.
    profile_id: "mock-fail-review",
    provider: "mock",
    label: "Mock — review stage fails (drafts/synth succeed) (fixture)",
    model_id: "mock-fail-review-v1",
    safe_input_tokens: 32_000,
    max_output_tokens: 2048,
    api_shape: "mock",
    execution_backend_id: "mock-provider-api",
    fixture: { scenario: "fail" },
  },
  {
    profile_id: "mock-slow",
    provider: "mock",
    label: "Mock — 400ms per call (fixture for cancel)",
    model_id: "mock-slow-v1",
    safe_input_tokens: 32_000,
    max_output_tokens: 2048,
    api_shape: "mock",
    execution_backend_id: "mock-provider-api",
    fixture: { extra_latency_ms: 400 },
  },
];

const PROVIDER_SEED_TEMPLATES: Record<
  "openai" | "anthropic" | "gemini",
  Omit<ProfileEntry, "profile_id" | "model_id" | "label"> & {
    label: string;
  }
> = {
  openai: {
    provider: "openai",
    label: "OpenAI (configured server-side)",
    safe_input_tokens: 128_000,
    max_output_tokens: 2048,
    api_shape: "openai_chat_completions",
    execution_backend_id: "openai-chat-completions",
  },
  anthropic: {
    provider: "anthropic",
    label: "Anthropic (configured server-side)",
    safe_input_tokens: 180_000,
    max_output_tokens: 2048,
    api_shape: "anthropic_messages_v1",
    execution_backend_id: "anthropic-messages-v1",
  },
  gemini: {
    provider: "gemini",
    label: "Google Gemini (configured server-side)",
    safe_input_tokens: 128_000,
    max_output_tokens: 2048,
    api_shape: "gemini_generate_content",
    execution_backend_id: "gemini-generate-content",
  },
};

function envDefaultProfiles(config: ProofestraConfig): ProfileEntry[] {
  const envProfiles: ProfileEntry[] = [];
  const openai = config.providerDefaultModels.openai;
  if (openai) {
    envProfiles.push({
      ...PROVIDER_SEED_TEMPLATES.openai,
      profile_id: "openai-default",
      label: `OpenAI default · ${openai}`,
      model_id: openai,
    });
  }
  const anthropic = config.providerDefaultModels.anthropic;
  if (anthropic) {
    envProfiles.push({
      ...PROVIDER_SEED_TEMPLATES.anthropic,
      profile_id: "anthropic-default",
      label: `Anthropic default · ${anthropic}`,
      model_id: anthropic,
    });
  }
  const gemini = config.providerDefaultModels.gemini;
  if (gemini) {
    envProfiles.push({
      ...PROVIDER_SEED_TEMPLATES.gemini,
      profile_id: "gemini-default",
      label: `Gemini default · ${gemini}`,
      model_id: gemini,
    });
  }
  // Native Codex profile. Listed only when the operator opted in AND pinned a
  // model; it is a separate backend from the OpenAI API profile above and its
  // readiness stays non-"configured" until the tool surface is proven.
  const codex = codexSettings(config);
  if (codex.enabled && isSafeModelId(codex.model)) {
    envProfiles.push({
      profile_id: "codex-local-default",
      provider: "openai",
      label: `ChatGPT Codex local CLI (subscription) · ${codex.model}`,
      model_id: codex.model,
      // Conservative capacity: the CLI's real window is not verified here.
      safe_input_tokens: 64_000,
      max_output_tokens: 2048,
      api_shape: "codex_exec_cli",
      execution_backend_id: CODEX_BACKEND_ID,
    });
  }
  return envProfiles;
}

export class ProfileCatalogError extends Error {
  constructor(message: string, public readonly path: string | null) {
    super(message);
    this.name = "ProfileCatalogError";
  }
}

export interface ResolvedCatalog {
  profiles: ProfileEntry[];
  source: "built_in" | "file_replace" | "file_append";
  file_path: string | null;
}

export function loadProfileCatalog(
  config: ProofestraConfig,
  overrides?: { fileContents?: string; filePath?: string },
): ResolvedCatalog {
  const combinedBuiltIn: ProfileEntry[] = [...BUILT_IN_SEEDS, ...envDefaultProfiles(config)];
  // Validate the built-in + env-derived seeds through the same strict schema
  // so provider/api_shape and null-model_id invariants also apply to the
  // bundled defaults; this guards against drift inside the source tree.
  const builtInValidated = z.array(ProfileSchema).safeParse(combinedBuiltIn);
  if (!builtInValidated.success) {
    throw new ProfileCatalogError(
      `built-in profile seeds failed validation: ${builtInValidated.error.issues[0]!.message}`,
      null,
    );
  }
  const builtIn: ProfileEntry[] = builtInValidated.data as ProfileEntry[];
  const path = overrides?.filePath ?? process.env.PROOFESTRA_PROFILES_FILE ?? null;
  let fileText: string | null = overrides?.fileContents ?? null;
  if (!fileText && path) {
    try {
      fileText = fs.readFileSync(path, "utf8");
    } catch (err) {
      throw new ProfileCatalogError(
        `cannot read PROOFESTRA_PROFILES_FILE: ${(err as Error).message}`,
        path,
      );
    }
  }
  if (!fileText) {
    const deduped = dedupeByProfileId(builtIn, "built-in");
    return { profiles: deduped, source: "built_in", file_path: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileText);
  } catch (err) {
    throw new ProfileCatalogError(`profile file is not valid JSON: ${(err as Error).message}`, path);
  }
  const file = FileSchema.safeParse(parsed);
  if (!file.success) {
    throw new ProfileCatalogError(
      `profile file validation failed: ${file.error.issues[0]!.message}`,
      path,
    );
  }
  const additions = file.data.profiles as ProfileEntry[];
  const originLabel = path ?? "profile file";
  if (file.data.mode === "replace") {
    const deduped = dedupeByProfileId(additions, originLabel);
    assertAtLeastOneUsableMock(deduped, path);
    return { profiles: deduped, source: "file_replace", file_path: path };
  }
  const combined = [...builtIn, ...additions];
  const deduped = dedupeByProfileId(combined, originLabel);
  return { profiles: deduped, source: "file_append", file_path: path };
}

function dedupeByProfileId(entries: ProfileEntry[], originLabel: string): ProfileEntry[] {
  const seen = new Map<string, ProfileEntry>();
  for (const entry of entries) {
    if (seen.has(entry.profile_id)) {
      throw new ProfileCatalogError(
        `duplicate profile_id "${entry.profile_id}" in ${originLabel}`,
        null,
      );
    }
    seen.set(entry.profile_id, entry);
  }
  return [...seen.values()];
}

function assertAtLeastOneUsableMock(entries: ProfileEntry[], path: string | null): void {
  if (!entries.some((e) => e.provider === "mock")) {
    throw new ProfileCatalogError(
      `profile file must include at least one mock profile so the server has an offline default`,
      path,
    );
  }
}

export function readinessFor(
  entry: ProfileEntry,
  config: ProofestraConfig,
): Readiness {
  if (entry.provider === "mock") return "configured";
  if (isNativeApiShape(entry.api_shape)) return nativeReadinessFor(entry.api_shape, config);
  if (!config.liveEnabled) return "disabled";
  switch (entry.provider) {
    case "openai":
      return config.providerCredentials.openaiKey ? "configured" : "missing_auth";
    case "anthropic":
      return config.providerCredentials.anthropicKey ? "configured" : "missing_auth";
    case "gemini":
      return config.providerCredentials.googleKey ? "configured" : "missing_auth";
    default:
      return "unsupported";
  }
}

export function toModelProfile(
  entry: ProfileEntry,
  config: ProofestraConfig,
): ModelProfile {
  const out: ModelProfile = {
    profile_id: entry.profile_id,
    provider: entry.provider,
    label: entry.label,
    model_id: entry.model_id,
    safe_input_tokens: entry.safe_input_tokens,
    max_output_tokens: entry.max_output_tokens,
    api_shape: entry.api_shape,
    readiness: readinessFor(entry, config),
    execution_backend_id: entry.execution_backend_id,
  };
  if (entry.capabilities) out.capabilities = { ...entry.capabilities };
  if (isNativeApiShape(entry.api_shape)) {
    // A native CLI job is text-only: native image/PDF/audio/video routing is
    // forced off regardless of what a profile file claims, so attachments
    // fall back to extracted text or an attachment-only note.
    out.capabilities = { ...out.capabilities, image: false, pdf: false, audio: false, video: false };
  }
  return out;
}

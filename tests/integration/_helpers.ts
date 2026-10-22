// Shared fastify-inject helpers for integration tests. Builds a fresh app
// against an in-memory SQLite file in `os.tmpdir()` with an optional
// `PROOFESTRA_PROFILES_FILE` override. Handles the GET /session cookie +
// X-CSRF-Token dance so individual tests can POST runs without boilerplate.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildApp, type AppBundle, type BuildAppOptions } from "../../src/server/app.js";
import { loadConfig, type ProofestraConfig } from "../../src/shared/config.js";
import { resetProfileCache } from "../../src/core/registry.js";

export interface TestAppOptions {
  profilesJson?: unknown;
  liveEnabled?: boolean;
  env?: Record<string, string | undefined>;
  // Extra `buildApp` seams (e.g. an injected attachment extractor).
  buildOptions?: Pick<BuildAppOptions, "extractAttachmentImpl" | "fetchImpl">;
}

export interface TestApp {
  app: AppBundle["app"];
  bundle: AppBundle;
  config: ProofestraConfig;
  sessionCookie: string;
  csrf: string;
  origin: string;
  cleanup: () => Promise<void>;
}

export async function makeTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "proofestra-test-"));
  const dataDir = path.join(workDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  const envBackup: Record<string, string | undefined> = {};
  const envOverrides: Record<string, string | undefined> = {
    PROOFESTRA_DATA_DIR: dataDir,
    PROOFESTRA_HOST: "127.0.0.1",
    PROOFESTRA_PORT: "3000",
    PROOFESTRA_ORIGIN: "http://127.0.0.1:3000",
    PROOFESTRA_LIVE_ENABLED: options.liveEnabled ? "1" : "0",
    PROOFESTRA_MOCK_LATENCY_MS: process.env.PROOFESTRA_MOCK_LATENCY_MS ?? "20",
    ...(options.env ?? {}),
  };
  if (options.profilesJson !== undefined) {
    const profilesPath = path.join(workDir, "profiles.json");
    fs.writeFileSync(profilesPath, JSON.stringify(options.profilesJson, null, 2));
    envOverrides.PROOFESTRA_PROFILES_FILE = profilesPath;
  }
  for (const [k, v] of Object.entries(envOverrides)) {
    envBackup[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  resetProfileCache();
  const config = loadConfig(workDir);
  const bundle = await buildApp({
    config,
    dbPath: path.join(dataDir, "proofestra.sqlite"),
    logger: false,
    ...(options.buildOptions ?? {}),
  });
  await bundle.app.ready();

  const sessionResp = await bundle.app.inject({
    method: "GET",
    url: "/api/v1/session",
    headers: {
      host: `127.0.0.1:${config.port}`,
    },
  });
  if (sessionResp.statusCode !== 200) {
    throw new Error(`session bootstrap failed: ${sessionResp.statusCode} ${sessionResp.payload}`);
  }
  const setCookie = sessionResp.headers["set-cookie"];
  const cookieRaw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!cookieRaw) throw new Error("session cookie missing");
  const sessionCookie = cookieRaw.split(";")[0]!;
  const csrf = (sessionResp.json() as { csrf_token: string }).csrf_token;

  return {
    app: bundle.app,
    bundle,
    config,
    sessionCookie,
    csrf,
    origin: config.origin,
    cleanup: async () => {
      await bundle.close();
      for (const [k, v] of Object.entries(envBackup)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      resetProfileCache();
    },
  };
}

export function authHeaders(ctx: TestApp): Record<string, string> {
  return {
    host: `127.0.0.1:${ctx.config.port}`,
    cookie: ctx.sessionCookie,
    origin: ctx.origin,
    "x-csrf-token": ctx.csrf,
    "content-type": "application/json",
  };
}

export function newKey(): string {
  return randomUUID();
}

// Process entry point (src/server/index.ts). main() runs on import, so each
// test mocks the app factory and config loader, stubs process.on/exit and the
// console, then imports a fresh copy of the module. No listener is bound.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProofestraConfig } from "../../src/shared/config.js";

function config(over: Partial<ProofestraConfig> = {}): ProofestraConfig {
  return {
    host: "127.0.0.1",
    port: 4321,
    origin: "http://127.0.0.1:4321",
    extraOrigins: [],
    apiPrefix: "/api/v1",
    dataDir: "/tmp/proofestra-never-opened",
    liveEnabled: false,
    providerCredentials: { openaiKey: null, anthropicKey: null, googleKey: null },
    providerDefaultModels: { openai: "o", anthropic: "a", gemini: "g" },
    ...over,
  };
}

let handlers: Record<string, () => void>;
let exitSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  handlers = {};
  vi.resetModules();
  vi.spyOn(process, "on").mockImplementation(((event: string, fn: () => void) => {
    if (event === "SIGINT" || event === "SIGTERM") handlers[event] = fn;
    return process;
  }) as never);
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.doUnmock("../../src/server/app.js");
  vi.doUnmock("../../src/shared/config.js");
  vi.restoreAllMocks();
  vi.resetModules();
});

function mockModules(cfg: ProofestraConfig, closeImpl: () => Promise<void> = async () => undefined) {
  const listen = vi.fn(async () => `http://${cfg.host}:${cfg.port}`);
  const close = vi.fn(closeImpl);
  const buildApp = vi.fn(async () => ({ app: { listen }, close }));
  vi.doMock("../../src/server/app.js", () => ({ buildApp }));
  vi.doMock("../../src/shared/config.js", () => ({ loadConfig: () => cfg }));
  return { listen, close, buildApp };
}

const logged = () => logSpy.mock.calls.map((c: unknown[]) => String(c[0]));

describe("server entry point", () => {
  it("builds the app with the loaded config, listens on host:port and logs the startup summary (live disabled)", async () => {
    const cfg = config();
    const { listen, buildApp } = mockModules(cfg);
    await import("../../src/server/index.js");
    await vi.waitFor(() => expect(handlers.SIGTERM).toBeTypeOf("function"));
    expect(buildApp).toHaveBeenCalledWith({ config: cfg, logger: true });
    expect(listen).toHaveBeenCalledWith({ host: "127.0.0.1", port: 4321 });
    const lines = logged();
    expect(lines).toContain("[proofestra] listening on http://127.0.0.1:4321");
    expect(lines).toContain("[proofestra] origin http://127.0.0.1:4321");
    expect(lines).toContain("[proofestra] data directory /tmp/proofestra-never-opened");
    expect(lines).toContain("[proofestra] live mode disabled (mock-only)");
    expect(lines.some((l: string) => l.includes("extra origins"))).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("logs extra origins and the live-enabled mode", async () => {
    mockModules(config({ liveEnabled: true, extraOrigins: ["http://localhost:5173", "http://127.0.0.1:5174"] }));
    await import("../../src/server/index.js");
    await vi.waitFor(() => expect(handlers.SIGINT).toBeTypeOf("function"));
    const lines = logged();
    expect(lines).toContain("[proofestra] extra origins allowed: http://localhost:5173, http://127.0.0.1:5174");
    expect(lines).toContain("[proofestra] live mode enabled (opt-in per request)");
  });

  it.each(["SIGINT", "SIGTERM"] as const)("%s closes the app, then exits 0", async (signal) => {
    const order: string[] = [];
    const { close } = mockModules(config(), async () => {
      order.push("close");
    });
    exitSpy.mockImplementation((() => {
      order.push("exit");
    }) as never);
    await import("../../src/server/index.js");
    await vi.waitFor(() => expect(handlers[signal]).toBeTypeOf("function"));
    handlers[signal]!();
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    expect(close).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["close", "exit"]);
    expect(logged()).toContain(`[proofestra] received ${signal}; closing`);
  });

  it("still exits 0 (and reports the error) when close() rejects, with no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    // addListener is not stubbed (only process.on is), so this is a real hook.
    process.addListener("unhandledRejection", onUnhandled);
    try {
      const { close } = mockModules(config(), async () => {
        throw new Error("db busy");
      });
      await import("../../src/server/index.js");
      await vi.waitFor(() => expect(handlers.SIGINT).toBeTypeOf("function"));
      handlers.SIGINT!();
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
      await new Promise((r) => setTimeout(r, 30));
      expect(close).toHaveBeenCalled();
      expect(errorSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes("error while closing"))).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  it("exits 1 and logs when the app fails to start (listen error)", async () => {
    const { listen } = mockModules(config());
    listen.mockRejectedValueOnce(new Error("EADDRINUSE"));
    await import("../../src/server/index.js");
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
    expect(errorSpy).toHaveBeenCalledWith("[proofestra] failed to start", expect.objectContaining({ message: "EADDRINUSE" }));
    expect(handlers.SIGINT).toBeUndefined();
  });

  it("exits 1 when configuration is invalid (loadConfig throws)", async () => {
    vi.doMock("../../src/server/app.js", () => ({ buildApp: vi.fn() }));
    vi.doMock("../../src/shared/config.js", () => ({
      loadConfig: () => {
        throw new Error("PROOFESTRA_PORT must be an integer in [1,65535], got 3000.5");
      },
    }));
    await import("../../src/server/index.js");
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
    expect(String((errorSpy.mock.calls[0]![1] as Error).message)).toContain("PROOFESTRA_PORT");
  });
});

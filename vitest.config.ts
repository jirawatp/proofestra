import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    reporters: ["default"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [],
      // Subprocess/worker coverage collection stays OFF. Vitest's auto-attach
      // injects NODE_V8_COVERAGE even into env:{} / fixed-env children, and the
      // security contract test correctly rejects that, so code that only runs
      // inside a child process or native worker thread is not collected.
      // Direct calls from tests into the same source in the parent process (for
      // example the synchronous Office/ZIP extractors and the worker entry
      // dispatch with a faked parentPort) ARE instrumented and counted; they
      // are not child-worker coverage, and the real Worker tests still run.
      autoAttachSubprocess: false,
      reportOnFailure: true,
      reporter: ["text", "json-summary", "json", "lcov", "html"],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
        autoUpdate: false,
      },
    },
    // Deterministic mock latency during tests so cancel/partial scenarios
    // behave the same locally and in CI.
    env: {
      PROOFESTRA_MOCK_LATENCY_MS: "20",
    },
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});

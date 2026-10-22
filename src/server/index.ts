// Server entry point. `npm run dev:server` launches this with tsx; `npm start`
// runs the compiled copy from dist/server/server/index.js.

import { buildApp } from "./app.js";
import { loadConfig } from "../shared/config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, close } = await buildApp({ config, logger: true });
  const address = await app.listen({ host: config.host, port: config.port });
  console.log(`[proofestra] listening on ${address}`);
  console.log(`[proofestra] origin ${config.origin}`);
  if (config.extraOrigins.length > 0) {
    console.log(`[proofestra] extra origins allowed: ${config.extraOrigins.join(", ")}`);
  }
  console.log(`[proofestra] data directory ${config.dataDir}`);
  console.log(
    `[proofestra] live mode ${config.liveEnabled ? "enabled (opt-in per request)" : "disabled (mock-only)"}`,
  );

  const shutdown = async (signal: string) => {
    console.log(`[proofestra] received ${signal}; closing`);
    try {
      await close();
    } catch (err) {
      // Still exit; just do not leave an unhandled rejection behind.
      console.error("[proofestra] error while closing", err);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[proofestra] failed to start", err);
  process.exit(1);
});

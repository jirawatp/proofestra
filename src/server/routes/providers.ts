import type { FastifyInstance } from "fastify";
import type { RouteDeps } from "./index.js";
import { describeBinaryToolCapabilities } from "../../core/parsers/binaryTools.js";
import { buildProviders, catalogSource, catalogVersion } from "../../core/registry.js";
import { describeNativeBackends } from "../../core/nativeBackends.js";

export function registerProvidersRoute(app: FastifyInstance, deps: RouteDeps): void {
  app.get("/api/v1/providers", async () => {
    const items = buildProviders(deps.config);
    return {
      live_enabled: deps.config.liveEnabled,
      // Booleans only: whether bounded local parsers exist. No path, version
      // or environment value ever leaves the server.
      capabilities: describeBinaryToolCapabilities(),
      // Sanitized native (CLI) backend states: fixed codes and booleans only.
      // No path, version, login state or vendor text; the vendor owns login.
      native_backends: describeNativeBackends(deps.config),
      catalog_version: catalogVersion(deps.config),
      catalog_source: catalogSource(deps.config),
      items,
      next_cursor: null,
    };
  });
}

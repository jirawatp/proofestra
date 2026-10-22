import type { FastifyInstance } from "fastify";
import type { RouteDeps } from "./index.js";
import { runtimePolicy } from "../../core/limits.js";

export function registerRuntimePolicyRoute(app: FastifyInstance, deps: RouteDeps): void {
  app.get("/api/v1/runtime-policy", async () => {
    return runtimePolicy({ liveEnabled: deps.config.liveEnabled });
  });
}

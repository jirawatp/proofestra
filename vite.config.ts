import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const SERVER_PORT = Number(process.env.PROOFESTRA_PORT ?? 3000);
const DEV_HOST = (process.env.PROOFESTRA_DEV_HOST ?? "127.0.0.1").toLowerCase();
const DEV_PORT = Number(process.env.PROOFESTRA_DEV_PORT ?? 5173);

// Loopback-only guard: never surface the dev server on a non-loopback host.
if (!(DEV_HOST === "127.0.0.1" || DEV_HOST === "localhost" || DEV_HOST === "::1")) {
  throw new Error(
    `PROOFESTRA_DEV_HOST must be a loopback hostname (127.0.0.1, localhost, ::1); got ${DEV_HOST}`,
  );
}

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
      "@web": path.resolve(__dirname, "src/web"),
    },
  },
  server: {
    port: DEV_PORT,
    strictPort: true,
    host: DEV_HOST,
    cors: false,
    // Deny Host headers other than loopback (defense against DNS rebinding).
    allowedHosts: ["127.0.0.1", "localhost"],
    // Keep the fs root at the project to prevent arbitrary file reads from the
    // dev server.
    fs: {
      strict: true,
      allow: [path.resolve(__dirname)],
    },
    // Explicit dev proxy configuration:
    // - Rewrite Host so the API server's Host-header allowlist accepts the
    //   proxied request (`changeOrigin: true`).
    // - Rewrite Origin so the API server's CSRF/Origin check accepts it from
    //   the dev page's actual origin. The browser always sends Origin as the
    //   dev page origin; we overwrite it to match the API's canonical origin.
    //   The API server additionally enforces loopback-only Host.
    proxy: {
      "^/api/": {
        target: `http://127.0.0.1:${SERVER_PORT}`,
        changeOrigin: true,
        headers: {
          origin: `http://127.0.0.1:${SERVER_PORT}`,
        },
      },
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist/public"),
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
    assetsInlineLimit: 0,
  },
});

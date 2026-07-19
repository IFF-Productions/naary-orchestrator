import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev server proxies /api → NestJS control plane (apps/api) so the browser
// avoids CORS during local development. Production wiring is env-driven.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // @naary/dsl ships CommonJS (dist), which leaks `exports` into the browser
      // bundle (runtime "exports is not defined"). It's pure/platform-agnostic, so
      // bundle it from TS SOURCE as ESM instead — no CJS interop needed. (Types
      // still resolve via the package's dist .d.ts for tsc.)
      // The zod registry layer (deliberately NOT re-exported from the dsl index;
      // the Node catalog screen derives node metadata from it). Must be listed
      // BEFORE the bare "@naary/dsl" alias — that one is a prefix match and
      // would otherwise mangle this subpath into ".../index.ts/dist/registry".
      "@naary/dsl/dist/registry": fileURLToPath(
        new URL("../../packages/dsl/src/registry.ts", import.meta.url),
      ),
      "@naary/dsl": fileURLToPath(
        new URL("../../packages/dsl/src/index.ts", import.meta.url),
      ),
      // Same reason as @naary/dsl — pure/platform-agnostic, bundled from source as ESM.
      // (Keep in sync with .storybook/main.ts.)
      "@naary/notifications": fileURLToPath(
        new URL("../../packages/notifications/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});

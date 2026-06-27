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
      "@naary/dsl": fileURLToPath(
        new URL("../../packages/dsl/src/index.ts", import.meta.url),
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

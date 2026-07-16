import { fileURLToPath, URL } from "node:url";
import type { StorybookConfig } from "@storybook/react-vite";
import { mergeConfig } from "vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  framework: { name: "@storybook/react-vite", options: {} },
  // Serve public/ so MSW's generated service worker (mockServiceWorker.js) is reachable —
  // it's what lets API-driven components/screens render against mock `/api` responses.
  staticDirs: ["../public"],
  // Match the app's Vite resolution: our workspace packages ship CommonJS `dist`, which leaks
  // `exports is not defined` into the browser bundle. Both are pure/platform-agnostic, so bundle
  // them from TS SOURCE as ESM — the same trick vite.config.ts uses (keep the two in sync).
  viteFinal: (cfg) =>
    mergeConfig(cfg, {
      resolve: {
        alias: {
          "@": fileURLToPath(new URL("../src", import.meta.url)),
          "@naary/dsl": fileURLToPath(
            new URL("../../../packages/dsl/src/index.ts", import.meta.url),
          ),
          "@naary/notifications": fileURLToPath(
            new URL(
              "../../../packages/notifications/src/index.ts",
              import.meta.url,
            ),
          ),
        },
      },
    }),
};

export default config;

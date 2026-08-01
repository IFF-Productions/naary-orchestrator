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
          // Keep in sync with vite.config.ts: the registry subpath must come
          // before the bare "@naary/dsl" prefix alias.
          "@naary/dsl/dist/registry": fileURLToPath(
            new URL("../../../packages/dsl/src/registry.ts", import.meta.url),
          ),
          // Same rule for the block renderer subpath (#928) — TemplateContentBlock and the
          // template editor deep-import it to keep the integration catalog off the eager
          // chunk. Storybook renders those components, so it needs the alias too; tsc does
          // NOT catch a missing one (it resolves via packages/dsl/dist/*.d.ts), only a
          // Storybook build does.
          "@naary/dsl/dist/template-blocks": fileURLToPath(
            new URL(
              "../../../packages/dsl/src/template-blocks.ts",
              import.meta.url,
            ),
          ),
          // Same rule again for the shared connection-type map (#830) — canvas config panels and
          // the Templates checklist deep-import it, and Storybook renders both.
          "@naary/dsl/dist/connection-types": fileURLToPath(
            new URL(
              "../../../packages/dsl/src/connection-types.ts",
              import.meta.url,
            ),
          ),
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

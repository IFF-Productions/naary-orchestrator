import { fileURLToPath, URL } from "node:url";
import type { StorybookConfig } from "@storybook/react-vite";
import { mergeConfig } from "vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  framework: { name: "@storybook/react-vite", options: {} },
  // TWO static roots, both served at `/`:
  //   ../public          → apps/web/public, the app's own production assets (embed.js, the logos).
  //   ./public           → apps/web/.storybook/public, which holds ONLY MSW's generated service
  //                        worker. It is what lets API-driven components/screens render against
  //                        mock `/api` responses, and `worker.start()` fetches it from the server
  //                        ROOT (`/mockServiceWorker.js`) — which a staticDir gives it.
  //
  // WHY THE WORKER IS NOT IN ../public (#1049). Vite copies `public/` VERBATIM into `dist/`, which
  // is the production image (apps/web/Dockerfile COPYs dist straight into nginx). That published a
  // request-interception service worker on the authenticated origin: inert until something calls
  // `navigator.serviceWorker.register()`, but a registered worker is scoped to the ORIGIN and
  // outlives the tab and the build that registered it. Storybook is the only consumer, so the file
  // lives beside the config that serves it. `apps/web/test/public-assets.drift.spec.ts` builds the
  // app for real and fails if anything dev-only reappears in `dist/`.
  staticDirs: ["../public", "./public"],
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

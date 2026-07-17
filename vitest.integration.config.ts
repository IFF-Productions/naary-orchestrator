import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

/**
 * Integration suite: the `*.integration.spec.ts` tests that exercise the real nodes against REAL
 * backing services spun up per-run via testcontainers (a throwaway Postgres, and in-process HTTP /
 * GraphQL servers). Requires Docker. Kept OUT of the default `vitest.config.ts` (which excludes
 * `*.integration.spec.ts`) so `pnpm test` stays fast and Docker-free.
 *
 * Run: `pnpm test:integration`. Same swc transform as the default config (NestJS DI needs decorator
 * metadata; see the note there).
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["apps/**/test/**/*.integration.spec.ts"],
    // A cold `docker pull` of the images + Temporal test env needs generous headroom.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // Containers bind host ports; running files in parallel risks port/resource contention on a
    // laptop or CI runner. Serialize for determinism (the suite is small).
    fileParallelism: false,
  },
  plugins: [
    swc.vite({
      swcrc: false,
      jsc: {
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
        },
      },
    }),
  ],
});

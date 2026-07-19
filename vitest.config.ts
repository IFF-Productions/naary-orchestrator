import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// Single root vitest config for the whole workspace. NestJS DI relies on
// emitDecoratorMetadata, which vitest's default transform does NOT emit, so we
// run everything through swc with legacyDecorator + decoratorMetadata enabled
// (mirrors tsconfig.base's experimentalDecorators + emitDecoratorMetadata).
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["packages/**/test/**/*.spec.ts", "apps/**/test/**/*.spec.ts"],
    // Docker-gated integration tests (real Postgres/HTTP/GraphQL via testcontainers) run
    // separately via vitest.integration.config.ts + `pnpm test:integration`, never in the
    // fast default suite. Exclude them here so `pnpm test` needs no Docker. Likewise the
    // `*.live.spec.ts` live suite (real external services + paid LLM calls) runs only via
    // `pnpm test:live` — excluded here so `pnpm test` can't accidentally bill/emit if a dev
    // happens to have real tokens exported.
    exclude: [
      "**/node_modules/**",
      "**/*.integration.spec.ts",
      "**/*.live.spec.ts",
    ],
    // Temporal's TestWorkflowEnvironment + worker startup needs headroom.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  plugins: [
    swc.vite({
      // IGNORE the repo-root `.swcrc` — that file exists ONLY for `@swc/register`,
      // which runs the apps and MUST emit CommonJS (`module.type: commonjs`) for
      // node's require hook. Vitest needs ESM output; inheriting that .swcrc would
      // force test files to `require()` and break vitest's ESM-only entry
      // ("Vitest cannot be imported in a CommonJS module using require()").
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

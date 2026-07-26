import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// Single root vitest config for the whole workspace. NestJS DI relies on
// emitDecoratorMetadata, which vitest's default transform does NOT emit, so we
// run everything through swc with legacyDecorator + decoratorMetadata enabled
// (mirrors tsconfig.base's experimentalDecorators + emitDecoratorMetadata).
/**
 * Optional CI split (see .github/workflows/ci.yml). Measured on a 2-vCPU hosted runner:
 * the 13 `*.e2e.spec.ts` files own **432s of the suite's 439s** of test time — each boots
 * its own Temporal `TestWorkflowEnvironment` — while the other 302 files total ~7s. So the
 * suite is one fat tail plus noise, and `--shard` alone would balance it badly (it splits
 * by file, ordered by size, which does not predict a 67s Temporal boot).
 *
 *   VITEST_SPLIT=unit        → everything EXCEPT those files (fast, one job)
 *   VITEST_SPLIT=worker-e2e  → ONLY those files (sharded across jobs)
 *   unset                    → the whole suite, which is what `pnpm test` does locally
 *
 * The two halves are exact complements *by construction*: both derive from E2E_GLOB, so a
 * new `*.e2e.spec.ts` anywhere is picked up by one side and dropped by the other — it can
 * never fall through the gap. Doing this here rather than with CLI `--exclude` flags in the
 * workflow is deliberate: CLI `--exclude` REPLACES `test.exclude`, so spelling it out in
 * YAML would silently re-enable the `*.live.spec.ts` suite (real external services, paid
 * LLM calls) the moment the two lists drifted.
 *
 * Both globs are anchored at `packages/`/`apps/` for the same reason the default include is:
 * an unanchored recursive `*.e2e.spec.ts` glob also matches stale git worktrees under
 * `.claude/worktrees/`, which would run every Temporal spec several times over from OLD
 * code. (Verified — that is not hypothetical.)
 */
const E2E_GLOB = [
  "packages/**/test/**/*.e2e.spec.ts",
  "apps/**/test/**/*.e2e.spec.ts",
];
const SPLIT = process.env.VITEST_SPLIT;

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include:
      SPLIT === "worker-e2e"
        ? E2E_GLOB
        : ["packages/**/test/**/*.spec.ts", "apps/**/test/**/*.spec.ts"],
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
      // The other half of the CI split. Unset ⇒ nothing extra excluded.
      ...(SPLIT === "unit" ? E2E_GLOB : []),
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

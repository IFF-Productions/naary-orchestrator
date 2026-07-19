import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

/**
 * LIVE suite: `*.live.spec.ts` tests that run real workflow graphs through the real Temporal
 * interpreter against REAL EXTERNAL SERVICES (GitHub, Slack/Teams, an MCP server, the Anthropic
 * API, …) using REAL credentials supplied via env vars. Each suite is `describe.skipIf(!token)` —
 * it SKIPS cleanly when its credential env vars are absent, so a normal checkout runs nothing here.
 *
 * These differ from `*.integration.spec.ts` (real nodes, but against LOCAL testcontainers /
 * in-process servers, Docker-gated) in two ways that keep them OUT of the default + integration
 * suites: they reach the public internet, and they can COST MONEY (paid LLM calls) and leave
 * side effects (issues, messages) — so they only ever run when a human deliberately runs
 * `pnpm test:live` with tokens exported. Tests create clearly-marked `naary-e2e-*` resources and
 * clean them up in `finally`.
 *
 * Same swc transform as the other configs (NestJS/Temporal DI needs decorator metadata).
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "apps/**/test/**/*.live.spec.ts",
      "packages/**/test/**/*.live.spec.ts",
    ],
    // Real network + a Temporal test env + paid LLM latency need generous headroom.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // Live suites touch shared remote state (a test repo, a channel); serialize for determinism.
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

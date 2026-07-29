# syntax=docker/dockerfile:1
# Shared backend image for BOTH the NestJS API and the Temporal worker — they
# run the same monorepo and differ only by the `command` set in docker-compose.
#
# Dev-oriented (single-command local stack), not a tuned production image:
# - runs the app's src via a `.cjs` bootstrap (src/main.cjs / src/worker.cjs) that registers
#   `@swc/register` with inline options and require()s the `.ts` entry — so dev dependencies
#   are kept rather than pruned. The bootstrap (not `node -r @swc/register src/*.ts`) is REQUIRED:
#   node >=22 routes a `.ts` ENTRY through the ESM loader, where extensionless relative imports
#   (e.g. `import "./env"`) fail; require()ing from a `.cjs` file forces the CJS path. Inline swc
#   options also avoid depending on `.swcrc` discovery inside the container.
#   NB the `typescript` v7 package is the native (Go) tsc — its classic JS compiler API is gone,
#   so ts-node/@swc-node/register (which import it) break; SWC uses its own parser and is
#   version-agnostic. It also emits decorator metadata, which NestJS DI requires (tsx/esbuild does not);

# - one image is built once and reused by api + worker.
# Production-grade images (distroless, non-root, pruned, dist-only) are a later
# infra task — see PRODUCTION-READINESS.md §3.A.
# Node major. Keep in lockstep with /.nvmrc and package.json `engines` — those are what CI and
# local dev read. Overridable at build time (`--build-arg NODE_VERSION=26`) so trying another
# major is a flag, not an edit across four files. 24 is the ACTIVE LTS (Krypton); 26 is Current until Oct 2026.
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim

# Prisma's engine + TLS to Postgres need openssl; ca-certificates for HTTPS to
# LLM/MCP providers from the worker. node:slim ships without openssl.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ── NO coding CLIs live here (#680) ─────────────────────────────────────────────────────
# This image used to install `claude` (247MB), `copilot` (335MB) and `cursor-agent` (219MB) —
# ~801MB the internet-facing api container carried so that two callers could spawn a coding agent
# IN-PROCESS. Both are gone:
#   * api    — the "claude-code" AI-generate source now POSTs to the sandbox-runner
#              (graph-generator.service.ts). It previously spawned `claude` with the api's own cwd
#              (/app — the entire deployed source tree) reachable through its Read/Grep/Glob grant.
#   * worker — codeAgent READ no longer has an in-worker branch (activities/code-agent.ts). It was
#              gated behind CODE_AGENT_SANDBOX_READ, off by default, so the un-isolated path #594
#              describes (/proc/<pid>/environ → ENCRYPTION_KEY) was the NORMAL one in production.
# Every coding-agent run is now a container the sandbox-runner launches: one PINNED image PER TOOL
# (deploy/sandbox/{Dockerfile,cursor,copilot,gemini}.Dockerfile), each with its own ENTRYPOINT, on
# an internal no-gateway network behind an allowlist proxy, read-only root, cap-drop ALL, non-root.
#
# Consequence to keep in mind before "just adding a CLI back": codeAgent and claude-code generate
# now REQUIRE the sandbox profile on the deploy host (COMPOSE_PROFILES=sandbox +
# SANDBOX_RUNNER_TOKEN — deploy/sandbox/README.md). They fail loudly with that instruction when it
# is absent, which is the intended posture: no CLI in this image means no silent un-isolated path.
#
# `curl` went with the cursor installer — nothing else in this image used it (the api/worker
# healthchecks use node's own fetch), so it is not reinstated.

# pnpm via corepack, pinned to the version in package.json's packageManager.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app

# Copy the whole workspace. workspace:* deps + the Temporal worker's runtime
# workflow bundling both need the full source tree, so we don't split this into
# a deps-only layer (the .dockerignore already strips node_modules/dist/.env).
COPY . .

# Install all deps (incl. dev: @swc/register + typescript power the start scripts), then
# generate the Prisma client and compile every composite TS project to dist/.
# @naary/* packages resolve through node_modules to their dist/index.js, so the
# `tsc -b` build is REQUIRED — @swc/register transpiles the app's own src on load
# but not imported workspace packages (they're loaded from their built dist/).
# A throwaway DATABASE_URL satisfies prisma.config.ts at generate time (generate
# never connects); it is build-only and not persisted into the image.
# BuildKit cache mount for the pnpm store: `COPY . .` above invalidates this layer on
# any source change, but the store (downloaded tarballs) persists across builds, so the
# install re-links from cache instead of re-downloading ~800 packages. Build-only — the
# store isn't in the final image, so runtime is byte-identical. Needs BuildKit (compose
# v2 / Docker Desktop default; the `# syntax` directive enables the --mount frontend).
#
# The final step PRECOMPILES the Temporal workflow bundle (apps/worker/dist/workflow-bundle.js)
# so the worker doesn't run an in-process webpack compile at boot — that ~4.3MB build spiked RSS
# and OOM-killed the worker during 2x-scale rolling deploys on the 8GB box (fix #676). Building it
# here runs the spike on the CI runner (ample RAM); worker.ts then loads the finished bundle. Runs
# AFTER `tsc -b` so the @naary/* deps the workflow imports are already built to dist/. The api/
# migrate services share this image and simply ignore the extra artifact.
RUN --mount=type=cache,target=/pnpm-store \
  pnpm install --frozen-lockfile --store-dir /pnpm-store \
  && DATABASE_URL="postgresql://build:build@localhost:5432/build" \
     pnpm --filter @naary/db exec prisma generate \
  && pnpm exec tsc -b \
  && pnpm --filter @naary/worker run build:bundle

# Secrets (ENCRYPTION_KEY, DB/Keycloak passwords) are injected at RUNTIME via
# compose env — never baked here. DATABASE_URL / TEMPORAL_ADDRESS are set per
# service in docker-compose.yml.
#
# Default command runs the API; the worker service overrides it in compose.
CMD ["pnpm", "--filter", "@naary/api", "start"]

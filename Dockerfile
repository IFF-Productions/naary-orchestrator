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
# Node 22 (LTS): pnpm 11 requires Node >= 22 (uses a builtin absent in Node 20).
# Node major. Keep in lockstep with /.nvmrc and package.json `engines` — those are what CI and
# local dev read. Overridable at build time (`--build-arg NODE_VERSION=24`) so a rollback is a
# flag, not an edit. 24 is the ACTIVE LTS (Krypton); 26 is Current until Oct 2026.
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim

# Prisma's engine + TLS to Postgres need openssl; ca-certificates for HTTPS to
# LLM/MCP providers from the worker. node:slim ships without openssl. curl is for
# the Cursor CLI installer below.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# The `claude` CLI for the codeAgent node's read-only (Slice 1) path, which runs `claude -p`
# IN the worker (capability-clamped: plan mode, Read/Grep/Glob — no Bash/write). Write mode
# runs in the isolated sandbox image instead (deploy/sandbox). Pinned for reproducibility.
ARG CLAUDE_CODE_VERSION=2.1.210
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm cache clean --force

# GitHub Copilot CLI (`copilot`) — the codeAgent copilot driver's read-mode binary. npm-installed
# (Node 22+, which this base is). PINNED for a reproducible build (like CLAUDE_CODE_VERSION); bump
# intentionally, or override via --build-arg.
ARG COPILOT_CLI_VERSION=1.0.73
RUN npm install -g "@github/copilot@${COPILOT_CLI_VERSION}" \
  && npm cache clean --force

# Cursor Agent CLI (`cursor-agent`) — the codeAgent cursor driver's read-mode binary. The official
# installer drops the binary in ~/.local/bin (added to PATH below). `-fsSL` follows redirects. By
# default BEST-EFFORT: if the installer ever changes/misbehaves the build still succeeds and
# cursor-agent is simply absent — the driver then errors cleanly at exec, so this never breaks the
# shared api/worker image build. Set --build-arg REQUIRE_CURSOR_CLI=true to make it FATAL (e.g. a
# CI job that must guarantee the binary is present). Verify the parse matches before production use.
ARG REQUIRE_CURSOR_CLI=false
RUN if curl -fsSL https://cursor.com/install | bash; then \
      echo "cursor-agent installed"; \
    elif [ "$REQUIRE_CURSOR_CLI" = "true" ]; then \
      echo "ERROR: cursor-agent install failed and REQUIRE_CURSOR_CLI=true"; exit 1; \
    else \
      echo "WARN: cursor-agent install skipped — cursor codeAgent driver unavailable until fixed"; \
    fi
ENV PATH="/root/.local/bin:${PATH}"

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

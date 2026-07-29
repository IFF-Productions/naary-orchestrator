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
# LLM/MCP providers from the worker. node:slim ships without openssl. curl is for
# the Cursor CLI installer below.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# ── coding CLIs (`claude`, `copilot`, `cursor-agent`) ────────────────────────────────────
# #680 Slice B asked to DROP these from the shared image once nothing execs them in-process.
# As of this commit BOTH services still do, so they stay — verified, not assumed:
#   * api    — apps/api/src/graphs/graph-generator.service.ts execs `claude` for the
#              "claude-code" AI-generate source (the fallback that makes a tenant with only a
#              Claude Code credential able to generate a workflow). Removing the binary takes
#              that path out: every such request 503s with "Claude Code isn't available on this
#              server" (the ENOENT branch) — loud, but only at request time, not build time.
#   * worker — apps/worker/src/temporal/activities/code-agent.ts still runs the CLI IN-PROCESS
#              for codeAgent READ mode unless CODE_AGENT_SANDBOX_READ=true. The sandboxed read
#              path (#594) exists but is OFF by default, so the in-worker exec is the norm.
# Removing them is blocked on: (1) the api's claude-code generate path moving off the local
# subprocess (or the api/worker image split — PRODUCTION-READINESS.md §3.A), and (2) sandboxed
# read becoming the default. Re-check both before deleting anything below.
#
# The `claude` CLI: the api's claude-code generate path AND the codeAgent node's in-worker read
# path (capability-clamped: plan mode, Read/Grep/Glob — no Bash/write). Write mode — and read
# mode with CODE_AGENT_SANDBOX_READ=true — run in the isolated sandbox image instead
# (deploy/sandbox), which installs its own copy. Pinned for reproducibility.
ARG CLAUDE_CODE_VERSION=2.1.210
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm cache clean --force

# GitHub Copilot CLI (`copilot`) — the codeAgent copilot driver's IN-WORKER read-mode binary.
# npm-installed (Node 22+, which this base is). PINNED for a reproducible build (like
# CLAUDE_CODE_VERSION); bump intentionally, or override via --build-arg.
#
# Reachability (why it can't just be dropped with #680 Slice B): the canvas disables the
# Cursor/Copilot options ("coming soon"), but `tool: "cursor" | "copilot"` is still accepted by
# the DSL save-gate (packages/dsl/src/registry.ts) and the Integrations screen offers both
# credential slots — so an API-authored / imported / AI-generated graph can select them and the
# worker will exec this binary. The sandbox does NOT cover them either: the runner only ever
# launches the pinned `naary-claude-sandbox` image (ALLOWED_SANDBOX_IMAGES), whose ENTRYPOINT is
# `claude`. Narrowing that DSL enum to `claude` is the cheapest way to make these two removable.
ARG COPILOT_CLI_VERSION=1.0.73
RUN npm install -g "@github/copilot@${COPILOT_CLI_VERSION}" \
  && npm cache clean --force

# Cursor Agent CLI (`cursor-agent`) — the codeAgent cursor driver's IN-WORKER read-mode binary
# (same reachability note as the copilot block above). The official installer drops the binary in
# ~/.local/bin (added to PATH below). `-fsSL` follows redirects. By default BEST-EFFORT: the
# installer is an UNPINNED remote script on a third-party host, so if it ever changes/404s/is
# unreachable the build still succeeds and cursor-agent is simply absent — the driver then errors
# cleanly at exec, and a transient cursor.com outage can't break the shared api/worker image build
# (which everything else depends on). Set --build-arg REQUIRE_CURSOR_CLI=true to make it FATAL
# (e.g. a CI job that must guarantee the binary is present).
#
# Download-then-run, NOT `curl … | bash`: a pipeline's exit status is the LAST command's, so with
# `if curl … | bash` a failed download fed `bash` an empty stdin, bash exited 0, and the build
# reported "cursor-agent installed" with no binary present — REQUIRE_CURSOR_CLI=true could never
# fire. Verified: with broken TLS, curl exits 77 and the old form still printed success. The final
# `command -v` also catches an installer that exits 0 without placing the binary.
ARG REQUIRE_CURSOR_CLI=false
RUN if curl -fsSL https://cursor.com/install -o /tmp/cursor-install.sh \
      && bash /tmp/cursor-install.sh \
      && PATH="/root/.local/bin:$PATH" command -v cursor-agent >/dev/null; then \
      echo "cursor-agent installed"; \
    elif [ "$REQUIRE_CURSOR_CLI" = "true" ]; then \
      echo "ERROR: cursor-agent install failed and REQUIRE_CURSOR_CLI=true"; exit 1; \
    else \
      echo "WARN: cursor-agent install skipped — cursor codeAgent driver unavailable until fixed"; \
    fi \
    && rm -f /tmp/cursor-install.sh
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

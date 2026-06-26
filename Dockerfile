# Shared backend image for BOTH the NestJS API and the Temporal worker — they
# run the same monorepo and differ only by the `command` set in docker-compose.
#
# Dev-oriented (single-command local stack), not a tuned production image:
# - runs via the existing `ts-node` start scripts (parity with local dev), so
#   dev dependencies are kept rather than pruned;
# - one image is built once and reused by api + worker.
# Production-grade images (distroless, non-root, pruned, dist-only) are a later
# infra task — see PRODUCTION-READINESS.md §3.A.
# Node 22 (LTS): pnpm 11 requires Node >= 22 (uses a builtin absent in Node 20).
FROM node:22-bookworm-slim

# Prisma's engine + TLS to Postgres need openssl; ca-certificates for HTTPS to
# LLM/MCP providers from the worker. node:slim ships without openssl.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# pnpm via corepack, pinned to the version in package.json's packageManager.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app

# Copy the whole workspace. workspace:* deps + the Temporal worker's runtime
# workflow bundling both need the full source tree, so we don't split this into
# a deps-only layer (the .dockerignore already strips node_modules/dist/.env).
COPY . .

# Install all deps (incl. dev: ts-node/typescript power the start scripts), then
# generate the Prisma client and compile every composite TS project to dist/.
# @naary/* packages resolve through node_modules to their dist/index.js, so the
# `tsc -b` build is REQUIRED — ts-node does not transpile imported packages.
# A throwaway DATABASE_URL satisfies prisma.config.ts at generate time (generate
# never connects); it is build-only and not persisted into the image.
RUN pnpm install --frozen-lockfile \
  && DATABASE_URL="postgresql://build:build@localhost:5432/build" \
     pnpm --filter @naary/db exec prisma generate \
  && pnpm exec tsc -b

# Secrets (ENCRYPTION_KEY, DB/Keycloak passwords) are injected at RUNTIME via
# compose env — never baked here. DATABASE_URL / TEMPORAL_ADDRESS are set per
# service in docker-compose.yml.
#
# Default command runs the API; the worker service overrides it in compose.
CMD ["pnpm", "--filter", "@naary/api", "start"]

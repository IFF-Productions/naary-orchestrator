# The sandbox-runner service image. This is the ONE container that holds Docker access
# (host-root-adjacent) — deliberately kept OFF the worker so that blast radius is contained
# (design §3, Option B rejected). It launches ephemeral `claude` sandbox containers on the
# internal no-gateway network. Minimal by design: node + the docker CLI + git, NO app secrets,
# NO DB access. The tenant key arrives per-request and is forwarded to the sandbox, never stored.
#
# Build from the repo root:
#   docker build -t naary-sandbox-runner -f deploy/sandbox/runner.Dockerfile .

FROM node:22-bookworm-slim

# docker CLI → launch sibling sandbox containers via the mounted host socket.
# git       → capture the sandbox's edits as a diff (no network/token involved).
RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g typescript@~6.0

WORKDIR /app
# The runner has no workspace deps — build it standalone (its tsconfig extends the repo base).
COPY tsconfig.base.json ./
COPY apps/sandbox-runner ./apps/sandbox-runner
WORKDIR /app/apps/sandbox-runner
RUN npm install --no-audit --no-fund && npx tsc

# Runs as root ONLY because it needs the docker socket; the SANDBOX containers it launches are
# non-root, capability-dropped, read-only, and egress-isolated (that's where untrusted code runs).
CMD ["node", "dist/index.js"]

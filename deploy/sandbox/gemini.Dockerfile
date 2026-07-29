# The codeAgent GEMINI sandbox image (`naary-gemini-sandbox`) — the ephemeral, egress-isolated box
# the runner launches one-per-run for a `tool: "gemini"` node. Sibling of ./Dockerfile (claude);
# see that file for the shared rationale. It holds only the Gemini credential (GEMINI_API_KEY, via
# env) and the working tree; NEVER a git token (design §2.2).
#
# Build:  docker build -t naary-gemini-sandbox:latest -f deploy/sandbox/gemini.Dockerfile deploy/sandbox
#
# NB the sandbox's egress allowlist (squid-allowlist.conf) must permit
# generativelanguage.googleapis.com before a gemini run can work — the network, not an env var, is
# the boundary.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim

# Pin the CLI for reproducible, security-sensitive builds — a VERSIONED default (not `latest`) so a
# rebuild can't silently pull a new/breaking/vulnerable release. Verified against this exact version
# (headless `-p`, `-o json`, `--approval-mode plan`, `--skip-trust`, GEMINI_API_KEY).
ARG GEMINI_CLI_VERSION=0.53.0

# `git` for in-tree diffs; `ca-certificates` for TLS to the proxy. `ripgrep` because the Gemini CLI
# looks for it and otherwise logs "Ripgrep is not available. Falling back to GrepTool." on every
# run — a slower search path and a line of noise in each envelope.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g "@google/gemini-cli@${GEMINI_CLI_VERSION}" \
  && npm cache clean --force

# Non-root: the model's tools run as an unprivileged user (defense in depth alongside the
# runner's --cap-drop ALL / no-new-privileges / read-only root).
RUN useradd --create-home --uid 10001 sandbox
USER sandbox
WORKDIR /work

# The runner supplies the full `gemini -p …` argv; no default command is baked in.
ENTRYPOINT ["gemini"]

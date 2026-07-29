# The codeAgent COPILOT sandbox image (`naary-copilot-sandbox`) — the ephemeral, egress-isolated
# box the runner launches one-per-run for a `tool: "copilot"` node. Sibling of ./Dockerfile
# (claude); see that file for the shared rationale. It holds only the Copilot credential (via env)
# and the working tree; NEVER a git token — even though this CLI is GitHub's, the two-box split
# (design §2.2) is unchanged: all VCS I/O happens in the activity, outside the sandbox.
#
# Build:  docker build -t naary-copilot-sandbox:latest -f deploy/sandbox/copilot.Dockerfile deploy/sandbox
#
# NB the sandbox's egress allowlist (squid-allowlist.conf) must permit this CLI's API host before a
# copilot run can work — the network, not an env var, is the boundary.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim

# Pin the CLI for reproducible, security-sensitive builds — a VERSIONED default (not `latest`) so a
# rebuild can't silently pull a new/breaking/vulnerable release. Bump deliberately.
ARG COPILOT_CLI_VERSION=1.0.73

# `git` for in-tree diffs (no network — the remote/token never enter here); `ca-certificates` for
# TLS to the proxy. curl kept out of the shipped image (it's only for the egress test).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g "@github/copilot@${COPILOT_CLI_VERSION}" \
  && npm cache clean --force

# Non-root: the model's tools run as an unprivileged user (defense in depth alongside the
# runner's --cap-drop ALL / no-new-privileges / read-only root).
RUN useradd --create-home --uid 10001 sandbox
USER sandbox
WORKDIR /work

# The runner supplies the full `copilot -p …` argv; no default command is baked in.
ENTRYPOINT ["copilot"]

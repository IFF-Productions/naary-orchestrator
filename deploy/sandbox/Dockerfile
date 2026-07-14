# The codeAgent sandbox image (`naary-claude-sandbox`) — the ephemeral, egress-isolated box
# the runner launches one-per-run to let Claude Code EDIT a working tree. It holds only the
# Anthropic key (via env) and the working tree; NEVER a git token (the activity does all VCS
# I/O outside the sandbox — the two-box split, design §2.2).
#
# Build:  docker build -t naary-claude-sandbox:latest deploy/sandbox
# It is launched with --network naary-sandbox-internal (no gateway) + HTTPS_PROXY → the
# allowlist proxy, so its only reachable destination is api.anthropic.com (proven by
# egress-test.sh). Runs as a non-root user with a read-only root fs (+ /tmp tmpfs).

FROM node:22-bookworm-slim

# `git` for in-tree diffs (no network — the remote/token never enter here); `ca-certificates`
# for TLS to the proxy. curl kept out of the shipped image (it's only for the egress test).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @anthropic-ai/claude-code \
  && npm cache clean --force

# Non-root: the model's tools run as an unprivileged user (defense in depth alongside the
# runner's --cap-drop ALL / no-new-privileges / read-only root).
RUN useradd --create-home --uid 10001 sandbox
USER sandbox
WORKDIR /work

# The runner supplies the full `claude -p …` argv; no default command is baked in.
ENTRYPOINT ["claude"]

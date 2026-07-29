# The codeAgent sandbox image (`naary-claude-sandbox`) — the ephemeral, egress-isolated box
# the runner launches one-per-run to let Claude Code EDIT a working tree. It holds only the
# Anthropic key (via env) and the working tree; NEVER a git token (the activity does all VCS
# I/O outside the sandbox — the two-box split, design §2.2).
#
# Build:  docker build -t naary-claude-sandbox:latest deploy/sandbox
# It is launched with --network naary-sandbox-internal (no gateway) + HTTPS_PROXY → the
# allowlist proxy, so its only reachable destination is api.anthropic.com (proven by
# egress-test.sh). Runs as a non-root user with a read-only root fs (+ /tmp tmpfs).

# Node major. Keep in lockstep with /.nvmrc and package.json `engines` — those are what CI and
# local dev read. Overridable at build time (`--build-arg NODE_VERSION=26`) so trying another
# major is a flag, not an edit across four files. 24 is the ACTIVE LTS (Krypton); 26 is Current until Oct 2026.
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim

# Marks this as a naary SANDBOX image, for the deploy host's disk hygiene. deploy.yml's pre-pull
# `docker image prune -af --filter until=<KEEP_HOURS>h` reclaims TAGGED images not referenced by a
# container — and sandbox containers are `--rm`, so nothing references these between runs. Without
# an exclusion the deploy would delete the image the next codeAgent run needs and re-pull ~1.7GiB
# every time. deploy.yml adds `--filter label!=com.naary.sandbox=1`; a separate, targeted sweep
# removes the sandbox images that are no longer the CURRENT ones (verified: the two filters AND).
LABEL com.naary.sandbox="1"

# Pin the CLI for reproducible, security-sensitive builds — a VERSIONED default (not `latest`)
# so a rebuild can't silently pull a new/breaking/vulnerable release. Bump deliberately; or
# override per deploy:  docker build --build-arg CLAUDE_CODE_VERSION=2.1.210 …
ARG CLAUDE_CODE_VERSION=2.1.210

# `git` for in-tree diffs (no network — the remote/token never enter here); `ca-certificates`
# for TLS to the proxy. curl kept out of the shipped image (it's only for the egress test).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm cache clean --force

# Non-root: the model's tools run as an unprivileged user (defense in depth alongside the
# runner's --cap-drop ALL / no-new-privileges / read-only root).
RUN useradd --create-home --uid 10001 sandbox
USER sandbox
WORKDIR /work

# The runner supplies the full `claude -p …` argv; no default command is baked in.
ENTRYPOINT ["claude"]

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

# Marks this as a naary SANDBOX image, for the deploy host's disk hygiene. deploy.yml's pre-pull
# `docker image prune -af --filter until=<KEEP_HOURS>h` reclaims TAGGED images not referenced by a
# container — and sandbox containers are `--rm`, so nothing references these between runs. Without
# an exclusion the deploy would delete the image the next codeAgent run needs and re-pull ~1.7GiB
# every time. deploy.yml adds `--filter label!=com.naary.sandbox=1`; a separate, targeted sweep
# removes the sandbox images that are no longer the CURRENT ones (verified: the two filters AND).
LABEL com.naary.sandbox="1"

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

# PRE-EXTRACT the CLI's bundled package at BUILD time, into the image.
#
# `copilot` is a self-extracting bundle: on first run it unpacks an app.js plus a NATIVE addon
# (`runtime.node`) into $XDG_CACHE_HOME and dlopen()s it. In the sandbox that cache would land on
# the writable tmpfs the runner mounts at HOME — which is `noexec`, so the load fails with
# "failed to map segment from shared object" and the CLI never starts.
#
# The fix is deliberately NOT to add `exec` to that tmpfs: that would let a run extract and execute
# arbitrary native code it fetched at runtime. Instead the addon is unpacked here, ships as part of
# the PINNED image, and is loaded from the read-only root — so what executes is fixed at build
# time. `--version` is the cheapest command that triggers extraction (it needs no credential), and
# it doubles as a smoke test that the install actually runs.
ENV XDG_CACHE_HOME=/opt/copilot-cache
RUN copilot --version \
  && chmod -R a+rX /opt/copilot-cache

# Non-root: the model's tools run as an unprivileged user (defense in depth alongside the
# runner's --cap-drop ALL / no-new-privileges / read-only root).
RUN useradd --create-home --uid 10001 sandbox
USER sandbox
WORKDIR /work

# The runner supplies the full `copilot -p …` argv; no default command is baked in.
ENTRYPOINT ["copilot"]

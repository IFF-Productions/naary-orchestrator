# The codeAgent CURSOR sandbox image (`naary-cursor-sandbox`) — the ephemeral, egress-isolated box
# the runner launches one-per-run for a `tool: "cursor"` node. Sibling of ./Dockerfile (claude);
# see that file for the shared rationale. It holds only the Cursor credential (via env) and the
# working tree; NEVER a git token (the activity does all VCS I/O outside the sandbox, design §2.2).
#
# Build:  docker build -t naary-cursor-sandbox:latest -f deploy/sandbox/cursor.Dockerfile deploy/sandbox
#
# ONE IMAGE PER TOOL is the point (#680): the runner maps tool → image, and each image's ENTRYPOINT
# is that tool's binary. Before this, `ALLOWED_SANDBOX_IMAGES` pinned only the claude image, so a
# cursor argv was handed to the `claude` entrypoint — the latent bug #933 found. That is now
# impossible by construction rather than by review.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim

# Marks this as a naary SANDBOX image, for the deploy host's disk hygiene. deploy.yml's pre-pull
# `docker image prune -af --filter until=<KEEP_HOURS>h` reclaims TAGGED images not referenced by a
# container — and sandbox containers are `--rm`, so nothing references these between runs. Without
# an exclusion the deploy would delete the image the next codeAgent run needs and re-pull ~1.7GiB
# every time. deploy.yml adds `--filter label!=com.naary.sandbox=1`; a separate, targeted sweep
# removes the sandbox images that are no longer the CURRENT ones (verified: the two filters AND).
LABEL com.naary.sandbox="1"

# `git` for in-tree diffs (no network — the remote/token never enter here); `ca-certificates` for
# TLS to the proxy; `curl` is REQUIRED here (unlike the claude image) because Cursor ships an
# install script rather than an npm package.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# Cursor Agent CLI. The official installer is an UNPINNED remote script on a third-party host, so
# unlike the npm-installed CLIs this cannot be version-pinned from here.
#
# FATAL on failure, deliberately — the opposite of the shared backend image's best-effort guard.
# There the installer was soft-failed so a cursor.com outage couldn't break the one image every
# service depends on; this image exists ONLY to run cursor-agent, so an image without the binary is
# useless and must not be published as if it worked.
#
# Download-then-run, NOT `curl … | bash`: a pipeline's exit status is the LAST command's, so a
# failed download fed `bash` an empty stdin and `bash` exited 0 — reporting success with no binary
# present (fixed for the backend image in #933). The `command -v` also catches an installer that
# exits 0 without placing the binary.
# The installer puts the real binary under the INSTALLING user's ~/.local/share/cursor-agent/
# versions/<ver>/ and leaves a SYMLINK in ~/.local/bin. Copying just that symlink produces a
# DANGLING link once we drop to the unprivileged user (verified: "executable file not found in
# $PATH"), so relocate the whole versioned tree to /opt and link to the resolved binary.
#
# The closing `--version` is a real functional check, not a `command -v`: it proves the binary
# actually executes as installed, which is exactly what the naive copy failed to do.
RUN curl -fsSL https://cursor.com/install -o /tmp/cursor-install.sh \
  && bash /tmp/cursor-install.sh \
  && rm -f /tmp/cursor-install.sh \
  && test -d /root/.local/share/cursor-agent \
  && mv /root/.local/share/cursor-agent /opt/cursor-agent \
  && ln -s "$(find /opt/cursor-agent/versions -maxdepth 2 -name cursor-agent -type f | head -1)" \
       /usr/local/bin/cursor-agent \
  && chmod -R a+rX /opt/cursor-agent \
  && cursor-agent --version

# Non-root: the model's tools run as an unprivileged user (defense in depth alongside the
# runner's --cap-drop ALL / no-new-privileges / read-only root).
RUN useradd --create-home --uid 10001 sandbox
USER sandbox
WORKDIR /work

# The runner supplies the full `cursor-agent -p …` argv; no default command is baked in.
ENTRYPOINT ["cursor-agent"]

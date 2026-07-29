#!/usr/bin/env bash
#
# Sandbox image smoke test (#680) — the companion to egress-test.sh.
#
# egress-test.sh proves the NETWORK containment. This proves the other half: that each coding-CLI
# image actually STARTS under the exact isolation flags `buildSandboxDockerArgs` emits (read-only
# root, non-root user, cap-drop ALL, no-new-privileges, tmpfs HOME) against an EMPTY workdir — the
# runner's ephemeral workspace, which has no repo and no git.
#
# Why this exists: the unit tests mock `exec`, so they pin the argv and prove nothing about whether
# a CLI can actually run under it. Every one of these images failed this check on the first try —
# copilot and gemini could not write HOME on a read-only root, cursor shipped a dangling symlink,
# and copilot's native addon could not be dlopen()ed from a `noexec` tmpfs. None of that is
# visible from TypeScript.
#
# PASS = the CLI started, parsed its argv, and got as far as REJECTING the bogus credential.
# FAIL = it died before that (ENOENT / EACCES / "executable file not found" / "failed to map
#        segment from shared object").
#
# Usage:  deploy/sandbox/smoke-test.sh [tool|image-ref …]   (default: all four, :latest)
#         PROXIED=1 deploy/sandbox/smoke-test.sh [tool|image-ref …]
#
# An argument containing '/' or '@' is an IMAGE REF, not a tool name: the tool is inferred from
# `naary-<tool>-sandbox` in the ref and that image is smoked instead of the local `:latest`. On a
# deploy host that is the only useful form — CI publishes digest-pinned GHCR refs and nothing tagged
# `:latest` exists there at all:
#   deploy/sandbox/smoke-test.sh ghcr.io/<owner>/naary-claude-sandbox:sha-abc123@sha256:…
# The refs a box is actually running:
#   docker inspect naary-sandbox-runner --format '{{range .Config.Env}}{{println .}}{{end}}' | grep SANDBOX_IMAGE_
#
# PROXIED=1 is the stronger check and the one that validates squid-allowlist.conf: it puts the CLI
# on the internal (no-gateway) network behind the allowlist proxy, exactly as the runner does. A
# bogus key still discriminates — "invalid API key" means the host is allowlisted AND reachable,
# while a proxy/connect failure means the allowlist is wrong. This is how the `.cursor.sh` entry
# was found: with only api.cursor.com the CLI could not reach its API, even though curl to
# api.cursor.com through the same proxy returned 200.
#
# Bring the proxy up first for PROXIED=1:
#   SANDBOX_RUNNER_TOKEN=x docker compose -f deploy/sandbox/docker-compose.sandbox.yml up -d sandbox-proxy
#
# Build the images first — see README.md.
set -u

WORKDIR="$(mktemp -d)"
chmod 0777 "$WORKDIR"
trap 'rm -rf "$WORKDIR"' EXIT

# Keep in lockstep with buildSandboxDockerArgs (apps/sandbox-runner/src/docker-run.ts).
ISO=(
  --rm --read-only
  --tmpfs /tmp:size=256m
  --tmpfs /home/sandbox:size=64m,mode=1777
  -v "$WORKDIR:/work" -w /work
  --security-opt no-new-privileges:true
  --cap-drop ALL
  --pids-limit 256 --memory 2048m --cpus 1.0
)
# Default: host network — checks STARTUP only. PROXIED=1 adds the real egress boundary.
if [ "${PROXIED:-0}" = "1" ]; then
  ISO+=(--network "${SANDBOX_NETWORK:-naary-sandbox-internal}"
        -e "HTTPS_PROXY=${SANDBOX_PROXY_URL:-http://naary-sandbox-proxy:3128}"
        -e "HTTP_PROXY=${SANDBOX_PROXY_URL:-http://naary-sandbox-proxy:3128}")
  echo "mode: PROXIED — internal network + allowlist proxy (validates squid-allowlist.conf)"
else
  echo "mode: startup only — re-run with PROXIED=1 to validate the egress allowlist"
fi

BAD_START='ENOENT|EACCES|executable file not found|failed to map segment|Cannot find module|not found for linux|Failed to reach|proxy'
AUTH_OK='invalid api key|api key not valid|API key is invalid|authenticated with GitHub|API_KEY_INVALID'
fail=0

smoke() { # tool image key-env-var args…
  local tool="$1" image="$2" var="$3"
  shift 3
  printf '\n──────── %s (%s) ────────\n' "$tool" "$image"
  local out
  out="$(docker run "${ISO[@]}" -e "$var=naary-smoke-invalid-key" "$image" "$@" 2>&1)"
  if grep -qiE "$BAD_START" <<<"$out"; then
    echo "FAIL — the CLI did not start:"
    grep -iE "$BAD_START" <<<"$out" | head -3 | sed 's/^/  | /'
    fail=1
  else
    echo "PASS — started and reached its provider/auth step:"
    grep -oiE "$AUTH_OK" <<<"$out" | head -1 | sed 's/^/  | /' ||
      echo "  | (no auth-rejection string matched — review the tail below)"
    tail -3 <<<"$out" | sed 's/^/  | /'
  fi
}

want() { # no args ⇒ run everything; otherwise only the named tools / matching refs
  [ "$#" -eq 0 ] && return 0
  for t in "$@"; do
    case "$t" in
      # An image REF: match by the `naary-<tool>-sandbox` repo name embedded in it, and use the ref
      # itself as the image so the bytes tested are the bytes deployed.
      */*|*@*) case "$t" in *"naary-$TOOL-sandbox"*) IMAGE="$t"; return 0 ;; esac ;;
      "$TOOL") return 0 ;;
    esac
  done
  return 1
}

TOOL=claude IMAGE=naary-claude-sandbox:latest
want "$@" && smoke claude "$IMAGE" ANTHROPIC_API_KEY \
  -p 'say hi' --output-format json --permission-mode plan --allowedTools Read,Grep,Glob
TOOL=cursor IMAGE=naary-cursor-sandbox:latest
want "$@" && smoke cursor "$IMAGE" CURSOR_API_KEY \
  -p 'say hi' --output-format json
TOOL=copilot IMAGE=naary-copilot-sandbox:latest
want "$@" && smoke copilot "$IMAGE" COPILOT_GITHUB_TOKEN \
  -p 'say hi' --output-format json --allow-tool read --deny-tool write --deny-tool shell
TOOL=gemini IMAGE=naary-gemini-sandbox:latest
want "$@" && smoke gemini "$IMAGE" GEMINI_API_KEY \
  -p 'say hi' -o json --approval-mode plan --skip-trust

echo
if [ "$fail" -eq 0 ]; then
  echo "All smoked images started under the isolation flags."
else
  echo "One or more images FAILED to start — see above."
fi
exit "$fail"

#!/usr/bin/env bash
# Adversarial egress test — the ACCEPTANCE GATE for the codeAgent sandbox (design
# CLAUDE-CODE-NODE.md §8b.1). It proves the network boundary the same way an attacker would
# probe it: a container on the sandbox's internal network may reach api.anthropic.com (to
# function) and NOTHING else — not other hosts via the proxy, not the internet directly, not
# cloud metadata. Uses a plain curl image (no claude needed) so it tests the NETWORK, not the CLI.
#
# Write/Bash mode for the codeAgent node MUST stay disabled until this passes on the deploy host.
#
# Usage:  ./deploy/sandbox/egress-test.sh         (brings the proxy up, tests, tears down)
set -uo pipefail

cd "$(dirname "$0")"
PROJECT="naary-sandbox-egtest"
NET="naary-sandbox-internal"
PROXY="http://naary-sandbox-proxy:3128"
CURL="curlimages/curl:8.11.1"
FAILED=0

compose() { docker compose -p "$PROJECT" -f docker-compose.sandbox.yml "$@"; }
# Run curl inside the sandbox's INTERNAL network (no gateway), like a real sandbox would.
in_sandbox() { docker run --rm --network "$NET" "$CURL" "$@"; }

pass() { echo "  ✅ $1"; }
fail() { echo "  ❌ $1"; FAILED=1; }

# Always tear down — even on Ctrl-C / CI cancellation after `compose up` — so a leftover proxy
# + networks can't make the next run (or operator debugging) unreliable. Runs once.
cleanup() { SANDBOX_RUNNER_TOKEN=x compose down >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "▸ bringing up the allowlist proxy + internal network…"
# Only the proxy — the egress boundary is what we're testing (not the runner, which needs a
# build + token). A throwaway token satisfies the runner service's `:?` guard during parsing.
# Fail FAST if it can't start (no Docker, image pull, bad config) — otherwise the downstream
# curl failures would misreport the real cause.
if ! SANDBOX_RUNNER_TOKEN=egress-test compose up -d sandbox-proxy; then
  echo "❌ could not start the sandbox proxy — is Docker running?"
  exit 1
fi
# Give squid a moment to bind.
sleep 3
docker pull -q "$CURL" >/dev/null 2>&1 || true

echo "▸ ALLOWED path — Anthropic via the proxy should connect:"
# A TLS CONNECT that genuinely reaches Anthropic returns an UPSTREAM 4xx (401/405 without a
# valid request). Require a 4xx (excluding 407 = proxy-auth) so a proxy-generated 5xx (squid
# up but upstream unreachable) doesn't read as a false pass — the real TLS tunnel must work.
code=$(in_sandbox -sS --max-time 25 -x "$PROXY" -o /dev/null -w '%{http_code}' \
  https://api.anthropic.com/v1/messages 2>/dev/null)
if [ "$code" -ge 400 ] 2>/dev/null && [ "$code" -lt 500 ] && [ "$code" != 407 ]; then
  pass "api.anthropic.com reachable via proxy (upstream HTTP $code)"
else
  fail "api.anthropic.com NOT reachable via proxy (got '$code' — tunnel broken/proxy 5xx)"
fi

echo "▸ BLOCKED paths — everything else must fail:"
# 1) A non-allowlisted host through the proxy → squid denies the CONNECT → non-zero exit.
if in_sandbox -sS --max-time 20 -x "$PROXY" -o /dev/null https://example.com >/dev/null 2>&1; then
  fail "example.com was reachable via the proxy (allowlist leaking!)"
else
  pass "example.com blocked by the proxy allowlist"
fi

# 2) Direct to a public IP, bypassing the proxy → no default gateway → no route.
if in_sandbox -sS --max-time 8 --noproxy '*' -o /dev/null https://1.1.1.1 >/dev/null 2>&1; then
  fail "1.1.1.1 reachable DIRECTLY (the network has a gateway — not isolated!)"
else
  pass "1.1.1.1 unreachable directly (no default gateway)"
fi

# 3) Cloud metadata endpoint (the classic SSRF/credential target).
if in_sandbox -sS --max-time 6 --noproxy '*' -o /dev/null \
  http://169.254.169.254/latest/meta-data/ >/dev/null 2>&1; then
  fail "169.254.169.254 (cloud metadata) reachable — SSRF exposure!"
else
  pass "169.254.169.254 (cloud metadata) unreachable"
fi

echo "▸ tearing down…" # (the EXIT trap runs cleanup)

if [ "$FAILED" -eq 0 ]; then
  echo "✅ EGRESS OK — Anthropic reachable via the allowlist proxy; the probed exfil paths"
  echo "   (non-allowlisted host via proxy, direct public IP, cloud metadata) are blocked."
  exit 0
fi
echo "❌ EGRESS ISOLATION FAILED — do NOT enable codeAgent write mode."
exit 1

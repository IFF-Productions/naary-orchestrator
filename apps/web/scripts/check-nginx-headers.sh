#!/usr/bin/env bash
# Assert the RESPONSE HEADERS the web image actually emits (#1046, #598).
#
# WHY A RUNNING SERVER AND NOT A TEST OVER nginx.conf: the SPA locations end in
# `try_files $uri /index.html`, and that fallback is an INTERNAL REDIRECT that re-enters
# location matching — the response is emitted from `location /`, so an add_header written in
# a `^~` block never reaches the SPA document. See the comment at the top of nginx.conf: a
# config can read as correct and emit nothing. Only curl settles it.
#
# NOT wired into `pnpm test` — it needs Docker and a full SPA build (several minutes). Run it
# by hand when touching apps/web/nginx.conf:
#
#   apps/web/scripts/check-nginx-headers.sh                 # builds the image, runs it, asserts
#   BASE_URL=http://localhost:8099 apps/web/scripts/check-nginx-headers.sh   # asserts a running one
#   BASE_URL=https://app.naar-y.com apps/web/scripts/check-nginx-headers.sh  # asserts PRODUCTION
#
# (Against production the edge may rewrite Cache-Control — see the Cloudflare notes in #1046.)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
IMAGE="${IMAGE:-naary-web:header-check}"
CONTAINER="naary-web-header-check"
PORT="${PORT:-8099}"
BASE_URL="${BASE_URL:-}"
OWN_CONTAINER=0

if [ -z "$BASE_URL" ]; then
  echo "==> building $IMAGE (this takes a few minutes)"
  docker build -f "$REPO_ROOT/apps/web/Dockerfile" -t "$IMAGE" "$REPO_ROOT"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" -p "$PORT:80" "$IMAGE" >/dev/null
  OWN_CONTAINER=1
  BASE_URL="http://localhost:$PORT"
  for _ in $(seq 1 30); do
    curl -sS -o /dev/null "$BASE_URL/" && break
    sleep 1
  done
fi
cleanup() { [ "$OWN_CONTAINER" = 1 ] && docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail=0
pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=1; }

headers() { curl -sSI "$BASE_URL$1" | tr -d '\r' | tr '[:upper:]' '[:lower:]'; }

# has <headers> <needle> <label>   — needle must be lowercase
has() { case "$1" in *"$2"*) pass "$3" ;; *) bad "$3 — expected to contain: $2" ;; esac; }
hasnt() { case "$1" in *"$2"*) bad "$3 — did NOT expect: $2" ;; *) pass "$3" ;; esac; }

echo "==> $BASE_URL"

# --- the SPA shell: must revalidate, never be reused blind (#1046) --------------------
h=$(headers /)
has "$h" "cache-control: no-cache" "/ → Cache-Control: no-cache"
hasnt "$h" "immutable" "/ → not immutable"
# ...and the security headers it has carried since audit #598 still ride along.
has "$h" "content-security-policy:" "/ → CSP present"
has "$h" "frame-ancestors 'none'" "/ → CSP frame-ancestors 'none'"
has "$h" "x-frame-options: deny" "/ → X-Frame-Options: DENY"
has "$h" "x-content-type-options: nosniff" "/ → nosniff"
has "$h" "referrer-policy: strict-origin-when-cross-origin" "/ → Referrer-Policy"
has "$h" "strict-transport-security: max-age=31536000" "/ → HSTS"
has "$h" "document-policy: js-profiling" "/ → Document-Policy"

# A client-side route resolves to the same document through the try_files fallback.
h=$(headers /runs)
has "$h" "cache-control: no-cache" "/runs (SPA fallback) → no-cache"
has "$h" "frame-ancestors 'none'" "/runs → CSP frame-ancestors 'none'"

# no-cache is REVALIDATE, not don't-store: the conditional request must still 304.
etag=$(curl -sSI "$BASE_URL/" | tr -d '\r' | awk 'tolower($1)=="etag:"{print $2}')
if [ -n "$etag" ]; then
  code=$(curl -sS -o /dev/null -w '%{http_code}' -H "If-None-Match: $etag" "$BASE_URL/")
  [ "$code" = "304" ] && pass "/ with If-None-Match → 304 (revalidation is cheap)" ||
    bad "/ with If-None-Match → $code, expected 304"
else
  bad "/ → no etag to revalidate against"
fi

# --- hashed build output: content-addressed, so pin it for a year ---------------------
# `|| true` because a no-match grep exits non-zero, and under `set -e` the assignment would
# kill the script before the guard below could say WHY.
asset=$(curl -sS "$BASE_URL/" | grep -o '/assets/[A-Za-z0-9_.-]*\.js' | head -1 || true)
[ -n "$asset" ] || { bad "could not find a hashed asset in index.html"; asset=/assets/none.js; }
h=$(headers "$asset")
has "$h" "cache-control: public, max-age=31536000, immutable" "$asset → immutable, 1y"

css=$(curl -sS "$BASE_URL/" | grep -o '/assets/[A-Za-z0-9_.-]*\.css' | head -1 || true)
if [ -n "$css" ]; then
  has "$(headers "$css")" "cache-control: public, max-age=31536000, immutable" "$css → immutable, 1y"
fi

# THE ONE THAT DISCRIMINATES A CORRECT CONFIG FROM A PLAUSIBLE ONE. A stale shell asks for a
# chunk the new build deleted; try_files serves index.html under that .js url. Keyed on
# $request_uri this would be stamped `immutable` — poisoning the url for a year. Keyed on the
# RESOLVED $uri it is /index.html by then, and revalidates.
h=$(headers /assets/deleted-by-a-later-deploy-DEADBEEF.js)
has "$h" "cache-control: no-cache" "missing /assets/*.js (falls back to index.html) → no-cache"
hasnt "$h" "immutable" "missing /assets/*.js → NOT immutable"

# --- public embeddable pages: same shell, same no-cache, framing posture intact -------
for p in /f/some-form-id /c/some-chat-id; do
  h=$(headers "$p")
  has "$h" "cache-control: no-cache" "$p → no-cache"
  has "$h" "frame-ancestors *" "$p → CSP frame-ancestors * (embeddable)"
  hasnt "$h" "x-frame-options" "$p → X-Frame-Options omitted (would block framing)"
done

# --- unhashed files at stable urls: must revalidate, never be pinned ------------------
# /embed.js above all — tenants paste it into their own sites, so a long TTL would freeze
# the loader on pages we do not control.
for p in /embed.js /naary-mark.svg /naary-flame.svg; do
  has "$(headers "$p")" "cache-control: no-cache" "$p (unhashed, stable url) → no-cache"
done

# --- the proxied API keeps its OWN Cache-Control, and only one ------------------------
# nginx add_header APPENDS. If a Cache-Control is ever added to `location /api/` it will not
# replace the API's `no-store` (#1042) but sit beside it — two values, undefined winner.
# Locally there is no api container (502, zero headers); against a live host the API's own
# `no-store` is the one. Either way: never more than one.
n=$(curl -sSI "$BASE_URL/api/anything" | tr -d '\r' | grep -ci '^cache-control:' || true)
[ "$n" -le 1 ] && pass "/api/* → at most one Cache-Control (found $n; nginx adds none)" ||
  bad "/api/* → $n Cache-Control headers, nginx is appending one to the API's own"

if [ "$fail" = 0 ]; then echo "==> all header assertions passed"; else echo "==> FAILURES"; fi
exit "$fail"

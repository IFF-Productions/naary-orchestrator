#!/usr/bin/env bash
# no-secrets.sh — PreToolUse (Edit|Write|MultiEdit)
# Blocks Claude Code from writing hardcoded credentials, or logging statements that
# print secret-bearing variables, into source files. exit 2 = block (enforcement).
#
# This is a heuristic dev-time guard, NOT a guarantee. Pair it with a real CI secret
# scanner (gitleaks/trufflehog) and the runtime redaction in the app.
set -euo pipefail

INPUT=$(cat)

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Collect the text being written across Write (.content), Edit (.new_string),
# and MultiEdit (.edits[].new_string).
CONTENT=$(echo "$INPUT" | jq -r '
  [ .tool_input.content // empty,
    .tool_input.new_string // empty,
    ( .tool_input.edits[]?.new_string // empty )
  ] | join("\n")
')

[ -z "$CONTENT" ] && exit 0

# 1) Literal provider keys / cloud credentials embedded in source.
if echo "$CONTENT" | grep -Eq \
  'sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}'; then
  echo "Blocked: a hardcoded API key/secret appears in ${FILE_PATH}." >&2
  echo "Secrets must go in the encrypted tenant credential store and be fetched inside an activity — never in source. (CLAUDE.md Tier 1, rule 4)" >&2
  exit 2
fi

# 2) Logging a secret-bearing variable (key leakage into logs/telemetry).
if echo "$CONTENT" | grep -Eiq \
  '(console\.(log|info|warn|error|debug)|logger\.[a-z]+|process\.stdout\.write)\([^)]*(api[_-]?key|secret|password|passwd|decryptedkey|bearer|access[_-]?token|refresh[_-]?token)[^)]*\)'; then
  echo "Blocked: ${FILE_PATH} appears to log a secret-bearing value." >&2
  echo "Never log keys/tokens (CLAUDE.md Tier 1, rule 4). Redact at the boundary." >&2
  exit 2
fi

# 3) Committing a .env with real-looking values (allow .env.example).
case "$FILE_PATH" in
  *.env|*.env.local|*.env.production)
    if echo "$CONTENT" | grep -Eq '=[^[:space:]]{16,}'; then
      echo "Blocked: writing populated ${FILE_PATH}. Keep real secrets out of committed files; use .env.example with placeholders." >&2
      exit 2
    fi
    ;;
esac

exit 0

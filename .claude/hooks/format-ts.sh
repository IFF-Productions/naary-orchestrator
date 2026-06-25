#!/usr/bin/env bash
# format-ts.sh — PostToolUse (Edit|Write|MultiEdit)
# Auto-formats the written TS/JS file. Non-blocking: always exits 0.
set -uo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

case "$FILE_PATH" in
  *.ts|*.tsx|*.js|*.jsx|*.json)
    [ -f "$FILE_PATH" ] && npx --yes prettier --write "$FILE_PATH" >/dev/null 2>&1 || true
    ;;
esac

exit 0

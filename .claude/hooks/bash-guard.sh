#!/usr/bin/env bash
# bash-guard.sh — PreToolUse (Bash)
# Blocks obviously destructive shell commands. exit 2 = block.
set -euo pipefail

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

[ -z "$CMD" ] && exit 0

# Destructive patterns we never want an agent to run unprompted.
if echo "$CMD" | grep -Eiq \
  'rm -rf[[:space:]]+/|rm -rf[[:space:]]+~|:\(\)\{|DROP[[:space:]]+(TABLE|DATABASE)|TRUNCATE[[:space:]]+TABLE|prisma migrate reset|prisma db push --force-reset|temporal operator namespace delete|git push[[:space:]].*(--force|-f)[[:space:]].*(main|master)|git reset --hard[[:space:]]+origin'; then
  echo "Blocked: this command is destructive and was stopped by bash-guard." >&2
  echo "If you really intend this, run it yourself outside the agent." >&2
  exit 2
fi

exit 0

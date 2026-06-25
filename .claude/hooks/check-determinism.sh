#!/usr/bin/env bash
# check-determinism.sh — PreToolUse (Edit|Write|MultiEdit)
# Blocks edits that introduce non-deterministic constructs into the Temporal
# workflow / graph-interpreter code, which break deterministic replay. exit 2 = block.
#
# Heuristic guard only. The authoritative determinism check is the Temporal replay
# test in CI (TestWorkflowEnvironment) — keep that as the real gate.
set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only police the deterministic layer. Everything else (activities, API, etc.) is free.
# Patterns cover both the flat layout and the pnpm-workspace layout
# (packages/dsl/src/walk.ts, apps/worker/src/temporal/workflows.ts).
case "$FILE_PATH" in
  *src/temporal/workflows.ts|*src/dsl/walk.ts|*.workflow.ts|*/workflows/*.ts) ;;
  *temporal/workflows.ts|*dsl/src/walk.ts) ;;
  *) exit 0 ;;
esac

CONTENT=$(echo "$INPUT" | jq -r '
  [ .tool_input.content // empty,
    .tool_input.new_string // empty,
    ( .tool_input.edits[]?.new_string // empty )
  ] | join("\n")
')

[ -z "$CONTENT" ] && exit 0

# Forbidden in deterministic workflow code — all of these belong in Activities.
# (Workflow-safe Temporal APIs like workflow.now()/sleep()/condition() are allowed.)
PATTERN='Date\.now\(|new Date\(\)|Math\.random\(|setTimeout\(|setInterval\(|process\.env|randomUUID\(|crypto\.randomBytes|require\(.fs.\)|\bfetch\(|\baxios\b|PrismaClient|\.query\('

HIT=$(echo "$CONTENT" | grep -Eo "$PATTERN" | sort -u | head -n 5 || true)

if [ -n "$HIT" ]; then
  echo "Blocked: non-deterministic construct(s) in workflow code ${FILE_PATH}:" >&2
  echo "$HIT" | sed 's/^/  - /' >&2
  echo "Workflow code must be deterministic for replay. Move I/O, time, and randomness into an Activity. (CLAUDE.md Tier 1, rules 2 & 3). Use workflow.now()/sleep()/condition() if you need workflow-safe time." >&2
  exit 2
fi

exit 0

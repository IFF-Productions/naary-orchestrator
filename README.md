# Claude Code hooks — install guide

These hooks turn the "requests" in `CLAUDE.md` into enforced gates. Hooks fire on
lifecycle events and a `PreToolUse` hook that exits **2** blocks the tool call before
it runs, feeding the reason back to Claude.

## What's here

| Script                  | Event / matcher              | Enforces |
|-------------------------|------------------------------|----------|
| `no-secrets.sh`         | PreToolUse `Edit\|Write\|MultiEdit` | No hardcoded keys or key-logging written into source (CLAUDE.md rule 4). |
| `check-determinism.sh`  | PreToolUse `Edit\|Write\|MultiEdit` | No `Date.now`, `Math.random`, I/O, etc. in workflow/interpreter files (rules 2 & 3). |
| `bash-guard.sh`         | PreToolUse `Bash`            | Blocks destructive commands (rm -rf /, DROP TABLE, prisma reset, force-push to main). |
| `format-ts.sh`          | PostToolUse `Edit\|Write\|MultiEdit` | Auto-formats written TS/JS with prettier (non-blocking). |

## Install

```bash
mkdir -p .claude/hooks
cp claude-hooks/*.sh .claude/hooks/
cp claude-hooks/settings.json .claude/settings.json   # or merge into an existing one
chmod +x .claude/hooks/*.sh                            # REQUIRED — unexecutable hooks fail silently
```

Commit `.claude/settings.json` and `.claude/hooks/` so the whole team gets the same
gates. Requires `jq` on PATH.

## Test a hook manually

```bash
echo '{"tool_name":"Write","tool_input":{"file_path":"src/x.ts","content":"const k=\"sk-ant-abc123def456ghi789jkl\""}}' \
  | .claude/hooks/no-secrets.sh; echo "exit: $?"   # expect a Blocked message and exit 2
```

## Important caveats

- **Exit 2 is the only enforcing code.** Exit 1 is treated as a non-blocking error —
  the action proceeds anyway. Every gate here uses exit 2 deliberately.
- **Hooks only run in trusted workspaces** and run with your shell's privileges —
  review every script before enabling (you should; they're short).
- **These are heuristic dev-time guards, not guarantees.** Keep the real safety nets:
  a CI secret scanner (gitleaks/trufflehog) for credentials, and the Temporal replay
  test (TestWorkflowEnvironment) as the authoritative determinism check. The hooks
  catch the common mistakes fast; CI catches the rest.

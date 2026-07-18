/**
 * Top-level router. Routes `<group> <command>` off argv, then hands the remaining
 * argv to the command (which runs its own strict per-command parseArgs). `--help`,
 * `-h`, `--version`, `-v` are intercepted before any strict parse, since a strict
 * schema would otherwise reject them at levels where they aren't declared.
 *
 * Exported (not inlined into the bin) so routing + error handling are unit-testable
 * against an injected CommandContext.
 */

import { wantsHelp, wantsVersion } from "./args";
import { ApiError, AuthError } from "./client";
import { AUTH_COMMANDS } from "./commands/auth";
import { APPROVALS_COMMANDS } from "./commands/approvals";
import { CONFIG_COMMANDS } from "./commands/config";
import { RUNS_COMMANDS } from "./commands/runs";
import { WORKFLOWS_COMMANDS } from "./commands/workflows";
import type { CommandContext } from "./context";
import { GROUP_HELP, TOP_HELP } from "./help";

type CommandFn = (argv: string[], ctx: CommandContext) => Promise<number>;

const GROUPS: Record<string, Record<string, CommandFn>> = {
  auth: AUTH_COMMANDS,
  runs: RUNS_COMMANDS,
  workflows: WORKFLOWS_COMMANDS,
  approvals: APPROVALS_COMMANDS,
  config: CONFIG_COMMANDS,
};

export async function run(
  argv: string[],
  ctx: CommandContext,
  version = "0.0.0",
): Promise<number> {
  const groupName = argv[0];

  // No args at all → top-level help.
  if (!groupName) {
    ctx.io.out(TOP_HELP);
    return 0;
  }

  const group = GROUPS[groupName];

  // --version / -v before any group is selected.
  if (!group && wantsVersion(argv)) {
    ctx.io.out(version);
    return 0;
  }

  if (!group) {
    // Top-level --help, or an unknown group.
    ctx.io.out(TOP_HELP);
    return wantsHelp(argv) ? 0 : 1;
  }

  const commandName = argv[1];
  // `naary runs` or `naary runs --help` → group help.
  if (!commandName || wantsHelp([commandName])) {
    ctx.io.out(GROUP_HELP[groupName] ?? TOP_HELP);
    return commandName ? 0 : 1;
  }

  const command = group[commandName];
  if (!command) {
    ctx.io.err(`Unknown command: ${groupName} ${commandName}`);
    ctx.io.out(GROUP_HELP[groupName] ?? TOP_HELP);
    return 1;
  }

  const rest = argv.slice(2);
  try {
    return await command(rest, ctx);
  } catch (e) {
    return handleError(e, ctx);
  }
}

function handleError(e: unknown, ctx: CommandContext): number {
  if (e instanceof AuthError) {
    ctx.io.err(e.message);
    return 1;
  }
  if (e instanceof ApiError) {
    ctx.io.err(e.message);
    return 1;
  }
  // parseArgs throws a TypeError with a helpful message on bad flags.
  const msg = e instanceof Error ? e.message : String(e);
  ctx.io.err(`Error: ${msg}`);
  return 1;
}

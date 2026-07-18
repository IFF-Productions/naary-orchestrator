/** `naary auth ...` commands. */

import { parseCommand, str } from "../args";
import {
  configPath,
  loadConfig,
  maskToken,
  readConfigFile,
  writeConfigFile,
  type ConfigFile,
} from "../config";
import type { CommandContext } from "../context";
import { GROUP_HELP } from "../help";

export async function authLogin(
  argv: string[],
  ctx: CommandContext,
): Promise<number> {
  const args = parseCommand(argv);
  if (args.help) {
    ctx.io.out(GROUP_HELP.auth);
    return 0;
  }
  const token = args.configFlags.token;
  if (!token) {
    ctx.io.err(
      "Missing --token. Usage: naary auth login --token <nry_...> [--api-url <url>]",
    );
    return 1;
  }
  // Merge onto any existing file so we don't drop a previously-saved apiUrl/env.
  const existing = readConfigFile();
  const next: ConfigFile = { ...existing, token };
  if (args.configFlags.apiUrl) next.apiUrl = args.configFlags.apiUrl;
  if (args.configFlags.env) next.env = args.configFlags.env;
  writeConfigFile(next);
  ctx.io.out(
    `Saved credentials to ${configPath()} (token ${maskToken(token)}).`,
  );
  return 0;
}

export async function authStatus(
  argv: string[],
  ctx: CommandContext,
): Promise<number> {
  const args = parseCommand(argv);
  if (args.help) {
    ctx.io.out(GROUP_HELP.auth);
    return 0;
  }
  const config = loadConfig(args.configFlags);
  ctx.io.out(`API URL: ${config.apiUrl}`);
  ctx.io.out(
    `Token:   ${config.token ? maskToken(config.token) : "(not set)"}`,
  );
  ctx.io.out(`Env:     ${config.env ?? "(default)"}`);
  ctx.io.out(`Config:  ${configPath()}`);
  return 0;
}

export const AUTH_COMMANDS: Record<
  string,
  (argv: string[], ctx: CommandContext) => Promise<number>
> = {
  login: authLogin,
  status: authStatus,
};

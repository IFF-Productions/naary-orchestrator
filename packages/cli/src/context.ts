/**
 * Shared command context. Everything a command touches for I/O and client
 * construction is injected here, so commands are testable without real stdout,
 * a real HOME, or a real network.
 */

import { ApiClient } from "./client";
import { loadConfig, type ConfigFlags, type ResolvedConfig } from "./config";

export interface IO {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface CommandContext {
  io: IO;
  /** Resolve config (flags > env > file) and build a client for it. */
  makeClient: (flags: ConfigFlags) => {
    client: ApiClient;
    config: ResolvedConfig;
  };
}

/** The default, real context: stdout/stderr + real config resolution. */
export function defaultContext(): CommandContext {
  return {
    io: {
      out: (line) => process.stdout.write(line + "\n"),
      err: (line) => process.stderr.write(line + "\n"),
    },
    makeClient: (flags) => {
      const config = loadConfig(flags);
      return { client: new ApiClient(config), config };
    },
  };
}

/** A command runs against a context + its (command-path-stripped) argv, returning an exit code. */
export type Command = (
  argv: string[],
  ctx: CommandContext,
) => Promise<number> | number;

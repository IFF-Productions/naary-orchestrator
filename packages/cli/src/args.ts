/**
 * Argument-parsing helpers built on node:util `parseArgs`.
 *
 * `parseArgs` has no notion of subcommands and is strict (throws on unknown options),
 * so we route first — pull the command-path words off argv — then run a per-command
 * `parseArgs` on the remainder with that command's option schema. Global connection
 * flags (--api-url/--token/--env) are merged into every command's schema so a command
 * can override config for a single invocation.
 */

import { parseArgs, type ParseArgsConfig } from "node:util";
import type { ConfigFlags } from "./config";

type OptionConfig = NonNullable<ParseArgsConfig["options"]>;

/** Connection flags accepted by every command. */
export const GLOBAL_OPTIONS: OptionConfig = {
  "api-url": { type: "string" },
  token: { type: "string" },
  env: { type: "string" },
  help: { type: "boolean", short: "h" },
};

export interface ParsedArgs {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
  /** Config-override flags pulled out of `values`. */
  configFlags: ConfigFlags;
  /** True if --help/-h was passed. */
  help: boolean;
}

/**
 * Parse `argv` (already stripped of the command-path words) against `options`
 * merged with the global connection flags. Positionals are allowed.
 */
export function parseCommand(
  argv: string[],
  options: OptionConfig = {},
): ParsedArgs {
  const merged: OptionConfig = { ...GLOBAL_OPTIONS, ...options };
  const { values, positionals } = parseArgs({
    args: argv,
    options: merged,
    allowPositionals: true,
    strict: true,
  });
  const v = values as Record<string, string | boolean | undefined>;
  return {
    values: v,
    positionals,
    configFlags: {
      apiUrl: typeof v["api-url"] === "string" ? v["api-url"] : undefined,
      token: typeof v.token === "string" ? v.token : undefined,
      env: typeof v.env === "string" ? v.env : undefined,
    },
    help: v.help === true,
  };
}

/** True if argv requests top-level help. */
export function wantsHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

/** True if argv requests the version. */
export function wantsVersion(argv: string[]): boolean {
  return argv.includes("--version") || argv.includes("-v");
}

/** Coerce a flag value to a string, or undefined. */
export function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Parse a flag value as an integer, or undefined. */
export function int(v: string | boolean | undefined): number | undefined {
  if (typeof v !== "string") return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? undefined : n;
}

/** True only for an explicitly-set boolean flag. */
export function bool(v: string | boolean | undefined): boolean {
  return v === true;
}

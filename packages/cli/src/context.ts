/**
 * Shared command context. Everything a command touches for I/O and client
 * construction is injected here, so commands are testable without real stdout,
 * a real HOME, or a real network.
 */

import os from "node:os";
import { openBrowser } from "./browser";
import { ApiClient, type FetchLike } from "./client";
import {
  configPath,
  loadConfig,
  type ConfigFlags,
  type ResolvedConfig,
} from "./config";
import { refreshSession } from "./session";

export interface IO {
  out: (line: string) => void;
  err: (line: string) => void;
}

/**
 * The impure surroundings `naary auth` needs: a clock, a sleep, a browser, a device name and the
 * path of the file the session lives in. Bundled (and optional) so the login/refresh code can be
 * driven by a fake clock and a temp file in tests, while every other command's context literal
 * stays exactly as it was.
 */
export interface AuthEnvironment {
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  hostname: () => string;
  openBrowser: (url: string) => boolean;
  configFile: string;
}

export interface CommandContext {
  io: IO;
  /** Resolve config (flags > env > file) and build a client for it. */
  makeClient: (flags: ConfigFlags) => {
    client: ApiClient;
    config: ResolvedConfig;
  };
  /** Defaults to the real clock/browser/`~/.naary/config.json` when omitted. */
  auth?: AuthEnvironment;
}

/** The real thing: system clock, real timers, real browser, real config path. */
export function defaultAuthEnvironment(): AuthEnvironment {
  return {
    fetch: globalThis.fetch as FetchLike,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    hostname: () => os.hostname(),
    openBrowser,
    configFile: configPath(),
  };
}

/** Resolve a context's auth environment, filling in the real one if the caller omitted it. */
export function authEnvironment(ctx: CommandContext): AuthEnvironment {
  return ctx.auth ?? defaultAuthEnvironment();
}

/** The default, real context: stdout/stderr + real config resolution. */
export function defaultContext(): CommandContext {
  const auth = defaultAuthEnvironment();
  return {
    io: {
      out: (line) => process.stdout.write(line + "\n"),
      err: (line) => process.stderr.write(line + "\n"),
    },
    makeClient: (flags) => {
      const config = loadConfig(flags);
      /**
       * Renew a 12-hour access token mid-command (#1078 §§3–4), but ONLY when the token being
       * renewed is the one we stored ourselves.
       *
       * `--token` and `NAARY_TOKEN` are deliberate overrides — typically a long-lived CI token —
       * and rotating them out from under the caller would silently substitute a different
       * credential for the one they named. `tokenSource` is what makes that distinction available
       * here at all; without it the hook would fire for every 401 and rewrite the config file on
       * behalf of a token that never came from it.
       */
      const hook =
        config.tokenSource === "file"
          ? () =>
              refreshSession({
                apiUrl: config.apiUrl,
                fetch: auth.fetch,
                file: auth.configFile,
              })
          : undefined;
      return { client: new ApiClient(config, auth.fetch, hook), config };
    },
    auth,
  };
}

/** A command runs against a context + its (command-path-stripped) argv, returning an exit code. */
export type Command = (
  argv: string[],
  ctx: CommandContext,
) => Promise<number> | number;

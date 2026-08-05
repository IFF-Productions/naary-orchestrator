/**
 * Config resolution for the naary CLI.
 *
 * Precedence (high → low): CLI flags → env vars → config file → built-in default.
 * The resolver is PURE: it takes already-read file contents and an env snapshot, so
 * it never touches `~` or `process.env` itself — that keeps precedence unit-testable
 * without writing a real HOME. The I/O helpers (read/write ~/.naary/config.json) live
 * alongside but are kept separate from the pure `resolveConfig`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Default base URL: the local **web** origin (nginx), NOT the API container's own port.
 *
 * The client appends `/api/v1` (see client.ts), and that `/api` segment is a PROXY path —
 * the API itself serves `v1/*` with no global prefix, and `apps/web/nginx.conf` rewrites
 * `^/api/(.*)` → `/$1` before proxying. So the base URL must be an origin that has that
 * proxy in front of it. This used to be `http://localhost:3000` (the API direct), which
 * composed to `http://localhost:3000/api/v1/runs` — a path nothing has ever served, so the
 * very first command anyone ran with no configuration 404'd. `http://localhost:8081` is the
 * local web origin the root README documents, and it is where the strip actually happens.
 */
export const DEFAULT_API_URL = "http://localhost:8081";

/** The shape persisted at ~/.naary/config.json. All fields optional. */
export interface ConfigFile {
  apiUrl?: string;
  token?: string;
  env?: string;
}

/** Flags a command may pass to override config for a single invocation. */
export interface ConfigFlags {
  apiUrl?: string;
  token?: string;
  env?: string;
}

/** Relevant environment variables, snapshotted. */
export interface ConfigEnv {
  NAARY_API_URL?: string;
  NAARY_TOKEN?: string;
  NAARY_ENV?: string;
}

/** The fully-resolved config the client uses. */
export interface ResolvedConfig {
  apiUrl: string;
  token?: string;
  env?: string;
}

/**
 * Merge flags > env > file > default, per field. `apiUrl` always has a value
 * (the default); `token` and `env` may be undefined.
 */
export function resolveConfig(sources: {
  flags?: ConfigFlags;
  env?: ConfigEnv;
  file?: ConfigFile;
}): ResolvedConfig {
  const flags = sources.flags ?? {};
  const env = sources.env ?? {};
  const file = sources.file ?? {};

  const pick = (...vals: Array<string | undefined>): string | undefined => {
    for (const v of vals) {
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return undefined;
  };

  return {
    apiUrl:
      pick(flags.apiUrl, env.NAARY_API_URL, file.apiUrl) ?? DEFAULT_API_URL,
    token: pick(flags.token, env.NAARY_TOKEN, file.token),
    env: pick(flags.env, env.NAARY_ENV, file.env),
  };
}

/** Mask a bearer token for display — never print the full secret. */
export function maskToken(token: string | undefined): string {
  if (!token) return "(none)";
  if (token.length <= 4) return "…" + token;
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

/** Snapshot the CLI-relevant env vars from a process env. */
export function envFromProcess(
  procEnv: NodeJS.ProcessEnv = process.env,
): ConfigEnv {
  return {
    NAARY_API_URL: procEnv.NAARY_API_URL,
    NAARY_TOKEN: procEnv.NAARY_TOKEN,
    NAARY_ENV: procEnv.NAARY_ENV,
  };
}

// --- I/O helpers (impure) --------------------------------------------------

export function configDir(): string {
  return path.join(os.homedir(), ".naary");
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

/**
 * Read + parse the config file, or {} if it does not exist / is unreadable. Only string-typed
 * `apiUrl`/`token`/`env` are kept — a corrupt file (e.g. a token stored as an object or number)
 * would otherwise produce garbage like `Bearer [object Object]` in a request header.
 */
export function readConfigFile(file: string = configPath()): ConfigFile {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const o = parsed as Record<string, unknown>;
    const clean: ConfigFile = {};
    if (typeof o.apiUrl === "string") clean.apiUrl = o.apiUrl;
    if (typeof o.token === "string") clean.token = o.token;
    if (typeof o.env === "string") clean.env = o.env;
    return clean;
  } catch {
    return {};
  }
}

/**
 * Write the config file, creating ~/.naary with 0700 and the file with 0600.
 * The file holds a bearer token, so it must not be world-readable (CLAUDE.md §4).
 */
export function writeConfigFile(
  data: ConfigFile,
  file: string = configPath(),
): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  // mkdir/writeFile `mode` is masked by umask and ignored if the path already
  // exists, so tighten explicitly.
  try {
    fs.chmodSync(dir, 0o700);
    fs.chmodSync(file, 0o600);
  } catch {
    // Best-effort on platforms without POSIX perms (e.g. Windows).
  }
}

/** Resolve config for the current process: flags + env + file. */
export function loadConfig(flags?: ConfigFlags): ResolvedConfig {
  return resolveConfig({
    flags,
    env: envFromProcess(),
    file: readConfigFile(),
  });
}

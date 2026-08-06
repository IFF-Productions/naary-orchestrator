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

/**
 * Every key we persist at ~/.naary/config.json, as data — because this list is used TWICE (the
 * type below and the read whitelist) and the two drifting is not a theoretical bug: `readConfigFile`
 * drops anything not on it, and `naary auth login`-style writes are `{...existing, …}` merges. A
 * field added to the type but forgotten in the whitelist would therefore be written once and then
 * silently deleted by the next write of any other field. Deriving both from one array makes that
 * impossible rather than merely unlikely.
 *
 * The four session fields (`refreshToken` and the three it travels with) are written by
 * `naary auth login` and rewritten on every rotation.
 */
export const CONFIG_FILE_FIELDS = [
  "apiUrl",
  "token",
  "env",
  "refreshToken",
  "tokenExpiresAt",
  "refreshTokenExpiresAt",
  "tenantId",
] as const;

/** The shape persisted at ~/.naary/config.json. All fields optional strings. */
export type ConfigFile = {
  [K in (typeof CONFIG_FILE_FIELDS)[number]]?: string;
};

/** The session fields a browser login writes — the ones `naary auth logout` clears. */
export const SESSION_FIELDS = [
  "token",
  "refreshToken",
  "tokenExpiresAt",
  "refreshTokenExpiresAt",
  "tenantId",
] as const satisfies readonly (typeof CONFIG_FILE_FIELDS)[number][];

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

/** Where the resolved token came from. Load-bearing, not diagnostics: only a token that came
 *  from the config FILE may be silently refreshed and rewritten. A `--token` flag or `NAARY_TOKEN`
 *  is a deliberate override — often a long-lived CI token — and rotating it out from under the
 *  caller would swap the credential they explicitly chose. */
export type TokenSource = "flag" | "env" | "file";

/** The fully-resolved config the client uses. */
export interface ResolvedConfig {
  apiUrl: string;
  token?: string;
  env?: string;
  /** Undefined when no token resolved at all. */
  tokenSource?: TokenSource;
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

  const token = pick(flags.token, env.NAARY_TOKEN, file.token);
  // Same precedence, evaluated once more to name the winner. `pick` skips empty strings, so a
  // `--token ""` falls through to the env var here exactly as it does above.
  const tokenSource: TokenSource | undefined =
    token === undefined
      ? undefined
      : pick(flags.token)
        ? "flag"
        : pick(env.NAARY_TOKEN)
          ? "env"
          : "file";

  return {
    apiUrl:
      pick(flags.apiUrl, env.NAARY_API_URL, file.apiUrl) ?? DEFAULT_API_URL,
    token,
    env: pick(flags.env, env.NAARY_ENV, file.env),
    tokenSource,
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
 * known fields are kept — a corrupt file (e.g. a token stored as an object or number) would
 * otherwise produce garbage like `Bearer [object Object]` in a request header.
 */
export function readConfigFile(file: string = configPath()): ConfigFile {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const o = parsed as Record<string, unknown>;
    const clean: ConfigFile = {};
    for (const key of CONFIG_FILE_FIELDS) {
      const v = o[key];
      if (typeof v === "string") clean[key] = v;
    }
    return clean;
  } catch {
    return {};
  }
}

/**
 * Write the config file, creating ~/.naary with 0700 and the file with 0600.
 * The file holds a bearer token, so it must not be world-readable (CLAUDE.md §4).
 *
 * Written to a sibling temp file and RENAMED into place, because this file now holds a refresh
 * token that is rewritten on every rotation: a crash (or two `naary` processes racing) partway
 * through a truncate-and-write leaves a half-JSON file, `readConfigFile` swallows the parse error
 * and returns `{}`, and the session is gone — both tokens, not just the one being replaced.
 * `rename` within a directory is atomic, so a reader sees the old file or the new one, never a
 * torn one. The temp name carries the pid so concurrent writers cannot land on each other's.
 */
export function writeConfigFile(
  data: ConfigFile,
  file: string = configPath(),
): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", {
      mode: 0o600,
    });
    // `mode` is masked by umask and ignored if the path already exists, so tighten explicitly —
    // and do it BEFORE the rename, so the file is never world-readable even momentarily.
    chmodQuietly(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Nothing useful to do; the original file is intact either way.
    }
    throw err;
  }
  chmodQuietly(dir, 0o700);
  // Re-assert on the final path too: the rename preserved the temp file's mode, but an existing
  // config.json created by an older CLI (or restored from a backup) is replaced wholesale here,
  // so this is also where a previously-loose file gets tightened.
  chmodQuietly(file, 0o600);
}

/** chmod, ignoring platforms without POSIX permissions (e.g. Windows). */
function chmodQuietly(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // Best-effort.
  }
}

/**
 * Merge a patch onto the file's CURRENT contents and write it back. Keys whose value is
 * `undefined` are DELETED.
 *
 * Re-reading here rather than patching a snapshot taken at process start is what keeps a rotation
 * from clobbering an unrelated field a concurrent `naary config` write just made — and, more to
 * the point, from resurrecting a session that a `logout` in another shell just cleared.
 */
export function updateConfigFile(
  patch: Partial<
    Record<(typeof CONFIG_FILE_FIELDS)[number], string | undefined>
  >,
  file: string = configPath(),
): ConfigFile {
  const next: ConfigFile = { ...readConfigFile(file) };
  for (const [key, value] of Object.entries(patch)) {
    const k = key as (typeof CONFIG_FILE_FIELDS)[number];
    if (value === undefined) delete next[k];
    else next[k] = value;
  }
  writeConfigFile(next, file);
  return next;
}

/** Resolve config for the current process: flags + env + file. */
export function loadConfig(flags?: ConfigFlags): ResolvedConfig {
  return resolveConfig({
    flags,
    env: envFromProcess(),
    file: readConfigFile(),
  });
}

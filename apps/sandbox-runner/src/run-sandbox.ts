import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { RunnerConfig } from "./config";
import {
  SANDBOX_KEY_ENV,
  assertAllowedKeyEnvVar,
  buildSandboxDockerArgs,
} from "./docker-run";

/** A safe run id — only these chars can appear in the mount path (blocks `..`/traversal
 *  that would let a caller mount an arbitrary host path into the sandbox). */
const RUN_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export interface RunRequest {
  runId: string;
  /** The coding-CLI argv (e.g. claude -p …). Data only — never shell-interpreted. */
  agentArgs: string[];
  /** The tenant's Claude Code credential — forwarded into the sandbox env under `keyEnvVar`,
   *  used, discarded. May be an API key OR a subscription setup-token. */
  authKey: string;
  /** Which env var to forward `authKey` under (allowlisted): ANTHROPIC_API_KEY for an API key,
   *  CLAUDE_CODE_OAUTH_TOKEN for a setup-token. Defaults to ANTHROPIC_API_KEY. */
  keyEnvVar?: string;
  timeoutMs?: number;
}

export interface RunResult {
  exitCode: number;
  /** The CLI's stdout (its JSON envelope). */
  stdout: string;
  /** The unified diff of the sandbox's edits to the working tree. */
  diff: string;
}

/** execFile seam — swapped in tests so no real docker/git is needed. Resolves {stdout,
 *  exitCode} even on a NON-ZERO exit; rejects on spawn failure (binary missing) OR when the
 *  child is killed (e.g. the timeout fires). */
export type Exec = (
  file: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; cwd?: string },
) => Promise<{ stdout: string; exitCode: number }>;

export const defaultExec: Exec = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        env: opts.env,
        timeout: opts.timeoutMs,
        cwd: opts.cwd,
        maxBuffer: 32 * 1024 * 1024,
      },
      (err, stdout) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (typeof code === "string" || (err as { killed?: boolean }).killed)
            return reject(err);
          return resolve({
            stdout: String(stdout),
            exitCode: typeof code === "number" ? code : 1,
          });
        }
        resolve({ stdout: String(stdout), exitCode: 0 });
      },
    );
  });

export class BadRequestError extends Error {}

/**
 * Launch ONE ephemeral, egress-isolated sandbox container for a run: mount the run's working
 * tree, run the coding CLI (Claude edits files), then capture the resulting git diff. The
 * Anthropic key is forwarded into the container BY NAME (value in the exec env), never on the
 * argv/logs. Returns the CLI output + the diff; the git token is never in scope here.
 */
export async function runSandbox(
  req: RunRequest,
  cfg: RunnerConfig,
  exec: Exec = defaultExec,
): Promise<RunResult> {
  if (!RUN_ID_RE.test(req.runId)) {
    throw new BadRequestError("invalid runId");
  }
  if (
    !Array.isArray(req.agentArgs) ||
    req.agentArgs.some((a) => typeof a !== "string")
  ) {
    throw new BadRequestError("agentArgs must be a string[]");
  }
  if (typeof req.authKey !== "string" || req.authKey.length === 0) {
    throw new BadRequestError("authKey is required");
  }
  // Default to the API-key var; validate any explicit choice against the allowlist so a caller
  // can't inject an arbitrary env var into the container.
  const keyEnvVar = req.keyEnvVar ?? SANDBOX_KEY_ENV;
  try {
    assertAllowedKeyEnvVar(keyEnvVar);
  } catch (e) {
    throw new BadRequestError(
      e instanceof Error ? e.message : "invalid keyEnvVar",
    );
  }
  // Resolve + confine the working dir to runsDir (defense in depth beyond the id regex —
  // e.g. ".." matches the regex but must not escape). The resolved path must be a strict
  // child of runsDir, never runsDir itself.
  const base = path.resolve(cfg.runsDir);
  const workdir = path.resolve(base, req.runId);
  if (workdir === base || !workdir.startsWith(base + path.sep)) {
    throw new BadRequestError("runId escapes the runs directory");
  }
  // The run dir MUST already exist (the worker writes the working tree there first). Docker
  // would otherwise auto-create a missing bind-mount source as root — letting an authed caller
  // force unbounded host writes under runsDir (DoS). Reject early if it's absent / not a dir.
  const info = await stat(workdir).catch(() => null);
  if (!info || !info.isDirectory()) {
    throw new BadRequestError("run working directory does not exist");
  }

  const dockerArgs = buildSandboxDockerArgs({
    image: cfg.image,
    network: cfg.network,
    proxyUrl: cfg.proxyUrl,
    workdir,
    agentArgs: req.agentArgs,
    keyEnvVar,
    limits: cfg.limits,
  });

  const { stdout, exitCode } = await exec("docker", dockerArgs, {
    // The credential reaches the sandbox via `-e <keyEnvVar>` (name-only in the argv) →
    // its value is read from THIS exec's env. Never inline, never logged.
    env: { ...process.env, [keyEnvVar]: req.authKey },
    timeoutMs: req.timeoutMs ?? cfg.defaultTimeoutMs,
  });

  // Capture the sandbox's edits as a diff. STAGE everything first (`git add -A`) so files the CLI
  // CREATED (untracked) are included — plain `git diff` shows tracked changes only and would
  // silently drop new files, which are a huge share of a coding agent's output. `add -A` still
  // honors .gitignore, so build artifacts don't leak into the diff. A non-zero git exit means we
  // can't trust the output as a diff (e.g. not a git repo) — surface it rather than return a
  // misleading "diff" alongside the docker exit code.
  const add = await exec("git", ["-C", workdir, "add", "-A"], {
    timeoutMs: 30_000,
  });
  if (add.exitCode !== 0) {
    throw new Error(
      "sandbox-runner: could not stage the edits (git add failed)",
    );
  }
  const git = await exec("git", ["-C", workdir, "diff", "--cached"], {
    timeoutMs: 30_000,
  });
  if (git.exitCode !== 0) {
    throw new Error("sandbox-runner: could not compute the diff (git failed)");
  }

  // Defense in depth: even though the key is forwarded by env (not argv), redact it from the
  // returned text in case the CLI echoed its env or the model wrote it into a file (→ diff).
  const redact = (s: string) =>
    req.authKey ? s.split(req.authKey).join("[REDACTED]") : s;
  return { exitCode, stdout: redact(stdout), diff: redact(git.stdout) };
}

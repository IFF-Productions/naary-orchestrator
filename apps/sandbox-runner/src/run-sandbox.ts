import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { RunnerConfig } from "./config";
import {
  ALLOWED_KEY_ENV_VARS_BY_TOOL,
  assertKeyEnvVarForTool,
  buildSandboxDockerArgs,
  isSandboxTool,
  type SandboxTool,
} from "./docker-run";

/** A safe run id — only these chars can appear in the mount path (blocks `..`/traversal
 *  that would let a caller mount an arbitrary host path into the sandbox). */
const RUN_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Which working tree the sandbox runs against.
 *
 *  - `"repo"` (default, the codeAgent write/read-with-repo path): the CALLER has already
 *    materialized a git working tree at `<runsDir>/<runId>`; we mount it and afterwards capture
 *    the CLI's edits as a staged diff.
 *  - `"ephemeral"` (#680): there is no repo at all — a prompt-in / JSON-out call (the api's
 *    `claude-code` AI-generate source, and a codeAgent READ node with no `repo`). The RUNNER
 *    creates a fresh empty directory under `runsDir`, mounts THAT, and deletes it afterwards; no
 *    git is involved, so no diff is produced.
 *
 * The runner (not the caller) owns the ephemeral directory on purpose: `runsDir` is a host bind
 * mount that only the runner has, so a caller with no repo needs nothing but HTTP. The alternative
 * — "the caller mkdirs it first" — would have forced the shared writable host mount onto the
 * internet-facing api container just to satisfy this function's stat() check.
 *
 * Both modes produce the SAME `docker run` argv (`buildSandboxDockerArgs` is untouched): pinned
 * image, internal no-gateway network, read-only root, cap-drop ALL, no-new-privileges, resource
 * caps, credential forwarded by name. Ephemeral differs only in who created the mounted directory
 * and in skipping git.
 */
export type Workspace = "repo" | "ephemeral";

export interface RunRequest {
  /** Repo mode: the id of the PRE-EXISTING working tree under `runsDir`. IGNORED in ephemeral
   *  mode (the runner generates its own id), so a caller can never influence that mount path. */
  runId?: string;
  /** Default `"repo"` — the pre-#680 behavior, so an older caller is unaffected. */
  workspace?: Workspace;
  /**
   * WHICH coding CLI to run — a member of the closed `SANDBOX_TOOLS` set, defaulting to "claude".
   * The runner maps it to an image from ITS OWN config; the request never names an image (the
   * runner holds the Docker socket, so a request-chosen image would be a host-root injection).
   */
  tool?: SandboxTool;
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
  /** The CLI's stderr. Returned because it is often the ONLY signal when the CLI dies before
   *  emitting its JSON envelope (an auth rejection, a proxy/egress failure) — without it a caller
   *  can only report a generic failure on exactly the hardest case to diagnose. Redacted like
   *  stdout. */
  stderr: string;
  /** The unified diff of the sandbox's edits to the working tree. Always `""` in ephemeral mode
   *  (there is no repo to diff). */
  diff: string;
}

/** execFile seam — swapped in tests so no real docker/git is needed. Resolves {stdout, stderr,
 *  exitCode} even on a NON-ZERO exit; rejects on spawn failure (binary missing) OR when the
 *  child is killed (e.g. the timeout fires). */
export type Exec = (
  file: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; cwd?: string },
) => Promise<{ stdout: string; stderr?: string; exitCode: number }>;

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
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (typeof code === "string" || (err as { killed?: boolean }).killed)
            return reject(err);
          return resolve({
            stdout: String(stdout),
            stderr: String(stderr),
            exitCode: typeof code === "number" ? code : 1,
          });
        }
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
          exitCode: 0,
        });
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
  const workspace: Workspace = req.workspace ?? "repo";
  if (workspace !== "repo" && workspace !== "ephemeral") {
    throw new BadRequestError('workspace must be "repo" or "ephemeral"');
  }
  // Repo mode only: the caller names an EXISTING tree, so the id becomes part of a mount path and
  // must be validated. Ephemeral ids are generated below and never caller-influenced.
  if (workspace === "repo" && !RUN_ID_RE.test(req.runId ?? "")) {
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
  // A wrong-typed keyEnvVar (number/object) would otherwise fall through to a misleading
  // "un-allowlisted" error — reject it explicitly with a clear message.
  if (req.keyEnvVar !== undefined && typeof req.keyEnvVar !== "string") {
    throw new BadRequestError("keyEnvVar must be a string");
  }
  // Resolve the tool FIRST — it selects both the image and the credential vars that are legal.
  // Rejected outright if it isn't a member of the closed set (never coerced to a default).
  if (req.tool !== undefined && !isSandboxTool(req.tool)) {
    throw new BadRequestError("unknown tool");
  }
  const tool: SandboxTool = req.tool ?? "claude";
  // Default to the tool's PRIMARY var; validate any explicit choice against THAT TOOL's allowlist,
  // so a caller can neither inject an arbitrary env var nor forward another tool's credential.
  const keyEnvVar = req.keyEnvVar ?? ALLOWED_KEY_ENV_VARS_BY_TOOL[tool][0];
  try {
    assertKeyEnvVarForTool(keyEnvVar, tool);
  } catch (e) {
    throw new BadRequestError(
      e instanceof Error ? e.message : "invalid keyEnvVar",
    );
  }
  // Resolve + confine the working dir to runsDir (defense in depth beyond the id regex —
  // e.g. ".." matches the regex but must not escape). The resolved path must be a strict
  // child of runsDir, never runsDir itself.
  const base = path.resolve(cfg.runsDir);
  const workdir = path.resolve(
    base,
    // Ephemeral: a RUNNER-generated id. `req.runId` is deliberately not consulted — a caller with
    // no repo has no legitimate say in the mount path, so this mode has no traversal surface at all.
    workspace === "ephemeral"
      ? `eph-${randomBytes(16).toString("hex")}`
      : (req.runId as string),
  );
  if (workdir === base || !workdir.startsWith(base + path.sep)) {
    throw new BadRequestError("runId escapes the runs directory");
  }

  if (workspace === "ephemeral") {
    // Create the empty tree ourselves. `recursive: false` so an id collision (never, in practice —
    // 128 bits) errors instead of silently reusing a live run's directory. The sandbox runs as an
    // unprivileged uid while the runner is root, so widen the mode explicitly (mkdir's `mode` is
    // masked by the process umask, hence the separate chmod): the CLI needs a writable cwd. It is
    // an empty, per-run directory that the `finally` below always removes.
    await mkdir(workdir, { recursive: false });
    await chmod(workdir, 0o777);
  } else {
    // The run dir MUST already exist (the worker writes the working tree there first). Docker
    // would otherwise auto-create a missing bind-mount source as root — letting an authed caller
    // force unbounded host writes under runsDir (DoS). Reject early if it's absent / not a dir.
    const info = await stat(workdir).catch(() => null);
    if (!info || !info.isDirectory()) {
      throw new BadRequestError("run working directory does not exist");
    }
  }

  try {
    const dockerArgs = buildSandboxDockerArgs(
      {
        // tool → image, from RUNNER config only. `buildSandboxDockerArgs` re-asserts the pin.
        image: cfg.images[tool],
        network: cfg.network,
        proxyUrl: cfg.proxyUrl,
        workdir,
        agentArgs: req.agentArgs,
        keyEnvVar,
        limits: cfg.limits,
      },
      // The allowlist is the OPERATOR's configured set, not a compile-time list of `:latest`
      // tags — that is what makes a digest-pinned production image launchable at all. Yes, this
      // makes the assertion tautological AT THIS call site; it stays because it is the backstop
      // for any future caller that builds a spec from something other than `cfg.images`.
      Object.values(cfg.images),
    );

    const {
      stdout,
      stderr = "",
      exitCode,
    } = await exec("docker", dockerArgs, {
      // The credential reaches the sandbox via `-e <keyEnvVar>` (name-only in the argv) →
      // its value is read from THIS exec's env. Never inline, never logged.
      env: { ...process.env, [keyEnvVar]: req.authKey },
      timeoutMs: req.timeoutMs ?? cfg.defaultTimeoutMs,
    });

    // Defense in depth: even though the key is forwarded by env (not argv), redact it from the
    // returned text in case the CLI echoed its env or the model wrote it into a file (→ diff).
    const redact = (s: string) =>
      req.authKey ? s.split(req.authKey).join("[REDACTED]") : s;

    // Ephemeral: no repo, so nothing to stage or diff. Running git here would fail ("not a git
    // repository") and turn a perfectly good prompt-in/JSON-out run into a 500.
    if (workspace === "ephemeral") {
      return {
        exitCode,
        stdout: redact(stdout),
        stderr: redact(stderr),
        diff: "",
      };
    }

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
      throw new Error(
        "sandbox-runner: could not compute the diff (git failed)",
      );
    }

    return {
      exitCode,
      stdout: redact(stdout),
      stderr: redact(stderr),
      diff: redact(git.stdout),
    };
  } finally {
    // Ephemeral trees are OURS — always remove them, including when docker throws/times out, so a
    // failing run can't accumulate directories under runsDir. Repo trees belong to the caller (the
    // worker's write path removes its own clone in its own finally), so they're left alone.
    if (workspace === "ephemeral") {
      await rm(workdir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}

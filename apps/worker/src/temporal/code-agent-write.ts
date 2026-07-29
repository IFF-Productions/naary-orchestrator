/**
 * codeAgent SANDBOX DISPATCH (design docs/design/CLAUDE-CODE-NODE.md §2.2 + Slice 2). Since #680
 * this is the ONLY way a codeAgent node runs — read and write alike; the in-worker exec is gone.
 *
 * The two-box split: the ACTIVITY (this file, outside the sandbox) does all git I/O — resolve the
 * GitHub App token and clone the repo into the shared runs dir — then dispatches to the sandbox-
 * RUNNER, which mounts that working tree into an egress-isolated container and runs the CLI. The
 * git token NEVER leaves this box: it is not put on any argv (a `credential.helper` reads it from
 * the child's env), not written to disk, and NOT included in the runner request (the runner only
 * ever receives the Anthropic/Claude Code credential). The runner returns the diff of the edits.
 * A read node with no repo skips this box entirely and runs in the runner's ephemeral workspace.
 *
 * Pure-ish + seam-injected (`__codeAgentWriteDeps`) so the orchestration is unit-testable without a
 * real runner, git, or GitHub App.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { ApplicationFailure } from "@temporalio/activity";
import { GITHUB_API, resolveAuthHeader } from "@naary/connections";

/** owner/name — conservative: repo path segments only, no protocol/host/`..`. */
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * A deterministic, runner-safe run id (matches the runner's `RUN_ID_RE` `^[A-Za-z0-9._-]{1,128}$`).
 * We HASH executionId+nodeId rather than concatenate them: a user-named nodeId can contain spaces/
 * slashes that the runner would reject (or that could alter the mount path). Deterministic → the
 * same node re-run reuses the same id (idempotent), and it never collides across nodes/executions.
 */
export function sandboxRunId(executionId: string, nodeId: string): string {
  const h = createHash("sha256")
    .update(`${executionId}\0${nodeId}`)
    .digest("hex");
  return `ca-${h.slice(0, 40)}`;
}

export interface CodeAgentWriteEnv {
  runnerUrl: string;
  runnerToken: string;
  /** Shared same-path host bind mount the worker clones into + the runner mounts (Slice 2b). */
  runsDir: string;
  /** Master gate — write mode is OFF until the runner is wired + egress proven on the deploy host.
   *  READ has NO gate: since #680 it is always sandboxed, so there is nothing to opt into. */
  writeEnabled: boolean;
}

/** Read the write-path config from the environment (all worker config, never workflow args). */
export function codeAgentWriteEnv(): CodeAgentWriteEnv {
  return {
    runnerUrl: process.env.SANDBOX_RUNNER_URL ?? "",
    runnerToken: process.env.SANDBOX_RUNNER_TOKEN ?? "",
    runsDir: process.env.CODE_AGENT_RUNS_DIR ?? "",
    writeEnabled: process.env.CODE_AGENT_WRITE_ENABLED === "true",
  };
}

export interface CodeAgentWriteParams {
  tenantId: string;
  executionId: string;
  nodeId: string;
  /**
   * Which posture to run in the sandbox. "write" (default) clones, dispatches write argv, and can
   * open a PR. "read" (#594/#680) uses the SAME isolated dispatch with read-only argv (Read/Grep/
   * Glob, plan mode) and NO PR. Since #680 read has no in-worker alternative — it is ALWAYS
   * sandboxed. The two-box credential split is identical: when there is a repo, the git token
   * clones outside the sandbox and never enters the runner.
   */
  mode?: "read" | "write";
  /** WHICH coding CLI to run (`driver.tool`). The runner maps it to that tool's OWN pinned image
   *  — the request never names an image. Omitted ⇒ the runner defaults to claude. */
  tool?: string;
  /** Required for write. OPTIONAL for read: a read node with no repo runs against an EMPTY
   *  ephemeral tree the runner creates (there is nothing to clone, and no git token involved). */
  repo?: string;
  branch?: string;
  /** Required whenever `repo` is set (it authorizes the clone); unused for an ephemeral read. */
  connectionId?: string;
  /** The CLI argv (already built for the mode by the driver). */
  agentArgs: string[];
  /** The Claude Code credential value + the env var to forward it under (from driver.authEnv). */
  authKey: string;
  keyEnvVar: string;
  timeoutMs?: number;
  /** Open a PR from the sandbox's edits (#444). Off ⇒ just return the diff. */
  openPr?: boolean;
  prTitle?: string;
  prBody?: string;
  commitMessage?: string;
  /** Head branch to create/push (node-owned, force-pushed). Default `naary/code-agent/<runId>`. */
  headBranch?: string;
}

export interface CodeAgentWriteResult {
  exitCode: number;
  /** The CLI's stdout (JSON envelope). */
  stdout: string;
  /** The CLI's stderr — often the only signal when it dies before emitting its envelope. */
  stderr?: string;
  /** Unified diff of the sandbox's edits. Always "" for a read run. */
  diff: string;
  /** Opened (or already-existing) PR when `openPr` succeeded and the diff was non-empty (#444). */
  pr?: { number: number; url: string; branch: string };
}

type Exec = (
  file: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<{ stdout: string; exitCode: number }>;

const defaultExec: Exec = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { env: opts.env, timeout: opts.timeoutMs, maxBuffer: 32 * 1024 * 1024 },
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

/** Test seam: git token resolution, the git/rm subprocess, and the runner HTTP call. */
export const __codeAgentWriteDeps = {
  resolveAuthHeader,
  exec: defaultExec,
  // Plain fetch (NOT safeFetch): the runner is an INTERNAL host, which safeFetch would block as
  // SSRF. The runner URL is trusted worker config, never workflow-controlled.
  fetch: (url: string, init: RequestInit): Promise<Response> =>
    fetch(url, init),
  // Separate seam for the GitHub REST API (#444): a FIXED public host (api.github.com), so the
  // internal-runner-vs-public-API distinction stays legible and tests assert PR params directly
  // instead of URL-sniffing the runner seam. Plain fetch — the host is a constant, never
  // workflow-controlled, so there's no SSRF surface to guard.
  githubFetch: (url: string, init: RequestInit): Promise<Response> =>
    fetch(url, init),
};

function nonRetryable(message: string, type: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(message, type);
}

/** POST the run to the sandbox runner and normalize its response. Shared by every posture — the
 *  body carries the CLI argv + the ANTHROPIC credential and NEVER the git token. */
async function dispatchToRunner(
  env: CodeAgentWriteEnv,
  body: Record<string, unknown>,
): Promise<CodeAgentWriteResult> {
  const res = await __codeAgentWriteDeps.fetch(`${env.runnerUrl}/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.runnerToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw nonRetryable(
      `codeAgent: the sandbox runner returned ${res.status}.`,
      "CODE_AGENT_RUNNER_ERROR",
    );
  }
  const parsed = (await res.json()) as CodeAgentWriteResult;
  return {
    exitCode: parsed.exitCode ?? 0,
    stdout: typeof parsed.stdout === "string" ? parsed.stdout : "",
    stderr: typeof parsed.stderr === "string" ? parsed.stderr : "",
    diff: typeof parsed.diff === "string" ? parsed.diff : "",
  };
}

/**
 * Run the coding CLI in the isolated sandbox. Three shapes, one dispatch:
 *
 *  - write        — clone `repo` (outside the sandbox, with the App token), run edit-mode argv,
 *                   return the diff, optionally open a PR.
 *  - read + repo  — same clone + dispatch, read-only argv, no PR.
 *  - read, no repo — nothing to clone: the RUNNER creates an empty ephemeral tree (#680). This is
 *                   what a plain "ask the agent" node is, and before #680 it was the un-sandboxed
 *                   in-worker exec that could read the worker's own filesystem (#594).
 *
 * Always cleans up any working tree it created. Throws non-retryable on config / gate / clone
 * failures (a user or operator must fix them; at-most-once means no auto-retry anyway).
 */
export async function runCodeAgentWrite(
  params: CodeAgentWriteParams,
  env: CodeAgentWriteEnv = codeAgentWriteEnv(),
): Promise<CodeAgentWriteResult> {
  const mode = params.mode ?? "write";
  // Write keeps its master gate — it is destructive (edits + opens PRs). Read has no gate: since
  // #680 it is sandboxed unconditionally, so there is no un-isolated fallback to opt out of.
  if (mode === "write" && !env.writeEnabled) {
    throw nonRetryable(
      "codeAgent write mode is disabled on this worker.",
      "CODE_AGENT_WRITE_DISABLED",
    );
  }
  if (!env.runnerUrl || !env.runnerToken) {
    throw nonRetryable(
      "codeAgent requires the sandbox runner, which is not configured on this worker. Deploy it (COMPOSE_PROFILES=sandbox + SANDBOX_RUNNER_TOKEN — see deploy/sandbox/README.md) and set SANDBOX_RUNNER_URL/SANDBOX_RUNNER_TOKEN.",
      "CODE_AGENT_SANDBOX_UNCONFIGURED",
    );
  }

  // No repo ⇒ nothing to clone, no git token, no runs-dir mount on this side: hand the whole run to
  // the runner's ephemeral workspace. Only legal for read — write must have something to edit.
  if (!params.repo) {
    if (mode === "write") {
      throw nonRetryable(
        "codeAgent write mode requires `repo`.",
        "CODE_AGENT_WRITE_CONFIG",
      );
    }
    return dispatchToRunner(env, {
      workspace: "ephemeral",
      tool: params.tool,
      agentArgs: params.agentArgs,
      authKey: params.authKey,
      keyEnvVar: params.keyEnvVar,
      timeoutMs: params.timeoutMs,
    });
  }

  // From here on there IS a repo: the two-box clone path.
  if (!env.runsDir) {
    throw nonRetryable(
      "codeAgent sandbox is not configured (CODE_AGENT_RUNS_DIR must match the runner's SANDBOX_RUNS_DIR).",
      "CODE_AGENT_SANDBOX_UNCONFIGURED",
    );
  }
  // `..` matches REPO_RE's char class (`.` is allowed for names like `org/.github`), so reject a
  // traversal segment explicitly — a repo string must never be able to walk paths in the URL.
  if (!REPO_RE.test(params.repo) || params.repo.includes("..")) {
    throw nonRetryable(
      `codeAgent: invalid repo "${params.repo}" (expected owner/name).`,
      "CODE_AGENT_BAD_REPO",
    );
  }
  if (!params.connectionId) {
    throw nonRetryable(
      "codeAgent requires a GitHub App connection to clone a repo.",
      "CODE_AGENT_NO_CONNECTION",
    );
  }

  // Resolve a short-lived install token via the SAME tested path the integration nodes use.
  const authHeader = await __codeAgentWriteDeps.resolveAuthHeader(
    params.tenantId,
    params.connectionId,
  );
  const gitToken = (authHeader.Authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!gitToken) {
    throw nonRetryable(
      "codeAgent: the connection did not yield a usable git token.",
      "CODE_AGENT_NO_TOKEN",
    );
  }

  const runId = sandboxRunId(params.executionId, params.nodeId);
  // Confine the workdir strictly under runsDir (defense in depth beyond the hashed id).
  const base = path.resolve(env.runsDir);
  const workdir = path.resolve(base, runId);
  if (workdir === base || !workdir.startsWith(base + path.sep)) {
    throw nonRetryable(
      "codeAgent: computed workdir escaped runsDir.",
      "CODE_AGENT_BAD_WORKDIR",
    );
  }

  // Git subprocess env shared by clone + (write+PR) push: the token rides in GIT_TOKEN, read by a
  // `credential.helper` injected via GIT_CONFIG_* (never on any argv). Reused so push authenticates
  // exactly like clone — the token stays in THIS box (never the sandbox, never an argv, never a log).
  const gitEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_TERMINAL_PROMPT: "0",
    GIT_TOKEN: gitToken,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0:
      '!f() { echo username=x-access-token; echo "password=$GIT_TOKEN"; }; f',
  };

  try {
    // Clone WITHOUT the token on the argv or in the URL: the credential.helper reads it from
    // GIT_TOKEN in the child env. The argv carries only the plain https URL + flags.
    const cloneArgs = [
      "clone",
      "--depth",
      "1",
      "--single-branch",
      ...(params.branch ? ["--branch", params.branch] : []),
      `https://github.com/${params.repo}.git`,
      workdir,
    ];
    const clone = await __codeAgentWriteDeps.exec("git", cloneArgs, {
      env: gitEnv,
      timeoutMs: 120_000,
    });
    if (clone.exitCode !== 0) {
      // Message is generic — the clone stderr could echo the URL; never surface it to history.
      throw nonRetryable(
        "codeAgent: git clone failed (check the repo, branch, and connection access).",
        "CODE_AGENT_CLONE_FAILED",
      );
    }

    // Dispatch the cloned tree to the runner (workspace "repo" — the default).
    const result = await dispatchToRunner(env, {
      runId,
      tool: params.tool,
      agentArgs: params.agentArgs,
      authKey: params.authKey,
      keyEnvVar: params.keyEnvVar,
      timeoutMs: params.timeoutMs,
    });

    // Write + PR (#444): only when asked, the CLI succeeded (exit 0), and it actually produced
    // changes (non-empty staged diff — the runner already ran `git add -A`). An empty diff is a
    // clean no-op: return no `pr`, don't error. Done HERE (before the finally rm) because the PR
    // must be opened while the clone still exists on disk.
    if (params.openPr && result.exitCode === 0 && result.diff.trim() !== "") {
      result.pr = await openPullRequest(
        params,
        params.repo,
        workdir,
        gitEnv,
        gitToken,
      );
    }
    return result;
  } finally {
    // Always remove the working tree — it may hold repo contents + the CLI's edits.
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** GitHub REST headers. A `User-Agent` is MANDATORY (GitHub 403s without it); the version pin +
 *  Accept select the stable JSON API. Bearer is the install token — used only for this box's calls. */
function githubHeaders(gitToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${gitToken}`,
    accept: "application/vnd.github+json",
    "user-agent": "naary-code-agent",
    "x-github-api-version": "2022-11-28",
  };
}

/**
 * Commit the sandbox's (already-staged) edits to a node-owned branch, push it, and open a PR (#444).
 * Runs OUTSIDE the sandbox with the install token — the two-box invariant holds (the sandbox never
 * saw the token). Idempotent on re-run: the head branch is deterministic + force-pushed, and a PR
 * that already exists (422) is fetched and returned rather than treated as an error.
 */
async function openPullRequest(
  params: CodeAgentWriteParams,
  /** Passed explicitly: `params.repo` is optional on the type (an ephemeral read has none), but a
   *  PR is only ever opened on the repo branch, where it is known-present. */
  repo: string,
  workdir: string,
  gitEnv: NodeJS.ProcessEnv,
  gitToken: string,
): Promise<{ number: number; url: string; branch: string }> {
  const headBranch =
    params.headBranch?.trim() ||
    `naary/code-agent/${sandboxRunId(params.executionId, params.nodeId)}`;
  const title = params.prTitle?.trim() || "Naary code agent changes";
  const commitMessage = params.commitMessage?.trim() || title;
  const body =
    params.prBody ?? "Automated changes by the Naary code-agent node.";
  const owner = repo.split("/")[0];

  // Commit onto a fresh node-owned branch. The runner already `git add -A`'d, so the edits are
  // staged and carry across the checkout; identity is passed via `-c` (no global git config needed).
  const git = (args: string[], timeoutMs = 60_000) =>
    __codeAgentWriteDeps.exec("git", ["-C", workdir, ...args], {
      env: gitEnv,
      timeoutMs,
    });
  const checkout = await git(["checkout", "-B", headBranch]);
  if (checkout.exitCode !== 0) {
    throw nonRetryable(
      "codeAgent: could not create the PR branch.",
      "CODE_AGENT_PR_BRANCH_FAILED",
    );
  }
  const commit = await git([
    "-c",
    "user.name=Naary Code Agent",
    "-c",
    "user.email=code-agent@users.noreply.github.com",
    "commit",
    "-m",
    commitMessage,
  ]);
  if (commit.exitCode !== 0) {
    throw nonRetryable(
      "codeAgent: could not commit the edits for the PR.",
      "CODE_AGENT_PR_COMMIT_FAILED",
    );
  }
  // Force-push the node-owned branch so a re-run updates it (the branch is namespaced to this node).
  const push = await git(
    ["push", "--force", "origin", `HEAD:refs/heads/${headBranch}`],
    120_000,
  );
  if (push.exitCode !== 0) {
    throw nonRetryable(
      "codeAgent: could not push the PR branch (check the connection has contents:write).",
      "CODE_AGENT_PR_PUSH_FAILED",
    );
  }

  // Resolve the base branch explicitly — the pulls API requires it. Use the configured clone branch,
  // else look up the repo's default branch (never guess/send empty).
  let base = params.branch?.trim();
  if (!base) {
    const repoRes = await __codeAgentWriteDeps.githubFetch(
      `${GITHUB_API}/repos/${repo}`,
      { method: "GET", headers: githubHeaders(gitToken) },
    );
    if (!repoRes.ok) {
      throw nonRetryable(
        "codeAgent: could not resolve the repo's default branch for the PR base.",
        "CODE_AGENT_PR_BASE_FAILED",
      );
    }
    base = ((await repoRes.json()) as { default_branch?: string })
      .default_branch;
    if (!base) {
      throw nonRetryable(
        "codeAgent: the repo returned no default branch.",
        "CODE_AGENT_PR_NO_BASE",
      );
    }
  }

  const prRes = await __codeAgentWriteDeps.githubFetch(
    `${GITHUB_API}/repos/${repo}/pulls`,
    {
      method: "POST",
      headers: {
        ...githubHeaders(gitToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ title, head: headBranch, base, body }),
    },
  );
  if (prRes.ok) {
    const pr = (await prRes.json()) as { number: number; html_url: string };
    return { number: pr.number, url: pr.html_url, branch: headBranch };
  }
  // Idempotency: a 422 means a PR for this head→base already exists (re-run). Fetch + return it
  // rather than failing — the force-push above already updated that same branch's contents.
  if (prRes.status === 422) {
    const existing = await __codeAgentWriteDeps.githubFetch(
      `${GITHUB_API}/repos/${repo}/pulls?head=${owner}:${headBranch}&state=open`,
      { method: "GET", headers: githubHeaders(gitToken) },
    );
    if (existing.ok) {
      const list = (await existing.json()) as Array<{
        number: number;
        html_url: string;
      }>;
      if (Array.isArray(list) && list.length > 0) {
        return {
          number: list[0].number,
          url: list[0].html_url,
          branch: headBranch,
        };
      }
    }
  }
  throw nonRetryable(
    `codeAgent: opening the pull request failed (${prRes.status}).`,
    "CODE_AGENT_PR_OPEN_FAILED",
  );
}

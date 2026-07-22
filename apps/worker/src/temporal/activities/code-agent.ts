// codeAgent node — headless coding CLI (claude -p) as a BYOK activity.
import { createLogger } from "@naary/logging";
import { execFile } from "node:child_process";
import { ApplicationFailure } from "@temporalio/activity";
import { getDefaultEnvironmentId } from "@naary/db";
import { MissingCredentialError } from "@naary/secrets";
import { type ClaimCheck, getObjectStore, maybeOffload } from "@naary/storage";
import { computeCost, recordUsage } from "@naary/usage";
import {
  activityDuration,
  activityRuns,
  runCostUsd,
  secondsSince,
} from "../../metrics";
import {
  type CodeAgentTool,
  resolveDriver,
  type TraceStep,
} from "../code-agent-drivers";
import { codeAgentWriteEnv, runCodeAgentWrite } from "../code-agent-write";
import { type AgentMeta, estimateTokens, getCredentials } from "./shared";

// Activities run in the worker PROCESS (a side-effect zone), so structured
// logging is fine here — unlike workflows.ts, which must stay deterministic.
// Logs carry execution-correlated ids (executionId/nodeId/tenantId) and token/
// cost numbers only — never prompts, completions, or keys (the logger scrubs).
const log = createLogger({ component: "worker" });

/** codeAgent config the activity needs (a subset of CodeAgentNodeConfig, resolved by the
 *  interpreter — `prompt` already has its `{{…}}` templating applied). */
export interface CodeAgentActivityConfig {
  tool?: CodeAgentTool;
  prompt: string;
  systemPrompt?: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  costUsd?: number;
  /** "write" clones `repo` and edits it in the sandbox (Slice 2c); default/"read" runs in-worker. */
  mode?: "read" | "write";
  repo?: string;
  branch?: string;
  connectionId?: string;
  /** Write mode + PR (#444): commit the edits to a branch, push, open a PR. */
  openPr?: boolean;
  prTitle?: string;
  prBody?: string;
  commitMessage?: string;
  headBranch?: string;
}
export interface CodeAgentResult {
  status: "ok";
  /** The CLI's final text (a plan/summary in read-only mode) + trace metadata. In write mode,
   *  `diff` carries the sandbox's edits: the inline unified-diff string, or a `ClaimCheck`
   *  reference (`{ __claimCheck, bytes }`) when large (resolved at the activity boundary). */
  output: {
    result: string;
    tool: string;
    sessionId?: string;
    diff?: string | ClaimCheck;
    /** Compact step-by-step execution trace (what the agent read/grepped, its reasoning) from
     *  the CLI's `stream-json` stream. Inline `TraceStep[]`, or a `ClaimCheck` reference when
     *  large (offloaded with the SAME claim-check mechanism as `diff`, resolved at the API
     *  boundary) so it never bloats Temporal history. */
    trace?: TraceStep[] | ClaimCheck;
    /** Opened (or already-existing) PR when write mode + `openPr` produced changes (#444). */
    pr?: { number: number; url: string; branch: string };
  };
  costUsd: number;
}

/**
 * Test seam: the credential source, usage sink, and the CLI subprocess runner — swappable
 * so the activity's orchestration (in-activity key fetch, billing fallback, error mapping)
 * is unit-testable without a live `claude` binary or DB.
 */
export const __codeAgentDeps = {
  getCredentials,
  getDefaultEnvId: getDefaultEnvironmentId,
  recordUsage,
  /** Run the CLI; resolve {stdout, exitCode} even on a non-zero exit (the CLI may still
   *  emit its JSON envelope), reject only on spawn failure (binary missing) / timeout. */
  exec: (
    binary: string,
    args: string[],
    opts: { env: NodeJS.ProcessEnv; timeoutMs?: number },
  ): Promise<{ stdout: string; exitCode: number }> =>
    new Promise((resolve, reject) => {
      const child = execFile(
        binary,
        args,
        {
          env: opts.env,
          timeout: opts.timeoutMs,
          // `--output-format stream-json --verbose` streams the FULL NDJSON — every assistant
          // message AND every tool_result (which carries read file contents) — so a read run over
          // a real codebase emits far more stdout than the old single-envelope `json` mode did.
          // Buffer generously: on overflow execFile DISCARDS stdout and fails the run with no
          // trace AND no result (a regression), so we'd rather hold the bytes. We keep only a
          // bounded, truncated slice of this (see the driver's trace caps) — the buffer is transient.
          maxBuffer: 256 * 1024 * 1024,
        },
        (err, stdout) => {
          if (err) {
            const code = (err as NodeJS.ErrnoException).code;
            // Spawn failure (ENOENT: binary not installed) or timeout (killed) → hard fail.
            if (
              typeof code === "string" ||
              (err as { killed?: boolean }).killed
            )
              return reject(err);
            // Otherwise the process ran and exited non-zero — keep its stdout.
            return resolve({
              stdout: String(stdout),
              exitCode: typeof code === "number" ? code : 1,
            });
          }
          resolve({ stdout: String(stdout), exitCode: 0 });
        },
      );
      // Close stdin (EOF) so `claude` doesn't block ~3s waiting for it — the prompt is passed via
      // args, not stdin (same fix as the graph-generator's CLI exec).
      child.stdin?.end();
    }),
  /** Write-mode dispatch: clone (outside the sandbox) → sandbox-runner → diff. Seam so the
   *  activity's orchestration is tested without a real runner/git. */
  runWrite: runCodeAgentWrite,
};

/**
 * codeAgent node (design docs/design/CLAUDE-CODE-NODE.md). Runs an agentic coding CLI via a
 * driver (Slice 1: `claude -p` in plan mode, read-only). Mirrors runAgent's envelope: BYOK
 * key fetched IN-ACTIVITY (per-`execFile` env, never a workflow arg/return, never logged),
 * fail-safe usage (never bills zero), and auth/quota → non-retryable so Temporal doesn't
 * burn retries on a credential the user must fix. At-most-once (`maximumAttempts: 1`).
 */
export async function callCodeAgent(
  cfg: CodeAgentActivityConfig,
  input: unknown,
  meta: AgentMeta,
): Promise<CodeAgentResult> {
  const startedAt = process.hrtime.bigint();
  try {
    const driver = resolveDriver(cfg.tool);
    // In memory only — injected as the subprocess env var, never returned/logged. Env-scoped creds:
    // the run's env (5b) selects the key; a pre-5b run falls back to the tenant default. See runAgent.
    const envId =
      meta.environmentId ??
      (await __codeAgentDeps.getDefaultEnvId(meta.tenantId));
    const apiKey = await __codeAgentDeps
      .getCredentials()
      .getDecryptedKey(meta.tenantId, envId, driver.credentialProvider);

    const write = cfg.mode === "write";
    const args = driver.buildArgs({
      prompt: cfg.prompt,
      systemPrompt: cfg.systemPrompt,
      model: cfg.model,
      maxTurns: cfg.maxTurns,
      maxBudgetUsd: cfg.maxBudgetUsd,
      write,
    });

    let stdout: string;
    let exitCode: number;
    let diff: string | undefined;
    let pr: { number: number; url: string; branch: string } | undefined;
    if (write) {
      // WRITE (Slice 2c): dispatch to the isolated sandbox-runner. The activity (here) clones the
      // repo with the git token OUTSIDE the sandbox; the runner only ever gets the Claude Code
      // credential (via the driver's chosen env var) — never the git token. The runner returns a diff.
      if (!cfg.repo || !cfg.connectionId) {
        throw ApplicationFailure.nonRetryable(
          "codeAgent write mode requires `repo` and a GitHub App `connectionId`.",
          "CODE_AGENT_WRITE_CONFIG",
        );
      }
      // authEnv gives { [varName]: value } — the contract is EXACTLY one entry (the CLI reads a
      // single auth var). Assert it rather than blindly destructure `[0]` (a future driver
      // returning 0 or >1 entries would otherwise crash or forward an ambiguous credential).
      const authEntries = Object.entries(driver.authEnv(apiKey));
      if (authEntries.length !== 1) {
        throw ApplicationFailure.nonRetryable(
          `codeAgent: driver "${driver.tool}" must resolve exactly one auth env var.`,
          "CODE_AGENT_BAD_AUTH_ENV",
        );
      }
      const [keyEnvVar, authKey] = authEntries[0];
      const w = await __codeAgentDeps.runWrite(
        {
          tenantId: meta.tenantId,
          executionId: meta.executionId,
          nodeId: meta.nodeId,
          repo: cfg.repo,
          branch: cfg.branch,
          connectionId: cfg.connectionId,
          agentArgs: args,
          authKey,
          keyEnvVar,
          timeoutMs: cfg.timeoutMs,
          // Write + PR (#444): commit the edits to a branch, push, open a PR — all OUTSIDE the sandbox.
          openPr: cfg.openPr,
          prTitle: cfg.prTitle,
          prBody: cfg.prBody,
          commitMessage: cfg.commitMessage,
          headBranch: cfg.headBranch,
        },
        codeAgentWriteEnv(),
      );
      stdout = w.stdout;
      exitCode = w.exitCode;
      diff = w.diff;
      pr = w.pr;
    } else {
      // READ (default): run the CLI IN the worker (plan mode, no repo). MINIMAL env — PATH/HOME +
      // the driver's chosen auth var (exactly one, API key vs OAuth token). Never the git token.
      const r = await __codeAgentDeps.exec(driver.binary, args, {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          ...driver.authEnv(apiKey),
        },
        timeoutMs: cfg.timeoutMs,
      });
      stdout = r.stdout;
      exitCode = r.exitCode;
    }
    const envlp = driver.parse(stdout, exitCode);

    // BILLING (Tier-1 rule 6): prefer the CLI's own token counts; else a char/4 estimate —
    // so recordUsage always writes non-zero tokens (never a silently-free call).
    const usage =
      envlp.usage?.inputTokens || envlp.usage?.outputTokens
        ? {
            inputTokens: envlp.usage.inputTokens ?? 0,
            outputTokens: envlp.usage.outputTokens ?? 0,
          }
        : // Count the whole prompt too (system + task prompt), not just system+input —
          // the task prompt is the bulk of the tokens, so omitting it would under-bill.
          estimateTokens(
            `${cfg.systemPrompt ?? ""}\n${cfg.prompt}`,
            input,
            envlp.result,
          );
    // Price against a REAL Claude model (the CLI runs Claude) so the ledger can bill from
    // tokens — a placeholder like "cli" has no pricing row and would throw.
    const model = cfg.model || "claude-opus-4-8";
    await __codeAgentDeps.recordUsage({
      tenantId: meta.tenantId,
      environmentId: meta.environmentId, // per-env cost tag (Slice 6)
      executionId: meta.executionId,
      nodeId: meta.nodeId,
      nodeType: "codeAgent", // Slice 2: by-node-type rollups without a graph join
      durationMs: Math.round(secondsSince(startedAt) * 1000), // measured in-activity
      provider: driver.credentialProvider,
      model,
      usage,
    });
    // Cost the workflow accumulates: the CLI's own total_cost_usd is authoritative for a
    // subprocess; else derive from tokens (guarded — an unknown model must not throw); else
    // the node's manual fallback. The ledger already recorded non-zero tokens regardless.
    let derivedCost: number | undefined;
    try {
      derivedCost = computeCost({
        provider: driver.credentialProvider,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
    } catch {
      derivedCost = undefined;
    }
    const costUsd = envlp.usage?.costUsd ?? derivedCost ?? cfg.costUsd ?? 0;

    if (envlp.isError) {
      // The CLI ran but reported a failure (checked even on exit 0). Usage was already
      // recorded (bill the attempt); surface a terminal node failure — at-most-once means
      // we never auto-retry it anyway.
      throw ApplicationFailure.nonRetryable(
        "The coding CLI reported a failed run.",
        "CODE_AGENT_FAILED",
      );
    }

    log.info(
      {
        activity: "callCodeAgent",
        executionId: meta.executionId,
        nodeId: meta.nodeId,
        tenantId: meta.tenantId,
        tool: driver.tool,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd,
      },
      "codeAgent node completed",
    );
    activityRuns.inc({ activity: "callCodeAgent", outcome: "ok" });
    activityDuration.observe(
      { activity: "callCodeAgent" },
      secondsSince(startedAt),
    );
    if (costUsd > 0) runCostUsd.inc(costUsd);

    // A write-mode diff can be large — offload past the 1MB claim-check threshold so it doesn't
    // bloat workflow history (CLAUDE.md: pass refs, not blobs). Small diffs stay inline.
    const diffOut =
      diff !== undefined
        ? ((await maybeOffload(diff, getObjectStore(), {
            keyPrefix: `codeagent-diff/${meta.tenantId}`,
          })) as string | ClaimCheck)
        : undefined;

    // The full agentic trace can be large on a long run — offload it with the SAME claim-check
    // mechanism as the diff (small traces stay inline). Keeps Temporal history under the ~2MB cap;
    // the API resolves the reference at its read boundary before the UI renders it.
    const traceOut =
      envlp.trace !== undefined && envlp.trace.length > 0
        ? ((await maybeOffload(envlp.trace, getObjectStore(), {
            keyPrefix: `codeagent-trace/${meta.tenantId}`,
          })) as TraceStep[] | ClaimCheck)
        : undefined;

    return {
      status: "ok",
      output: {
        result: envlp.result,
        tool: driver.tool,
        sessionId: envlp.sessionId,
        ...(diffOut !== undefined ? { diff: diffOut } : {}),
        ...(traceOut !== undefined ? { trace: traceOut } : {}),
        ...(pr !== undefined ? { pr } : {}),
      },
      costUsd,
    };
  } catch (e) {
    activityRuns.inc({ activity: "callCodeAgent", outcome: "error" });
    activityDuration.observe(
      { activity: "callCodeAgent" },
      secondsSince(startedAt),
    );
    if (e instanceof ApplicationFailure) throw e;
    if (e instanceof MissingCredentialError) {
      throw ApplicationFailure.nonRetryable(
        "Missing or invalid provider credential",
        "AUTH",
        { tenantId: meta.tenantId },
      );
    }
    // A subprocess/parse error's message can carry argv/prompt/env material (execFile echoes
    // the command; a parse error the output). Unlike the AI-SDK path, there's no structured
    // error to sanitize — so throw a FULLY GENERIC message (the raw error stays in the worker
    // log via the metric/log below, never in Temporal history). maximumAttempts:1 → no retry.
    log.warn(
      {
        activity: "callCodeAgent",
        executionId: meta.executionId,
        nodeId: meta.nodeId,
        tenantId: meta.tenantId,
        // SAFE classifiers for correlation — the error's class + machine code, never the
        // message/stack (which can carry argv/prompt/env). The code disambiguates what a
        // bare "Error" can't: ENOENT (CLI binary missing) vs a crypto decrypt failure vs
        // a Prisma error code from the usage write. Diagnostics without leaking secrets.
        errorName: e instanceof Error ? e.name : "unknown",
        errorCode:
          typeof (e as { code?: unknown }).code === "string" ||
          typeof (e as { code?: unknown }).code === "number"
            ? (e as { code: string | number }).code
            : undefined,
      },
      "codeAgent subprocess failed (details suppressed from workflow history)",
    );
    throw ApplicationFailure.retryable(
      "The coding CLI run failed (transient).",
      "CODE_AGENT_TRANSIENT",
    );
  }
}

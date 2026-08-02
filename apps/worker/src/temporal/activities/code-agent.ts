// codeAgent node — headless coding CLI (claude -p) as a BYOK activity.
import { createLogger } from "@naary/logging";
import { ApplicationFailure } from "@temporalio/activity";
import { getDefaultEnvironmentId } from "@naary/db";
import { MissingCredentialError } from "@naary/secrets";
import { type ClaimCheck, getObjectStore, maybeOffload } from "@naary/storage";
import { computeCost, recordUsage } from "@naary/usage";
import { assertStructuredOutputSize } from "./structured-output-size";
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
  /** JSON Schema constraining the final answer (registry `codeAgent.outputSchema`). Only the
   *  `claude` driver can enforce it; the activity refuses it on any other tool. */
  outputSchema?: Record<string, unknown>;
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
    /**
     * The schema-constrained answer, PARSED — present only when the node set `outputSchema`.
     * Bound as `<nodeId>.output.structured.<field>`. `result` still carries the same value as
     * text, so an existing binding to `.result` keeps working.
     *
     * INLINE, unlike `diff` and `trace` which claim-check offload when large — and deliberately so:
     * those are display artifacts the API resolves, while this is DATA THE GRAPH READS. A
     * claim-check reference can't be dereferenced inside a workflow, so offloading it would make
     * the feature unusable downstream. Same treatment as the agent node's structured output, which
     * has always been inline for the same reason (raised in review on #823).
     */
    structured?: Record<string, unknown>;
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
 * Test seam: the credential source, usage sink, and the sandbox dispatch — swappable so the
 * activity's orchestration (in-activity key fetch, billing fallback, error mapping) is
 * unit-testable without a live runner or DB.
 *
 * NB there is deliberately NO `exec` seam any more (#680): the CLI is never spawned in the worker
 * process, so every run goes through `runWrite` → the sandbox-runner.
 */
export const __codeAgentDeps = {
  getCredentials,
  getDefaultEnvId: getDefaultEnvironmentId,
  recordUsage,
  /** Sandbox dispatch: (clone outside the sandbox →) sandbox-runner → stdout + diff. Seam so the
   *  activity's orchestration is tested without a real runner/git. */
  runWrite: runCodeAgentWrite,
};

/**
 * codeAgent node (design docs/design/CLAUDE-CODE-NODE.md). Runs the Claude Code CLI inside the
 * isolated sandbox — always (#680). Mirrors runAgent's envelope: BYOK key fetched IN-ACTIVITY
 * (handed to the runner for one container, never a workflow arg/return, never logged), fail-safe
 * usage (never bills zero), and auth/quota → non-retryable so Temporal doesn't burn retries on a
 * credential the user must fix. At-most-once (`maximumAttempts: 1`).
 */
export async function callCodeAgent(
  cfg: CodeAgentActivityConfig,
  input: unknown,
  meta: AgentMeta,
): Promise<CodeAgentResult> {
  const startedAt = process.hrtime.bigint();
  try {
    const driver = resolveDriver(cfg.tool);
    // STRUCTURED OUTPUT: refuse rather than approximate — and refuse FIRST, before any I/O. A
    // schema the driver cannot enforce would hand back unvalidated prose in a field the graph reads
    // as typed data: a run that LOOKS successful and is wrong, which is worse than failing.
    // Non-retryable, because no retry fixes a capability. (Same reasoning as the form-encoded-body
    // refusal in @naary/dsl.)
    //
    // Checked BEFORE the credential read (raised in review): otherwise a node with this config bug
    // on a tenant with no key fails with "missing credential", hiding the real, actionable cause.
    if (cfg.outputSchema && !driver.capabilities.structuredOutput) {
      throw ApplicationFailure.nonRetryable(
        `codeAgent: the '${driver.tool}' CLI cannot enforce an output schema — remove the schema, or switch this node's tool to 'claude'.`,
        "CODE_AGENT_NO_STRUCTURED_OUTPUT",
      );
    }
    // In memory only — injected as the subprocess env var, never returned/logged. Env-scoped creds:
    // the run's env (5b) selects the key; a pre-5b run falls back to the tenant default. See runAgent.
    const envId =
      meta.environmentId ??
      (await __codeAgentDeps.getDefaultEnvId(meta.tenantId));
    const apiKey = await __codeAgentDeps
      .getCredentials()
      .getDecryptedKey(meta.tenantId, envId, driver.credentialProvider);

    const write = cfg.mode === "write";
    // #680: there is no in-worker branch any more. Read and write BOTH go to the sandbox-runner —
    // read differs only in argv (plan mode, Read/Grep/Glob) and in opening no PR. This is what
    // actually closes #594: the CLI can no longer see the worker's filesystem (/proc/<pid>/environ
    // → ENCRYPTION_KEY), because it no longer runs on the worker at all.
    const sandboxEnv = codeAgentWriteEnv();
    const args = driver.buildArgs({
      prompt: cfg.prompt,
      systemPrompt: cfg.systemPrompt,
      model: cfg.model,
      maxTurns: cfg.maxTurns,
      maxBudgetUsd: cfg.maxBudgetUsd,
      write,
      ...(cfg.outputSchema ? { outputSchema: cfg.outputSchema } : {}),
    });

    // Write needs a repo to edit; read runs against the clone when `repo` is set, and otherwise
    // against an EMPTY ephemeral tree the runner creates. A repo (either mode) needs the App
    // connection that authorizes the clone.
    if (write && !cfg.repo) {
      throw ApplicationFailure.nonRetryable(
        "codeAgent write mode requires `repo` and a GitHub App `connectionId`.",
        "CODE_AGENT_WRITE_CONFIG",
      );
    }
    if (cfg.repo && !cfg.connectionId) {
      throw ApplicationFailure.nonRetryable(
        "codeAgent needs a GitHub App `connectionId` to clone `repo`.",
        write ? "CODE_AGENT_WRITE_CONFIG" : "CODE_AGENT_READ_CONFIG",
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
        mode: write ? "write" : "read",
        // The runner maps this tool to ITS OWN pinned image (one image per CLI, each with that
        // CLI's ENTRYPOINT). Passing the tool rather than an image name is deliberate: the runner
        // holds the Docker socket, so a caller-chosen image would be a host-root injection surface.
        tool: driver.tool,
        repo: cfg.repo,
        branch: cfg.branch,
        connectionId: cfg.connectionId,
        agentArgs: args,
        authKey,
        keyEnvVar,
        timeoutMs: cfg.timeoutMs,
        // Write + PR (#444): commit the edits to a branch, push, open a PR — all OUTSIDE the
        // sandbox. Read never mutates the tree, so no PR fields.
        openPr: write ? cfg.openPr : false,
        prTitle: write ? cfg.prTitle : undefined,
        prBody: write ? cfg.prBody : undefined,
        commitMessage: write ? cfg.commitMessage : undefined,
        headBranch: write ? cfg.headBranch : undefined,
      },
      sandboxEnv,
    );
    const stdout = w.stdout;
    const exitCode = w.exitCode;
    const diff = write ? w.diff : undefined; // a read run makes no edits → no diff
    const pr = write ? w.pr : undefined;
    // stderr matters for drivers that don't put their envelope on stdout — the Gemini CLI writes
    // its `-o json` envelope to stderr on a failed run (stdout is empty), so without this a failed
    // gemini run would be an undiagnosable `no_envelope`.
    const envlp = driver.parse(stdout, exitCode, w.stderr);

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
    // #1060: which branch above ran IS the provenance, and it is unrecoverable from `usage` — an
    // estimated 900 and a reported 900 are the same integer. Recomputed rather than folded into the
    // ternary above so the `envlp.usage?.x` test keeps narrowing `envlp.usage` for the true branch.
    const estimated = !(envlp.usage?.inputTokens || envlp.usage?.outputTokens);
    // Price against a REAL model for THIS driver's provider so the ledger can bill from tokens —
    // a placeholder like "cli" has no pricing row and would throw (after the CLI already ran and
    // cost money). Per-driver, so a gemini run isn't priced against a Claude table.
    const model = cfg.model || driver.defaultPricingModel;
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
      estimated, // #1060 — true when the CLI envelope carried no counts and the char/4 estimate ran
    });
    // #827: same guard and the same placement as the agent node — AFTER recordUsage, because the
    // CLI has already run and been billed by now. A guard on one node and not the other would just
    // make the pair inconsistent, which is why the issue asked for both in one change.
    if (envlp.structured)
      assertStructuredOutputSize(envlp.structured, meta.nodeId);

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
      // we never auto-retry it anyway. #551: carry the CLI's reason (subtype) into BOTH the
      // message (so the run detail says WHY) and the error type (so its Sentry issue groups by
      // reason — captureActivityFailure fingerprints by activity+type — instead of every kind
      // of coding-run failure collapsing into one undiagnosable alert). Subtype is a bounded CLI
      // enum, never user text, so it's safe in history/telemetry.
      const sub = envlp.failureSubtype;
      throw ApplicationFailure.nonRetryable(
        sub
          ? `The coding CLI reported a failed run (${sub}).`
          : "The coding CLI reported a failed run.",
        sub ? `CODE_AGENT_FAILED:${sub}` : "CODE_AGENT_FAILED",
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
        ...(envlp.structured ? { structured: envlp.structured } : {}),
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

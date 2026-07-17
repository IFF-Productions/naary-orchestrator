// mcpTool node — remote MCP tool calls over a tenant connection.
import { createLogger } from "@naary/logging";
import { ApplicationFailure } from "@temporalio/activity";
import {
  AuthConfigError,
  BlockedEgressError,
  MissingConnectionTokenError,
  NeedsReauthError,
  callMcpTool as mcpCall,
  resolveMcpTarget,
} from "@naary/connections";
import { hasSecretRefDeep, resolveSecretsDeep } from "@naary/secrets";
import {
  getObjectStore,
  maybeOffload,
  resolveClaimChecks,
} from "@naary/storage";
import {
  activityDuration,
  activityRuns,
  runCostUsd,
  secondsSince,
} from "../../metrics";
import {
  type AgentMeta,
  getSecretStore,
  makeSecretResolver,
  toSanitizedRetryable,
} from "./shared";

// Activities run in the worker PROCESS (a side-effect zone), so structured
// logging is fine here — unlike workflows.ts, which must stay deterministic.
// Logs carry execution-correlated ids (executionId/nodeId/tenantId) and token/
// cost numbers only — never prompts, completions, or keys (the logger scrubs).
const log = createLogger({ component: "worker" });

export interface McpToolConfig {
  connectionId: string;
  tool: string;
  /** Tool arguments, already resolved from upstream outputs by the interpreter. */
  arguments?: Record<string, unknown>;
  /** Flat per-call cost (Arch§4.6) — MCP tools have no token cost, so spend is
   *  operator-configured. Returned + accumulated so tool spend hits the budget. */
  costUsd?: number;
}

export interface McpToolResult {
  status: "ok";
  content: unknown;
  /** Metered cost of this tool call — the workflow accumulates it (Arch§4.6). */
  costUsd: number;
}

/** Test seam: connection→target resolution + the MCP call, swappable in tests. */
export const __mcpDeps = {
  resolveMcpTarget,
  callMcpTool: mcpCall,
  // Environment Secrets ($secrets): decrypt one named secret for the run's env (in-memory only).
  getSecret: (
    tenantId: string,
    environmentId: string,
    name: string,
  ): Promise<string | null> =>
    getSecretStore().get(tenantId, environmentId, `secret:${name}`),
};

/**
 * MCP Tool node: resolve the connection's server URL + auth header IN-ACTIVITY
 * (token never crosses the workflow boundary), call the remote tool, return its
 * content. Missing-token / needs-reauth map to non-retryable (the user must fix
 * the connection); transient errors retry.
 */
export async function callMcpTool(
  cfg: McpToolConfig,
  input: unknown,
  meta: AgentMeta,
): Promise<McpToolResult> {
  const startedAt = process.hrtime.bigint();
  try {
    const store = getObjectStore();
    const target = await __mcpDeps.resolveMcpTarget(
      meta.tenantId,
      cfg.connectionId,
    );
    // Resolve any claim-checked upstream args back to their real values before the
    // call (Arch§4.6) — the workflow only ever carried the small reference.
    const claimResolvedArgs = (await resolveClaimChecks(
      cfg.arguments ?? (input as Record<string, unknown>) ?? {},
      store,
    )) as Record<string, unknown>;
    // Resolve `{{ $secrets.NAME }}` in the tool arguments in-memory (Tier-1 §4 — the workflow left
    // them literal). Args ride in the request body to the MCP server, never in our result/logs (the
    // result is the tool's output), so this needs no cross-origin handling like httpRequest headers.
    const args = hasSecretRefDeep(claimResolvedArgs)
      ? ((await resolveSecretsDeep(
          claimResolvedArgs,
          makeSecretResolver(meta, __mcpDeps.getSecret),
        )) as Record<string, unknown>)
      : claimResolvedArgs;
    const result = await __mcpDeps.callMcpTool({
      serverUrl: target.serverUrl,
      headers: target.headers,
      tool: cfg.tool,
      arguments: args,
    });
    // A tool-level error (isError) is NOT success — surface it instead of
    // letting the workflow proceed as if the call worked. Non-retryable: the
    // same arguments usually fail the same way, so don't burn Temporal retries.
    if (result.isError) {
      throw ApplicationFailure.nonRetryable(
        `MCP tool '${cfg.tool}' returned an error`,
        "MCP_TOOL_ERROR",
        { connectionId: cfg.connectionId, content: result.content },
      );
    }
    // Offload a large result to object storage and return a small reference, so it
    // can't blow Temporal's ~2MB payload cap (Arch§4.6). Small results stay inline.
    const content = await maybeOffload(result.content, store, {
      keyPrefix: `mcp/${meta.tenantId}`,
    });
    log.info(
      {
        activity: "callMcpTool",
        executionId: meta.executionId,
        nodeId: meta.nodeId,
        tenantId: meta.tenantId,
        tool: cfg.tool,
        connectionId: cfg.connectionId,
        costUsd: cfg.costUsd ?? 0,
      },
      "mcp tool completed",
    );
    activityRuns.inc({ activity: "callMcpTool", outcome: "ok" });
    activityDuration.observe(
      { activity: "callMcpTool" },
      secondsSince(startedAt),
    );
    if ((cfg.costUsd ?? 0) > 0) runCostUsd.inc(cfg.costUsd ?? 0);
    return { status: "ok", content, costUsd: cfg.costUsd ?? 0 };
  } catch (e) {
    activityRuns.inc({ activity: "callMcpTool", outcome: "error" });
    activityDuration.observe(
      { activity: "callMcpTool" },
      secondsSince(startedAt),
    );
    // Our own deliberate failures (e.g. MCP_TOOL_ERROR) are already safe + correctly
    // non-retryable — pass them through untouched.
    if (e instanceof ApplicationFailure) throw e;
    // A blocked egress target is a misconfiguration (SSRF guard) — retrying the
    // same URL won't help, so fail non-retryable.
    if (e instanceof BlockedEgressError) {
      throw ApplicationFailure.nonRetryable(
        "Connection target is not allowed",
        "BLOCKED_EGRESS",
        { connectionId: cfg.connectionId },
      );
    }
    if (e instanceof AuthConfigError) {
      // Platform misconfig (e.g. GitHub App env unset) — retrying can't fix it.
      throw ApplicationFailure.nonRetryable(e.message, "AUTH_NOT_CONFIGURED");
    }
    if (
      e instanceof MissingConnectionTokenError ||
      e instanceof NeedsReauthError
    ) {
      throw ApplicationFailure.nonRetryable(
        "Connection needs re-authorization",
        "CONNECTION_REAUTH",
        { connectionId: cfg.connectionId },
      );
    }
    // Transient: sanitized retryable (an MCP transport error can carry the
    // connection's bearer token in its request fields).
    throw toSanitizedRetryable(e, "MCP_TRANSIENT");
  }
}

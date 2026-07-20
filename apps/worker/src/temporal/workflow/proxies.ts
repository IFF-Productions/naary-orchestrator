// Activity proxies for the deterministic interpreter (split out of workflows.ts —
// moved verbatim, zero behavior change). proxyActivities() only builds a typed
// Proxy from pure config, so defining these at module level issues no command and
// is replay-safe. Each proxy block is a SINGLE module-level instance shared by
// every workflow module — do not redefine these elsewhere.
import * as wf from "@temporalio/workflow";
import type { NodeRetryPolicy } from "@naary/dsl";
// Type-only: keeps activity code OUT of the deterministic workflow bundle.
// Do NOT drop `type` — that would pull I/O code into the sandbox.
import type * as activities from "../activities";

export const {
  runAgent,
  callMcpTool,
  recordExecution,
  loadVariables,
  setExecutionStatus,
  computeDateTime,
  resolveSubWorkflowGraph,
  callHmac,
  callHash,
  callJwt,
  callTotp,
  callXml,
  callHtmlExtract,
  callMarkdown,
  callVectorUpsert,
  callVectorQuery,
  callCsv,
  callEncode,
  callRandom,
  loadChatHistory,
  appendChatTurn,
} = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 3 },
});

// The HTTP node's request deadline is user-configurable (up to MAX_HTTP_TIMEOUT_MS,
// clamped in the activity), so it needs a start-to-close strictly ABOVE that cap —
// otherwise Temporal would kill a slow-but-running request and RETRY it, duplicating
// a non-idempotent POST/PUT/PATCH/DELETE. The activity's AbortController is the real
// deadline; this timeout is just the outer backstop.
export const { callHttpRequest, callGraphQL } = wf.proxyActivities<
  typeof activities
>({
  startToCloseTimeout: "150 seconds",
  retry: { maximumAttempts: 3 },
});

// Native integration node. READ actions are idempotent → normal retries. WRITE actions
// (create_issue/comment/transition) run AT-MOST-ONCE — a lost response must not duplicate a
// create (design §4, same reasoning as callSqlExec/callSendEmail). The interpreter picks the
// proxy by the catalog action's `write` flag.
export const { callIntegration: callIntegrationRead } = wf.proxyActivities<
  typeof activities
>({ startToCloseTimeout: "60 seconds", retry: { maximumAttempts: 3 } });
export const { callIntegration: callIntegrationWrite } = wf.proxyActivities<
  typeof activities
>({ startToCloseTimeout: "60 seconds", retry: { maximumAttempts: 1 } });

// Items model A3: the batched per-item map. maxAttempts:1 — mapNode catches per-item errors and
// returns them, so it only throws on a genuine infra crash; retrying a batch of non-idempotent I/O
// would re-charge + duplicate side effects (design §0.3). The start-to-close must cover the WORST
// case, or a healthy batch times out (an infra-throw): up to MAX_MAP_BATCH_ITEMS (100) items at
// concurrency 10 = 10 waves, and the slowest per-item deadline is httpRequest's ~150s → ~25 min.
// 40 min leaves headroom; the per-item calls hold their own in-activity deadlines.
export const { mapNode } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "40 minutes",
  retry: { maximumAttempts: 1 },
});

// codeAgent runs an agentic coding CLI subprocess — minutes-long, and AT-MOST-ONCE
// (maximumAttempts: 1): later slices commit/push/PR, so a partial write must never be
// auto-retried. Its own block (like mapNode) keeps that long timeout off the shared 1-min
// activities. The subprocess timeout (cfg.timeoutMs) is the real deadline within this.
export const { callCodeAgent } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "40 minutes",
  retry: { maximumAttempts: 1 },
});

// Same reasoning as callHttpRequest: the per-query timeout (≤ MAX_SQL_TIMEOUT_MS,
// clamped in the activity) is the real deadline; the start-to-close sits above it so
// Temporal doesn't kill + retry a slow-but-running query. (Reads are idempotent, but
// keeping the driver as the deadline avoids spurious retries of expensive queries.)
export const { callSqlQuery } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "150 seconds",
  retry: { maximumAttempts: 3 },
});

// A WRITE is NOT idempotent — a retry after a partial/ambiguous first attempt could
// double-write. So sqlExec runs AT-MOST-ONCE (maximumAttempts: 1), like callSendEmail:
// a failure fails the node rather than risk applying the statement twice.
export const { callSqlExec } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "150 seconds",
  retry: { maximumAttempts: 1 },
});

// Sending email is NOT idempotent — a retry after a first attempt already handed the
// message to the SMTP server (but lost the ack) would double-send. So this runs
// AT-MOST-ONCE (no retries): a transient failure fails the node rather than risk
// spamming the recipient. (A future idempotency-key design could relax this.)
export const { callSendEmail } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "60 seconds",
  retry: { maximumAttempts: 1 },
});

// Read-only feed fetch — idempotent, so normal retries are fine. Its own block so
// the start-to-close sits above the fetch timeout (same reasoning as http/sql).
export const { callRssRead } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "60 seconds",
  retry: { maximumAttempts: 3 },
});

// pollTrigger fetch + change-detect. Egress fetch (retryable), and the cursor write
// is idempotent-enough (a retry recomputes the same key). Own block for the timeout.
export const { callPoll } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "60 seconds",
  retry: { maximumAttempts: 3 },
});

// Best-effort tenant notification (webhook POST). The activity itself never throws;
// a couple of retries cover a transient webhook blip. Non-critical to the run.
export const { sendNotification } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 2 },
});

// Pause-side approval snapshot (Slice 1): resolves contextFields expressions + approver
// display names and stamps pausedAt. Read-only DB + clock — idempotent, so normal retries.
export const { prepareApproval } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 3 },
});

// Post-resume budget re-read (Slice 3, pause-not-fail): a pure DB read of the tenant's
// caps/policy — idempotent, so normal retries. Only ever called on the patched pause path.
export const { refreshBudget } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 3 },
});

// Sandboxed user JS. The activity caps wall-clock at ≤5s; the start-to-close sits
// above that. User-code failures are non-retryable in the activity, so 1 attempt.
export const { callCode } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 1 },
});

/**
 * Per-node retry override (NodeDef.retry, n8n's "Retry On Fail"). Returns a proxy whose
 * activities carry the node's retry policy, or undefined to use the module default. Building a
 * proxy in the workflow body is deterministic (pure config → replays identically). Temporal's
 * retries are unbounded + exponential + crash-surviving — naary beats n8n's 5-try/5s cap.
 * Only used by the idempotent-ish activity nodes; a non-retryable ApplicationFailure (401/429)
 * still won't retry regardless.
 */
export function retryOverride(
  retry: NodeRetryPolicy | undefined,
  startToCloseTimeoutMs: number,
): ReturnType<typeof wf.proxyActivities<typeof activities>> | undefined {
  if (!retry) return undefined;
  // Durations as milliseconds (numbers) — Temporal accepts them and they sidestep the
  // template-literal Duration string type.
  return wf.proxyActivities<typeof activities>({
    startToCloseTimeout: startToCloseTimeoutMs,
    retry: {
      maximumAttempts: retry.maxAttempts ?? 3,
      // Temporal requires initialInterval > 0 — floor to 1ms so a configured 0 = "as fast
      // as possible" doesn't produce an invalid RetryPolicy (which would fail the run).
      initialInterval: Math.max(1, (retry.initialIntervalSeconds ?? 1) * 1000),
      backoffCoefficient: retry.backoffCoefficient ?? 2,
      ...(retry.maxIntervalSeconds
        ? { maximumInterval: retry.maxIntervalSeconds * 1000 }
        : {}),
    },
  });
}

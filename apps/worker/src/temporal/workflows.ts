import * as wf from "@temporalio/workflow";
import {
  approvalSignal,
  resumeSignal,
  stateQuery,
  webhookResponseQuery,
} from "@naary/contracts";
import type {
  ApprovalInput,
  ExecutionState,
  ExecutionStatus,
  ResumeInput,
  WebhookResponse,
} from "@naary/contracts";
import {
  getByPath,
  resolveTemplates,
  nextNodes,
  resolveAggregate,
  resolveCompareDatasets,
  resolveFilter,
  resolveListOps,
  resolveHmac,
  resolveHash,
  resolveIf,
  resolveJson,
  resolveNumber,
  resolveHttpRequest,
  resolveJwt,
  resolveMcpArguments,
  resolveRenameKeys,
  resolveRss,
  resolveSendEmail,
  resolveSet,
  resolveSqlQuery,
  resolveSqlExec,
  resolveSubWorkflowInput,
  resolveSwitch,
  resolveText,
  resolveWebhookResponse,
  asNodeConfig,
  computeItemsRegions,
  type ItemsRegion,
} from "@naary/dsl";
import type { GraphDef, NodeDef, NodeRetryPolicy } from "@naary/dsl";
// Type-only: keeps activity code OUT of the deterministic workflow bundle.
// Do NOT drop `type` — that would pull I/O code into the sandbox.
import type * as activities from "./activities";
// Pure fan-out policy (no side effects) — safe to import into workflow code.
import { FOREACH_CONCURRENCY, perChildCap } from "./foreach-cap";

const {
  runAgent,
  callMcpTool,
  recordExecution,
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
  callCsv,
  callEncode,
  callRandom,
} = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 3 },
});

/** Max sub-workflow nesting depth (a run at this depth refuses to spawn children).
 *  Bounds accidental/infinite recursion — a saved graph that calls itself. */
const MAX_SUBWORKFLOW_DEPTH = 5;

/** Max items a single forEach will fan out to (child run per item). An array larger
 *  than this trips the circuit breaker — filter/limit upstream first. */
const MAX_FOREACH_ITEMS = 100;

// The HTTP node's request deadline is user-configurable (up to MAX_HTTP_TIMEOUT_MS,
// clamped in the activity), so it needs a start-to-close strictly ABOVE that cap —
// otherwise Temporal would kill a slow-but-running request and RETRY it, duplicating
// a non-idempotent POST/PUT/PATCH/DELETE. The activity's AbortController is the real
// deadline; this timeout is just the outer backstop.
const { callHttpRequest } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "150 seconds",
  retry: { maximumAttempts: 3 },
});

// Same reasoning as callHttpRequest: the per-query timeout (≤ MAX_SQL_TIMEOUT_MS,
// clamped in the activity) is the real deadline; the start-to-close sits above it so
// Temporal doesn't kill + retry a slow-but-running query. (Reads are idempotent, but
// keeping the driver as the deadline avoids spurious retries of expensive queries.)
const { callSqlQuery } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "150 seconds",
  retry: { maximumAttempts: 3 },
});

// A WRITE is NOT idempotent — a retry after a partial/ambiguous first attempt could
// double-write. So sqlExec runs AT-MOST-ONCE (maximumAttempts: 1), like callSendEmail:
// a failure fails the node rather than risk applying the statement twice.
const { callSqlExec } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "150 seconds",
  retry: { maximumAttempts: 1 },
});

// Sending email is NOT idempotent — a retry after a first attempt already handed the
// message to the SMTP server (but lost the ack) would double-send. So this runs
// AT-MOST-ONCE (no retries): a transient failure fails the node rather than risk
// spamming the recipient. (A future idempotency-key design could relax this.)
const { callSendEmail } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "60 seconds",
  retry: { maximumAttempts: 1 },
});

// Read-only feed fetch — idempotent, so normal retries are fine. Its own block so
// the start-to-close sits above the fetch timeout (same reasoning as http/sql).
const { callRssRead } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "60 seconds",
  retry: { maximumAttempts: 3 },
});

// pollTrigger fetch + change-detect. Egress fetch (retryable), and the cursor write
// is idempotent-enough (a retry recomputes the same key). Own block for the timeout.
const { callPoll } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "60 seconds",
  retry: { maximumAttempts: 3 },
});

// Best-effort tenant notification (webhook POST). The activity itself never throws;
// a couple of retries cover a transient webhook blip. Non-critical to the run.
const { sendNotification } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 2 },
});

// Sandboxed user JS. The activity caps wall-clock at ≤5s; the start-to-close sits
// above that. User-code failures are non-retryable in the activity, so 1 attempt.
const { callCode } = wf.proxyActivities<typeof activities>({
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
function retryOverride(
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

export interface RunGraphResult {
  status: ExecutionStatus;
  ctx: Record<string, unknown>;
}

/** Non-secret execution context. `tenantId` is fine in workflow args/history;
 *  the provider KEY is never here — it's fetched inside the activity by tenantId.
 *
 *  Budget caps are SNAPSHOTTED here at start (the api reads the tenant budget and
 *  passes them in) so enforcement stays deterministic — no DB read in the workflow.
 *  Enforcement is opt-in per cap: a cap that is undefined is not enforced. */
export interface RunGraphCtx {
  tenantId: string;
  /** The saved-graph key this run executes — recorded for the Runs list. */
  workflowKey?: string;
  perExecutionCapUsd?: number;
  maxStepsPerRun?: number;
  /** The version-pinned graph snapshot this run executes (Slice #5). Carried in
   *  history for traceability; the interpreter walks the passed graph as-is. */
  graphContentHash?: string;
  graphVersion?: number;
  /** Force continueAsNew after this many steps (Slice #6) — deterministic, for
   *  long loops + tests. When unset, only Temporal's continueAsNewSuggested trips. */
  continueAsNewAfterSteps?: number;
  /** Nesting depth for executeSubWorkflow runs (top-level = 0/undefined). A child
   *  run is spawned with depth+1; the interpreter refuses to nest past
   *  MAX_SUBWORKFLOW_DEPTH so a self-referential graph can't recurse forever. */
  subWorkflowDepth?: number;
  /** The saved-graph key to run (detached) if THIS run fails — an error-handler
   *  workflow. Resolved + started in-activity on failure. */
  errorWorkflowKey?: string;
  /** True when this run IS an error-handler (started by another run's failure).
   *  Suppresses re-firing a handler so a failing handler can't loop. */
  isErrorHandler?: boolean;
  /** Single-node TEST mode (design SINGLE-NODE-EXECUTION.md slice 3): seed ctx from `seededCtx`
   *  (upstream outputs, from pins) and run just the target node's activity. Suppresses the
   *  Execution/read-model recording so a test never shows up as a "run" — but the activity is
   *  real (secrets in-activity) and any LLM/tool spend is still metered (its own UsageEvent). */
  test?: boolean;
  /** Node outputs to pre-populate ctx with (test mode) — the target node reads these as its
   *  upstream inputs, so no upstream nodes execute. */
  seededCtx?: Record<string, unknown>;
}

/** Carried across continueAsNew so a long/looping run resumes with state intact
 *  (Slice #6) — the same graph snapshot is passed again as the first arg. */
export interface ResumeState {
  ctx: Record<string, unknown>;
  costUsd: number;
  stepCount: number;
  startNodeId: string;
  /** Fan-in arrival counts per merge node id (Slice N5). Carried so a run that
   *  continueAsNews mid-join resumes its counts. Plain object (CAN-safe). */
  mergeArrivals?: Record<string, number>;
}

/**
 * Sanitized, bounded failure message for a node's error output (onError: "continue").
 * Temporal wraps an activity failure in ActivityFailure whose `cause` carries the real
 * message; unwrap to the innermost cause, then cap length so a huge error can't bloat the
 * ctx/history. Activity errors are already sanitized upstream (toSanitizedRetryable), so
 * this never surfaces secrets.
 */
function nodeErrorMessage(err: unknown): string {
  let e: unknown = err;
  // Drill through wrapped failures (ActivityFailure → cause → …) to the root message.
  for (let i = 0; i < 5 && e && typeof e === "object" && "cause" in e; i++) {
    const cause = (e as { cause?: unknown }).cause;
    if (!cause) break;
    e = cause;
  }
  const msg = e instanceof Error ? e.message : String(e);
  return msg.length > 500 ? `${msg.slice(0, 500)}…` : msg;
}

/**
 * The generic interpreter: one workflow walks graph DATA (CLAUDE.md Tier-1
 * rule 1 — interpreter, not codegen). Deterministic — all side effects go
 * through activities; the human-approval pause is a Signal + condition(), never
 * a poll or sleep-loop (rules 2–5).
 */
export async function runGraph(
  graph: GraphDef,
  input: unknown,
  runCtx: RunGraphCtx,
  resume?: ResumeState,
): Promise<RunGraphResult> {
  // On a continueAsNew restart, seed state from the carried snapshot. In single-node test mode,
  // seed ctx with the target's upstream outputs (from pins) so only the target executes.
  const ctx: Record<string, unknown> = resume
    ? { ...resume.ctx }
    : { __input: input, ...(runCtx.seededCtx ?? {}) };
  let approval: ApprovalInput | undefined;
  // Set by resumeSignal when an external system calls the run's resume URL (wait/webhook mode).
  let webhookResume: ResumeInput | undefined;
  let status: ExecutionStatus = "running";
  let currentNodeId = resume?.startNodeId ?? graph.startNodeId;
  // The synchronous response a respondToWebhook node sets, exposed via a query for
  // the webhook ingress to return. Read shortly after start (before any long-run
  // continueAsNew), so it is intentionally NOT carried across a CAN boundary.
  let webhookResponse: WebhookResponse | undefined;

  // Deterministic enforcement state: driven ONLY by activity-returned costs and
  // a node counter — never a DB read in workflow code (CLAUDE.md rule 2; §3).
  let costUsd = resume?.costUsd ?? 0;
  let stepCount = resume?.stepCount ?? 0;

  // Fan-in join state (Slice N5). `mergeParents` maps a merge node id → its inbound
  // parents' ids in DECLARED edge order (its length is the expected in-degree);
  // precomputed once from the graph (deterministic, pure). `mergeArrivals` counts
  // how many inbound branches have reached each merge so far — the last to arrive
  // runs it. Only nodes of type "merge" participate, so other multi-inbound nodes
  // (e.g. loop back-edges) keep their existing behavior.
  const mergeParents = new Map<string, string[]>();
  for (const n of graph.nodes) {
    if (n.type === "merge") {
      mergeParents.set(
        n.id,
        graph.edges.filter((e) => e.to === n.id).map((e) => e.from),
      );
    }
  }
  const mergeArrivals: Record<string, number> = resume?.mergeArrivals
    ? { ...resume.mergeArrivals }
    : {};

  // Items model (design ITEMS-MODEL-CURRENT-ITEM.md): precompute the splitOut→region map. Pure +
  // deterministic (same source of truth the save-gate validates), so computing it never affects
  // history; the per-item EXECUTION is what's gated by patched("items-model-v1") below.
  const itemsRegionBySplit = new Map<string, ItemsRegion>();
  for (const r of computeItemsRegions(graph).regions) {
    itemsRegionBySplit.set(r.splitOutId, r);
  }

  wf.setHandler(approvalSignal, (s) => {
    approval = s;
  });
  wf.setHandler(resumeSignal, (s) => {
    webhookResume = s;
  });
  wf.setHandler(stateQuery, (): ExecutionState => ({
    status,
    currentNodeId,
    ctx,
  }));
  wf.setHandler(webhookResponseQuery, () => webhookResponse);

  // Register run ownership so this run shows in the Runs list + is tenant-authorized
  // — covers SCHEDULED runs (started by Temporal, with no API-side record). Only on
  // first start (not continueAsNew). Behind a patched() gate so in-flight runs that
  // predate this change don't hit a nondeterminism error on replay (CLAUDE.md:
  // version interpreter changes with workflow.patched()).
  if (!resume && !runCtx.test && wf.patched("record-execution-v1")) {
    await recordExecution({
      workflowId: wf.workflowInfo().workflowId,
      tenantId: runCtx.tenantId,
      workflowKey: runCtx.workflowKey,
    });
  }

  // Push the current status + cost to the Execution read-model so the Runs list is
  // a single PG read (no per-run Temporal calls). Gated by patched() so in-flight
  // runs that predate this change stay replay-safe.
  async function syncStatus(): Promise<void> {
    if (runCtx.test) return; // test mode: never touch the Runs read-model
    if (wf.patched("exec-status-v1")) {
      await setExecutionStatus({
        workflowId: wf.workflowInfo().workflowId,
        status,
        costUsd,
      });
    }
  }

  const nodeById = new Map<string, NodeDef>(graph.nodes.map((n) => [n.id, n]));

  /** Run one node's side effect. Returns a TERMINAL status to stop the whole run
   *  (rejected), or null to continue. Mutates ctx / cost via the closures. */
  async function execNode(node: NodeDef): Promise<ExecutionStatus | null> {
    // Template-lite expressions: resolve any `{{ nodeId.path }}` in string config against ctx
    // BEFORE the node runs (pure + deterministic — design docs/design/EXPRESSIONS.md).
    const cfg = resolveTemplates(
      (node.config ?? {}) as Record<string, unknown>,
      ctx,
    );
    switch (node.type) {
      case "start":
      case "end":
        return null;
      case "webhookTrigger":
        // Slice #4: the inbound event (the workflow input) is this node's output.
        ctx[node.id] = ctx.__input;
        return null;
      case "scheduleTrigger":
        // Entry node: the run was started by a Temporal cron Schedule (control-plane synced
        // on save). Passthrough of the run input — the schedule carries no external event.
        ctx[node.id] = ctx.__input;
        return null;
      case "formTrigger":
        // Entry node: the run was started by a hosted form submission (a later slice adds the
        // public endpoint). The submitted fields ARE the run input → this node's output.
        ctx[node.id] = ctx.__input;
        return null;
      case "errorTrigger":
        // Entry node of an error-handler graph — its output is the failure context
        // the interpreter passed as this run's input.
        ctx[node.id] = ctx.__input;
        return null;
      case "pollTrigger": {
        // Entry node: fetch the URL + detect change vs the persisted cursor (keyed by
        // workflowKey so it spans the scheduled runs). Output {changed, body}; branch
        // on `<id>.changed` to no-op when nothing's new.
        const pollCfg = asNodeConfig(cfg, "pollTrigger");
        const r = await callPoll(pollCfg, {
          tenantId: runCtx.tenantId,
          workflowKey: runCtx.workflowKey ?? "",
          nodeId: node.id,
        });
        ctx[node.id] = { changed: r.changed, body: r.body };
        return null;
      }
      case "agent": {
        // tenantId flows in workflow args (not a secret); the activity fetches
        // the tenant's key by tenantId. executionId is deterministic.
        const over = retryOverride(node.retry, 60_000);
        const result = await (over?.runAgent ?? runAgent)(
          cfg as unknown as activities.AgentConfig,
          ctx.__input,
          {
            tenantId: runCtx.tenantId,
            executionId: wf.workflowInfo().workflowId,
            nodeId: node.id,
          },
        );
        ctx[node.id] = result;
        // Cost is a commutative SUM — accumulating it is order-independent (safe
        // even under parallel fan-out, where Temporal replays activity completion
        // order deterministically anyway).
        costUsd += result.costUsd;
        ctx.__costUsd = costUsd;
        return null;
      }
      case "mcpTool": {
        // Resolving tool args from upstream outputs is deterministic graph work,
        // so it happens HERE; the I/O (token fetch + HTTP) is inside the activity.
        const mcpCfg = asNodeConfig(cfg, "mcpTool");
        const over = retryOverride(node.retry, 60_000);
        const toolResult = await (over?.callMcpTool ?? callMcpTool)(
          {
            connectionId: mcpCfg.connectionId,
            tool: mcpCfg.tool,
            arguments: resolveMcpArguments(mcpCfg, ctx),
            costUsd: mcpCfg.costUsd,
          },
          ctx.__input,
          {
            tenantId: runCtx.tenantId,
            executionId: wf.workflowInfo().workflowId,
            nodeId: node.id,
          },
        );
        ctx[node.id] = toolResult;
        // Meter tool spend into the run budget so the per-execution cap sees it
        // (Arch§4.6) — commutative accumulation, same as the agent node.
        costUsd += toolResult.costUsd;
        ctx.__costUsd = costUsd;
        return null;
      }
      case "httpRequest": {
        // Binding resolution is deterministic graph work (pure ctx path-reads), so
        // it runs HERE; the I/O (auth fetch, egress check, fetch) is in the activity.
        const httpCfg = asNodeConfig(cfg, "httpRequest");
        const over = retryOverride(node.retry, 150_000);
        const result = await (over?.callHttpRequest ?? callHttpRequest)(
          resolveHttpRequest(httpCfg, ctx),
          ctx.__input,
          {
            tenantId: runCtx.tenantId,
            executionId: wf.workflowInfo().workflowId,
            nodeId: node.id,
          },
        );
        // Expose the response as {status, headers, body} so edges branch on
        // `<nodeId>.status` (the HTTP code), per the node's behavior contract.
        ctx[node.id] = {
          status: result.httpStatus,
          headers: result.headers,
          body: result.body,
        };
        costUsd += result.costUsd;
        ctx.__costUsd = costUsd;
        return null;
      }
      case "sqlQuery": {
        // Param binding is deterministic graph work (pure ctx path-reads); the DSN
        // read + DB query (read-only) are in the activity. The sql text is never
        // built from bindings — only the params array (no SQL injection).
        const sqlCfg = asNodeConfig(cfg, "sqlQuery");
        const over = retryOverride(node.retry, 150_000);
        const result = await (over?.callSqlQuery ?? callSqlQuery)(
          resolveSqlQuery(sqlCfg, ctx),
          ctx.__input,
          {
            tenantId: runCtx.tenantId,
            executionId: wf.workflowInfo().workflowId,
            nodeId: node.id,
          },
        );
        // Expose {rows, rowCount} so edges branch on `<nodeId>.rowCount`.
        ctx[node.id] = { rows: result.rows, rowCount: result.rowCount };
        costUsd += result.costUsd;
        ctx.__costUsd = costUsd;
        return null;
      }
      case "sqlExec": {
        // A WRITE (INSERT/UPDATE/DELETE). Same binding rules as sqlQuery (params only,
        // never the SQL text); the DSN read + transactional write are in the activity,
        // which runs at-most-once (writes aren't idempotent).
        const execCfg = asNodeConfig(cfg, "sqlExec");
        const result = await callSqlExec(
          resolveSqlExec(execCfg, ctx),
          ctx.__input,
          {
            tenantId: runCtx.tenantId,
            executionId: wf.workflowInfo().workflowId,
            nodeId: node.id,
          },
        );
        // Expose {rowsAffected} so edges branch on `<nodeId>.rowsAffected`.
        ctx[node.id] = { rowsAffected: result.rowsAffected };
        costUsd += result.costUsd;
        ctx.__costUsd = costUsd;
        return null;
      }
      case "set": {
        // Pure node: build the output object from static fields + upstream
        // bindings entirely in the interpreter (deterministic, no I/O, no cost).
        // Output IS the built object, so edges/nodes read `<nodeId>.<field>`.
        const setCfg = asNodeConfig(cfg, "set");
        ctx[node.id] = resolveSet(setCfg, ctx);
        return null;
      }
      case "renameKeys": {
        // Pure node: reshape an upstream object's keys, entirely in the interpreter.
        const rkCfg = asNodeConfig(cfg, "renameKeys");
        ctx[node.id] = resolveRenameKeys(rkCfg, ctx);
        return null;
      }
      case "text": {
        // Pure node: one string op on an upstream value → { result }. Deterministic
        // (regex is pure; invalid patterns fail closed to null in resolveText).
        const txtCfg = asNodeConfig(cfg, "text");
        ctx[node.id] = resolveText(txtCfg, ctx);
        return null;
      }
      case "filter": {
        // Pure node: keep the upstream array items matching the per-item predicate.
        // Output IS the filtered array (downstream reads `<id>.0` or aggregates it).
        const filterCfg = asNodeConfig(cfg, "filter");
        ctx[node.id] = resolveFilter(filterCfg, ctx);
        return null;
      }
      case "aggregate": {
        // Pure node: collapse an upstream array → { result }.
        const aggCfg = asNodeConfig(cfg, "aggregate");
        ctx[node.id] = resolveAggregate(aggCfg, ctx);
        return null;
      }
      case "listOps": {
        // Pure node: sort / limit / dedupe an upstream array → array.
        const loCfg = asNodeConfig(cfg, "listOps");
        ctx[node.id] = resolveListOps(loCfg, ctx);
        return null;
      }
      case "compareDatasets": {
        // Pure node: diff two upstream arrays by key → {added,removed,changed,same}.
        const cdCfg = asNodeConfig(cfg, "compareDatasets");
        ctx[node.id] = resolveCompareDatasets(cdCfg, ctx);
        return null;
      }
      case "xml": {
        // Parse XML→object / build object→XML in the activity (parser stays out of
        // the deterministic bundle). Input value resolved here (pure ctx read).
        const xmlCfg = asNodeConfig(cfg, "xml");
        const inputVal = getByPath(ctx[xmlCfg.from], xmlCfg.path);
        const result = await callXml(
          { operation: xmlCfg.operation },
          inputVal,
          {
            tenantId: runCtx.tenantId,
            executionId: wf.workflowInfo().workflowId,
            nodeId: node.id,
          },
        );
        ctx[node.id] = result.result;
        return null;
      }
      case "htmlExtract": {
        // Pull values from an HTML string by CSS selector. HTML resolved here (pure ctx
        // read); the parse runs in the activity (parser out of the deterministic bundle).
        const htmlCfg = asNodeConfig(cfg, "htmlExtract");
        const htmlVal = getByPath(ctx[htmlCfg.from], htmlCfg.path);
        const res = await callHtmlExtract(
          { extractions: htmlCfg.extractions ?? [] },
          htmlVal,
          {
            tenantId: runCtx.tenantId,
            executionId: wf.workflowInfo().workflowId,
            nodeId: node.id,
          },
        );
        ctx[node.id] = res.result;
        return null;
      }
      case "markdown": {
        // Convert an HTML string → Markdown. HTML resolved here (pure ctx read); the parse runs
        // in the activity (parser out of the deterministic bundle, like htmlExtract).
        const mdCfg = asNodeConfig(cfg, "markdown");
        const mdVal = getByPath(ctx[mdCfg.from], mdCfg.path);
        const res = await callMarkdown(mdVal, {
          tenantId: runCtx.tenantId,
          executionId: wf.workflowInfo().workflowId,
          nodeId: node.id,
        });
        ctx[node.id] = res.result;
        return null;
      }
      case "noOp": {
        // Does nothing — a structural/placeholder node. Emits {} (downstream nodes bind to real
        // upstream node ids, so routing an edge through here doesn't break any binding).
        ctx[node.id] = {};
        return null;
      }
      case "csv": {
        // Parse CSV→rows / build rows→CSV. Input resolved here (pure ctx read); the parse
        // runs in the activity (parser out of the deterministic bundle).
        const csvCfg = asNodeConfig(cfg, "csv");
        const csvVal = getByPath(ctx[csvCfg.from], csvCfg.path);
        const res = await callCsv(
          {
            operation: csvCfg.operation,
            header: csvCfg.header,
            delimiter: csvCfg.delimiter,
          },
          csvVal,
          {
            tenantId: runCtx.tenantId,
            executionId: wf.workflowInfo().workflowId,
            nodeId: node.id,
          },
        );
        ctx[node.id] = res.result;
        return null;
      }
      case "dateTime": {
        // The base value is resolved deterministically here (pure ctx read); the
        // CLOCK READ (when source is "now") happens in the activity, since time is
        // non-deterministic and must not touch workflow code.
        const dtCfg = asNodeConfig(cfg, "dateTime");
        const src = dtCfg.source;
        const base =
          !src || src === "now"
            ? null
            : ((getByPath(ctx[src.from], src.path) ?? null) as
                string | number | null);
        ctx[node.id] = await computeDateTime({
          base,
          addSeconds: dtCfg.addSeconds,
        });
        return null;
      }
      case "merge": {
        // Fan-in join. Only REACHED here on the LAST inbound arrival (execChain
        // absorbs earlier ones), so all inbound parents have run — combine their
        // outputs from ctx. Pure: no I/O, no cost. `<mergeId>` holds the combined
        // value; downstream reads `<mergeId>.0`/`.1` (array) or fields (object).
        const mergeCfg = asNodeConfig(cfg, "merge");
        const parents = mergeParents.get(node.id) ?? [];
        const inputs = parents.map((p) => ctx[p]);
        ctx[node.id] =
          mergeCfg.mode === "object"
            ? Object.assign(
                {},
                ...inputs.filter((i) => i !== null && typeof i === "object"),
              )
            : inputs;
        return null;
      }
      case "switch": {
        // Pure node: pick the first matching rule → { matched }. Downstream edges branch
        // on `<switchId>.matched`. Reuses evaluateCondition (structured, no eval).
        const swCfg = asNodeConfig(cfg, "switch");
        ctx[node.id] = resolveSwitch(swCfg, ctx);
        return null;
      }
      case "if": {
        // Pure node: combine predicates with AND/OR → { result }. Downstream edges branch
        // on `<ifId>.result` (eq true / eq false).
        const ifCfg = asNodeConfig(cfg, "if");
        ctx[node.id] = resolveIf(ifCfg, ctx);
        return null;
      }
      case "json": {
        // Pure node: JSON parse/stringify (deterministic ES built-ins, no activity).
        // Malformed JSON on parse throws → a node failure onError:"continue" can catch.
        const jsonCfg = asNodeConfig(cfg, "json");
        ctx[node.id] = resolveJson(jsonCfg, ctx);
        return null;
      }
      case "number": {
        // Pure node: one arithmetic op on resolved operands → { result }.
        const numCfg = asNodeConfig(cfg, "number");
        ctx[node.id] = resolveNumber(numCfg, ctx);
        return null;
      }
      case "random": {
        // Generate a fresh random value. Runs in the activity — randomness must never touch
        // deterministic workflow code. No inputs. Output { value }.
        const rndCfg = asNodeConfig(cfg, "random");
        const res = await callRandom(
          {
            operation: rndCfg.operation,
            length: rndCfg.length,
            min: rndCfg.min,
            max: rndCfg.max,
          },
          {
            tenantId: runCtx.tenantId,
            executionId: wf.workflowInfo().workflowId,
            nodeId: node.id,
          },
        );
        ctx[node.id] = { value: res.value };
        return null;
      }
      case "encode": {
        // Input resolved here (pure ctx read); the encode runs in the activity (Buffer for
        // base64/hex isn't in the deterministic bundle). Output { result }.
        const encCfg = asNodeConfig(cfg, "encode");
        const encVal = getByPath(ctx[encCfg.from], encCfg.path);
        const res = await callEncode({ operation: encCfg.operation }, encVal, {
          tenantId: runCtx.tenantId,
          executionId: wf.workflowInfo().workflowId,
          nodeId: node.id,
        });
        ctx[node.id] = { result: res.result };
        return null;
      }
      case "hmac": {
        // Binding resolution is deterministic (pure ctx read); the key fetch +
        // signing happen in the activity (the key never enters workflow history).
        const hmacCfg = asNodeConfig(cfg, "hmac");
        const result = await callHmac(resolveHmac(hmacCfg, ctx), ctx.__input, {
          tenantId: runCtx.tenantId,
          executionId: wf.workflowInfo().workflowId,
          nodeId: node.id,
        });
        ctx[node.id] = { digest: result.digest };
        return null;
      }
      case "hash": {
        // Keyless digest. Binding resolution is deterministic (pure ctx read); the hash
        // (node:crypto) runs in the activity, out of the deterministic bundle.
        const hashCfg = asNodeConfig(cfg, "hash");
        const result = await callHash(resolveHash(hashCfg, ctx), ctx.__input, {
          tenantId: runCtx.tenantId,
          executionId: wf.workflowInfo().workflowId,
          nodeId: node.id,
        });
        ctx[node.id] = { digest: result.digest };
        return null;
      }
      case "jwt": {
        const jwtCfg = asNodeConfig(cfg, "jwt");
        const result = await callJwt(resolveJwt(jwtCfg, ctx), ctx.__input, {
          tenantId: runCtx.tenantId,
          executionId: wf.workflowInfo().workflowId,
          nodeId: node.id,
        });
        ctx[node.id] = { token: result.token };
        return null;
      }
      case "totp": {
        // No bindings: the seed comes from the connection, the time from the clock
        // — both handled in the activity. Output is the current code.
        const totpCfg = asNodeConfig(cfg, "totp");
        const result = await callTotp(totpCfg, ctx.__input, {
          tenantId: runCtx.tenantId,
          executionId: wf.workflowInfo().workflowId,
          nodeId: node.id,
        });
        ctx[node.id] = { code: result.code };
        return null;
      }
      case "sendEmail": {
        // Binding resolution is deterministic (pure ctx read); the SMTP URI fetch +
        // send happen in the activity (URI/creds never enter workflow history).
        const emailCfg = asNodeConfig(cfg, "sendEmail");
        const result = await callSendEmail(
          resolveSendEmail(emailCfg, ctx),
          ctx.__input,
          {
            tenantId: runCtx.tenantId,
            executionId: wf.workflowInfo().workflowId,
            nodeId: node.id,
          },
        );
        ctx[node.id] = { messageId: result.messageId };
        costUsd += result.costUsd;
        ctx.__costUsd = costUsd;
        return null;
      }
      case "rssRead": {
        // URL resolution is deterministic (pure ctx read); the fetch + XML parse
        // (I/O, egress-guarded) run in the activity. Output {items, count} so
        // downstream filter/listOps/aggregate can operate on `<nodeId>.items`.
        const rssCfg = asNodeConfig(cfg, "rssRead");
        const over = retryOverride(node.retry, 60_000);
        const result = await (over?.callRssRead ?? callRssRead)(
          resolveRss(rssCfg, ctx),
          ctx.__input,
          {
            tenantId: runCtx.tenantId,
            executionId: wf.workflowInfo().workflowId,
            nodeId: node.id,
          },
        );
        ctx[node.id] = { items: result.items, count: result.count };
        return null;
      }
      case "executeSubWorkflow": {
        const subCfg = asNodeConfig(cfg, "executeSubWorkflow");
        // Recursion guard FIRST — never launch below the nesting cap (a graph that
        // calls itself would otherwise recurse forever). Reuses the circuit-breaker
        // terminal status (same "runaway protection tripped" intent).
        const depth = runCtx.subWorkflowDepth ?? 0;
        if (depth >= MAX_SUBWORKFLOW_DEPTH) return "circuit_open";

        // Resolve the child input deterministically (pure ctx path-reads). When the
        // node configures no input, forward the parent's own trigger input.
        const childInput = resolveSubWorkflowInput(subCfg, ctx) ?? ctx.__input;

        // Fetch + version-snapshot the child graph IN the activity (I/O). Pinning
        // the hash/version means a later edit to the child can't alter this run.
        const snapshot = await resolveSubWorkflowGraph({
          tenantId: runCtx.tenantId,
          workflowKey: subCfg.workflowKey,
        });

        // Launch the child as a durable child workflow (deterministic). The id is
        // deterministic (+stepCount so a looped node spawns distinct children).
        // Default ParentClosePolicy is TERMINATE — the child dies with the parent.
        // The child records its own Execution row (recordExecution), so it appears
        // as its own run in the Runs list. Budget: the child gets the parent's
        // REMAINING per-execution cap; its cost is metered back below.
        const result = await wf.executeChild(runGraph, {
          workflowId: `${wf.workflowInfo().workflowId}-sub-${node.id}-${stepCount}`,
          args: [
            snapshot.graph,
            childInput,
            {
              tenantId: runCtx.tenantId,
              workflowKey: subCfg.workflowKey,
              perExecutionCapUsd:
                runCtx.perExecutionCapUsd !== undefined
                  ? Math.max(0, runCtx.perExecutionCapUsd - costUsd)
                  : undefined,
              maxStepsPerRun: runCtx.maxStepsPerRun,
              graphContentHash: snapshot.contentHash,
              graphVersion: snapshot.version,
              subWorkflowDepth: depth + 1,
            } satisfies RunGraphCtx,
          ],
        });

        // Meter child spend into the parent budget (commutative sum, like agent/
        // mcp/http).
        const childCost =
          typeof result.ctx.__costUsd === "number" ? result.ctx.__costUsd : 0;
        costUsd += childCost;
        ctx.__costUsd = costUsd;

        // Expose a BOUNDED projection so the parent graph can branch on
        // `<nodeId>.status` and read child node outputs via `<nodeId>.output.*`.
        // We deliberately do NOT copy the child's whole ctx verbatim: drop the
        // internal `__*` bookkeeping (`__input` duplicates the input we passed;
        // `__costUsd` is already metered above). Each child node output is
        // individually claim-checked (≤1MB) upstream, and the depth cap bounds
        // nesting, so this payload — which rides in parent history / the
        // continueAsNew snapshot — stays bounded (CLAUDE.md: pass refs, not blobs).
        const output: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(result.ctx)) {
          if (!k.startsWith("__")) output[k] = v;
        }
        ctx[node.id] = { status: result.status, output };
        return null;
      }
      case "forEach": {
        // Map an array by running a saved graph once per item as a durable child
        // run. Same machinery as executeSubWorkflow, looped: depth guard + item cap
        // bound the fan-out; children run concurrently; results stay in item order.
        const feCfg = asNodeConfig(cfg, "forEach");
        const depth = runCtx.subWorkflowDepth ?? 0;
        if (depth >= MAX_SUBWORKFLOW_DEPTH) return "circuit_open";

        const raw = getByPath(ctx[feCfg.from], feCfg.path);
        const items = Array.isArray(raw) ? raw : [];
        if (items.length === 0) {
          ctx[node.id] = [];
          return null;
        }
        // Explicit runaway guard — never fan out past the cap (no silent truncation).
        if (items.length > MAX_FOREACH_ITEMS) return "circuit_open";

        // Resolve the child graph ONCE (same workflowKey for every item), then launch
        // one child per item with the item as its input.
        const snapshot = await resolveSubWorkflowGraph({
          tenantId: runCtx.tenantId,
          workflowKey: feCfg.workflowKey,
        });
        const parentId = wf.workflowInfo().workflowId;

        // A child that throws (a stopAndError node or a non-retryable activity error)
        // becomes a failed ENTRY rather than a rejected Promise.all that kills the
        // whole batch (child failure ≠ parent crash; a RETURNED terminal status
        // already resolves normally). Catching a deterministic rejection is replay-safe.
        // A completed child's cost folds into the parent (commutative sum) and its
        // bounded {status, output} projection is collected in ARRAY ORDER, so the graph
        // can branch on `<nodeId>.N.status` without the batch dying.
        if (wf.patched("foreach-chunked-cap-v1")) {
          // Bounded concurrency window + per-window cap divisor (audit A-3/Q-3): run
          // items in chunks of FOREACH_CONCURRENCY so at most that many child runs are
          // in flight at once, and split the remaining cap across each chunk's children
          // so their concurrent spends can't sum past it. The running `costUsd` carried
          // between chunks means an expensive early chunk can legitimately starve later
          // ones (their childCap → 0 ⇒ those children fail on budget) — the aggregate
          // never exceeds the cap, which is the rule-6 fail-safe, NOT a bug.
          const collected: {
            status: string;
            output: Record<string, unknown>;
          }[] = [];
          for (
            let start = 0;
            start < items.length;
            start += FOREACH_CONCURRENCY
          ) {
            const chunk = items.slice(start, start + FOREACH_CONCURRENCY);
            const childCap =
              runCtx.perExecutionCapUsd !== undefined
                ? perChildCap(runCtx.perExecutionCapUsd - costUsd, chunk.length)
                : undefined;
            const settled = await Promise.all(
              chunk.map((item, j) =>
                wf
                  .executeChild(runGraph, {
                    // Global index (start + j) — a chunk-local index would collide
                    // workflowIds across chunks.
                    workflowId: `${parentId}-foreach-${node.id}-${stepCount}-${start + j}`,
                    args: [
                      snapshot.graph,
                      item,
                      {
                        tenantId: runCtx.tenantId,
                        workflowKey: feCfg.workflowKey,
                        perExecutionCapUsd: childCap,
                        maxStepsPerRun: runCtx.maxStepsPerRun,
                        graphContentHash: snapshot.contentHash,
                        graphVersion: snapshot.version,
                        subWorkflowDepth: depth + 1,
                      } satisfies RunGraphCtx,
                    ],
                  })
                  .then((r) => ({ ok: true as const, r }))
                  .catch(() => ({ ok: false as const })),
              ),
            );
            for (const s of settled) {
              if (!s.ok) {
                collected.push({ status: "failed", output: {} });
                continue;
              }
              const r = s.r;
              costUsd +=
                typeof r.ctx.__costUsd === "number" ? r.ctx.__costUsd : 0;
              const output: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(r.ctx)) {
                if (!k.startsWith("__")) output[k] = v;
              }
              collected.push({ status: r.status as string, output });
            }
          }
          ctx.__costUsd = costUsd;
          ctx[node.id] = collected;
          return null;
        }

        // LEGACY path (runs started before the patch): single fan-out, one shared cap
        // snapshot. Kept byte-identical so in-flight runs replay without nondeterminism.
        const childCap =
          runCtx.perExecutionCapUsd !== undefined
            ? Math.max(0, runCtx.perExecutionCapUsd - costUsd)
            : undefined;

        const settled = await Promise.all(
          items.map((item, i) =>
            wf
              .executeChild(runGraph, {
                workflowId: `${parentId}-foreach-${node.id}-${stepCount}-${i}`,
                args: [
                  snapshot.graph,
                  item,
                  {
                    tenantId: runCtx.tenantId,
                    workflowKey: feCfg.workflowKey,
                    perExecutionCapUsd: childCap,
                    maxStepsPerRun: runCtx.maxStepsPerRun,
                    graphContentHash: snapshot.contentHash,
                    graphVersion: snapshot.version,
                    subWorkflowDepth: depth + 1,
                  } satisfies RunGraphCtx,
                ],
              })
              .then((r) => ({ ok: true as const, r }))
              .catch(() => ({ ok: false as const })),
          ),
        );

        const collected = settled.map((s) => {
          if (!s.ok) return { status: "failed", output: {} };
          const r = s.r;
          costUsd += typeof r.ctx.__costUsd === "number" ? r.ctx.__costUsd : 0;
          const output: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(r.ctx)) {
            if (!k.startsWith("__")) output[k] = v;
          }
          return { status: r.status as string, output };
        });
        ctx.__costUsd = costUsd;
        ctx[node.id] = collected;
        return null;
      }
      case "wait": {
        const waitCfg = asNodeConfig(cfg, "wait");
        if (waitCfg.mode === "webhook") {
          // Durable pause until an external system resumes the run (Signal + condition(),
          // exactly like humanApproval — no polling, survives crashes/days). An optional
          // durable timer auto-continues after timeoutSeconds so a stuck run isn't wedged.
          status = "awaiting_webhook";
          await syncStatus(); // surface the pause in the Runs list
          const timeoutMs =
            typeof waitCfg.timeoutSeconds === "number" &&
            waitCfg.timeoutSeconds > 0
              ? waitCfg.timeoutSeconds * 1000
              : undefined;
          let resumed = true;
          if (timeoutMs !== undefined) {
            resumed = await wf.condition(
              () => webhookResume !== undefined,
              timeoutMs,
            );
          } else {
            await wf.condition(() => webhookResume !== undefined);
          }
          status = "running";
          // Durable, branchable output: <nodeId>.resumed / .timedOut / .payload.
          ctx[node.id] = {
            resumed,
            timedOut: !resumed,
            payload: resumed ? (webhookResume?.payload ?? null) : null,
          };
          webhookResume = undefined; // consume so a later loop iteration can pause again
          return null;
        }
        // Durable delay via a Temporal timer — survives crashes, costs nothing
        // while waiting, and replays deterministically (no wall-clock, no
        // sleep-loop). Skip a non-positive duration so the node just passes through.
        const secs = waitCfg.durationSeconds ?? 0;
        if (secs > 0) await wf.sleep(secs * 1000);
        return null;
      }
      case "stopAndError": {
        // Terminal failure: throw a non-retryable ApplicationFailure so the run
        // ends as FAILED (surfaced in the Runs list + timeline) rather than
        // burning Temporal task retries. The message is static, non-secret text.
        const errCfg = asNodeConfig(cfg, "stopAndError");
        throw wf.ApplicationFailure.nonRetryable(
          errCfg.message && errCfg.message.trim()
            ? errCfg.message
            : "Workflow stopped by a Stop and Error node",
          "STOP_AND_ERROR",
        );
      }
      case "respondToWebhook": {
        // Pure node: set the response the webhook ingress returns synchronously,
        // then CONTINUE (respond fast, keep working). The response is exposed via
        // webhookResponseQuery, which the ingress polls.
        const rwCfg = asNodeConfig(cfg, "respondToWebhook");
        webhookResponse = resolveWebhookResponse(rwCfg, ctx);
        ctx[node.id] = { statusCode: webhookResponse.statusCode };
        return null;
      }
      case "code": {
        // Sandboxed user JS runs in the activity (QuickJS is non-deterministic).
        // Pass the entry input + a __-stripped snapshot of upstream outputs; the
        // code's return value becomes this node's output.
        const codeCfg = asNodeConfig(cfg, "code");
        const snapshot: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(ctx)) {
          if (!k.startsWith("__")) snapshot[k] = v;
        }
        const result = await callCode(
          codeCfg,
          { input: ctx.__input, ctx: snapshot },
          {
            tenantId: runCtx.tenantId,
            executionId: wf.workflowInfo().workflowId,
            nodeId: node.id,
          },
        );
        ctx[node.id] = result.result;
        return null;
      }
      case "humanApproval": {
        status = "awaiting_approval";
        await syncStatus(); // surface the pause in the Runs list / approval queue
        // Notify the tenant (best-effort) that a decision is needed — a HITL pause can
        // last days, so don't rely on someone watching the inbox. Gated + swallowed so
        // it can never affect the run. Patched so in-flight runs don't diverge on replay.
        const approvalCfg2 = (cfg ?? {}) as {
          title?: string;
          timeoutHours?: number;
        };
        if (wf.patched("notify-v1") && !runCtx.isErrorHandler) {
          try {
            await sendNotification({
              tenantId: runCtx.tenantId,
              kind: "approval_pending",
              workflowId: wf.workflowInfo().workflowId,
              workflowKey: runCtx.workflowKey,
              title: approvalCfg2.title,
            });
          } catch {
            /* best-effort — never block the pause on a notification */
          }
        }
        // Optional auto-reject timeout (durable Temporal timer; deterministic).
        const approvalCfg = (cfg ?? {}) as { timeoutHours?: number };
        const timeoutMs =
          typeof approvalCfg.timeoutHours === "number" &&
          approvalCfg.timeoutHours > 0
            ? approvalCfg.timeoutHours * 3_600_000
            : undefined;
        let decided = true;
        if (timeoutMs !== undefined) {
          // condition(fn, timeout) → true if signalled, false if it timed out.
          decided = await wf.condition(() => approval !== undefined, timeoutMs);
        } else {
          await wf.condition(() => approval !== undefined); // wait forever
        }
        status = "running";
        // Record the decision + reason on the node's output so it's durable, visible
        // in the run, and branchable downstream (<nodeId>.approved / .comment). A ctx
        // write is in-workflow state — no new command, so it stays replay-safe.
        if (!decided) {
          ctx[node.id] = {
            approved: false,
            comment: "Auto-rejected: no decision before the timeout.",
          };
          return "rejected"; // timed out → auto-reject
        }
        ctx[node.id] = {
          approved: approval!.approved,
          comment: approval!.comment ?? null,
        };
        if (!approval!.approved) return "rejected";
        approval = undefined; // consume so a later loop iteration can pause again
        return null;
      }
    }
    return null;
  }

  /**
   * Execute a chain from `startId`: run a node, then follow the outgoing edges
   * whose condition passes (Slice #6). 0 next = chain ends; 1 = sequential/branch
   * (incl. a back-edge = loop); >1 = parallel fan-out via Promise.all (declared-
   * edge order; the first terminal in array order stops the whole run). Returns a
   * terminal status, or null when the chain completes normally.
   */
  async function execChain(
    startId: string,
    topLevel: boolean,
  ): Promise<ExecutionStatus | null> {
    let current: string | undefined = startId;
    while (current !== undefined) {
      // Circuit breaker + per-execution cap, before the node's work. The circuit
      // breaker now meaningfully bounds intentional LOOPS (closes QA#7).
      stepCount++;
      if (
        runCtx.maxStepsPerRun !== undefined &&
        stepCount > runCtx.maxStepsPerRun
      ) {
        return "circuit_open";
      }
      if (
        runCtx.perExecutionCapUsd !== undefined &&
        costUsd >= runCtx.perExecutionCapUsd
      ) {
        return "budget_exceeded";
      }

      const node = nodeById.get(current);
      if (node === undefined) {
        // Dangling edge / unknown node → terminal, not an infinite workflow-task
        // retry (QA#8). The control plane also validates before start.
        return "invalid_graph";
      }
      currentNodeId = current;

      // Items model (design ITEMS-MODEL-CURRENT-ITEM.md §0.2): a splitOut runs its LINEAR PURE
      // region once per array element, then hands the collected array to loopEnd. The region is
      // the DRAWN bracket (validated at save), so there is no participation inference here — just a
      // bounded loop over execNode. Gated by patched() so runs that predate this stay replay-safe
      // (old graphs have no splitOut, so they never reach this branch anyway).
      if (node.type === "splitOut" && wf.patched("items-model-v1")) {
        const region = itemsRegionBySplit.get(current);
        if (region) {
          const splitCfg = asNodeConfig(
            resolveTemplates(
              (node.config ?? {}) as Record<string, unknown>,
              ctx,
            ),
            "splitOut",
          );
          const arr = getByPath(ctx[splitCfg.from], splitCfg.path);
          // Fail closed on a DEFINED non-array source (a mis-binding) rather than silently mapping
          // 0 times; a missing/null source is a legitimate "no items" → empty region.
          if (arr !== undefined && arr !== null && !Array.isArray(arr)) {
            throw wf.ApplicationFailure.nonRetryable(
              `splitOut '${current}' source is not an array`,
              "ITEMS_NOT_ARRAY",
            );
          }
          const items = Array.isArray(arr) ? arr : [];
          const collected: unknown[] = [];
          let firstIter: Record<string, unknown> | undefined;

          for (let i = 0; i < items.length; i++) {
            stepCount++; // each item is a logical step (bounds a runaway splitOut via the breaker)
            if (
              runCtx.maxStepsPerRun !== undefined &&
              stepCount > runCtx.maxStepsPerRun
            ) {
              return "circuit_open";
            }
            ctx[current] = items[i]; // the current item — region nodes bind to splitOut to read it
            for (const rid of region.regionNodeIds) {
              const rnode = nodeById.get(rid);
              if (!rnode) return "invalid_graph";
              currentNodeId = rid; // attribute a mid-region failure to the actual node, not splitOut
              try {
                const t = await execNode(rnode);
                if (t !== null) return t; // defensive: today's pure region nodes never return terminal
              } catch (err) {
                if (rnode.onError !== "continue") throw err;
                ctx[rid] = { error: nodeErrorMessage(err) };
              }
            }
            collected.push(ctx[region.collectFrom]);
            if (i === 0) {
              firstIter = { [current]: items[0] };
              for (const rid of region.regionNodeIds) firstIter[rid] = ctx[rid];
            }
          }

          // items-authoritative: leave ctx[regionNode] as the FIRST item's projection (matches the
          // single-item world; an empty array leaves the splitOut/region outputs undefined).
          if (firstIter) {
            for (const k of Object.keys(firstIter)) ctx[k] = firstIter[k];
          } else {
            ctx[current] = undefined;
            for (const rid of region.regionNodeIds) ctx[rid] = undefined;
          }
          ctx[region.loopEndId] = collected; // loopEnd's output IS the collected array
          currentNodeId = region.loopEndId;
          current = nextNodes(graph, region.loopEndId, ctx)[0]; // linear exit → single next
          continue;
        }
      }

      // Fan-in join gate (Slice N5): when a branch reaches a merge, record its
      // arrival; if not all inbound branches are in yet, ABSORB this branch (stop
      // here — a sibling will complete the join). Only the LAST arrival falls
      // through to run the merge + continue downstream, so the merge and everything
      // after it execute exactly once. (Determinism: arrival order under the
      // Promise.all fan-out is fixed by microtask/activity-completion order, which
      // Temporal replays identically.)
      if (node.type === "merge") {
        const expected = mergeParents.get(current)?.length ?? 0;
        const arrived = (mergeArrivals[current] ?? 0) + 1;
        mergeArrivals[current] = arrived;
        if (arrived < expected) return null;
      }

      // Per-node error policy (n8n's "On Error"). "continue" catches a node failure,
      // records `{ error }` as its output, and proceeds so the graph can branch on
      // `<nodeId>.error`; "stop" (default) rethrows to fail the run (the workflow-level
      // error handler, if bound, then fires). The catch is deterministic — Temporal
      // records the activity failure in history and replays it identically. costUsd
      // accumulated before the failure is kept (already metered).
      let terminal: ExecutionStatus | null;
      try {
        terminal = await execNode(node);
      } catch (err) {
        if (node.onError !== "continue") throw err;
        ctx[node.id] = { error: nodeErrorMessage(err) };
        terminal = null;
      }
      if (terminal !== null) return terminal;

      const nexts = nextNodes(graph, current, ctx);
      if (nexts.length <= 1) {
        current = nexts[0]; // sequential / branch / loop back-edge (undefined = end)

        // Bound history growth on long loops (Slice #6): at a safe single-next
        // boundary in the top-level chain (no pending approval, no in-flight
        // handler), continueAsNew carrying the state so the run resumes intact.
        const cap = runCtx.continueAsNewAfterSteps;
        const shouldContinue =
          wf.workflowInfo().continueAsNewSuggested ||
          (cap !== undefined && stepCount >= cap);
        if (
          topLevel &&
          current !== undefined &&
          shouldContinue &&
          approval === undefined &&
          wf.allHandlersFinished()
        ) {
          await wf.continueAsNew<typeof runGraph>(graph, input, runCtx, {
            ctx,
            costUsd,
            stepCount,
            startNodeId: current,
            mergeArrivals,
          });
        }
      } else {
        // Parallel fan-out: each branch runs to its own terminal concurrently.
        // Cost/steps are commutative accumulations + Temporal replays activity
        // completion order deterministically, so the shared state stays
        // replay-safe. The per-exec cap can be overshot by a bounded amount across
        // concurrent branches (same class as the documented monthly-cap overshoot).
        // Branches are NOT top-level → they don't continueAsNew mid-flight.
        const results = await Promise.all(
          nexts.map((n) => execChain(n, false)),
        );
        for (const r of results) if (r !== null) return r; // array (edge) order
        return null;
      }
    }
    return null;
  }

  // Wrap the walk so BOTH failure surfaces are observable in one place: a RETURNED
  // terminal status (rejected/budget_exceeded/circuit_open/invalid_graph) and a
  // THROWN ApplicationFailure (stopAndError, non-retryable activity errors) that
  // would otherwise escape runGraph entirely.
  let threw: unknown;
  try {
    const terminal = await execChain(currentNodeId, true);
    status = terminal ?? "completed";

    // Fail LOUD on a stranded fan-in join (Slice N5): if a merge received SOME but
    // not all of its inbound branches, the join never fired and everything after it
    // was silently skipped — reporting "completed" would look like success while
    // having done nothing. This happens when a conditional path UPSTREAM of a merge
    // branch prevents that branch from arriving (validateGraph only blocks conditional
    // edges DIRECTLY into a merge). Surface it as a terminal invalid_graph instead of
    // a clean completion. (Only overrides a would-be success — a real terminal status
    // from the run itself wins.)
    if (terminal === null) {
      for (const [mergeId, parents] of mergeParents) {
        const arrived = mergeArrivals[mergeId] ?? 0;
        if (arrived > 0 && arrived < parents.length) {
          status = "invalid_graph";
          break;
        }
      }
    }
  } catch (e) {
    // Framework control-flow signals are NOT app failures and must propagate
    // untouched: continueAsNew (a long run unwinding to resume — the CAN call lives
    // inside execChain) and cancellation. Catching either would fire the handler +
    // issue commands mid-unwind (determinism hazard).
    if (e instanceof wf.ContinueAsNew || wf.isCancellation(e)) throw e;
    threw = e;
  }

  // On failure, start the tenant's error-handler graph (if bound) as a DETACHED child
  // — ParentClosePolicy.ABANDON so it survives THIS run failing. Loop-guarded
  // (a handler run never fires its own handler) and patched so in-flight runs that
  // predate this don't diverge on replay. A missing handler / start failure must
  // never mask the original error.
  const isFailure =
    threw !== undefined ||
    status === "rejected" ||
    status === "budget_exceeded" ||
    status === "circuit_open" ||
    status === "invalid_graph";
  // Notify the tenant (best-effort) that a run failed — same swallow + patch gate as
  // the approval notification. Skipped for error-handler runs (they ARE the response).
  if (isFailure && !runCtx.isErrorHandler && wf.patched("notify-v1")) {
    try {
      await sendNotification({
        tenantId: runCtx.tenantId,
        kind: "run_failed",
        workflowId: wf.workflowInfo().workflowId,
        workflowKey: runCtx.workflowKey,
        detail: threw !== undefined ? "failed" : status,
      });
    } catch {
      /* best-effort — a notification problem must not mask the failure */
    }
  }
  if (
    isFailure &&
    runCtx.errorWorkflowKey &&
    !runCtx.isErrorHandler &&
    wf.patched("onerror-handler-v1")
  ) {
    try {
      const handler = await resolveSubWorkflowGraph({
        tenantId: runCtx.tenantId,
        workflowKey: runCtx.errorWorkflowKey,
      });
      const parentId = wf.workflowInfo().workflowId;
      const errorPayload = {
        failedWorkflowId: parentId,
        workflowKey: runCtx.workflowKey,
        status: threw !== undefined ? "failed" : status,
        error:
          threw !== undefined
            ? {
                message: threw instanceof Error ? threw.message : String(threw),
                type:
                  threw instanceof wf.ApplicationFailure
                    ? threw.type
                    : undefined,
              }
            : undefined,
      };
      await wf.startChild(runGraph, {
        workflowId: `${parentId}-onerror`,
        parentClosePolicy: wf.ParentClosePolicy.ABANDON,
        args: [
          handler.graph,
          errorPayload,
          {
            tenantId: runCtx.tenantId,
            workflowKey: runCtx.errorWorkflowKey,
            isErrorHandler: true,
            graphContentHash: handler.contentHash,
            graphVersion: handler.version,
          } satisfies RunGraphCtx,
        ],
      });
    } catch {
      // swallow — never mask the original failure with a handler problem
    }
  }

  if (threw !== undefined) throw threw; // preserve FAILED semantics (no syncStatus)
  await syncStatus(); // final status + cost for the Runs list
  return { status, ctx };
}

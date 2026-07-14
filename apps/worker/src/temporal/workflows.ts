import * as wf from "@temporalio/workflow";
import {
  approvalSignal,
  chatMessageSignal,
  chatReplyQuery,
  resumeSignal,
  stateQuery,
  webhookResponseQuery,
} from "@naary/contracts";
import type {
  ApprovalInput,
  ChatReplyState,
  ChatTurnInput,
  ExecutionState,
  ExecutionStatus,
  ResumeInput,
  WebhookResponse,
} from "@naary/contracts";
import {
  getByPath,
  evaluateCondition,
  resolveTemplates,
  collectUnresolved,
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
  resolveIntegrationFields,
  getIntegrationAction,
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
  BATCHABLE_REGION_ACTIVITIES,
  type ItemsRegion,
  type TraceCell,
  type RegionTrace,
  type UnresolvedRef,
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

/** Max sub-workflow nesting depth (a run at this depth refuses to spawn children).
 *  Bounds accidental/infinite recursion — a saved graph that calls itself. */
const MAX_SUBWORKFLOW_DEPTH = 5;

/** Max items a single forEach will fan out to (child run per item). An array larger
 *  than this trips the circuit breaker — filter/limit upstream first. */
const MAX_FOREACH_ITEMS = 100;

/** Items model A3: max items a single splitOut region batches through ONE mapNode activity. The N
 *  resolved configs (in) + N outputs (out) ride in Temporal history verbatim (no global codec), so
 *  a very large N would cross the ~2MB payload cap and hard-fail the history write. Fail closed
 *  BELOW the cap with a clear message; larger fan-out belongs in `forEach` (child runs, own history)
 *  or an upstream chunk. (Per-payload claim-check offload to lift this is a later slice.) */
const MAX_MAP_BATCH_ITEMS = 100;

/** Items model A4: max ACTIVITY executions across a per-item sub-DAG region in one run (design
 *  §0.4.1). A4 regions run item-major and can't batch (branching), so each live activity occurrence is
 *  its own Temporal command → history grows O(live activity executions). Fail closed here — a region
 *  that needs more per-item activity fan-out with branching belongs in `forEach` (child run per item).
 *  Distinct from MAX_MAP_BATCH_ITEMS, which caps a single A3 mapNode's batch, not a running total. */
const MAX_A4_REGION_ACTIVITY_EXECUTIONS = 100;

/** Per-item INTERMEDIATE trace grid (items-model §0.4.2). Capture is PURE STATE — it writes a
 *  `__regionTrace` key into `ctx` and issues NO Temporal command and NO `stepCount` change, so it is
 *  replay-safe by construction (needs no `patched()`) and rides the CAN snapshot (:1647) + return
 *  (:1786) verbatim like the rest of `ctx`. The caps below are what keep that carried payload bounded
 *  (CLAUDE.md ~2MB): first K items captured (excess → `truncatedItems`, never silent), each cell's
 *  value JSON-capped. A cell is tri-state — value / dead (A4 dead branch) / error. */
const MAX_TRACE_ITEMS = 50;
const MAX_TRACE_CELL_BYTES = 1000;
/** Aggregate cap across ALL regions in one run segment. Per-region worst case is ~650KB (50 rows ×
 *  ~13 cols × 1KB), so several full wide regions could otherwise push the CAN snapshot (:1647) + return
 *  (:1786) past Temporal's ~2MB and FAIL AN OTHERWISE-HEALTHY RUN. A diagnostic must never do that:
 *  once this budget is hit, later regions emit `{ unavailable: "budget" }` instead of a grid.
 *  TraceCell / RegionTrace wire types are shared from @naary/dsl (worker writes, web renders). */
const MAX_TRACE_TOTAL_BYTES = 512_000;

/** One tri-state cell from a node's per-item output. `live=false` ⇒ dead branch (A4). An
 *  `onError:"continue"` result is `{ error }` ⇒ shown as `err`. Otherwise the value, JSON-capped so a
 *  large output can't blow the carried payload (over the cap → a visible truncation marker). PURE. */
function traceCell(value: unknown, live: boolean): TraceCell {
  if (!live) return { dead: true };
  if (
    value !== null &&
    typeof value === "object" &&
    "error" in (value as object)
  ) {
    return { err: String((value as { error: unknown }).error) };
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return { v: "<unserializable>" };
  }
  if (json !== undefined && json.length > MAX_TRACE_CELL_BYTES) {
    return { v: `<truncated ${json.length} bytes>` };
  }
  return { v: value };
}

// The HTTP node's request deadline is user-configurable (up to MAX_HTTP_TIMEOUT_MS,
// clamped in the activity), so it needs a start-to-close strictly ABOVE that cap —
// otherwise Temporal would kill a slow-but-running request and RETRY it, duplicating
// a non-idempotent POST/PUT/PATCH/DELETE. The activity's AbortController is the real
// deadline; this timeout is just the outer backstop.
const { callHttpRequest } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "150 seconds",
  retry: { maximumAttempts: 3 },
});

// Native integration node. READ actions are idempotent → normal retries. WRITE actions
// (create_issue/comment/transition) run AT-MOST-ONCE — a lost response must not duplicate a
// create (design §4, same reasoning as callSqlExec/callSendEmail). The interpreter picks the
// proxy by the catalog action's `write` flag.
const { callIntegration: callIntegrationRead } = wf.proxyActivities<
  typeof activities
>({ startToCloseTimeout: "60 seconds", retry: { maximumAttempts: 3 } });
const { callIntegration: callIntegrationWrite } = wf.proxyActivities<
  typeof activities
>({ startToCloseTimeout: "60 seconds", retry: { maximumAttempts: 1 } });

// Items model A3: the batched per-item map. maxAttempts:1 — mapNode catches per-item errors and
// returns them, so it only throws on a genuine infra crash; retrying a batch of non-idempotent I/O
// would re-charge + duplicate side effects (design §0.3). The start-to-close must cover the WORST
// case, or a healthy batch times out (an infra-throw): up to MAX_MAP_BATCH_ITEMS (100) items at
// concurrency 10 = 10 waves, and the slowest per-item deadline is httpRequest's ~150s → ~25 min.
// 40 min leaves headroom; the per-item calls hold their own in-activity deadlines.
const { mapNode } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "40 minutes",
  retry: { maximumAttempts: 1 },
});

// codeAgent runs an agentic coding CLI subprocess — minutes-long, and AT-MOST-ONCE
// (maximumAttempts: 1): later slices commit/push/PR, so a partial write must never be
// auto-retried. Its own block (like mapNode) keeps that long timeout off the shared 1-min
// activities. The subprocess timeout (cfg.timeoutMs) is the real deadline within this.
const { callCodeAgent } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "40 minutes",
  retry: { maximumAttempts: 1 },
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
  /** The `respondToWebhook` body, if the graph set one. Normally consumed via the
   *  webhookResponseQuery (the ingress polls it), but a CHILD run can't be queried by its
   *  parent mid-flight, so the durable chat session reads the reply from here (design §2.1b,
   *  option i). Undefined when the graph produced no synchronous response. */
  reply?: unknown;
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
  // Running total of per-item trace bytes across ALL regions this segment (§0.4.2 aggregate cap). Not
  // carried across CAN — each segment re-budgets against its own fresh regions (prior segments' traces
  // already rode their own snapshot). Command-neutral like the rest of the trace.
  let traceBytes = 0;

  // Fan-in join state (Slice N5). `mergeParents` maps a merge node id → its inbound
  // parents' ids in DECLARED edge order (its length is the expected in-degree);
  // precomputed once from the graph (deterministic, pure). `mergeArrivals` counts
  // how many inbound branches have reached each merge so far — the last to arrive
  // runs it. Only nodes of type "merge" participate, so other multi-inbound nodes
  // (e.g. loop back-edges) keep their existing behavior.
  const nodeById = new Map<string, NodeDef>(graph.nodes.map((n) => [n.id, n]));
  // Graph node-id set — lets the unresolved-input diagnostic tell "source ran but was empty"
  // (a real node) from "source doesn't exist" (a typo/deleted node). Pure + precomputed once.
  const nodeIdSet = new Set(nodeById.keys());

  // Items model (design ITEMS-MODEL-CURRENT-ITEM.md): precompute the splitOut→region map. Pure +
  // deterministic (same source of truth the save-gate validates), so computing it never affects
  // history; the per-item EXECUTION is what's gated by patched() below.
  const itemsRegionBySplit = new Map<string, ItemsRegion>();
  const a4RegionMergeIds = new Set<string>();
  for (const r of computeItemsRegions(graph).regions) {
    itemsRegionBySplit.set(r.splitOutId, r);
    // A merge INSIDE an A4 region is owned by that region's per-item pass, NOT the top-level fan-in
    // walker — so it must not participate in mergeParents/stranded-join. (Pre-A4 graphs have no region
    // merge, so this set is empty for them and the top-level behavior is byte-identical.)
    if (r.kind === "a4") {
      for (const id of r.regionNodeIds) {
        if (nodeById.get(id)?.type === "merge") a4RegionMergeIds.add(id);
      }
    }
  }

  const mergeParents = new Map<string, string[]>();
  for (const n of graph.nodes) {
    if (n.type === "merge" && !a4RegionMergeIds.has(n.id)) {
      mergeParents.set(
        n.id,
        graph.edges.filter((e) => e.to === n.id).map((e) => e.from),
      );
    }
  }
  const mergeArrivals: Record<string, number> = resume?.mergeArrivals
    ? { ...resume.mergeArrivals }
    : {};

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
      graphVersion: runCtx.graphVersion,
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

  /** Run one node's side effect. Returns a TERMINAL status to stop the whole run
   *  (rejected), or null to continue. Mutates ctx / cost via the closures. */
  async function execNode(node: NodeDef): Promise<ExecutionStatus | null> {
    // Template-lite expressions: resolve any `{{ nodeId.path }}` in string config against ctx
    // BEFORE the node runs (pure + deterministic — design docs/design/EXPRESSIONS.md).
    const cfg = resolveTemplates(
      (node.config ?? {}) as Record<string, unknown>,
      ctx,
    );
    // Diagnose inputs (tokens + bindings) whose SOURCE produced no output — so an empty/failed
    // node names WHICH source was missing on the run detail. Pure + deterministic (getByPath over
    // ctx), issues NO Temporal command → replay-safe by construction, like __regionTrace (needs no
    // patched()). Keyed by node id so a re-run in a loop overwrites rather than piling up.
    const missing = collectUnresolved(node, ctx, nodeIdSet);
    if (missing.length > 0) {
      const diag = (ctx.__unresolved ??= {}) as Record<string, UnresolvedRef[]>;
      diag[node.id] = missing;
    } else if (ctx.__unresolved && typeof ctx.__unresolved === "object") {
      // A prior pass (loop re-run) may have flagged this node — clear it, and drop the
      // whole key when nothing remains so a fully-resolved run's ctx is byte-identical.
      const diag = ctx.__unresolved as Record<string, UnresolvedRef[]>;
      delete diag[node.id];
      if (Object.keys(diag).length === 0) delete ctx.__unresolved;
    }
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
      case "chatTrigger":
        // Entry node: the run was started by a hosted chat message (public endpoint + durable
        // session are later slices). The inbound { message, sessionId } IS the run input.
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
      case "codeAgent": {
        // The prompt's {{…}} is already resolved in `cfg`. No retryOverride: this node is
        // AT-MOST-ONCE (its proxy block pins maximumAttempts:1) — later slices commit/PR,
        // so a partial write must never auto-retry. The activity fetches the BYOK key.
        const caCfg = asNodeConfig(cfg, "codeAgent");
        const caResult = await callCodeAgent(
          {
            tool: caCfg.tool,
            prompt: caCfg.prompt,
            systemPrompt: caCfg.systemPrompt,
            model: caCfg.model,
            maxTurns: caCfg.maxTurns,
            maxBudgetUsd: caCfg.maxBudgetUsd,
            timeoutMs: caCfg.timeoutMs,
            costUsd: caCfg.costUsd,
          },
          ctx.__input,
          {
            tenantId: runCtx.tenantId,
            executionId: wf.workflowInfo().workflowId,
            nodeId: node.id,
          },
        );
        ctx[node.id] = caResult;
        costUsd += caResult.costUsd;
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
      case "integration": {
        // Native provider action. Field resolution (static + bindings) is deterministic
        // graph work → HERE; the auth fetch + egress + HTTP is in the activity. A WRITE
        // action runs AT-MOST-ONCE (no retry) so a lost response can't duplicate a create
        // (design §4); reads retry. No per-node retryOverride — the write/read split governs
        // idempotency and a retry override must never re-enable retries on a write.
        const iCfg = asNodeConfig(cfg, "integration");
        const action = getIntegrationAction(iCfg.provider, iCfg.action);
        const runIntegration = action?.write
          ? callIntegrationWrite
          : callIntegrationRead;
        ctx[node.id] = await runIntegration(
          iCfg,
          resolveIntegrationFields(iCfg, ctx),
          {
            tenantId: runCtx.tenantId,
            executionId: wf.workflowInfo().workflowId,
            nodeId: node.id,
          },
        );
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
      case "vectorUpsert": {
        // RAG: input resolved here (pure ctx read); the BYOK embed + pgvector write are in the
        // activity (key never crosses the workflow boundary). Output { upserted }.
        const vuCfg = asNodeConfig(cfg, "vectorUpsert");
        const vuVal = getByPath(ctx[vuCfg.from], vuCfg.path);
        const res = await callVectorUpsert(
          { collection: vuCfg.collection },
          vuVal,
          {
            tenantId: runCtx.tenantId,
            executionId: wf.workflowInfo().workflowId,
            nodeId: node.id,
          },
        );
        ctx[node.id] = res.result;
        costUsd += res.costUsd; // embedding spend, metered like any activity
        ctx.__costUsd = costUsd;
        return null;
      }
      case "vectorQuery": {
        // RAG: embed the query + return the top-k nearest chunks (activity). Output { matches }.
        const vqCfg = asNodeConfig(cfg, "vectorQuery");
        const vqVal = getByPath(ctx[vqCfg.from], vqCfg.path);
        const res = await callVectorQuery(
          { collection: vqCfg.collection, topK: vqCfg.topK },
          vqVal,
          {
            tenantId: runCtx.tenantId,
            executionId: wf.workflowInfo().workflowId,
            nodeId: node.id,
          },
        );
        ctx[node.id] = res.result;
        costUsd += res.costUsd;
        ctx.__costUsd = costUsd;
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
          const splitOutId = current; // narrowed to string here (the while-loop guard); stable id
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
          const N = items.length;
          let collected: unknown[] = [];
          let firstIter: Record<string, unknown> | undefined;
          // Per-item trace grid (§0.4.2). Captured ONLY in the per-item in-workflow loops (A4, A2);
          // the A3 node-major branch leaves `traced` false so the run view renders the legible
          // "unavailable for batched-activity regions" message rather than a blank/partial grid.
          // splitOut is column 0 (the input item that drives the branch); then region nodes in topo
          // order. Capture is stepCount-neutral and issues no command — see traceCell / MAX_TRACE_*.
          const traceRows: Record<string, TraceCell>[] = [];
          const traceNodes = [splitOutId, ...region.regionNodeIds];
          let traced = false;
          let a3Unavailable = false; // A3 node-major region → emit the "unavailable" marker instead

          const overBudget = (): boolean =>
            runCtx.maxStepsPerRun !== undefined &&
            stepCount > runCtx.maxStepsPerRun;

          // A3 (design §0.3): a region containing a batchable ACTIVITY node runs NODE-major (one
          // mapNode activity per node, N items batched). A PURE-only region keeps A2's exact
          // item-major loop — safe because the graph is content-hash-snapshotted at run start, so an
          // in-flight A2 run's region can never gain an activity and always takes the item-major path.
          const hasActivity = region.regionNodeIds.some((rid) =>
            BATCHABLE_REGION_ACTIVITIES.has(nodeById.get(rid)?.type ?? ""),
          );

          // ORDER IS LOAD-BEARING (replay safety): `kind === "a4"` MUST short-circuit before
          // `patched()`. A pre-A4 run has only linear regions, so it never CALLS this new patched()
          // marker on replay and stays deterministic. Flipping the operands would make every in-flight
          // linear run evaluate a new patched() on replay → nondeterminism. Do not reorder.
          if (region.kind === "a4" && wf.patched("items-model-a4-v1")) {
            // ── A4: PER-ITEM SUB-DAG (design §0.4.1) ──
            // Item-major (branching breaks the A3 batch). For each item, one topological pass with
            // dead-branch propagation: a region node is LIVE iff some in-edge's source is live AND its
            // condition passes; if/switch mark exactly the matched edge live. A `merge` combines only
            // its LIVE inputs. Topo order (from the validator) ⇒ every predecessor's liveness is known
            // before a node is reached, so ONE pass suffices.
            const regionSet = new Set(region.regionNodeIds);
            // Group in-region edges by their target in ONE pass over graph.edges (not a filter per
            // region node) — this runs on the workflow task thread, so keep it O(edges), not O(nodes×edges).
            const inEdgesOf = new Map<string, typeof graph.edges>();
            for (const e of graph.edges) {
              if (
                regionSet.has(e.to) &&
                (e.from === splitOutId || regionSet.has(e.from))
              ) {
                const list = inEdgesOf.get(e.to);
                if (list) list.push(e);
                else inEdgesOf.set(e.to, [e]);
              }
            }
            let activityExecs = 0;
            traced = true;

            for (let i = 0; i < N; i++) {
              stepCount++;
              if (overBudget()) return "circuit_open";
              ctx[splitOutId] = items[i];
              const live = new Map<string, boolean>();

              for (const rid of region.regionNodeIds) {
                stepCount++;
                if (overBudget()) return "circuit_open";
                const rnode = nodeById.get(rid);
                if (!rnode) return "invalid_graph";
                // LIVE in-edges: source live (splitOut is always live) AND condition passes now.
                const liveIns = (inEdgesOf.get(rid) ?? []).filter((e) => {
                  const srcLive =
                    e.from === splitOutId ? true : (live.get(e.from) ?? false);
                  return (
                    srcLive &&
                    (!e.condition || evaluateCondition(e.condition, ctx))
                  );
                });
                if (liveIns.length === 0) {
                  live.set(rid, false);
                  ctx[rid] = undefined; // dead this item — no run, no side effect
                  continue;
                }
                live.set(rid, true);
                currentNodeId = rid;

                if (rnode.type === "merge") {
                  // Combine only the LIVE inputs (a dead branch contributes nothing).
                  const mode = (rnode.config as { mode?: string } | undefined)
                    ?.mode;
                  const inputs = liveIns.map((e) => ctx[e.from]);
                  ctx[rid] =
                    mode === "object"
                      ? Object.assign(
                          {},
                          ...inputs.filter(
                            (x) => x !== null && typeof x === "object",
                          ),
                        )
                      : inputs;
                  continue;
                }
                if (BATCHABLE_REGION_ACTIVITIES.has(rnode.type)) {
                  activityExecs++;
                  if (activityExecs > MAX_A4_REGION_ACTIVITY_EXECUTIONS) {
                    throw wf.ApplicationFailure.nonRetryable(
                      `splitOut region '${splitOutId}' ran ${activityExecs} per-item activities over the ${MAX_A4_REGION_ACTIVITY_EXECUTIONS} cap — use forEach for large branching fan-out`,
                      "ITEMS_A4_ACTIVITY_CAP",
                    );
                  }
                }
                try {
                  const t = await execNode(rnode);
                  if (t !== null) return t;
                } catch (err) {
                  if (rnode.onError !== "continue") throw err;
                  ctx[rid] = { error: nodeErrorMessage(err) };
                }
                // Per-execution budget cap inside the region (like the top-level loop).
                if (
                  runCtx.perExecutionCapUsd !== undefined &&
                  costUsd >= runCtx.perExecutionCapUsd
                ) {
                  return "budget_exceeded";
                }
              }
              collected.push(ctx[region.collectFrom]);
              if (i < MAX_TRACE_ITEMS) {
                // Tri-state row from the LIVE map (pure; no command, no stepCount).
                const row: Record<string, TraceCell> = {
                  [splitOutId]: traceCell(items[i], true),
                };
                for (const rid of region.regionNodeIds)
                  row[rid] = traceCell(ctx[rid], live.get(rid) ?? false);
                traceRows.push(row);
              }
              if (i === 0) {
                firstIter = { [splitOutId]: items[0] };
                for (const rid of region.regionNodeIds)
                  firstIter[rid] = ctx[rid];
              }
            }
          } else if (!hasActivity) {
            // ── ITEM-MAJOR (A2, unchanged) ──
            traced = true;
            for (let i = 0; i < N; i++) {
              stepCount++; // the item itself is a step (bounds an empty region over a huge array)
              if (overBudget()) return "circuit_open";
              ctx[current] = items[i]; // the current item — region nodes bind to splitOut to read it
              for (const rid of region.regionNodeIds) {
                stepCount++; // count every region-node execution toward the breaker
                if (overBudget()) return "circuit_open";
                const rnode = nodeById.get(rid);
                if (!rnode) return "invalid_graph";
                currentNodeId = rid; // attribute a mid-region failure to the actual node
                try {
                  const t = await execNode(rnode);
                  if (t !== null) return t; // defensive: pure region nodes never return terminal
                } catch (err) {
                  if (rnode.onError !== "continue") throw err;
                  ctx[rid] = { error: nodeErrorMessage(err) };
                }
              }
              collected.push(ctx[region.collectFrom]);
              if (i < MAX_TRACE_ITEMS) {
                // Linear region: every node ran (live). An onError:"continue" cell shows as err.
                const row: Record<string, TraceCell> = {
                  [splitOutId]: traceCell(items[i], true),
                };
                for (const rid of region.regionNodeIds)
                  row[rid] = traceCell(ctx[rid], true);
                traceRows.push(row);
              }
              if (i === 0) {
                firstIter = { [current]: items[0] };
                for (const rid of region.regionNodeIds)
                  firstIter[rid] = ctx[rid];
              }
            }
          } else {
            // ── NODE-MAJOR (A3): process each region node fully (all N items) before the next ──
            a3Unavailable = true; // per-item grid isn't built here (would need transposing mapNode)
            const regionOut = new Map<string, unknown[]>();
            regionOut.set(splitOutId, items); // splitOut's per-item output IS the items
            // Set ctx to frame `i` (splitOut + prior region nodes at index i) so pure execNode and
            // the config resolvers read the current item.
            const frameAt = (i: number): void => {
              ctx[splitOutId] = items[i];
              for (const [nid, outs] of regionOut) ctx[nid] = outs[i];
            };
            // The N "item" steps (matches item-major's per-item increment); region-node steps are
            // added per node below.
            stepCount += N;
            if (overBudget()) return "circuit_open";
            for (const rid of region.regionNodeIds) {
              stepCount += N; // N executions of this node
              if (overBudget()) return "circuit_open";
              const rnode = nodeById.get(rid);
              if (!rnode) return "invalid_graph";
              currentNodeId = rid;

              if (BATCHABLE_REGION_ACTIVITIES.has(rnode.type)) {
                // Payload-cap guard: N configs + N outputs ride in history verbatim (see
                // MAX_MAP_BATCH_ITEMS). Fail closed rather than a cryptic history-write failure.
                if (N > MAX_MAP_BATCH_ITEMS) {
                  throw wf.ApplicationFailure.nonRetryable(
                    `splitOut region node '${rid}' would batch ${N} items over the ${MAX_MAP_BATCH_ITEMS} cap — chunk upstream or use forEach`,
                    "ITEMS_BATCH_TOO_LARGE",
                  );
                }
                if (N === 0) {
                  regionOut.set(rid, []); // empty region: no work, no wasted mapNode command
                  continue;
                }
                // Resolve each item's activity payload (deterministic, in workflow), then ONE mapNode.
                const mapItems: activities.MapNodeItem[] = [];
                for (let i = 0; i < N; i++) {
                  frameAt(i);
                  const cfgR = resolveTemplates(
                    (rnode.config ?? {}) as Record<string, unknown>,
                    ctx,
                  );
                  let cfg: unknown;
                  if (rnode.type === "httpRequest") {
                    cfg = resolveHttpRequest(
                      asNodeConfig(cfgR, "httpRequest"),
                      ctx,
                    );
                  } else if (rnode.type === "mcpTool") {
                    const m = asNodeConfig(cfgR, "mcpTool");
                    cfg = {
                      connectionId: m.connectionId,
                      tool: m.tool,
                      arguments: resolveMcpArguments(m, ctx),
                      costUsd: m.costUsd,
                    };
                  } else {
                    cfg = cfgR; // agent uses its resolved config directly
                  }
                  mapItems.push({ cfg, input: items[i] }); // input = the current item (frozen §0.3)
                }
                let res: activities.MapNodeResult;
                try {
                  res = await mapNode(rnode.type, mapItems, {
                    tenantId: runCtx.tenantId,
                    executionId: wf.workflowInfo().workflowId,
                    nodeId: rid,
                  });
                } catch (err) {
                  // An INFRA-level mapNode crash (maxAttempts:1). Respect onError:"continue" like
                  // execNode does; else fail the run. (Per-ITEM errors don't throw — see below.)
                  if (rnode.onError !== "continue") throw err;
                  const msg = nodeErrorMessage(err);
                  regionOut.set(
                    rid,
                    Array.from({ length: N }, () => ({ error: msg })),
                  );
                  continue;
                }
                costUsd += res.costUsd; // completed items already billed in-activity (fail-safe)
                ctx.__costUsd = costUsd;
                // Enforce the per-execution cap IN the region (like the top-level loop) so a batch
                // that pushes over budget stops the remaining region nodes promptly.
                if (
                  runCtx.perExecutionCapUsd !== undefined &&
                  costUsd >= runCtx.perExecutionCapUsd
                ) {
                  return "budget_exceeded";
                }
                regionOut.set(rid, res.outputs);
                const anyError = res.outputs.some(
                  (o) =>
                    o !== null &&
                    typeof o === "object" &&
                    "error" in (o as object),
                );
                if (anyError && rnode.onError !== "continue") {
                  throw wf.ApplicationFailure.nonRetryable(
                    `mapNode: an item failed in region node '${rid}'`,
                    "ITEMS_MAPNODE_ITEM",
                  );
                }
              } else {
                // Pure region node, node-major: run once per item against frame i.
                const outs: unknown[] = [];
                for (let i = 0; i < N; i++) {
                  frameAt(i);
                  try {
                    const t = await execNode(rnode);
                    if (t !== null) return t;
                  } catch (err) {
                    if (rnode.onError !== "continue") throw err;
                    ctx[rid] = { error: nodeErrorMessage(err) };
                  }
                  outs.push(ctx[rid]);
                }
                regionOut.set(rid, outs);
              }
            }
            collected = regionOut.get(region.collectFrom) ?? [];
            if (N > 0) {
              firstIter = {};
              for (const [nid, outs] of regionOut) firstIter[nid] = outs[0];
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
          if (traced || a3Unavailable) {
            // Publish under the `__` bookkeeping namespace (auto-hidden from the node-output list by
            // isNodeOutputKey; surfaced only by the run view's trace grid). Keyed by splitOut so a
            // graph with several regions carries one entry each. PURE — no command. A4/A2 emit the
            // grid; A3 emits the `unavailable` marker so the UI can explain the gap.
            const trace = (ctx.__regionTrace ??= {}) as Record<
              string,
              RegionTrace
            >;
            if (!traced) {
              trace[splitOutId] = { unavailable: "batched" };
            } else {
              const grid: RegionTrace = {
                nodes: traceNodes,
                items: traceRows,
                ...(N > MAX_TRACE_ITEMS
                  ? { truncatedItems: N - MAX_TRACE_ITEMS }
                  : {}),
              };
              // Aggregate byte cap: a diagnostic must never push the run payload over Temporal's ~2MB
              // and fail an otherwise-healthy run. Measure this grid; if it would exceed the running
              // budget, drop to the `budget` marker (fail closed, visible) rather than growing ctx.
              const gridBytes = JSON.stringify(grid).length;
              if (traceBytes + gridBytes > MAX_TRACE_TOTAL_BYTES) {
                trace[splitOutId] = { unavailable: "budget" };
              } else {
                traceBytes += gridBytes;
                trace[splitOutId] = grid;
              }
            }
          }
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
  // Distinguish "no respondToWebhook ran" (undefined) from "ran with an empty body" (null), so the
  // durable chat session can tell a no-reply turn from a real empty reply — mirrors the ingress's
  // `response.body ?? null`. Undefined ⇒ no synchronous reply at all.
  return {
    status,
    ctx,
    reply: webhookResponse ? (webhookResponse.body ?? null) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Durable per-session chat workflow (design §2.1b, option A)
// ---------------------------------------------------------------------------

/** First-start args for a chat session. The graph SNAPSHOT is pinned at session start (later
 *  messages are just Signals), so a mid-session graph edit doesn't take effect until the session
 *  idle-expires — a deliberate choice for a consistent conversation. */
export interface ChatSessionInput {
  graph: GraphDef;
  /** Same non-secret ctx runGraph gets (tenantId + caps + graph hash/version); passed to each
   *  per-message child run. Only tenantId flows through history — no secrets (Tier-1 #4). */
  ctx: RunGraphCtx;
  /** The public chat id + conversation session id — for durable history persistence. */
  chatId: string;
  sessionId: string;
  /** End the session after this much silence. Defaults to CHAT_SESSION_IDLE_TIMEOUT_MS; overridable
   *  so a test can drive the idle-close path without a 30-minute wait. */
  idleTimeoutMs?: number;
}

/** State carried across continueAsNew so a long conversation resumes intact. */
interface ChatSessionResume {
  history: { role: string; text: string }[];
  /** Bounded recent turnId→reply window, carried so a client still polling across a CAN boundary
   *  can still read its reply (advisor: a CAN must not orphan an un-polled reply). */
  recentReplies: { turnId: string; reply: unknown }[];
  /** History already seeded from the durable table — don't reload on a CAN resume. */
  seeded: boolean;
}

/** End the session after this much silence (frees the workflow; the table keeps the history). */
const CHAT_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** Bound the in-Temporal (and CAN-carried) working history. The table holds the full record. */
const MAX_CHAT_HISTORY_MESSAGES = 40;
/** How many recent replies stay queryable (and cross a CAN). Covers the client's poll window. */
const MAX_CHAT_RECENT_REPLIES = 20;

/** Reduce a reply body to text for history — never throws (a circular/BigInt body → ""). */
function stringifyChatReply(reply: unknown): string {
  if (typeof reply === "string") return reply;
  if (reply == null) return "";
  try {
    return JSON.stringify(reply) ?? "";
  } catch {
    return "";
  }
}

/**
 * A long-lived, turn-SERIALIZED conversation. `POST /chat/:id` does `signalWithStart` (starts it on
 * the first message of a session, signals it after) and then Queries `chatReplyQuery(turnId)` for the
 * answer. Replies are keyed by the API-minted `turnId`, so two concurrent messages never read each
 * other's reply — the fix for the cross-talk race that got option A deferred.
 *
 * Each message runs the chat graph as a CHILD `runGraph` (interpreter stays the single source of
 * truth; the reply comes back via RunGraphResult.reply). The ChatMessage table is the durable
 * backing store: seeded once at start, appended each turn — so idle-expiry doesn't lose memory.
 */
export async function chatSession(
  input: ChatSessionInput,
  resume?: ChatSessionResume,
): Promise<void> {
  const { graph, ctx, chatId, sessionId } = input;
  const idleTimeoutMs = input.idleTimeoutMs ?? CHAT_SESSION_IDLE_TIMEOUT_MS;
  const queue: ChatTurnInput[] = [];
  let history = resume?.history ?? [];
  const recentReplies = resume?.recentReplies ?? [];
  let processing: string | undefined;

  wf.setHandler(chatMessageSignal, (turn: ChatTurnInput) => {
    queue.push(turn);
  });
  wf.setHandler(chatReplyQuery, (turnId: string): ChatReplyState => {
    const hit = recentReplies.find((r) => r.turnId === turnId);
    // A recorded turn whose reply is `undefined` ran but produced no synchronous response — terminal
    // `no_reply` (the poll stops + reports "started"); a real reply is `null` at least, never undefined.
    if (hit) {
      return hit.reply === undefined
        ? { status: "no_reply" }
        : { status: "replied", reply: hit.reply };
    }
    const inFlight =
      processing === turnId || queue.some((q) => q.turnId === turnId);
    return { status: inFlight ? "pending" : "unknown" };
  });

  // Seed the working history from the durable table ONCE (first start, not a CAN resume) so a session
  // restarted after idle-expiry resumes with memory.
  if (!resume?.seeded) {
    history = await loadChatHistory({
      tenantId: ctx.tenantId,
      chatId,
      sessionId,
    });
  }

  while (true) {
    const got = await wf.condition(() => queue.length > 0, idleTimeoutMs);
    // Idle → end the session. Re-check the queue for a message delivered in the sliver between the
    // timeout firing and here, and drain in-flight signal handlers, so no message is dropped on close.
    if (!got && queue.length === 0) {
      await wf.condition(() => wf.allHandlersFinished());
      if (queue.length === 0) return;
    }

    const turn = queue.shift();
    if (!turn) continue;
    processing = turn.turnId;

    // Run the chat graph as a child. Deterministic, unique child id per turn (turnId is an API-minted
    // input, not workflow-generated). A per-turn failure must not kill the session — record an error
    // reply and carry on.
    let replyBody: unknown;
    try {
      const child = await wf.executeChild(runGraph, {
        workflowId: `${wf.workflowInfo().workflowId}-turn-${turn.turnId}`,
        args: [
          graph,
          { message: turn.message, sessionId, history },
          { ...ctx },
        ],
      });
      replyBody = child.reply;
    } catch (e) {
      if (e instanceof wf.ContinueAsNew || wf.isCancellation(e)) throw e;
      replyBody = { error: "The chat run failed." };
    }

    // Always record the turn's outcome so chatReplyQuery resolves promptly (a `undefined` reply →
    // `no_reply`, so the API poll returns "started" instead of waiting out the timeout).
    recentReplies.push({ turnId: turn.turnId, reply: replyBody });
    if (recentReplies.length > MAX_CHAT_RECENT_REPLIES) recentReplies.shift();
    processing = undefined;

    // Only a real reply advances memory: a turn with no synchronous response (no respondToWebhook)
    // isn't persisted — matching the non-durable path, which doesn't persist when the graph didn't
    // reply. (A per-turn child failure sets replyBody to an `{error}` object, which IS a reply.)
    if (replyBody !== undefined) {
      const assistantText = stringifyChatReply(replyBody);
      history.push(
        { role: "user", text: turn.message },
        { role: "assistant", text: assistantText },
      );
      if (history.length > MAX_CHAT_HISTORY_MESSAGES) {
        history = history.slice(history.length - MAX_CHAT_HISTORY_MESSAGES);
      }
      // Durable record of the turn (survives idle-expiry / CAN). Best-effort — a store hiccup must not
      // kill a live conversation; the in-Temporal history still serves the current session.
      await appendChatTurn({
        tenantId: ctx.tenantId,
        chatId,
        sessionId,
        userText: turn.message,
        assistantText,
      }).catch(() => undefined);
    }

    // continueAsNew only when the queue is DRAINED (so no un-run message is lost) and history has
    // grown — carrying recentReplies so a client mid-poll still reads its reply.
    if (queue.length === 0 && wf.workflowInfo().continueAsNewSuggested) {
      await wf.continueAsNew<typeof chatSession>(input, {
        history,
        recentReplies,
        seeded: true,
      });
    }
  }
}

// The generic graph interpreter (split out of workflows.ts — the runGraph body is
// moved VERBATIM, zero behavior change; only the surrounding imports changed).
// DETERMINISTIC TEMPORAL WORKFLOW CODE — CLAUDE.md Tier-1 rules apply: no I/O, no
// clock, no randomness; all side effects via the activity proxies; secrets never
// enter workflow args/history; wf.patched() call sites are load-bearing for replay.
import * as wf from "@temporalio/workflow";
import {
  APPROVAL_CTX_KEY,
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
  resolveGraphQL,
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
import type {
  ApprovalNodeConfig,
  GraphDef,
  NodeDef,
  NodeOutputMap,
} from "@naary/dsl";
// Type-only: keeps activity code OUT of the deterministic workflow bundle.
// Do NOT drop `type` — that would pull I/O code into the sandbox.
import type * as activities from "../activities";
// Pure fan-out policy (no side effects) — safe to import into workflow code.
import { FOREACH_CONCURRENCY, perChildCap } from "../foreach-cap";
import {
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
  callHttpRequest,
  callGraphQL,
  callIntegrationRead,
  callIntegrationWrite,
  mapNode,
  callCodeAgent,
  callSqlQuery,
  callSqlExec,
  callSendEmail,
  callRssRead,
  callPoll,
  prepareApproval,
  sendNotification,
  callCode,
  retryOverride,
} from "./proxies";
import {
  MAX_SUBWORKFLOW_DEPTH,
  MAX_FOREACH_ITEMS,
  MAX_MAP_BATCH_ITEMS,
  MAX_A4_REGION_ACTIVITY_EXECUTIONS,
  MAX_TRACE_ITEMS,
  MAX_TRACE_TOTAL_BYTES,
  traceCell,
  nodeErrorMessage,
} from "./helpers";
import type { RunGraphResult, RunGraphCtx, ResumeState } from "./types";

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

  // Single source of truth for every activity's `meta` — ALL activity calls use this so a run's
  // environmentId (Slice 5b) reaches EVERY env-scoped secret/cred read uniformly (a missed call site
  // would silently read the default env's creds). environmentId is undefined for a pre-5b run (its
  // ctx predates the field) → the activity falls back to the tenant default (byte-identical). Data-only
  // threading — no new/removed/reordered command, so replay-safe WITHOUT patched(); and it rides
  // continueAsNew because runCtx is re-passed whole.
  const metaFor = (nodeId: string): activities.AgentMeta => ({
    tenantId: runCtx.tenantId,
    environmentId: runCtx.environmentId,
    executionId: wf.workflowInfo().workflowId,
    nodeId,
  });

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
      environmentId: runCtx.environmentId, // tag the run with its env (Slice 6)
      workflowKey: runCtx.workflowKey,
      graphVersion: runCtx.graphVersion,
    });
  }

  // Global Variables ($vars): seed the run's env-scoped non-secret config into ctx as DATA, so string
  // expressions can read `{{ $vars.KEY }}` (resolved by the same getByPath the rest of the template
  // engine uses — no resolver change). ONE PG read via an activity (I/O → activity, Tier-1 #3); the
  // workflow only threads the returned map. Behind a patched() gate so in-flight runs predating this
  // stay replay-safe (CLAUDE.md: version interpreter changes with patched()). Only on first start —
  // a continueAsNew/resume already carries $vars inside its ctx snapshot, so re-loading would be both
  // redundant and a nondeterminism risk (the DB may have changed mid-run). NOT secrets (Tier-1 #4).
  if (!resume && wf.patched("load-variables-v1")) {
    ctx.$vars = await loadVariables({
      tenantId: runCtx.tenantId,
      environmentId: runCtx.environmentId,
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
          environmentId: runCtx.environmentId, // env-scoped cursor; absent = legacy run → default env (in-activity)
          workflowKey: runCtx.workflowKey ?? "",
          nodeId: node.id,
        });
        ctx[node.id] = {
          changed: r.changed,
          body: r.body,
        } satisfies NodeOutputMap["pollTrigger"];
        return null;
      }
      case "agent": {
        // tenantId flows in workflow args (not a secret); the activity fetches
        // the tenant's key by tenantId. executionId is deterministic.
        const over = retryOverride(node.retry, 60_000);
        const result = await (over?.runAgent ?? runAgent)(
          cfg as unknown as activities.AgentConfig,
          ctx.__input,
          metaFor(node.id),
        );
        ctx[node.id] = result satisfies NodeOutputMap["agent"];
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
            // Write mode (Slice 2c): the activity clones `repo` (via the App `connectionId`) and
            // dispatches to the sandbox-runner; default/read runs in-worker with no repo.
            mode: caCfg.mode,
            repo: caCfg.repo,
            branch: caCfg.branch,
            connectionId: caCfg.connectionId,
          },
          ctx.__input,
          metaFor(node.id),
        );
        ctx[node.id] = caResult satisfies NodeOutputMap["codeAgent"];
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
          metaFor(node.id),
        );
        ctx[node.id] = toolResult satisfies NodeOutputMap["mcpTool"];
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
        ctx[node.id] = (await runIntegration(
          iCfg,
          resolveIntegrationFields(iCfg, ctx),
          metaFor(node.id),
        )) satisfies NodeOutputMap["integration"];
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
          metaFor(node.id),
        );
        // Expose the response as {status, headers, body} so edges branch on
        // `<nodeId>.status` (the HTTP code), per the node's behavior contract.
        ctx[node.id] = {
          status: result.httpStatus,
          headers: result.headers,
          body: result.body,
        } satisfies NodeOutputMap["httpRequest"];
        costUsd += result.costUsd;
        ctx.__costUsd = costUsd;
        return null;
      }
      case "graphQL": {
        // Binding resolution is deterministic graph work (pure ctx path-reads); the POST + egress
        // check + $secrets resolution are in the activity. `{{ $secrets.X }}` stays literal here.
        const gqlCfg = asNodeConfig(cfg, "graphQL");
        const over = retryOverride(node.retry, 150_000);
        const result = await (over?.callGraphQL ?? callGraphQL)(
          resolveGraphQL(gqlCfg, ctx),
          ctx.__input,
          metaFor(node.id),
        );
        // Expose {data, errors, httpStatus} so edges branch on `<id>.errors` (GraphQL returns
        // 200-with-errors) or read `<id>.data`.
        ctx[node.id] = {
          data: result.data,
          errors: result.errors,
          httpStatus: result.httpStatus,
        } satisfies NodeOutputMap["graphQL"];
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
          metaFor(node.id),
        );
        // Expose {rows, rowCount} so edges branch on `<nodeId>.rowCount`.
        ctx[node.id] = {
          rows: result.rows,
          rowCount: result.rowCount,
        } satisfies NodeOutputMap["sqlQuery"];
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
          metaFor(node.id),
        );
        // Expose {rowsAffected} so edges branch on `<nodeId>.rowsAffected`.
        ctx[node.id] = {
          rowsAffected: result.rowsAffected,
        } satisfies NodeOutputMap["sqlExec"];
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
          metaFor(node.id),
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
          metaFor(node.id),
        );
        ctx[node.id] = res.result;
        return null;
      }
      case "markdown": {
        // Convert an HTML string → Markdown. HTML resolved here (pure ctx read); the parse runs
        // in the activity (parser out of the deterministic bundle, like htmlExtract).
        const mdCfg = asNodeConfig(cfg, "markdown");
        const mdVal = getByPath(ctx[mdCfg.from], mdCfg.path);
        const res = await callMarkdown(mdVal, metaFor(node.id));
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
          metaFor(node.id),
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
          metaFor(node.id),
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
          metaFor(node.id),
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
          metaFor(node.id),
        );
        ctx[node.id] = { value: res.value } satisfies NodeOutputMap["random"];
        return null;
      }
      case "encode": {
        // Input resolved here (pure ctx read); the encode runs in the activity (Buffer for
        // base64/hex isn't in the deterministic bundle). Output { result }.
        const encCfg = asNodeConfig(cfg, "encode");
        const encVal = getByPath(ctx[encCfg.from], encCfg.path);
        const res = await callEncode(
          { operation: encCfg.operation },
          encVal,
          metaFor(node.id),
        );
        ctx[node.id] = { result: res.result };
        return null;
      }
      case "hmac": {
        // Binding resolution is deterministic (pure ctx read); the key fetch +
        // signing happen in the activity (the key never enters workflow history).
        const hmacCfg = asNodeConfig(cfg, "hmac");
        const result = await callHmac(
          resolveHmac(hmacCfg, ctx),
          ctx.__input,
          metaFor(node.id),
        );
        ctx[node.id] = {
          digest: result.digest,
        } satisfies NodeOutputMap["hmac"];
        return null;
      }
      case "hash": {
        // Keyless digest. Binding resolution is deterministic (pure ctx read); the hash
        // (node:crypto) runs in the activity, out of the deterministic bundle.
        const hashCfg = asNodeConfig(cfg, "hash");
        const result = await callHash(
          resolveHash(hashCfg, ctx),
          ctx.__input,
          metaFor(node.id),
        );
        ctx[node.id] = {
          digest: result.digest,
        } satisfies NodeOutputMap["hash"];
        return null;
      }
      case "jwt": {
        const jwtCfg = asNodeConfig(cfg, "jwt");
        const result = await callJwt(
          resolveJwt(jwtCfg, ctx),
          ctx.__input,
          metaFor(node.id),
        );
        ctx[node.id] = { token: result.token } satisfies NodeOutputMap["jwt"];
        return null;
      }
      case "totp": {
        // No bindings: the seed comes from the connection, the time from the clock
        // — both handled in the activity. Output is the current code.
        const totpCfg = asNodeConfig(cfg, "totp");
        const result = await callTotp(totpCfg, ctx.__input, metaFor(node.id));
        ctx[node.id] = { code: result.code } satisfies NodeOutputMap["totp"];
        return null;
      }
      case "sendEmail": {
        // Binding resolution is deterministic (pure ctx read); the SMTP URI fetch +
        // send happen in the activity (URI/creds never enter workflow history).
        const emailCfg = asNodeConfig(cfg, "sendEmail");
        const result = await callSendEmail(
          resolveSendEmail(emailCfg, ctx),
          ctx.__input,
          metaFor(node.id),
        );
        ctx[node.id] = {
          messageId: result.messageId,
        } satisfies NodeOutputMap["sendEmail"];
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
          metaFor(node.id),
        );
        ctx[node.id] = {
          items: result.items,
          count: result.count,
        } satisfies NodeOutputMap["rssRead"];
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
          environmentId: runCtx.environmentId,
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
              // Child runs in the PARENT's env (Slice 5b) — a sandbox parent's sub-workflow uses
              // sandbox creds/connections, not the default env.
              environmentId: runCtx.environmentId,
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
        ctx[node.id] = {
          status: result.status,
          output,
        } satisfies NodeOutputMap["executeSubWorkflow"];
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
          environmentId: runCtx.environmentId,
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
                        environmentId: runCtx.environmentId, // child inherits the parent's env (5b)
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
                    environmentId: runCtx.environmentId, // child inherits the parent's env (5b)
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
        ctx[node.id] = {
          statusCode: webhookResponse.statusCode,
        } satisfies NodeOutputMap["respondToWebhook"];
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
          metaFor(node.id),
        );
        ctx[node.id] = result.result;
        return null;
      }
      case "humanApproval": {
        status = "awaiting_approval";
        await syncStatus(); // surface the pause in the Runs list / approval queue
        const gateCfg = (cfg ?? {}) as ApprovalNodeConfig;
        // ---- Approval routing + SLA/escalation (REDESIGN-FUNCTIONALITY-GAPS.md Slice 1) ----
        // REPLAY INVARIANT (two layers): every NEW command below (prepareApproval, the
        // segmented timer loop, reminder/escalation notifications) is gated on
        // (a) the PRESENCE of the Slice-1 config fields — so plain gates take the exact
        //     pre-existing command sequence — AND
        // (b) a patched() marker (PR #424 review): in a staged deploy the API/web can save
        //     graphs WITH these fields while runs still start on an OLD worker; those
        //     histories lack the new commands, so the updated worker must replay them on
        //     the legacy path. patched() returns false for such histories and records the
        //     marker for new runs (CLAUDE.md: version interpreter changes with patched()).
        const hasSlice1Meta =
          gateCfg.approvers !== undefined ||
          gateCfg.slaHours !== undefined ||
          gateCfg.contextFields !== undefined ||
          (gateCfg.remindAfterHours?.length ?? 0) > 0 ||
          gateCfg.escalateAfterHours !== undefined;
        const slice1Active =
          hasSlice1Meta && wf.patched("approval-routing-sla-v1");
        if (slice1Active) {
          // Pause-side awaiting snapshot via an ACTIVITY: contextFields expression eval,
          // approver group-name read, and the pausedAt clock stamp are side effects
          // (Tier-1 rules 2/3); `$secrets` refs stay literal inside prepareApproval, so
          // secrets can never enter this record / history (rule 4). The returned DATA is
          // stored under the reserved __approval ctx key, where the API's stateQuery
          // reads it (inbox rows, decide-time enforcement, public prompt).
          const snapshot: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(ctx)) {
            if (!k.startsWith("__")) snapshot[k] = v;
          }
          ctx[APPROVAL_CTX_KEY] = await prepareApproval({
            tenantId: runCtx.tenantId,
            nodeId: node.id,
            config: {
              approvers: gateCfg.approvers,
              slaHours: gateCfg.slaHours,
              remindAfterHours: gateCfg.remindAfterHours,
              escalateAfterHours: gateCfg.escalateAfterHours,
              escalateTo: gateCfg.escalateTo,
              contextFields: gateCfg.contextFields,
            },
            ctx: snapshot,
          });
        }
        // Notify the tenant (best-effort) that a decision is needed — a HITL pause can
        // last days, so don't rely on someone watching the inbox. Gated + swallowed so
        // it can never affect the run. Patched so in-flight runs don't diverge on replay.
        if (wf.patched("notify-v1") && !runCtx.isErrorHandler) {
          try {
            await sendNotification({
              tenantId: runCtx.tenantId,
              environmentId: runCtx.environmentId,
              kind: "approval_pending",
              workflowId: wf.workflowInfo().workflowId,
              workflowKey: runCtx.workflowKey,
              title: gateCfg.title,
            });
          } catch {
            /* best-effort — never block the pause on a notification */
          }
        }
        // Optional auto-reject timeout (durable Temporal timer; deterministic).
        const timeoutMs =
          typeof gateCfg.timeoutHours === "number" && gateCfg.timeoutHours > 0
            ? gateCfg.timeoutHours * 3_600_000
            : undefined;
        // Reminder/escalation schedule — a PURE derivation of the immutable config
        // snapshot (offsets in ms, sorted ascending; a same-offset reminder fires before
        // the escalation via the stable sort), so the timer sequence replays identically.
        // Offsets at/after the auto-reject timeout can never fire and are dropped.
        const gateTimers: {
          atMs: number;
          flavor: "reminder" | "escalation";
          index?: number;
        }[] = [];
        (gateCfg.remindAfterHours ?? []).forEach((h, i) => {
          if (typeof h === "number" && h > 0) {
            gateTimers.push({
              atMs: h * 3_600_000,
              flavor: "reminder",
              index: i + 1,
            });
          }
        });
        if (
          typeof gateCfg.escalateAfterHours === "number" &&
          gateCfg.escalateAfterHours > 0
        ) {
          gateTimers.push({
            atMs: gateCfg.escalateAfterHours * 3_600_000,
            flavor: "escalation",
          });
        }
        gateTimers.sort((a, b) => a.atMs - b.atMs);
        const schedule = gateTimers.filter(
          (t) => timeoutMs === undefined || t.atMs < timeoutMs,
        );

        let decided = true;
        if (schedule.length === 0) {
          // Pre-existing durable wait — byte-identical commands for old graphs (see the
          // replay invariant above).
          if (timeoutMs !== undefined) {
            // condition(fn, timeout) → true if signalled, false if it timed out.
            decided = await wf.condition(
              () => approval !== undefined,
              timeoutMs,
            );
          } else {
            await wf.condition(() => approval !== undefined); // wait forever
          }
        } else {
          // Segmented durable wait: condition() up to each reminder/escalation offset
          // (durable Temporal timers — no clock reads in workflow code), firing the
          // notification ACTIVITY on each elapse, then the remaining auto-reject window
          // (or wait forever). A decision signal at any point exits the loop.
          let elapsedMs = 0;
          for (const t of schedule) {
            const deltaMs = t.atMs - elapsedMs;
            const signalled =
              deltaMs > 0
                ? await wf.condition(() => approval !== undefined, deltaMs)
                : approval !== undefined;
            if (signalled) break;
            elapsedMs = t.atMs;
            // Same error-handler gate as the initial pause notification (an error-handler
            // run never pages) — deterministic (runCtx is workflow-args data).
            if (!runCtx.isErrorHandler) {
              try {
                await sendNotification({
                  tenantId: runCtx.tenantId,
                  environmentId: runCtx.environmentId,
                  kind: "approval_pending",
                  workflowId: wf.workflowInfo().workflowId,
                  workflowKey: runCtx.workflowKey,
                  title: gateCfg.title,
                  flavor: t.flavor,
                  ...(t.flavor === "reminder"
                    ? { reminderIndex: t.index }
                    : {}),
                  ...(t.flavor === "escalation" && gateCfg.escalateTo
                    ? { escalateTo: gateCfg.escalateTo }
                    : {}),
                });
              } catch {
                /* best-effort — a notification must never affect the pause */
              }
            }
          }
          if (approval === undefined) {
            if (timeoutMs !== undefined) {
              decided = await wf.condition(
                () => approval !== undefined,
                timeoutMs - elapsedMs,
              );
            } else {
              await wf.condition(() => approval !== undefined); // wait forever
            }
          }
        }
        status = "running";
        // The gate is no longer pending — drop the awaiting record so a later loop
        // iteration pauses fresh (plain ctx write: no command, replay-safe).
        if (slice1Active) delete ctx[APPROVAL_CTX_KEY];
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
                  res = await mapNode(rnode.type, mapItems, metaFor(rid));
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
        environmentId: runCtx.environmentId,
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
        environmentId: runCtx.environmentId,
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
            // The error handler runs in the FAILED run's env (5b) — a sandbox failure's handler
            // uses sandbox creds/connections.
            environmentId: runCtx.environmentId,
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

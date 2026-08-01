import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import {
  type Client,
  type Connection,
  WorkflowNotFoundError,
} from "@temporalio/client";
import {
  chatMessageSignal,
  chatReplyQuery,
  CHAT_SESSION_WORKFLOW,
  RUN_GRAPH_WORKFLOW,
  TASK_QUEUE,
  webhookResponseQuery,
  type Citation,
  type WebhookResponse,
} from "@naary/contracts";
import type { GraphDef, NodeDef } from "@naary/dsl";
import { getPrisma, resolveWorkflowKey } from "@naary/db";
import {
  evaluateResume,
  resumeWarningText,
  type ResumeEligibility,
} from "@naary/dsl";
import { getObjectStore, resolveClaimChecks } from "@naary/storage";
import { TracedClass } from "@naary/observability";
import { getBudget } from "@naary/usage";
import type { Principal } from "../auth/tenant.decorator";
import { assertWithinMonthlyBudget } from "../budget/budget-guard";
import { PermissionsService } from "../permissions/permissions.service";
import { assertWithinCompanyMonthlyBudget } from "../budget/company-budget-guard";
import { executionsStarted } from "../common/metrics";
import { EnvironmentsService } from "../environments/environments.service";
import {
  type GraphSnapshot,
  GraphsService,
  hashGraph,
} from "../graphs/graphs.service";
import { connectTemporal } from "../temporal/client";
import {
  DEFAULT_MAX_STEPS_PER_RUN,
  DEFAULT_WORKFLOW_KEY,
  type AwaitingApproval,
  type BatchDecisionResult,
  type RunEvent,
  type RunPage,
  type RunStateView,
  type RunSummary,
} from "./executions.types";
import {
  nodeTimesFrom,
  projectSearchText,
  startSampleInput,
} from "./executions.helpers";
import {
  audioFilename,
  audioRefFromCtx,
  isTenantOwnedAudioRef,
  safeContentType,
} from "./run-artifacts";
import {
  type ExecutionsDeps,
  queryAwaiting,
  queryHistory,
  queryListPage,
  queryOriginalTriggerInput,
  queryPromptByWorkflowId,
  queryRunGraph,
  queryState,
} from "./executions.queries";
import {
  opApprove,
  opApproveBatch,
  opDecideByToken,
  opGetResumePath,
  opRemindContext,
  opResumeByToken,
} from "./executions.approvals-ops";
import {
  accessApprovalPrompt,
  accessAssertApprover,
  accessAssertOwner,
  accessAssertRun,
  accessAssertRunAccess,
  accessRunViewFilter,
  accessToRunSummary,
} from "./executions.access";

// Moved interfaces re-exported so existing import sites keep resolving them here.
export type {
  ApproverSummary,
  AwaitingApproval,
  BatchDecisionResult,
  RunEvent,
  RunPage,
  RunStateView,
  RunSummary,
} from "./executions.types";
import { resumeSnapshotsEnabled, storageProvider } from "../config";

/**
 * Wraps the Temporal client: start an execution, signal approval, query state (client
 * connects once at boot, closes on shutdown). Every run is recorded as an
 * `Execution { workflowId, tenantId }` so the control plane can authorize the caller's
 * tenant — a raw workflowId is never enough. Read/approval/access method BODIES live in
 * sibling modules (executions.{queries,approvals-ops,access}.ts), invoked as thin
 * delegators here via {@link deps}.
 */
@Injectable()
@TracedClass()
export class ExecutionsService implements OnModuleInit, OnModuleDestroy {
  private client!: Client;
  private connection!: Connection;

  constructor(
    private readonly graphs: GraphsService,
    private readonly environments: EnvironmentsService,
    /** @Optional so the many bare test constructions still work; when an ACTOR is passed
     *  to start/rerun the service must be wired (fail CLOSED, never skip authz). */
    @Optional() private readonly permissions?: PermissionsService,
  ) {}

  /** The wired PermissionsService, or throw. Only consulted when an ACTOR is present —
   *  an actor without wired permissions must fail CLOSED, never skip authz. */
  private perms(): PermissionsService {
    if (!this.permissions) {
      throw new Error("ExecutionsService: PermissionsService is not wired");
    }
    return this.permissions;
  }

  /** In-service `run` assert (RBAC-GROUPS.md §4). See accessAssertRun. */
  private async assertRun(
    actor: Principal | undefined,
    workflowKey: string,
    environmentId: string,
  ): Promise<void> {
    return accessAssertRun(this.deps(), actor, workflowKey, environmentId);
  }

  /** G3 (§8.4) — gate a single run surface on the run's own workflow. See
   *  accessAssertRunAccess. */
  private async assertRunAccess(
    actor: Principal | undefined,
    action: "view" | "run",
    row: {
      tenantId: string;
      workflowKey: string | null;
      environmentId: string | null;
    },
  ): Promise<void> {
    return accessAssertRunAccess(this.deps(), actor, action, row);
  }

  /** G3 (§8.4) — the Runs-list view filter for a RESTRICTED subject. See
   *  accessRunViewFilter. */
  private async runViewFilter(
    actor: Principal | undefined,
    tenantId: string,
  ): Promise<Record<string, unknown> | null> {
    return accessRunViewFilter(this.deps(), actor, tenantId);
  }

  /** The class members the extracted read/approval/access free functions reach through
   *  `this`, as bound callbacks + the always-present collaborators. The private helpers
   *  stay ON the class (this forwards to them), so `perms()`'s fail-closed throw remains
   *  the single source of truth; `perms` is a LAZY thunk so it fires only when the moved
   *  body actually consults it (never eagerly here — which would break the permission-less
   *  test constructions before their actor guard). */
  private deps(): ExecutionsDeps {
    return {
      client: this.client,
      environments: this.environments,
      graphs: this.graphs,
      perms: () => this.perms(),
      assertOwner: (workflowId, tenantId) =>
        this.assertOwner(workflowId, tenantId),
      assertRunAccess: (actor, action, row) =>
        this.assertRunAccess(actor, action, row),
      assertApprover: (actor, workflowId, tenantId) =>
        this.assertApprover(actor, workflowId, tenantId),
      runViewFilter: (actor, tenantId) => this.runViewFilter(actor, tenantId),
      toRunSummary: (r) => this.toRunSummary(r),
      approvalPrompt: (tenantId, environmentId, workflowKey, nodeId, ctx) =>
        this.approvalPrompt(tenantId, environmentId, workflowKey, nodeId, ctx),
      approve: (id, approved, tenantId, comment, actor) =>
        this.approve(id, approved, tenantId, comment, actor),
    };
  }

  async onModuleInit(): Promise<void> {
    const { client, connection } = await connectTemporal();
    this.client = client;
    this.connection = connection;
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection?.close();
  }

  /** Manual start. `tenantId` comes from the authenticated principal (not the body);
   *  runs the tenant's graph for `workflowKey` (default "default"; the canvas
   *  saves + runs "canvas"). The chosen graph must already be saved. Pass
   *  `graphVersion` to run a SPECIFIC saved version (e.g. re-run at an older/newer
   *  version); omit for the latest. */
  async start(
    tenantId: string,
    environmentId: string,
    input?: Record<string, unknown>,
    workflowKey: string = DEFAULT_WORKFLOW_KEY,
    graphVersion?: number,
    /** The user-facing caller (SPA/v1/MCP manual start). Absent for internal/trigger
     *  callers — those are workspace-level automation (§0) and are never gated. */
    actor?: Principal,
    /** Opt into per-run verbose (DEBUG) activity logging for THIS run only. */
    debug = false,
  ): Promise<{ workflowId: string }> {
    // #904 — a manual start can name a RETIRED key (an MCP `run_workflow` argument held in an
    // external agent's config, a `naary run --workflow` script, a v1 caller). Resolve before the
    // §4 assert: `WorkflowGrantKey` carries the live key after a rename, so checking the old one
    // would 403 a user who has access.
    workflowKey = await resolveWorkflowKey(tenantId, workflowKey);
    await this.assertRun(actor, workflowKey, environmentId);
    const snapshot =
      graphVersion === undefined
        ? await this.graphs.getLatest(tenantId, environmentId, workflowKey)
        : await this.graphs.getVersion(
            tenantId,
            environmentId,
            workflowKey,
            graphVersion,
          );
    if (!snapshot) {
      throw new NotFoundException(
        graphVersion === undefined
          ? `No '${workflowKey}' graph for this tenant — save one first`
          : `No version ${graphVersion} of '${workflowKey}' for this tenant`,
      );
    }
    // Default input precedence: explicit body input → the Start node's configured sampleInput →
    // EMPTY. The last step used to be a hardcoded `{ message: "I was charged twice this month" }`
    // demo payload, which made a manual run structurally different from the real trigger: EVERY
    // schedule starts a run with `{}` (#991 — all four schedule-creation paths, not just the
    // cron/poll ones auto-synced on save), so "Run now" on a scheduled workflow injected a support
    // ticket its steps were never written to accept, and the run failed for a reason the schedule
    // would never hit (#979). Worse, `sampleInput` then existed on the `start` node type ALONE, so
    // a scheduleTrigger graph had no way to opt out; #983 gave the field to every entry node with
    // a real payload to stand in for. That demo payload now lives on the demo graph that wants it
    // (sampleGraph). A run with nothing to pass passes nothing.
    //
    // This is the ONLY reader of `startSampleInput`: the field means "what a MANUAL run sends"
    // and nothing else — schedules deliberately never consult it (see startWorkflowAction).
    return this.startGraph(
      `exec-${tenantId}`,
      snapshot,
      input ?? startSampleInput(snapshot.graph) ?? {},
      tenantId,
      environmentId,
      workflowKey,
      debug,
    );
  }

  /**
   * Connectivity test for the codeAgent node's Claude Code path (the Integrations "Run test"
   * button). Starts a MINIMAL read-only run — an in-memory graph {start → codeAgent → end}
   * that asks the CLI to reply "OK" — so the user can confirm end-to-end that the `claude`
   * binary is present in the worker AND their Anthropic key works through the CLI (a different
   * path than the agent node's direct API validation). Not saved as a workflow; it's a normal
   * run the UI polls via getState. maxTurns:1 keeps it cheap.
   */
  async startCodeAgentTest(
    tenantId: string,
    environmentId: string,
  ): Promise<{ workflowId: string }> {
    const graph: GraphDef = {
      startNodeId: "start",
      nodes: [
        { id: "start", type: "start" },
        {
          id: "codeAgent",
          type: "codeAgent",
          config: {
            tool: "claude",
            prompt: "Reply with the single word: OK.",
            maxTurns: 1,
          },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "codeAgent" },
        { from: "codeAgent", to: "end" },
      ],
    };
    const snapshot: GraphSnapshot = {
      graph,
      contentHash: hashGraph(graph),
      version: 0,
    };
    return this.startGraph(
      `catest-${tenantId}`,
      snapshot,
      {},
      tenantId,
      environmentId,
      "__codeagent_test",
    );
  }

  /** Start a webhook-triggered run; the verified event becomes the trigger output.
   *  The caller resolved + snapshotted the graph from the DB. Refused when the workflow is
   *  INACTIVE (n8n parity) — an automatic trigger, unlike a manual `start()`. */
  async startWebhook(
    tenantId: string,
    environmentId: string,
    snapshot: GraphSnapshot,
    event: unknown,
    workflowKey: string,
  ): Promise<{ workflowId: string }> {
    await this.assertActive(tenantId, environmentId, workflowKey);
    return this.startGraph(
      `wh-${tenantId}`,
      snapshot,
      event,
      tenantId,
      environmentId,
      workflowKey,
    );
  }

  /** Start a form-submission run; the validated+sanitized submission becomes the trigger output.
   *  The caller resolved + snapshotted the graph (and confirmed its entry is a formTrigger).
   *  Refused when the workflow is INACTIVE (n8n parity) — automatic, unlike a manual `start()`. */
  async startForm(
    tenantId: string,
    environmentId: string,
    snapshot: GraphSnapshot,
    submission: Record<string, unknown>,
    workflowKey: string,
  ): Promise<{ workflowId: string }> {
    await this.assertActive(tenantId, environmentId, workflowKey);
    return this.startGraph(
      `form-${tenantId}`,
      snapshot,
      submission,
      tenantId,
      environmentId,
      workflowKey,
    );
  }

  /**
   * Start a run triggered by an external MCP client invoking the workflow's hosted tool
   * (docs/design/MCP-SERVER.md §5, flavor B). The tool-call arguments become the trigger output.
   * Like the form/webhook ingress this is an AUTOMATIC external trigger, so it is activation-gated
   * (refused when the workflow is INACTIVE) — unlike the generic `run_workflow`/manual `start()`,
   * which is the operator "Run" path. `tenantId`/`environmentId` come from the MCP token, never a
   * tool argument (Tier-1 rule 4 tenant isolation).
   */
  async startMcpTrigger(
    tenantId: string,
    environmentId: string,
    input: Record<string, unknown> | undefined,
    workflowKey: string,
  ): Promise<{ workflowId: string }> {
    await this.assertActive(tenantId, environmentId, workflowKey);
    const snapshot = await this.graphs.getLatest(
      tenantId,
      environmentId,
      workflowKey,
    );
    if (!snapshot) {
      throw new NotFoundException(
        `No '${workflowKey}' graph for this tenant — save one first`,
      );
    }
    return this.startGraph(
      `mcp-${tenantId}`,
      snapshot,
      input ?? {},
      tenantId,
      environmentId,
      workflowKey,
    );
  }

  /**
   * Start a webhook run AND wait (bounded) for a `respondToWebhook` node to set a
   * synchronous response. Polls the response query until it's set, the run closes,
   * or the timeout elapses — then returns whatever it has. Any query hiccup or a
   * run that never responds degrades to `{ workflowId }` (no response → the ingress
   * falls back to 202). Never throws for the response path.
   */
  async startWebhookAwaitResponse(
    tenantId: string,
    environmentId: string,
    snapshot: GraphSnapshot,
    event: unknown,
    workflowKey: string,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<{ workflowId: string; response?: WebhookResponse }> {
    const { workflowId } = await this.startWebhook(
      tenantId,
      environmentId,
      snapshot,
      event,
      workflowKey,
    );
    const response = await this.pollForResponse(workflowId, opts);
    return response ? { workflowId, response } : { workflowId };
  }

  /**
   * Start a CHAT run (input `{ message, sessionId }` from the chatTrigger) AND wait (bounded) for the
   * graph's `respondToWebhook` node to set the reply — the chat's answer. Same durable-response
   * mechanism as the webhook path; a run that never replies degrades to `{ workflowId }`. (Durable
   * per-session conversation state is a later slice; this is single-turn.)
   */
  async startChatAwaitResponse(
    tenantId: string,
    environmentId: string,
    snapshot: GraphSnapshot,
    input: {
      message: string;
      sessionId: string;
      history?: { role: string; text: string }[];
    },
    workflowKey: string,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<{ workflowId: string; response?: WebhookResponse }> {
    await this.assertActive(tenantId, environmentId, workflowKey);
    const { workflowId } = await this.startGraph(
      `chat-${tenantId}`,
      snapshot,
      input,
      tenantId,
      environmentId,
      workflowKey,
    );
    const response = await this.pollForResponse(workflowId, opts);
    return response ? { workflowId, response } : { workflowId };
  }

  /**
   * Send a message to a DURABLE per-session chat (design §2.1b, option A). `signalWithStart` starts
   * the long-lived `chatSession` workflow on the first message of a session and signals it after; the
   * turn-id keyed `chatReplyQuery` is then polled for this message's answer (so concurrent messages
   * never read each other's reply). Degrades to `{ replied:false }` if the turn doesn't answer in time.
   */
  async sendChatSessionMessage(
    tenantId: string,
    environmentId: string,
    snapshot: GraphSnapshot,
    input: { message: string; sessionId: string; chatId: string },
    workflowKey: string,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<{ replied: boolean; reply?: unknown; citations?: Citation[] }> {
    await this.assertActive(tenantId, environmentId, workflowKey);
    // Stable, deterministic session id — the SAME id for every message of this conversation, so
    // signalWithStart routes them to one workflow. sessionId is sanitized (opaque, ≤200 chars).
    // environmentId is part of the key: the SAME tenant/workflowKey/sessionId used in two envs must
    // route to DIFFERENT durable sessions, or their conversation state would mix across envs.
    const safeSession = input.sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
    const sessionWorkflowId = `chatsession-${tenantId}-${environmentId}-${workflowKey}-${safeSession}`;
    const turnId = randomUUID(); // minted here, never in workflow code (determinism)
    const budget = await getBudget(tenantId);
    // Same fast-fail gates as startGraph — a chat turn is a run start too.
    // Tenant gate first, then the company-wide OUTER gate (both must pass).
    await assertWithinMonthlyBudget(tenantId, budget);
    await assertWithinCompanyMonthlyBudget(tenantId);

    await this.client.workflow.signalWithStart(CHAT_SESSION_WORKFLOW, {
      workflowId: sessionWorkflowId,
      taskQueue: TASK_QUEUE,
      signal: chatMessageSignal,
      signalArgs: [{ message: input.message, turnId }],
      args: [
        {
          graph: snapshot.graph,
          ctx: {
            tenantId,
            environmentId,
            workflowKey,
            perExecutionCapUsd: budget?.perExecutionCapUsd,
            maxStepsPerRun: budget?.maxStepsPerRun ?? DEFAULT_MAX_STEPS_PER_RUN,
            // Slice 3: same pause-only snapshot as startGraph (see its comment).
            ...(budget?.onBudgetExceeded === "pause"
              ? { onBudgetExceeded: "pause" as const }
              : {}),
            graphContentHash: snapshot.contentHash,
            graphVersion: snapshot.version,
          },
          chatId: input.chatId,
          sessionId: input.sessionId,
        },
      ],
    });

    return this.pollForChatReply(sessionWorkflowId, turnId, opts);
  }

  /** Poll a chat session's reply for one turn until it's replied, ages out, or times out. */
  private async pollForChatReply(
    sessionWorkflowId: string,
    turnId: string,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<{ replied: boolean; reply?: unknown; citations?: Citation[] }> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const pollMs = opts.pollMs ?? 150;
    const handle = this.client.workflow.getHandle(sessionWorkflowId);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const state = await handle.query(chatReplyQuery, turnId);
        if (state.status === "replied")
          return {
            replied: true,
            reply: state.reply,
            citations: state.citations, // RAG sources for this turn (issue #482)
          };
        // The turn ran but the graph set no synchronous response — terminal, stop early and report
        // "started" (matches the non-durable path) rather than waiting out the full timeout.
        if (state.status === "no_reply") return { replied: false };
        // "unknown" only occurs after the reply aged out of the window (shouldn't happen inside the
        // poll deadline) — keep polling until the deadline in case of a transient ordering.
      } catch {
        // Transient query/replay hiccup — keep polling.
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return { replied: false };
  }

  /**
   * Poll a run's `respondToWebhook` response query until it's set, the run closes, or the timeout
   * elapses. Never throws (a query hiccup keeps polling); returns undefined if no response arrives.
   * Shared by the webhook + chat synchronous-reply paths.
   */
  private async pollForResponse(
    workflowId: string,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<WebhookResponse | undefined> {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const pollMs = opts.pollMs ?? 150;
    const handle = this.client.workflow.getHandle(workflowId);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const response = await handle.query(webhookResponseQuery);
        if (response) return response;
        // Not set yet — stop early if the run has already closed, but re-query ONCE first (the run
        // may have set the response AND completed between this query and the describe).
        const desc = await handle.describe();
        if (desc.status.name !== "RUNNING") {
          return await handle
            .query(webhookResponseQuery)
            .catch(() => undefined);
        }
      } catch {
        // Transient replay/worker hiccup — keep polling until the deadline.
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return undefined;
  }

  /** Throw 409 if the workflow is deactivated. The gate for AUTOMATIC triggers only (webhook/form);
   *  manual `start()` and schedule/poll (paused in Temporal when inactive) don't call this. */
  private async assertActive(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
  ): Promise<void> {
    // Activation is env-scoped: an automatic trigger fires in the endpoint's OWN environment
    // (design ENVIRONMENTS.md Slice 4), so its activation flag is checked there.
    if (!(await this.graphs.isActive(tenantId, environmentId, workflowKey))) {
      throw new ConflictException("Workflow is inactive");
    }
  }

  private async startGraph(
    prefix: string,
    snapshot: GraphSnapshot,
    input: unknown,
    tenantId: string,
    environmentId: string,
    workflowKey: string,
    /** Per-run verbose logging — the manual `start()` path forwards it, and `resume()` inherits it
     *  from the failed run's snapshot; triggers omit it. */
    debug = false,
    /**
     * Resume-from-failed-node (docs/design/RESUME-FROM-FAILED-NODE.md §4). Present ONLY for that
     * path: it becomes the interpreter's 4th arg (`ResumeState`), so the walk starts at the failed
     * node with the snapshotted ctx instead of at the graph's start node with an empty one.
     * `resumedFromId` records lineage on the read-model row.
     */
    resumeOpts?: {
      resume: {
        ctx: Record<string, unknown>;
        startNodeId: string;
        costUsd: number;
        stepCount: number;
        mergeArrivals?: Record<string, number>;
        reseedVars: true;
      };
      resumedFromId: string;
    },
  ): Promise<{ workflowId: string }> {
    // The funnel for EVERY start path. Resolving here is what guarantees the `Execution` row and
    // the run's Temporal ctx record the LIVE key (#904) — so a run triggered through a retired
    // webhook/form/chat/MCP reference still lands in the renamed workflow's history, and the
    // interpreter's own `workflowKey` (used for self-heal, notifications and the error handler)
    // is never a name that no longer exists.
    workflowKey = await resolveWorkflowKey(tenantId, workflowKey);
    const workflowId = `${prefix}-${randomUUID()}`;
    const budget = await getBudget(tenantId);
    // Fast-fail if the workspace is already over its monthly cap (covers start/webhook/form,
    // which all funnel here). Optimization only — reserveBudget in the agent activity is the
    // authoritative guard; this just avoids starting a run that would die at the first agent.
    await assertWithinMonthlyBudget(tenantId, budget);
    // Company-wide OUTER gate (COMPANIES.md §8, Slice 5) — layered above the tenant gate,
    // both must pass. No-op for standalone workspaces; fails open on lookup errors.
    await assertWithinCompanyMonthlyBudget(tenantId);
    // Bind the current error handler (if any) at start — the interpreter starts it
    // detached on failure. Read now (deterministic in-workflow needs it via args).
    // Env-scoped (slice-6 cleanup): the RUN'S env's binding, so a sandbox failure
    // triggers sandbox's handler, never prod's.
    const errorWorkflowKey = await this.graphs.getErrorHandler(
      tenantId,
      environmentId,
      workflowKey,
    );

    // Pass the immutable graph SNAPSHOT (bytes that existed now); the content hash
    // + version ride in the workflow ctx (history) and a Temporal memo so the run
    // is traceable to its exact version and a later edit can't change it.
    await this.client.workflow.start(RUN_GRAPH_WORKFLOW, {
      args: [
        snapshot.graph,
        input,
        {
          tenantId,
          environmentId,
          workflowKey,
          perExecutionCapUsd: budget?.perExecutionCapUsd,
          maxStepsPerRun: budget?.maxStepsPerRun ?? DEFAULT_MAX_STEPS_PER_RUN,
          // Slice 3 (pause-not-fail): snapshot the policy ONLY when it is "pause" — the
          // value that activates the interpreter's park path. reject/downgrade behave
          // identically to the pre-Slice-3 absent field, so old args stay byte-identical.
          ...(budget?.onBudgetExceeded === "pause"
            ? { onBudgetExceeded: "pause" as const }
            : {}),
          graphContentHash: snapshot.contentHash,
          graphVersion: snapshot.version,
          ...(errorWorkflowKey ? { errorWorkflowKey } : {}),
          // Per-run verbose logging (opt-in): only set when true so a normal run's args stay
          // byte-identical. Threaded to each activity's meta → DEBUG-level logs for THIS run only.
          ...(debug ? { debug: true } : {}),
        },
        // Arg 4 (ResumeState) is OMITTED on every ordinary start, so a normal run's args stay
        // byte-identical to before this feature existed.
        ...(resumeOpts ? [resumeOpts.resume] : []),
      ],
      taskQueue: TASK_QUEUE,
      workflowId,
      memo: {
        graphContentHash: snapshot.contentHash,
        graphVersion: snapshot.version,
      },
    });

    // Record ownership so approve/getState can be authorized by tenant, plus the
    // snapshotted version for the Runs list / run detail (the memo/history also hold it).
    // searchText projects the run's TRIGGER INPUT for "search by contained data" (#463) — input
    // only, never node outputs / completion text (privacy rule). null when there's nothing to index.
    await getPrisma().execution.create({
      data: {
        workflowId,
        tenantId,
        environmentId, // tag the run with its env (Slice 6)
        workflowKey,
        graphVersion: snapshot.version,
        searchText: projectSearchText(input) ?? null,
        ...(resumeOpts ? { resumedFromId: resumeOpts.resumedFromId } : {}),
      },
    });
    executionsStarted.inc({ workflowKey });
    return { workflowId };
  }

  /**
   * Single-node TEST (design SINGLE-NODE-EXECUTION.md slice 3): run ONE activity node against a
   * seeded ctx (its upstream outputs, from pins) and return its output. Runs the REAL interpreter
   * in test mode over a synthetic one-node graph — same activity + in-activity secret fetch +
   * billing as a real run — but records no Execution/read-model row (it's not a "run"). Awaits
   * completion (a single activity). Throws WorkflowFailedError if the node errors.
   */
  async testNode(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
    node: NodeDef,
    seededCtx: Record<string, unknown>,
  ): Promise<{
    output: unknown;
    /** Interpreter-measured duration of the tested node (Slice 2); null when the
     *  run recorded none (never a fabricated client-side guess). */
    durationMs: number | null;
    /** Real metered spend of the test run (ctx.__costUsd — same fail-safe billing
     *  as any run: missing usage ledgers the estimate, never zero). Null when the
     *  node meters no cost at all (pure/uncosted nodes). */
    costUsd: number | null;
  }> {
    const graph: GraphDef = {
      startNodeId: node.id,
      nodes: [node, { id: "__snx_end", type: "end" }],
      edges: [{ from: node.id, to: "__snx_end" }],
    };
    const budget = await getBudget(tenantId);
    const result = (await this.client.workflow.execute(RUN_GRAPH_WORKFLOW, {
      args: [
        graph,
        (seededCtx.__input as unknown) ?? {},
        {
          tenantId,
          // A single-node test runs the REAL activity + in-activity secret fetch, so it must read
          // THIS env's creds/connections (Slice 5b) — a sandbox test uses sandbox keys.
          environmentId,
          workflowKey,
          test: true,
          seededCtx,
          perExecutionCapUsd: budget?.perExecutionCapUsd,
          maxStepsPerRun: budget?.maxStepsPerRun ?? DEFAULT_MAX_STEPS_PER_RUN,
          // Slice 3: deliberately NO onBudgetExceeded here — a single-node test is
          // awaited synchronously and must fail fast on budget, never park.
        },
      ],
      taskQueue: TASK_QUEUE,
      workflowId: `test-${tenantId}-${randomUUID()}`,
    })) as { ctx: Record<string, unknown> };
    const t = nodeTimesFrom(result.ctx)?.[node.id];
    return {
      output: result.ctx[node.id],
      durationMs: t ? Math.max(0, t.f - t.s) : null,
      costUsd:
        typeof result.ctx.__costUsd === "number" ? result.ctx.__costUsd : null,
    };
  }

  async approve(
    id: string,
    approved: boolean,
    tenantId: string,
    comment?: string,
    /** The user-facing caller (SPA/v1/MCP). G3: asserts `run` on the run's workflow —
     *  deciding an approval is a run-control action. The PUBLIC signed-link path goes
     *  through decideByToken (HMAC-authorized), NOT here, and stays ungated. */
    actor?: Principal,
  ): Promise<void> {
    return opApprove(this.deps(), id, approved, tenantId, comment, actor);
  }

  /** Decide-time approver enforcement (REDESIGN-FUNCTIONALITY-GAPS.md Slice 1). See
   *  accessAssertApprover. */
  private async assertApprover(
    actor: Principal | undefined,
    workflowId: string,
    tenantId: string,
  ): Promise<void> {
    return accessAssertApprover(this.deps(), actor, workflowId, tenantId);
  }

  /**
   * Decide many paused runs at once with the SAME decision. Each run is signalled
   * independently (de-duped so a double-selected id can't double-signal) — an
   * already-closed or not-owned run must not abort the rest, so we `allSettled` and
   * return a per-run outcome. The caller surfaces which ids slipped (ok:false).
   */
  async approveBatch(
    ids: string[],
    approved: boolean,
    tenantId: string,
    comment?: string,
    actor?: Principal,
  ): Promise<BatchDecisionResult[]> {
    return opApproveBatch(this.deps(), ids, approved, tenantId, comment, actor);
  }

  /**
   * Resolve everything a manual "Remind now" needs (Slice 1): asserts tenant ownership +
   * the `run` verb on the run's workflow, confirms the run is STILL awaiting approval
   * (409 otherwise — nothing to remind about), and returns the run's env + prompt title.
   * The controller then fans the reminder out via NotificationsService.sendApprovalReminder
   * (API-side send — see that method for why not a worker Signal round-trip).
   */
  async remindContext(
    id: string,
    tenantId: string,
    actor?: Principal,
  ): Promise<{
    environmentId: string;
    workflowId: string;
    workflowKey: string | null;
    title: string;
  }> {
    return opRemindContext(this.deps(), id, tenantId, actor);
  }

  /**
   * Resume a run paused on a wait(webhook) node by signalling `resumeSignal` with the caller's
   * payload. PUBLIC path: authorization is the HMAC resume token (verified in the controller), so
   * there is NO tenant/owner check here — the token is the credential. A run that isn't paused
   * (already resumed, completed, or timed out) is a closed workflow → NOT_FOUND → 409, mirroring
   * `approve`.
   */
  async resumeByToken(workflowId: string, payload: unknown): Promise<void> {
    return opResumeByToken(this.deps(), workflowId, payload);
  }

  /** Approve/reject a paused run authorized by a signed link token (not a bearer) — the public
   *  approval-decision path. No tenant assertion (the HMAC token IS the authorization; the caller
   *  verified it). Mirrors resumeByToken's closed-run handling. */
  async decideByToken(
    workflowId: string,
    approved: boolean,
    comment?: string,
  ): Promise<void> {
    return opDecideByToken(this.deps(), workflowId, approved, comment);
  }

  /** The relative resume-URL path for a run, for the owner's UI to display/copy. Tenant-scoped
   *  and run-gated (G3, #593) — the path is a resume capability. */
  async getResumePath(
    workflowId: string,
    tenantId: string,
    actor?: Principal,
  ): Promise<string> {
    return opGetResumePath(this.deps(), workflowId, tenantId, actor);
  }

  /**
   * Cancel a running (or paused) run — terminates the workflow immediately (status → terminated).
   * Terminate rather than a graceful cancel: the generic interpreter doesn't handle a
   * CancelledFailure, so terminate gives a definitive stop. Tenant-scoped via assertOwner. A run
   * that's already closed returns NOT_FOUND → 409 (nothing to cancel).
   */
  async cancel(id: string, tenantId: string, actor?: Principal): Promise<void> {
    const row = await this.assertOwner(id, tenantId);
    // G3: cancelling is a run-control action — `run` on the run's workflow (§8.4).
    await this.assertRunAccess(actor, "run", row);
    try {
      await this.client.workflow.getHandle(id).terminate("Canceled by user");
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) {
        throw new ConflictException(
          "Execution is already finished — nothing to cancel.",
        );
      }
      throw e;
    }
    // Close out the read-model ourselves (#807). Nothing else will: `finishedAt` is only ever
    // stamped by the worker's setExecutionStatus activity, and a terminate runs NO workflow code —
    // run-graph deliberately rethrows a cancellation before its failure path. So the row kept its
    // last synced status ("running") with finishedAt null, which showed a canceled run with no
    // duration forever, and left it matching a "running" status filter.
    //
    // "terminated", not "canceled": we call terminate(), so this is exactly what a live
    // describe() reports for this run — writing anything else would make the read-model and the
    // reconcile path disagree about the same run.
    //
    // BEST-EFFORT. The run is already terminated by the time we get here, so a failed write must
    // not turn a successful cancel into a 500 — the caller's retry would then hit the 409 above
    // and they'd have no way to succeed. A missed write degrades to the old behaviour: the list's
    // reconcile still reports "terminated", now with closeTime for the duration.
    try {
      await getPrisma().execution.update({
        where: { workflowId: id },
        data: {
          status: "terminated",
          finishedAt: new Date(),
          // Mirror setExecutionStatus, which clears this on every non-budget status: the column
          // means "currently paused since", and a terminated run is not paused. Today the
          // month-rollover reconcile also filters on status: "awaiting_budget" so a stale value
          // couldn't wake anything — but the invariant is the column's, not that query's.
          budgetPausedAt: null,
        },
      });
    } catch {
      /* read-model lag only — the cancel itself succeeded */
    }
  }

  /**
   * Soft-archive (hide from the default Runs list) or restore a run. Read-model-only:
   * flips `archivedAt` on the PG row and never touches Temporal — a running run can be
   * archived and keeps executing; unarchiving is just clearing the flag. Owner-scoped.
   */
  async setArchived(
    id: string,
    tenantId: string,
    archived: boolean,
    actor?: Principal,
  ): Promise<void> {
    const row = await this.assertOwner(id, tenantId);
    // G3 (#598): archiving is a run-control action — mirror `cancel`, don't stop at
    // the tenant check.
    await this.assertRunAccess(actor, "run", row);
    await getPrisma().execution.update({
      where: { workflowId: id },
      data: { archivedAt: archived ? new Date() : null },
    });
  }

  /**
   * Archive (or restore) many runs at once. Each is settled independently (mirrors
   * approveBatch): one not-owned/unknown id doesn't fail the whole batch — the caller gets a
   * per-run outcome so it can drop the successes and surface the rest.
   */
  async archiveBatch(
    ids: string[],
    tenantId: string,
    archived: boolean,
    actor?: Principal,
  ): Promise<BatchDecisionResult[]> {
    const unique = [...new Set(ids)];
    const settled = await Promise.allSettled(
      unique.map((id) => this.setArchived(id, tenantId, archived, actor)),
    );
    return settled.map((r, i) =>
      r.status === "fulfilled"
        ? { workflowId: unique[i], ok: true }
        : {
            workflowId: unique[i],
            ok: false,
            error:
              r.reason instanceof Error ? r.reason.message : String(r.reason),
          },
    );
  }

  /**
   * Cancel (terminate) many runs in one call. Each is cancelled INDEPENDENTLY and tenant-scoped
   * (via `cancel` → assertOwner), so an already-terminal, not-owned, or unknown run yields a
   * per-run `ok:false` instead of failing the whole batch — same best-effort contract as
   * approveBatch/archiveBatch. De-duped.
   */
  async cancelBatch(
    ids: string[],
    tenantId: string,
    actor?: Principal,
  ): Promise<BatchDecisionResult[]> {
    const unique = [...new Set(ids)];
    const settled = await Promise.allSettled(
      unique.map((id) => this.cancel(id, tenantId, actor)),
    );
    return settled.map((r, i) =>
      r.status === "fulfilled"
        ? { workflowId: unique[i], ok: true }
        : {
            workflowId: unique[i],
            ok: false,
            error:
              r.reason instanceof Error ? r.reason.message : String(r.reason),
          },
    );
  }

  /**
   * The tenant's runs currently paused for human approval, each enriched with the
   * approval node's prompt (title/instructions) resolved from the stored graph — so
   * the inbox shows WHAT is being approved, not just that something is waiting.
   *
   * Starts from the read-model (status = awaiting_approval), then confirms each is
   * STILL awaiting via a live query (a run may have been decided since the row was
   * written) and reads its current node. Bounded by the number of paused runs.
   */
  async listAwaiting(
    tenantId: string,
    actor?: Principal,
  ): Promise<AwaitingApproval[]> {
    return queryAwaiting(this.deps(), tenantId, actor);
  }

  /** Public (token-authed) approval prompt lookup by workflowId — for the signed-link decision page.
   *  Resolves tenant/workflowKey from the Execution row (no bearer), confirms the run is still
   *  awaiting, and returns the node's prompt plus (Slice 1) the workspace display name and the
   *  pause-time context fields — the public page's trust line + fields card. Degrades to
   *  `{ awaiting: false }` on any miss. */
  async promptByWorkflowId(workflowId: string): Promise<{
    awaiting: boolean;
    title?: string;
    instructions?: string | null;
    workspaceName?: string | null;
    contextFields?: Record<string, string> | null;
    slaHours?: number | null;
    dueAt?: string | null;
  }> {
    return queryPromptByWorkflowId(this.deps(), workflowId);
  }

  /** Resolve a humanApproval node's title/instructions from the tenant's stored graph.
   *  See accessApprovalPrompt. */
  private async approvalPrompt(
    tenantId: string,
    environmentId: string | null,
    workflowKey: string | null,
    nodeId: string,
    ctx?: Record<string, unknown>,
  ): Promise<{ title: string; instructions: string | null }> {
    return accessApprovalPrompt(
      this.deps(),
      tenantId,
      environmentId,
      workflowKey,
      nodeId,
      ctx,
    );
  }

  /** Recent runs for the tenant (newest first) — the non-paged convenience over
   *  {@link listPage} (same read-model + Temporal-failure reconcile). */
  async list(
    tenantId: string,
    limit = 50,
    archived = false,
    actor?: Principal,
    /** Free-text substring search over the run's trigger-input projection + id/key (#463). */
    q?: string,
  ): Promise<RunSummary[]> {
    const { items } = await this.listPage(
      tenantId,
      { limit, archived, q },
      actor,
    );
    return items;
  }

  /**
   * Cursor-paged variant of {@link list} (the public v1 GET /runs seam). Keyset
   * pagination on (createdAt DESC, workflowId DESC): the returned `nextCursor`
   * encodes the last row's sort key, so the next page picks up exactly after it
   * even as new runs land at the top (an offset would drift). `nextCursor` is null
   * when there is no further page. Same read-model + reconcile path as list().
   */
  async listPage(
    tenantId: string,
    opts: {
      limit?: number;
      cursor?: string;
      archived?: boolean;
      q?: string;
    } = {},
    /** The user-facing caller (SPA Runs screen / v1 GET /runs). G3 (§8.4): a RESTRICTED
     *  subject's rows are view-filtered IN the where clause, so pagination stays exact.
     *  Absent for internal callers + the company rollup path (workspace-level reads). */
    actor?: Principal,
  ): Promise<RunPage> {
    return queryListPage(this.deps(), tenantId, opts, actor);
  }

  /** Map one Execution read-model row to a RunSummary. See accessToRunSummary. */
  private async toRunSummary(r: {
    workflowId: string;
    workflowKey: string | null;
    status: string;
    costUsd: unknown;
    createdAt: Date;
    finishedAt: Date | null;
    failureKind: string | null;
    archivedAt: Date | null;
    graphVersion: number | null;
  }): Promise<RunSummary> {
    return accessToRunSummary(this.deps(), r);
  }

  /** Live detail for a run — truthful, never-500 status handling (RUNNING queried,
   *  COMPLETED via result(), Temporal failure mapped, gone → 404). See queryState. */
  async getState(
    id: string,
    tenantId: string,
    actor?: Principal,
  ): Promise<RunStateView> {
    return queryState(this.deps(), id, tenantId, actor);
  }

  /**
   * A node's binary AUDIO artifact (textToSpeech, #689) — the bytes, streamed from object storage.
   *
   * The reference is read out of the RUN CTX at `<nodeId>.output.audio.__objectRef`, never from the
   * request, and is additionally required to sit under this tenant's `tts/<tenantId>/` prefix — a
   * graph author can write any `__objectRef` into ctx (e.g. via a `set` node), so ownership must be
   * proven from the key, not inferred from the run. Auth/view-gating rides on `getState`, which
   * already does assertOwner + assertRunAccess.
   *
   * A missing object is a clean 404, never a 500: with the default in-memory store the objects live
   * in the WORKER process, so this legitimately has nothing to serve in a dev setup (the same
   * limitation `resolveCtxRefs` documents for claim checks).
   */
  async nodeAudio(
    id: string,
    nodeId: string,
    tenantId: string,
    actor?: Principal,
  ): Promise<{ body: Buffer; contentType: string; filename: string }> {
    const state = await queryState(this.deps(), id, tenantId, actor);
    const audio = audioRefFromCtx(state.ctx, nodeId);
    if (!audio) {
      throw new NotFoundException("No audio for that node in this run");
    }
    if (!isTenantOwnedAudioRef(audio.__objectRef, tenantId)) {
      // Not this tenant's object (or an unknown/malformed reference) — indistinguishable from
      // "absent" on purpose: never confirm the existence of someone else's object.
      throw new NotFoundException("No audio for that node in this run");
    }
    const contentType = safeContentType(audio.contentType);
    let body: Buffer;
    try {
      body = await getObjectStore().get(audio.__objectRef);
    } catch {
      throw new NotFoundException(
        "The audio object is no longer available in storage",
      );
    }
    return { body, contentType, filename: audioFilename(nodeId, contentType) };
  }

  /** The run's execution log — a curated timeline from Temporal history (maps by event
   *  type + plain fields only, no payload decoding, so nothing secret leaks). See
   *  queryHistory. */
  async history(
    id: string,
    tenantId: string,
    actor?: Principal,
  ): Promise<RunEvent[]> {
    return queryHistory(this.deps(), id, tenantId, actor);
  }

  /** The trigger input a past run was STARTED with, read back from Temporal history
   *  (payloads[1] of the started event) — works for any terminal state, incl. a FAILED
   *  run whose ctx getState can't return, which is what a re-run needs. See
   *  queryOriginalTriggerInput. */
  private async originalTriggerInput(
    id: string,
  ): Promise<Record<string, unknown> | undefined> {
    return queryOriginalTriggerInput(this.deps(), id);
  }

  /** The version-pinned graph a past run EXECUTED, read back from Temporal history
   *  (payloads[0] of the started event) — the exact snapshot it walked, even if the saved
   *  workflow was edited since. Owner-scoped; 404 if the run/snapshot is gone. See
   *  queryRunGraph. */
  async runGraph(
    id: string,
    tenantId: string,
    actor?: Principal,
  ): Promise<{
    graph: Record<string, unknown>;
    version: number | null;
    workflowKey: string | null;
  }> {
    return queryRunGraph(this.deps(), id, tenantId, actor);
  }

  /**
   * Can this failed run be resumed at the node that died?
   * (docs/design/RESUME-FROM-FAILED-NODE.md §3, §6)
   *
   * A separate read from `resume()` on purpose: the UI has to be able to DISABLE the button and say
   * why. A button that only fails on click is the same class of gap as a retry checkbox that isn't
   * wired — it looks supported and isn't.
   *
   * All the graph reasoning is `evaluateResume` in @naary/dsl (pure, unit-tested); this method's job
   * is to gather the three inputs it needs — the run's terminal state, the EXACT graph it walked, and
   * whether a ctx snapshot is retrievable.
   */
  async resumeEligibility(
    id: string,
    tenantId: string,
    actor?: Principal,
  ): Promise<ResumeEligibility & { warningText?: string }> {
    await this.assertOwner(id, tenantId);
    const row = await getPrisma().execution.findUnique({
      where: { workflowId: id },
    });
    if (!row) throw new NotFoundException("Run not found");
    if (row.workflowKey) {
      const envId =
        row.environmentId ?? (await this.environments.defaultEnvId(tenantId));
      await this.assertRun(actor, row.workflowKey, envId);
    }

    // The exact snapshot the run WALKED — never the latest saved version, which may have renamed or
    // removed the very node we would resume at. Unrecoverable ⇒ evaluateResume refuses.
    const graph = await this.runGraph(id, tenantId, actor).then(
      (g) => g.graph as unknown as GraphDef,
      () => null,
    );

    const verdict = evaluateResume({
      status: row.status,
      failedNodeId: row.failedNodeId,
      graph,
      executedNodeIds: row.executedNodeIds,
      hasSnapshot: row.resumeSnapshot !== null,
      snapshotDetail: this.snapshotDetail(),
    });
    if (verdict.warnings.includes("at_most_once_node") && graph) {
      const type =
        graph.nodes.find((n) => n.id === verdict.failedNodeId)?.type ?? "";
      return {
        ...verdict,
        warningText: resumeWarningText("at_most_once_node", type),
      };
    }
    return verdict;
  }

  /** Why a snapshot might be absent — surfaced verbatim so "can't resume" is never unexplained. */
  private snapshotDetail(): string {
    if (!resumeSnapshotsEnabled()) {
      return "Resume snapshots are turned off for this deployment (RESUME_SNAPSHOTS=off).";
    }
    if (storageProvider() !== "s3") {
      return "Resume needs object storage (STORAGE_PROVIDER=s3); without it a run's state isn't saved anywhere the API can read.";
    }
    return "No saved state was found for this run — it may have failed before snapshots were enabled, or the snapshot has since expired.";
  }

  /**
   * Resume a failed run AT the node that failed, keeping everything earlier as-is.
   *
   * The point of the feature: a rerun repeats side effects an earlier node already had (the email is
   * sent twice). This starts a NEW Temporal workflow — a failed one is closed and cannot be
   * restarted — but seeds it with the failed run's ctx and points the walk at the failed node, so
   * nothing upstream executes again.
   *
   * Ineligible ⇒ 409 with the reason, never a best-effort attempt: every refusal in `evaluateResume`
   * is a case that would otherwise produce a plausible-looking WRONG run.
   */
  async resume(
    id: string,
    tenantId: string,
    opts: { acknowledgeSideEffects?: boolean } = {},
    actor?: Principal,
  ): Promise<{ workflowId: string }> {
    const verdict = await this.resumeEligibility(id, tenantId, actor);
    if (!verdict.resumable) {
      throw new ConflictException(
        verdict.detail ?? `This run can't be resumed (${verdict.reason}).`,
      );
    }
    // The failed node may have taken effect before reporting failure (a 500 after the write), and
    // only the caller knows. Refuse to guess on their behalf.
    if (
      verdict.warnings.includes("at_most_once_node") &&
      !opts.acknowledgeSideEffects
    ) {
      throw new BadRequestException(
        `${verdict.warningText ?? "The failing node may already have taken effect."} Pass acknowledgeSideEffects to resume anyway.`,
      );
    }

    const row = await getPrisma().execution.findUnique({
      where: { workflowId: id },
    });
    if (!row?.workflowKey) {
      throw new BadRequestException(
        "This run predates workflow-key tracking and can't be resumed.",
      );
    }
    const envId =
      row.environmentId ?? (await this.environments.defaultEnvId(tenantId));
    const recovered = await this.runGraph(id, tenantId, actor);
    const graph = recovered.graph as unknown as GraphDef;

    // Rehydrate the ctx from object storage. A non-null reference can still 404 — the bucket
    // lifecycle expires it — so this is the one refusal that can only be discovered here.
    let ctx: Record<string, unknown>;
    try {
      const resolved = await resolveClaimChecks(
        row.resumeSnapshot,
        getObjectStore(),
      );
      if (
        !resolved ||
        typeof resolved !== "object" ||
        Array.isArray(resolved)
      ) {
        throw new Error("snapshot did not resolve to an object");
      }
      ctx = resolved as Record<string, unknown>;
    } catch {
      throw new ConflictException(
        "This run's saved state is no longer available (snapshots expire), so it can't be resumed. Re-running it will start from the beginning.",
      );
    }

    return this.startGraph(
      "resume",
      // The snapshot the ORIGINAL run walked. `version` is echoed for the read model; a null
      // version (pre-tracking run) still resumes — the graph bytes are what matter.
      { graph, contentHash: "", version: recovered.version ?? 0 },
      await this.originalTriggerInput(id),
      tenantId,
      envId,
      row.workflowKey,
      // Debug is INHERITED here, unlike a re-run: a re-run is a fresh start you opt into, while a
      // resume continues the run you were already trying to understand — turning the verbose worker
      // logs and the per-node debug rows off at the resume is the opposite of what's wanted.
      // The snapshot's own `__debug` marker is the carrier: it was written by the very run whose
      // flag this asks about, it is already in hand (no third fetchHistory), and it can't drift from
      // the ctx the resumed run is seeded with. The one case it misses — a run started with `debug`
      // before #924 taught the interpreter to stamp `__debug` — could only come from a hand-rolled
      // API call, since nothing in the product sent the flag until then.
      ctx.__debug === true,
      {
        resume: {
          ctx,
          startNodeId: verdict.failedNodeId as string,
          // Carried so a resumed run continues against the SAME spend, rather than getting a fresh
          // allowance — resuming must not be a way around a per-run budget cap.
          costUsd: Number(row.costUsd ?? 0),
          // Verbatim from the snapshot: it seeds child-workflow ids, so recomputing it would
          // silently re-run children that already succeeded.
          stepCount: row.resumeStepCount ?? 0,
          ...(row.resumeMergeArrivals
            ? {
                mergeArrivals: row.resumeMergeArrivals as Record<
                  string,
                  number
                >,
              }
            : {}),
          // The snapshot's ctx may predate the failure, so $vars must be re-read — the interpreter
          // otherwise skips them for any resume (correct for continueAsNew only).
          reseedVars: true,
        },
        resumedFromId: id,
      },
    );
  }

  /**
   * Re-run a past execution: start a NEW run of the same saved workflow with the same
   * trigger input the original was started with (n8n's "Retry"). By default it runs
   * against the CURRENT graph (start snapshots the latest) — so re-running picks up any
   * fix. Pass `graphVersion` to re-run at a SPECIFIC saved version (newer or older) of
   * the run's OWN workflowKey — the version is resolved against that key only, never an
   * arbitrary (key, version) from the caller. The run is durable and metered exactly
   * like any other start. Returns the new run id.
   */
  async rerun(
    id: string,
    tenantId: string,
    graphVersion?: number,
    actor?: Principal,
    /** Opt the NEW run into per-run diagnostics (verbose worker logs + the Run Detail's
     *  per-node debug rows). Never inherited from the original run — "re-run with debug"
     *  is a deliberate choice made when you want to understand a run that already failed. */
    debug = false,
  ): Promise<{ workflowId: string }> {
    await this.assertOwner(id, tenantId);
    const row = await getPrisma().execution.findUnique({
      where: { workflowId: id },
    });
    if (!row?.workflowKey) {
      throw new BadRequestException(
        "This run predates workflow-key tracking and can't be re-run.",
      );
    }
    // Re-run in the ORIGINAL run's env (Slice 6) — a sandbox run re-runs against the sandbox graph.
    // A pre-Slice-6 run has no env tag → the tenant default (where its graph lived).
    const envId =
      row.environmentId ?? (await this.environments.defaultEnvId(tenantId));
    // `run` gate (§4) against the run's own key + env, BEFORE reading the original input.
    await this.assertRun(actor, row.workflowKey, envId);
    const input = await this.originalTriggerInput(id);
    // workflowKey is the run's OWN key; graphVersion (if given) is resolved against
    // that key inside start() — the caller can't target another workflow's version.
    // No actor forwarded: the gate already ran just above (same key + env).
    return this.start(
      tenantId,
      envId,
      input,
      row.workflowKey,
      graphVersion,
      undefined,
      debug,
    );
  }

  /** 404 if the execution is unknown, 403 if it belongs to another tenant. See
   *  accessAssertOwner. */
  private async assertOwner(
    workflowId: string,
    tenantId: string,
  ): Promise<{
    tenantId: string;
    workflowKey: string | null;
    environmentId: string | null;
    failedNodeId: string | null;
    executedNodeIds: string[];
  }> {
    return accessAssertOwner(workflowId, tenantId);
  }
}

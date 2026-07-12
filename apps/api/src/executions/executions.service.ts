import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import {
  type Client,
  type Connection,
  defaultPayloadConverter,
  WorkflowNotFoundError,
} from "@temporalio/client";
import {
  approvalSignal,
  chatMessageSignal,
  chatReplyQuery,
  CHAT_SESSION_WORKFLOW,
  resumeSignal,
  RUN_GRAPH_WORKFLOW,
  stateQuery,
  TASK_QUEUE,
  webhookResponseQuery,
  type ExecutionState,
  type ExecutionStatus,
  type ResumeInput,
  type WebhookResponse,
} from "@naary/contracts";
import type { GraphDef, NodeDef } from "@naary/dsl";
import { getPrisma } from "@naary/db";
import { TracedClass } from "@naary/observability";
import { getBudget } from "@naary/usage";
import { executionsStarted } from "../common/metrics";
import { type GraphSnapshot, GraphsService } from "../graphs/graphs.service";
import { connectTemporal } from "../temporal/client";
import { resumePath } from "./resume-token";

/** Circuit breaker default when a tenant has no budget configured (safety net). */
const DEFAULT_MAX_STEPS_PER_RUN = 50;

/** workflowKey of the demo graph that POST /executions starts. */
const DEFAULT_WORKFLOW_KEY = "default";

/** A run in the list, with live status + accumulated cost from Temporal. */
export interface RunSummary {
  workflowId: string;
  workflowKey: string | null;
  /** App status (running | awaiting_approval | completed | rejected |
   *  budget_exceeded | circuit_open | invalid_graph) or a Temporal close reason
   *  (failed | timed_out | terminated | canceled) or "unknown" if unreachable. */
  status:
    | ExecutionStatus
    | "failed"
    | "timed_out"
    | "terminated"
    | "canceled"
    | "unknown";
  /** Accumulated run cost (from the workflow ctx), or null when unavailable. */
  costUsd: number | null;
  /** When the workflow started (Temporal), ISO. */
  startedAt: string;
  /** DB record time, ISO (kept for time-bucketed charts). */
  createdAt: string;
}

/** Live run detail — like ExecutionState but with the widened status (a run can be
 *  Temporal-failed/terminated, which ExecutionStatus alone can't express). */
export interface RunStateView {
  status: RunSummary["status"];
  currentNodeId: string;
  ctx: Record<string, unknown>;
}

/** A run paused at a humanApproval node, enriched with the node's prompt (resolved
 *  from the stored graph) so the approvals inbox can show WHAT is being approved. */
export interface AwaitingApproval {
  workflowId: string;
  workflowKey: string | null;
  nodeId: string;
  title: string;
  instructions: string | null;
  createdAt: string;
}

/** One run's outcome in a batch approve/reject — ok:false carries why it slipped. */
export interface BatchDecisionResult {
  workflowId: string;
  ok: boolean;
  error?: string;
}

/** Temporal closed-status name → our UI status string (COMPLETED handled via result()). */
const TEMPORAL_CLOSED_STATUS: Record<string, RunSummary["status"]> = {
  FAILED: "failed",
  TIMED_OUT: "timed_out",
  TERMINATED: "terminated",
  CANCELLED: "canceled",
  CANCELED: "canceled",
  CONTINUED_AS_NEW: "running",
};

/** Temporal FAILURE states only (for reconciling a stuck-non-terminal PG row). */
const TEMPORAL_FAILED_STATUS: Record<string, RunSummary["status"]> = {
  FAILED: "failed",
  TIMED_OUT: "timed_out",
  TERMINATED: "terminated",
  CANCELLED: "canceled",
  CANCELED: "canceled",
};

/** One entry in a run's execution log (derived from a Temporal history event). */
export interface RunEvent {
  id: number;
  /** Coarse kind for the UI icon/colour. */
  kind:
    | "started"
    | "activity"
    | "signal"
    | "timer"
    | "completed"
    | "error"
    | "continued";
  label: string;
  at: string | null;
  detail?: string;
}

/** The subset of Temporal history-event fields we read (one attrs object is set). */
interface RawHistoryEvent {
  eventId?: number | string | { toString(): string };
  eventTime?: {
    seconds?: number | string | { toString(): string };
    nanos?: number;
  };
  workflowExecutionStartedEventAttributes?: unknown;
  activityTaskScheduledEventAttributes?: { activityType?: { name?: string } };
  activityTaskCompletedEventAttributes?: unknown;
  activityTaskFailedEventAttributes?: { failure?: { message?: string } };
  workflowExecutionSignaledEventAttributes?: { signalName?: string };
  timerStartedEventAttributes?: unknown;
  timerFiredEventAttributes?: unknown;
  workflowExecutionCompletedEventAttributes?: unknown;
  workflowExecutionFailedEventAttributes?: { failure?: { message?: string } };
  workflowExecutionContinuedAsNewEventAttributes?: unknown;
}

function mapHistoryEvent(e: RawHistoryEvent): RunEvent | null {
  const id = Number(e.eventId ?? 0);
  const at = e.eventTime?.seconds
    ? new Date(
        Number(e.eventTime.seconds) * 1000 + (e.eventTime.nanos ?? 0) / 1e6,
      ).toISOString()
    : null;
  const base = { id, at };
  if (e.workflowExecutionStartedEventAttributes)
    return { ...base, kind: "started", label: "Run started" };
  if (e.activityTaskScheduledEventAttributes)
    return {
      ...base,
      kind: "activity",
      label: `Activity: ${e.activityTaskScheduledEventAttributes.activityType?.name ?? "?"}`,
    };
  if (e.activityTaskCompletedEventAttributes)
    return { ...base, kind: "activity", label: "Activity completed" };
  if (e.activityTaskFailedEventAttributes)
    return {
      ...base,
      kind: "error",
      label: "Activity failed",
      detail: e.activityTaskFailedEventAttributes.failure?.message,
    };
  if (e.workflowExecutionSignaledEventAttributes)
    return {
      ...base,
      kind: "signal",
      label: `Signal: ${e.workflowExecutionSignaledEventAttributes.signalName ?? "?"}`,
    };
  if (e.timerStartedEventAttributes)
    return {
      ...base,
      kind: "timer",
      label: "Timer started (approval timeout)",
    };
  if (e.timerFiredEventAttributes)
    return { ...base, kind: "timer", label: "Timer fired" };
  if (e.workflowExecutionCompletedEventAttributes)
    return { ...base, kind: "completed", label: "Run completed" };
  if (e.workflowExecutionFailedEventAttributes)
    return {
      ...base,
      kind: "error",
      label: "Run failed",
      detail: e.workflowExecutionFailedEventAttributes.failure?.message,
    };
  if (e.workflowExecutionContinuedAsNewEventAttributes)
    return { ...base, kind: "continued", label: "Continued as new" };
  return null; // workflow-task / marker / version noise — skip
}

/** Run statuses that won't change again — the read-model is authoritative for these. */
const TERMINAL_STATUSES = new Set([
  "completed",
  "rejected",
  "budget_exceeded",
  "circuit_open",
  "invalid_graph",
  "failed",
  "timed_out",
  "terminated",
  "canceled",
]);
function isTerminalStatus(s: string): boolean {
  return TERMINAL_STATUSES.has(s);
}

/** The Start node's configured sample input (used as the default manual-run input). */
function startSampleInput(
  graph: GraphSnapshot["graph"],
): Record<string, unknown> | undefined {
  const start = graph.nodes.find((n) => n.id === graph.startNodeId);
  const sample = (start?.config as { sampleInput?: unknown } | undefined)
    ?.sampleInput;
  return sample && typeof sample === "object" && !Array.isArray(sample)
    ? (sample as Record<string, unknown>)
    : undefined;
}

/**
 * Wraps the Temporal client: start an execution, signal approval, query state.
 * The client connects once at boot and closes on shutdown.
 *
 * Every run is recorded as an `Execution { workflowId, tenantId }` so the control
 * plane can authorize `approve`/`getState` against the caller's tenant — a raw
 * workflowId is never enough to act on a run.
 */
@Injectable()
@TracedClass()
export class ExecutionsService implements OnModuleInit, OnModuleDestroy {
  private client!: Client;
  private connection!: Connection;

  constructor(private readonly graphs: GraphsService) {}

  async onModuleInit(): Promise<void> {
    const { client, connection } = await connectTemporal();
    this.client = client;
    this.connection = connection;
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection?.close();
  }

  /** Manual start. `tenantId` comes from the authenticated principal (not the body);
   *  runs the tenant's latest graph for `workflowKey` (default "default"; the canvas
   *  saves + runs "canvas"). The chosen graph must already be saved. */
  async start(
    tenantId: string,
    input?: Record<string, unknown>,
    workflowKey: string = DEFAULT_WORKFLOW_KEY,
  ): Promise<{ workflowId: string }> {
    const snapshot = await this.graphs.getLatest(tenantId, workflowKey);
    if (!snapshot) {
      throw new NotFoundException(
        `No '${workflowKey}' graph for this tenant — save one first`,
      );
    }
    // Default input precedence: explicit body input → the Start node's configured
    // sampleInput → a generic fallback. Lets a workflow define realistic test data.
    return this.startGraph(
      `exec-${tenantId}`,
      snapshot,
      input ??
        startSampleInput(snapshot.graph) ?? {
          message: "I was charged twice this month",
        },
      tenantId,
      workflowKey,
    );
  }

  /** Start a webhook-triggered run; the verified event becomes the trigger output.
   *  The caller resolved + snapshotted the graph from the DB. Refused when the workflow is
   *  INACTIVE (n8n parity) — an automatic trigger, unlike a manual `start()`. */
  async startWebhook(
    tenantId: string,
    snapshot: GraphSnapshot,
    event: unknown,
    workflowKey: string,
  ): Promise<{ workflowId: string }> {
    await this.assertActive(tenantId, workflowKey);
    return this.startGraph(
      `wh-${tenantId}`,
      snapshot,
      event,
      tenantId,
      workflowKey,
    );
  }

  /** Start a form-submission run; the validated+sanitized submission becomes the trigger output.
   *  The caller resolved + snapshotted the graph (and confirmed its entry is a formTrigger).
   *  Refused when the workflow is INACTIVE (n8n parity) — automatic, unlike a manual `start()`. */
  async startForm(
    tenantId: string,
    snapshot: GraphSnapshot,
    submission: Record<string, unknown>,
    workflowKey: string,
  ): Promise<{ workflowId: string }> {
    await this.assertActive(tenantId, workflowKey);
    return this.startGraph(
      `form-${tenantId}`,
      snapshot,
      submission,
      tenantId,
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
    snapshot: GraphSnapshot,
    event: unknown,
    workflowKey: string,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<{ workflowId: string; response?: WebhookResponse }> {
    const { workflowId } = await this.startWebhook(
      tenantId,
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
    snapshot: GraphSnapshot,
    input: {
      message: string;
      sessionId: string;
      history?: { role: string; text: string }[];
    },
    workflowKey: string,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<{ workflowId: string; response?: WebhookResponse }> {
    await this.assertActive(tenantId, workflowKey);
    const { workflowId } = await this.startGraph(
      `chat-${tenantId}`,
      snapshot,
      input,
      tenantId,
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
    snapshot: GraphSnapshot,
    input: { message: string; sessionId: string; chatId: string },
    workflowKey: string,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<{ replied: boolean; reply?: unknown }> {
    await this.assertActive(tenantId, workflowKey);
    // Stable, deterministic session id — the SAME id for every message of this conversation, so
    // signalWithStart routes them to one workflow. sessionId is sanitized (opaque, ≤200 chars).
    const safeSession = input.sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
    const sessionWorkflowId = `chatsession-${tenantId}-${workflowKey}-${safeSession}`;
    const turnId = randomUUID(); // minted here, never in workflow code (determinism)
    const budget = await getBudget(tenantId);

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
            workflowKey,
            perExecutionCapUsd: budget?.perExecutionCapUsd,
            maxStepsPerRun: budget?.maxStepsPerRun ?? DEFAULT_MAX_STEPS_PER_RUN,
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
  ): Promise<{ replied: boolean; reply?: unknown }> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const pollMs = opts.pollMs ?? 150;
    const handle = this.client.workflow.getHandle(sessionWorkflowId);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const state = await handle.query(chatReplyQuery, turnId);
        if (state.status === "replied")
          return { replied: true, reply: state.reply };
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
    workflowKey: string,
  ): Promise<void> {
    if (!(await this.graphs.isActive(tenantId, workflowKey))) {
      throw new ConflictException("Workflow is inactive");
    }
  }

  private async startGraph(
    prefix: string,
    snapshot: GraphSnapshot,
    input: unknown,
    tenantId: string,
    workflowKey: string,
  ): Promise<{ workflowId: string }> {
    const workflowId = `${prefix}-${randomUUID()}`;
    const budget = await getBudget(tenantId);
    // Bind the current error handler (if any) at start — the interpreter starts it
    // detached on failure. Read now (deterministic in-workflow needs it via args).
    const errorWorkflowKey = await this.graphs.getErrorHandler(
      tenantId,
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
          workflowKey,
          perExecutionCapUsd: budget?.perExecutionCapUsd,
          maxStepsPerRun: budget?.maxStepsPerRun ?? DEFAULT_MAX_STEPS_PER_RUN,
          graphContentHash: snapshot.contentHash,
          graphVersion: snapshot.version,
          ...(errorWorkflowKey ? { errorWorkflowKey } : {}),
        },
      ],
      taskQueue: TASK_QUEUE,
      workflowId,
      memo: {
        graphContentHash: snapshot.contentHash,
        graphVersion: snapshot.version,
      },
    });

    // Record ownership so approve/getState can be authorized by tenant.
    await getPrisma().execution.create({
      data: { workflowId, tenantId, workflowKey },
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
    workflowKey: string,
    node: NodeDef,
    seededCtx: Record<string, unknown>,
  ): Promise<unknown> {
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
          workflowKey,
          test: true,
          seededCtx,
          perExecutionCapUsd: budget?.perExecutionCapUsd,
          maxStepsPerRun: budget?.maxStepsPerRun ?? DEFAULT_MAX_STEPS_PER_RUN,
        },
      ],
      taskQueue: TASK_QUEUE,
      workflowId: `test-${tenantId}-${randomUUID()}`,
    })) as { ctx: Record<string, unknown> };
    return result.ctx[node.id];
  }

  async approve(
    id: string,
    approved: boolean,
    tenantId: string,
    comment?: string,
  ): Promise<void> {
    await this.assertOwner(id, tenantId);
    try {
      await this.client.workflow
        .getHandle(id)
        .signal(approvalSignal, { approved, ...(comment ? { comment } : {}) });
    } catch (e) {
      // Signaling a CLOSED workflow (already completed / rejected / failed) returns
      // gRPC NOT_FOUND → WorkflowNotFoundError. The execution row exists (assertOwner
      // passed), so it's not a 404 — it's a 409: the run is no longer awaiting
      // approval. Mirrors getState's WorkflowNotFoundError handling, with the right
      // semantics for a write. (Previously this leaked an unhandled 500.)
      if (e instanceof WorkflowNotFoundError) {
        throw new ConflictException(
          "Execution is not awaiting approval (already completed, rejected, or failed).",
        );
      }
      throw e;
    }
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
  ): Promise<BatchDecisionResult[]> {
    const unique = [...new Set(ids)];
    const settled = await Promise.allSettled(
      unique.map((id) => this.approve(id, approved, tenantId, comment)),
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
   * Resume a run paused on a wait(webhook) node by signalling `resumeSignal` with the caller's
   * payload. PUBLIC path: authorization is the HMAC resume token (verified in the controller), so
   * there is NO tenant/owner check here — the token is the credential. A run that isn't paused
   * (already resumed, completed, or timed out) is a closed workflow → NOT_FOUND → 409, mirroring
   * `approve`.
   */
  async resumeByToken(workflowId: string, payload: unknown): Promise<void> {
    try {
      await this.client.workflow
        .getHandle(workflowId)
        .signal(resumeSignal, { payload } satisfies ResumeInput);
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) {
        throw new ConflictException(
          "Run is not awaiting a webhook resume (already resumed, completed, or timed out).",
        );
      }
      throw e;
    }
  }

  /** Approve/reject a paused run authorized by a signed link token (not a bearer) — the public
   *  approval-decision path. No tenant assertion (the HMAC token IS the authorization; the caller
   *  verified it). Mirrors resumeByToken's closed-run handling. */
  async decideByToken(
    workflowId: string,
    approved: boolean,
    comment?: string,
  ): Promise<void> {
    const handle = this.client.workflow.getHandle(workflowId);
    // GUARD (public signed link): only decide a run that is CURRENTLY awaiting approval. Temporal
    // buffers a signal sent to a running-but-not-yet-paused run, so without this a stale link
    // clicked later could be "saved up" and auto-satisfy a FUTURE humanApproval pause (a graph that
    // loops or has multiple approvals). Query the live state first; anything but awaiting → 409.
    let status: string;
    try {
      status = (await handle.query(stateQuery)).status;
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) {
        throw new ConflictException("Run not found or already closed.");
      }
      throw e;
    }
    if (status !== "awaiting_approval") {
      throw new ConflictException(
        "Run is not awaiting approval (already decided, completed, or timed out).",
      );
    }
    try {
      await handle.signal(approvalSignal, {
        approved,
        ...(comment ? { comment } : {}),
      });
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) {
        throw new ConflictException(
          "Run is not awaiting approval (already completed, rejected, or timed out).",
        );
      }
      throw e;
    }
  }

  /** The relative resume-URL path for a run, for the owner's UI to display/copy. Tenant-scoped. */
  async getResumePath(workflowId: string, tenantId: string): Promise<string> {
    await this.assertOwner(workflowId, tenantId);
    return resumePath(workflowId);
  }

  /**
   * Cancel a running (or paused) run — terminates the workflow immediately (status → terminated).
   * Terminate rather than a graceful cancel: the generic interpreter doesn't handle a
   * CancelledFailure, so terminate gives a definitive stop. Tenant-scoped via assertOwner. A run
   * that's already closed returns NOT_FOUND → 409 (nothing to cancel).
   */
  async cancel(id: string, tenantId: string): Promise<void> {
    await this.assertOwner(id, tenantId);
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
  async listAwaiting(tenantId: string): Promise<AwaitingApproval[]> {
    const rows = await getPrisma().execution.findMany({
      where: { tenantId, status: "awaiting_approval" },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const items = await Promise.all(
      rows.map(async (r): Promise<AwaitingApproval | null> => {
        let currentNodeId = "";
        try {
          const s = await this.client.workflow
            .getHandle(r.workflowId)
            .query(stateQuery);
          // Decided/advanced since the read-model write, or closed → not awaiting.
          if (s.status !== "awaiting_approval") return null;
          currentNodeId = s.currentNodeId;
        } catch {
          return null; // closed/gone
        }
        const prompt = await this.approvalPrompt(
          tenantId,
          r.workflowKey,
          currentNodeId,
        );
        return {
          workflowId: r.workflowId,
          workflowKey: r.workflowKey,
          nodeId: currentNodeId,
          title: prompt.title,
          instructions: prompt.instructions,
          createdAt: r.createdAt.toISOString(),
        };
      }),
    );
    return items.filter((x): x is AwaitingApproval => x !== null);
  }

  /** Public (token-authed) approval prompt lookup by workflowId — for the signed-link decision page.
   *  Resolves tenant/workflowKey from the Execution row (no bearer), confirms the run is still
   *  awaiting, and returns the node's prompt. Degrades to `{ awaiting: false }` on any miss. */
  async promptByWorkflowId(workflowId: string): Promise<{
    awaiting: boolean;
    title?: string;
    instructions?: string | null;
  }> {
    const row = await getPrisma().execution.findUnique({
      where: { workflowId },
    });
    if (!row) return { awaiting: false };
    try {
      const s = await this.client.workflow
        .getHandle(workflowId)
        .query(stateQuery);
      if (s.status !== "awaiting_approval") return { awaiting: false };
      const prompt = await this.approvalPrompt(
        row.tenantId,
        row.workflowKey,
        s.currentNodeId,
      );
      return {
        awaiting: true,
        title: prompt.title,
        instructions: prompt.instructions,
      };
    } catch {
      return { awaiting: false };
    }
  }

  /** Resolve a humanApproval node's title/instructions from the tenant's stored graph. */
  private async approvalPrompt(
    tenantId: string,
    workflowKey: string | null,
    nodeId: string,
  ): Promise<{ title: string; instructions: string | null }> {
    if (!workflowKey) return { title: "Approval required", instructions: null };
    const snap = await this.graphs
      .getLatest(tenantId, workflowKey)
      .catch(() => null);
    const node = snap?.graph.nodes.find((n) => n.id === nodeId);
    const cfg = (node?.config ?? {}) as {
      title?: string;
      instructions?: string;
    };
    return {
      title: cfg.title?.trim() || "Approval required",
      instructions: cfg.instructions?.trim() || null,
    };
  }

  /**
   * Recent runs for the tenant (newest first). Reads the Execution READ-MODEL: the
   * interpreter pushes status + accumulated cost to the row as a run progresses
   * (see setExecutionStatus), so a terminal run needs ZERO Temporal calls — the
   * key scaling win over the old per-run describe()+result() (which replayed each
   * closed run's history).
   *
   * One reconcile: a run still marked non-terminal in PG that FAILED at the
   * Temporal level (the workflow THREW, so it couldn't push a terminal status) is
   * caught with a cheap describe() ONLY (no history replay). Genuinely
   * running/awaiting runs keep their pushed status.
   */
  async list(tenantId: string, limit = 50): Promise<RunSummary[]> {
    const rows = await getPrisma().execution.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 100),
    });
    return Promise.all(
      rows.map(async (r) => {
        const startedAt = r.createdAt.toISOString();
        const base = {
          workflowId: r.workflowId,
          workflowKey: r.workflowKey,
          costUsd: r.costUsd !== null ? Number(r.costUsd) : null,
          startedAt,
          createdAt: startedAt,
        };
        if (isTerminalStatus(r.status)) {
          return { ...base, status: r.status as RunSummary["status"] };
        }
        // Non-terminal in PG → reconcile against Temporal (cheap describe only) so
        // a workflow that threw (Temporal-FAILED) isn't shown as forever-running.
        try {
          const desc = await this.client.workflow
            .getHandle(r.workflowId)
            .describe();
          const failed = TEMPORAL_FAILED_STATUS[desc.status.name];
          return {
            ...base,
            status: failed ?? (r.status as RunSummary["status"]),
          };
        } catch {
          return { ...base, status: r.status as RunSummary["status"] };
        }
      }),
    );
  }

  /**
   * Live detail for a run. Mirrors list()'s truthful, never-500 status handling:
   * describe() to learn the Temporal state, then a RUNNING run is queried, a
   * COMPLETED run's terminal status + ctx come from result(), and a Temporal
   * failure (FAILED/TIMED_OUT/TERMINATED/CANCELED) maps to a real status instead
   * of throwing a 500. Only a truly-gone run is a 404.
   */
  async getState(id: string, tenantId: string): Promise<RunStateView> {
    await this.assertOwner(id, tenantId);
    const handle = this.client.workflow.getHandle(id);
    try {
      const desc = await handle.describe();
      if (desc.status.name === "RUNNING") {
        // Wrap the query (mirrors list()): a transient replay/worker hiccup must
        // degrade to "running", never 500.
        try {
          const s = await handle.query(stateQuery);
          return {
            status: s.status,
            currentNodeId: s.currentNodeId,
            ctx: s.ctx,
          };
        } catch {
          return { status: "running", currentNodeId: "", ctx: {} };
        }
      }
      if (desc.status.name === "COMPLETED") {
        try {
          const r = (await handle.result()) as {
            status: ExecutionStatus;
            ctx: Record<string, unknown>;
          };
          return { status: r.status, currentNodeId: "", ctx: r.ctx };
        } catch {
          return { status: "completed", currentNodeId: "", ctx: {} };
        }
      }
      // Temporal-level failure (the workflow threw, was terminated, etc.) — there's
      // no returned {status,ctx} to recover, so report the mapped close reason.
      return {
        status: TEMPORAL_CLOSED_STATUS[desc.status.name] ?? "unknown",
        currentNodeId: "",
        ctx: {},
      };
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) {
        throw new NotFoundException("Execution not found");
      }
      throw e;
    }
  }

  /**
   * The run's execution log — a curated timeline from the workflow's Temporal
   * history (the durable record of what happened). We map by event TYPE (which
   * `*EventAttributes` is present) + read only plain fields (activity name, signal
   * name, failure message — already sanitized at the activity) — no payload
   * decoding, so nothing secret-bearing is surfaced.
   */
  async history(id: string, tenantId: string): Promise<RunEvent[]> {
    await this.assertOwner(id, tenantId);
    let h: { events?: unknown[] | null };
    try {
      h = await this.client.workflow.getHandle(id).fetchHistory();
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) {
        throw new NotFoundException("Execution not found");
      }
      throw e;
    }
    const out: RunEvent[] = [];
    for (const raw of h.events ?? []) {
      const ev = mapHistoryEvent(raw as RawHistoryEvent);
      if (ev) out.push(ev);
    }
    return out;
  }

  /**
   * The trigger input a past run was STARTED with, read back from Temporal history
   * (the durable source of truth). We decode the WorkflowExecutionStarted event's
   * SECOND arg — `startGraph` starts the workflow with `[graph, input, runCtx]`, so
   * `payloads[1]` is the input — using the default payload converter (this deployment
   * configures no custom one). Works for ANY terminal state, including a FAILED run
   * whose ctx `getState` can't return — which is exactly what a re-run needs. Returns
   * undefined if the event/payload is missing or undecodable (caller falls back to the
   * graph's default input). Nothing is surfaced to the user: the value is fed straight
   * back into a new run, so no new payload exposure.
   */
  private async originalTriggerInput(
    id: string,
  ): Promise<Record<string, unknown> | undefined> {
    let h: { events?: unknown[] | null };
    try {
      h = await this.client.workflow.getHandle(id).fetchHistory();
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) {
        throw new NotFoundException("Execution not found");
      }
      throw e;
    }
    const started = (h.events ?? []).find(
      (ev) =>
        (ev as { workflowExecutionStartedEventAttributes?: unknown })
          .workflowExecutionStartedEventAttributes,
    ) as
      | {
          workflowExecutionStartedEventAttributes?: {
            input?: { payloads?: unknown[] };
          };
        }
      | undefined;
    const payloads =
      started?.workflowExecutionStartedEventAttributes?.input?.payloads;
    if (!payloads || payloads.length < 2) return undefined;
    try {
      const decoded = defaultPayloadConverter.fromPayload(payloads[1] as never);
      return decoded == null ? undefined : (decoded as Record<string, unknown>);
    } catch {
      return undefined;
    }
  }

  /**
   * Re-run a past execution: start a NEW run of the same saved workflow with the same
   * trigger input the original was started with (n8n's "Retry"). It runs against the
   * CURRENT graph (start snapshots the latest) — so re-running picks up any fix. The
   * run is durable and metered exactly like any other start. Returns the new run id.
   */
  async rerun(id: string, tenantId: string): Promise<{ workflowId: string }> {
    await this.assertOwner(id, tenantId);
    const row = await getPrisma().execution.findUnique({
      where: { workflowId: id },
    });
    if (!row?.workflowKey) {
      throw new BadRequestException(
        "This run predates workflow-key tracking and can't be re-run.",
      );
    }
    const input = await this.originalTriggerInput(id);
    return this.start(tenantId, input, row.workflowKey);
  }

  /** 404 if the execution is unknown, 403 if it belongs to another tenant. */
  private async assertOwner(
    workflowId: string,
    tenantId: string,
  ): Promise<void> {
    const row = await getPrisma().execution.findUnique({
      where: { workflowId },
    });
    if (!row) throw new NotFoundException("Execution not found");
    if (row.tenantId !== tenantId) {
      throw new ForbiddenException("Execution belongs to another tenant");
    }
  }
}

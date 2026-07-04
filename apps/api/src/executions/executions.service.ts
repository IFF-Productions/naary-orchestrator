import { randomUUID } from "node:crypto";
import {
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
  WorkflowNotFoundError,
} from "@temporalio/client";
import {
  approvalSignal,
  RUN_GRAPH_WORKFLOW,
  stateQuery,
  TASK_QUEUE,
  webhookResponseQuery,
  type ExecutionState,
  type ExecutionStatus,
  type WebhookResponse,
} from "@naary/contracts";
import { getPrisma } from "@naary/db";
import { getBudget } from "@naary/usage";
import { executionsStarted } from "../common/metrics";
import { type GraphSnapshot, GraphsService } from "../graphs/graphs.service";
import { connectTemporal } from "../temporal/client";

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
   *  The caller resolved + snapshotted the graph from the DB. */
  async startWebhook(
    tenantId: string,
    snapshot: GraphSnapshot,
    event: unknown,
    workflowKey: string,
  ): Promise<{ workflowId: string }> {
    return this.startGraph(
      `wh-${tenantId}`,
      snapshot,
      event,
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
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const pollMs = opts.pollMs ?? 150;
    const handle = this.client.workflow.getHandle(workflowId);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const response = await handle.query(webhookResponseQuery);
        if (response) return { workflowId, response };
        // Not set yet — stop early if the run has already closed. But re-query ONCE
        // first: the run may have set the response AND completed between this query
        // and the describe (the node is often right before `end`). A closed run
        // still answers queries from its final state.
        const desc = await handle.describe();
        if (desc.status.name !== "RUNNING") {
          const final = await handle
            .query(webhookResponseQuery)
            .catch(() => undefined);
          return final ? { workflowId, response: final } : { workflowId };
        }
      } catch {
        // Transient replay/worker hiccup — keep polling until the deadline.
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return { workflowId };
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

  async approve(
    id: string,
    approved: boolean,
    tenantId: string,
  ): Promise<void> {
    await this.assertOwner(id, tenantId);
    try {
      await this.client.workflow
        .getHandle(id)
        .signal(approvalSignal, { approved });
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

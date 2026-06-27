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
  type ExecutionState,
  type ExecutionStatus,
} from "@naary/contracts";
import { getPrisma } from "@naary/db";
import { getBudget } from "@naary/usage";
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

/** The workflow accumulates total run cost (agent + MCP tool) in ctx.__costUsd. */
function costFromCtx(ctx: Record<string, unknown> | undefined): number | null {
  const c = ctx?.__costUsd;
  return typeof c === "number" ? c : null;
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

  private async startGraph(
    prefix: string,
    snapshot: GraphSnapshot,
    input: unknown,
    tenantId: string,
    workflowKey: string,
  ): Promise<{ workflowId: string }> {
    const workflowId = `${prefix}-${randomUUID()}`;
    const budget = await getBudget(tenantId);

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
   * Recent runs for the tenant (newest first), enriched with LIVE status + cost
   * read from Temporal (state lives there, not the DB). Per run: describe() tells
   * us running-vs-closed + start time; a RUNNING run is queried for its app status
   * (awaiting_approval, etc.) and accumulated cost; a CLOSED run's TRUE terminal
   * status comes from result() (the workflow returns {status, ctx} — a rejected /
   * budget_exceeded run is Temporal-COMPLETED, so describe() alone would wrongly
   * read "completed"). Enrichment is best-effort + parallel; a run we can't reach
   * falls back to "unknown" rather than failing the list. Bounded — a tenant
   * search attribute + Temporal list() is the scaling follow-up.
   */
  async list(tenantId: string, limit = 50): Promise<RunSummary[]> {
    const rows = await getPrisma().execution.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 100),
    });
    return Promise.all(rows.map((r) => this.enrich(r)));
  }

  private async enrich(row: {
    workflowId: string;
    workflowKey: string | null;
    createdAt: Date;
  }): Promise<RunSummary> {
    const base = {
      workflowId: row.workflowId,
      workflowKey: row.workflowKey,
      createdAt: row.createdAt.toISOString(),
      startedAt: row.createdAt.toISOString(),
    };
    try {
      const handle = this.client.workflow.getHandle(row.workflowId);
      const desc = await handle.describe();
      const startedAt = desc.startTime?.toISOString() ?? base.startedAt;

      if (desc.status.name === "RUNNING") {
        try {
          const state = await handle.query(stateQuery);
          return {
            ...base,
            startedAt,
            status: state.status,
            costUsd: costFromCtx(state.ctx),
          };
        } catch {
          return { ...base, startedAt, status: "running", costUsd: null };
        }
      }
      if (desc.status.name === "COMPLETED") {
        // The workflow RETURNS its terminal status (success / rejected /
        // budget_exceeded / …) — result() recovers the truthful value.
        const result = (await handle.result()) as {
          status: ExecutionStatus;
          ctx: Record<string, unknown>;
        };
        return {
          ...base,
          startedAt,
          status: result.status,
          costUsd: costFromCtx(result.ctx),
        };
      }
      // FAILED / TIMED_OUT / TERMINATED / CANCELED / CONTINUED_AS_NEW
      return {
        ...base,
        startedAt,
        status: TEMPORAL_CLOSED_STATUS[desc.status.name] ?? "unknown",
        costUsd: null,
      };
    } catch {
      return { ...base, status: "unknown", costUsd: null };
    }
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

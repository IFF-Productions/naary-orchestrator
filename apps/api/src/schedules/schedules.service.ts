import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { Client, Connection } from "@temporalio/client";
import { RUN_GRAPH_WORKFLOW, TASK_QUEUE } from "@naary/contracts";
import { getPrisma } from "@naary/db";
import type { GraphDef } from "@naary/dsl";
import { getBudget } from "@naary/usage";
import { GraphsService } from "../graphs/graphs.service";
import { connectTemporal } from "../temporal/client";

/** Circuit-breaker default when a tenant has no budget configured (matches start). */
const DEFAULT_MAX_STEPS_PER_RUN = 50;

export interface ScheduleView {
  id: string;
  workflowKey: string;
  cron: string;
  paused: boolean;
  createdAt: string;
  /** Next fire time from Temporal, ISO, or null if unknown/paused. */
  nextRunAt: string | null;
}

/**
 * Per-workflow recurring runs, backed by Temporal Schedules (cron). Temporal owns
 * the schedule + its firing; the `Schedule` row is the tenant-scoped index so we
 * can list/authorize by tenant. The schedule's action starts the SAME runGraph
 * workflow as a manual run, with the graph SNAPSHOT pinned at creation (editing
 * the workflow later doesn't change an existing schedule — recreate to pick up a
 * new version). Connects its own Temporal client (mirrors ExecutionsService).
 */
@Injectable()
export class SchedulesService implements OnModuleInit, OnModuleDestroy {
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

  async create(
    tenantId: string,
    workflowKey: string,
    cron: string,
  ): Promise<ScheduleView> {
    const cronExpr = cron?.trim();
    if (!cronExpr) throw new BadRequestException("cron is required");

    const snapshot = await this.graphs.getLatest(tenantId, workflowKey);
    if (!snapshot) {
      throw new NotFoundException(
        `No '${workflowKey}' graph for this tenant — save one first`,
      );
    }
    const budget = await getBudget(tenantId);
    const id = `sched-${tenantId}-${workflowKey}-${randomUUID().slice(0, 8)}`;

    try {
      await this.client.schedule.create({
        scheduleId: id,
        spec: { cronExpressions: [cronExpr] },
        action: {
          type: "startWorkflow",
          workflowType: RUN_GRAPH_WORKFLOW,
          taskQueue: TASK_QUEUE,
          // Temporal appends the scheduled time to make each run's id unique.
          workflowId: `schedrun-${tenantId}-${workflowKey}`,
          args: [
            snapshot.graph,
            sampleInput(snapshot.graph) ?? { message: "scheduled run" },
            {
              tenantId,
              workflowKey,
              perExecutionCapUsd: budget?.perExecutionCapUsd,
              maxStepsPerRun:
                budget?.maxStepsPerRun ?? DEFAULT_MAX_STEPS_PER_RUN,
              graphContentHash: snapshot.contentHash,
              graphVersion: snapshot.version,
            },
          ],
          memo: {
            graphContentHash: snapshot.contentHash,
            graphVersion: snapshot.version,
          },
        },
      });
    } catch (_e) {
      // Most commonly an invalid cron expression — surface a 400, not a 500.
      throw new BadRequestException(
        "Could not create schedule — check the cron expression (e.g. '0 9 * * 1-5').",
      );
    }

    await getPrisma().schedule.create({
      data: { id, tenantId, workflowKey, cron: cronExpr },
    });
    return {
      id,
      workflowKey,
      cron: cronExpr,
      paused: false,
      createdAt: new Date().toISOString(),
      nextRunAt: null,
    };
  }

  /**
   * Keep a pollTrigger graph's interval Schedule in sync (audit: pollTrigger slice).
   * If the graph's start node is a pollTrigger, ensure a Temporal INTERVAL schedule
   * runs it every `intervalSeconds` (≥30s floor). Idempotent: re-created on each save
   * so it always reflects the latest graph + interval. No-op for non-poll graphs.
   * Best-effort — the caller should not fail a save if scheduling hiccups.
   */
  async syncPollSchedule(
    tenantId: string,
    workflowKey: string,
    graph: GraphDef,
  ): Promise<void> {
    const start = graph.nodes.find((n) => n.id === graph.startNodeId);
    if (!start || start.type !== "pollTrigger") return;
    const cfg = (start.config ?? {}) as { intervalSeconds?: number };
    const everySeconds = Math.max(
      30,
      Math.floor(Number(cfg.intervalSeconds) || 300),
    );
    const snapshot = await this.graphs.getLatest(tenantId, workflowKey);
    if (!snapshot) return;
    const budget = await getBudget(tenantId);
    const id = `poll-${tenantId}-${workflowKey}`;

    // Delete-then-create so the schedule always reflects the latest graph + interval
    // (simpler + more robust than an in-place update of spec + action).
    try {
      await this.client.schedule.getHandle(id).delete();
    } catch {
      /* no existing schedule — first activation */
    }
    await this.client.schedule.create({
      scheduleId: id,
      spec: { intervals: [{ every: everySeconds * 1000 }] },
      action: {
        type: "startWorkflow",
        workflowType: RUN_GRAPH_WORKFLOW,
        taskQueue: TASK_QUEUE,
        workflowId: `pollrun-${tenantId}-${workflowKey}`,
        args: [
          snapshot.graph,
          {},
          {
            tenantId,
            workflowKey,
            perExecutionCapUsd: budget?.perExecutionCapUsd,
            maxStepsPerRun: budget?.maxStepsPerRun ?? DEFAULT_MAX_STEPS_PER_RUN,
            graphContentHash: snapshot.contentHash,
            graphVersion: snapshot.version,
          },
        ],
        memo: {
          graphContentHash: snapshot.contentHash,
          graphVersion: snapshot.version,
        },
      },
    });
    await getPrisma().schedule.upsert({
      where: { id },
      create: { id, tenantId, workflowKey, cron: `every ${everySeconds}s` },
      update: { cron: `every ${everySeconds}s` },
    });
  }

  /**
   * Keep a `scheduleTrigger` graph's CRON Schedule in sync (mirror of syncPollSchedule).
   * If the graph's start node is a scheduleTrigger, ensure a Temporal cron Schedule runs it
   * on `cron`. Idempotent: delete-then-create on each save so it reflects the latest graph +
   * cron. No-op for non-schedule graphs. Best-effort — the caller must not fail a save if
   * scheduling hiccups (e.g. an invalid cron, which Temporal rejects on create).
   */
  async syncCronSchedule(
    tenantId: string,
    workflowKey: string,
    graph: GraphDef,
  ): Promise<void> {
    const start = graph.nodes.find((n) => n.id === graph.startNodeId);
    if (!start || start.type !== "scheduleTrigger") return;
    const cron = String((start.config as { cron?: string })?.cron ?? "").trim();
    if (!cron) return;
    const snapshot = await this.graphs.getLatest(tenantId, workflowKey);
    if (!snapshot) return;
    const budget = await getBudget(tenantId);
    const id = `cron-${tenantId}-${workflowKey}`;

    try {
      await this.client.schedule.getHandle(id).delete();
    } catch {
      /* no existing schedule — first activation */
    }
    await this.client.schedule.create({
      scheduleId: id,
      spec: { cronExpressions: [cron] },
      action: {
        type: "startWorkflow",
        workflowType: RUN_GRAPH_WORKFLOW,
        taskQueue: TASK_QUEUE,
        workflowId: `cronrun-${tenantId}-${workflowKey}`,
        args: [
          snapshot.graph,
          {},
          {
            tenantId,
            workflowKey,
            perExecutionCapUsd: budget?.perExecutionCapUsd,
            maxStepsPerRun: budget?.maxStepsPerRun ?? DEFAULT_MAX_STEPS_PER_RUN,
            graphContentHash: snapshot.contentHash,
            graphVersion: snapshot.version,
          },
        ],
        memo: {
          graphContentHash: snapshot.contentHash,
          graphVersion: snapshot.version,
        },
      },
    });
    await getPrisma().schedule.upsert({
      where: { id },
      create: { id, tenantId, workflowKey, cron },
      update: { cron },
    });
  }

  /** Tenant's schedules, enriched with the next fire time from Temporal. */
  async list(tenantId: string): Promise<ScheduleView[]> {
    const rows = await getPrisma().schedule.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    });
    return Promise.all(
      rows.map(async (r) => {
        let nextRunAt: string | null = null;
        let paused = r.paused;
        try {
          const d = await this.client.schedule.getHandle(r.id).describe();
          nextRunAt = d.info.nextActionTimes?.[0]?.toISOString() ?? null;
          paused = d.state.paused;
        } catch {
          /* schedule missing in Temporal — fall back to the row */
        }
        return {
          id: r.id,
          workflowKey: r.workflowKey,
          cron: r.cron,
          paused,
          createdAt: r.createdAt.toISOString(),
          nextRunAt,
        };
      }),
    );
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.assertOwner(tenantId, id);
    try {
      await this.client.schedule.getHandle(id).delete();
    } catch {
      /* already gone in Temporal */
    }
    await getPrisma()
      .schedule.delete({ where: { id } })
      .catch(() => undefined);
  }

  async setPaused(
    tenantId: string,
    id: string,
    paused: boolean,
  ): Promise<void> {
    await this.assertOwner(tenantId, id);
    const handle = this.client.schedule.getHandle(id);
    if (paused) await handle.pause("paused via API");
    else await handle.unpause("resumed via API");
    await getPrisma().schedule.update({ where: { id }, data: { paused } });
  }

  /** Fire the schedule's workflow immediately (in addition to its cron). */
  async trigger(tenantId: string, id: string): Promise<void> {
    await this.assertOwner(tenantId, id);
    await this.client.schedule.getHandle(id).trigger();
  }

  private async assertOwner(tenantId: string, id: string): Promise<void> {
    const row = await getPrisma().schedule.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Schedule not found");
    if (row.tenantId !== tenantId) {
      throw new ForbiddenException("Schedule belongs to another tenant");
    }
  }
}

/** The Start node's configured sample input (the scheduled run's input). */
function sampleInput(graph: GraphDef): Record<string, unknown> | undefined {
  const start = graph.nodes.find((n) => n.id === graph.startNodeId);
  const s = (start?.config as { sampleInput?: unknown } | undefined)
    ?.sampleInput;
  return s && typeof s === "object" && !Array.isArray(s)
    ? (s as Record<string, unknown>)
    : undefined;
}

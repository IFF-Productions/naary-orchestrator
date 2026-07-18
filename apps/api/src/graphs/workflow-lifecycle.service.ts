import { Injectable } from "@nestjs/common";
import type { GraphDef } from "@naary/dsl";
import { TracedClass } from "@naary/observability";
import { EnvironmentsService } from "../environments/environments.service";
import { SchedulesService } from "../schedules/schedules.service";
import { type GraphSnapshot, GraphsService } from "./graphs.service";

/**
 * The ONE save/delete path for a workflow definition + its Temporal-schedule side-effects,
 * shared by the SPA controller (graphs.controller) and the public v1 controller
 * (v1-workflows.controller) — previously each duplicated the sync/teardown logic inline
 * (the TODO(consolidate) in v1-workflows.controller).
 *
 * Lives NEXT TO GraphsService rather than on it: SchedulesService already injects
 * GraphsService (schedule creation snapshots the graph), so GraphsService injecting
 * SchedulesService back would be a circular dependency. This thin orchestrator sits above
 * both.
 *
 * Invariants preserved exactly:
 * - DEFAULT-ENV-ONLY gating: Temporal schedules aren't env-scoped yet, so sync/teardown
 *   only runs for the default env — a sandbox save/delete must never reconfigure or kill
 *   the default/prod copy's triggers.
 * - Best-effort side-effects: a scheduling hiccup must not fail the save/delete
 *   (`.catch(() => undefined)`).
 */
@Injectable()
@TracedClass()
export class WorkflowLifecycleService {
  constructor(
    private readonly graphs: GraphsService,
    private readonly schedules: SchedulesService,
    private readonly environments: EnvironmentsService,
  ) {}

  /** Upsert (content-hash + version) the graph, then — default env only — (re)sync its
   *  poll/cron schedules so a saved trigger graph actually fires. */
  async saveWorkflow(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
    name: string,
    graph: GraphDef,
  ): Promise<GraphSnapshot> {
    const snap = await this.graphs.upsert(
      tenantId,
      environmentId,
      workflowKey,
      name,
      graph,
    );
    if (await this.environments.isDefaultEnv(tenantId, environmentId)) {
      await this.schedules
        .syncPollSchedule(tenantId, workflowKey, graph)
        .catch(() => undefined);
      await this.schedules
        .syncCronSchedule(tenantId, workflowKey, graph)
        .catch(() => undefined);
    }
    return snap;
  }

  /** Delete the workflow in this env; for the DEFAULT env's copy also tear down its
   *  Temporal schedules and the shared (tenant-wide) rows/triggers (deleteShared).
   *  Returns false when the key doesn't exist in the env (caller 404s). */
  async deleteWorkflow(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
  ): Promise<boolean> {
    const isDefault = await this.environments.isDefaultEnv(
      tenantId,
      environmentId,
    );
    if (isDefault) {
      await this.schedules
        .teardownForWorkflow(tenantId, workflowKey)
        .catch(() => undefined);
    }
    return this.graphs.deleteWorkflow(
      tenantId,
      environmentId,
      workflowKey,
      isDefault,
    );
  }
}

import { Injectable, Optional } from "@nestjs/common";
import type { GraphDef } from "@naary/dsl";
import { TracedClass } from "@naary/observability";
import type { Principal } from "../auth/tenant.decorator";
import { PermissionsService } from "../permissions/permissions.service";
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
 * - ENV-SCOPED side-effects (env-scoped-schedules slice): schedules carry the env in their
 *   identity now, so save syncs THIS env's schedules and delete tears down THIS env's ids —
 *   a sandbox save/delete touches only sandbox's triggers, never the default/prod copy's.
 * - Best-effort side-effects: a scheduling hiccup must not fail the save/delete
 *   (`.catch(() => undefined)`).
 * - Permission asserts (RBAC-GROUPS.md §4, slice G1) run BEFORE any side effect: the save
 *   gate lives in GraphsService.upsert (edit vs canCreate — the upsert already reads the
 *   latest row, so "new key?" is free); the DELETE gate is asserted here, ahead of the
 *   schedule teardown. No actor (internal callers) ⇒ no check.
 */
@Injectable()
@TracedClass()
export class WorkflowLifecycleService {
  constructor(
    private readonly graphs: GraphsService,
    private readonly schedules: SchedulesService,
    @Optional() private readonly permissions?: PermissionsService,
  ) {}

  /** Upsert (content-hash + version) the graph, then (re)sync THIS env's poll/cron
   *  schedules so a saved trigger graph actually fires — in its own environment. With an
   *  actor, the upsert asserts `edit` (existing key) or `canCreate` (new key) before
   *  persisting. */
  async saveWorkflow(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
    name: string,
    graph: GraphDef,
    actor?: Principal,
    /** Optional commit note for this version (#488). */
    saveMessage?: string,
  ): Promise<GraphSnapshot> {
    const snap = await this.graphs.upsert(
      tenantId,
      environmentId,
      workflowKey,
      name,
      graph,
      actor,
      saveMessage,
    );
    await this.schedules
      .syncPollSchedule(tenantId, environmentId, workflowKey, graph)
      .catch(() => undefined);
    await this.schedules
      .syncCronSchedule(tenantId, environmentId, workflowKey, graph)
      .catch(() => undefined);
    return snap;
  }

  /** Delete the workflow in this env, tearing down THIS env's Temporal schedules (and,
   *  best-effort, any legacy no-env ids — see SchedulesService.teardownForWorkflow).
   *  Returns false when the key doesn't exist in the env (caller 404s). With an actor,
   *  asserts `delete` FIRST — before the teardown side effect can fire. */
  async deleteWorkflow(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
    actor?: Principal,
  ): Promise<boolean> {
    // Resolve a retired key FIRST (#904): the grant list and every row now carry the live key, so
    // both the §4 assert and the schedule teardown must be addressed at it.
    const key = await this.graphs.liveKey(tenantId, workflowKey);
    if (actor) {
      if (!this.permissions) {
        // Fail CLOSED: an actor implies a user-facing call site — authz must run.
        throw new Error(
          "WorkflowLifecycleService: PermissionsService is not wired",
        );
      }
      await this.permissions.assertCan(actor, "delete", key, environmentId);
    }
    await this.schedules
      .teardownForWorkflow(tenantId, environmentId, key)
      .catch(() => undefined);
    return this.graphs.deleteWorkflow(tenantId, environmentId, key);
  }
}

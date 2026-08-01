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
import type {
  Client,
  Connection,
  ScheduleOptionsAction,
} from "@temporalio/client";
import { RUN_GRAPH_WORKFLOW, TASK_QUEUE } from "@naary/contracts";
import { getPrisma } from "@naary/db";
import type { GraphDef } from "@naary/dsl";
import { getBudget } from "@naary/usage";
import { type GraphSnapshot, GraphsService } from "../graphs/graphs.service";
import { connectTemporal } from "../temporal/client";
// Circuit-breaker default when a tenant has no budget configured. Imported, not re-declared: the
// same cap applies whether a schedule starts the run or the API does, so two copies could disagree
// about a safety net (#805).
import { DEFAULT_MAX_STEPS_PER_RUN } from "../executions/executions.types";

export interface ScheduleView {
  id: string;
  workflowKey: string;
  cron: string;
  paused: boolean;
  createdAt: string;
  /** Next fire time from Temporal, ISO, or null if unknown/paused. */
  nextRunAt: string | null;
}

/** Counts from the one-time boot reconcile of legacy (no-env) schedule ids. */
export interface ReconcileResult {
  migrated: number;
  failed: number;
}

/**
 * Per-workflow recurring runs, backed by Temporal Schedules (cron). Temporal owns
 * the schedule + its firing; the `Schedule` row is the tenant-scoped index so we
 * can list/authorize by tenant. The schedule's action starts the SAME runGraph
 * workflow as a manual run, with the graph SNAPSHOT pinned at creation (editing
 * the workflow later doesn't change an existing schedule — recreate to pick up a
 * new version). Connects its own Temporal client (mirrors ExecutionsService).
 *
 * Env-scoped (ENVIRONMENTS.md §7, final slice): the environment is part of the schedule
 * IDENTITY — the Temporal schedule id carries the env segment
 * (`poll-${tenantId}-${environmentId}-${workflowKey}`), the startWorkflow action args carry
 * `environmentId` (so scheduled runs land in their env, reaching env-scoped creds/secrets/
 * notifications/poll cursors), and every isActive/snapshot read uses the SCHEDULE'S env.
 * Legacy no-env ids are cleaned up two ways: ownership-guarded best-effort deletes on every
 * sync/teardown (the safety net — see clearLegacyScheduleIfOwned) and the one-time boot
 * reconcile (reconcileLegacyScheduleIds).
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
    environmentId: string,
    workflowKey: string,
    cron: string,
  ): Promise<ScheduleView> {
    const cronExpr = cron?.trim();
    if (!cronExpr) throw new BadRequestException("cron is required");

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
    const id = `sched-${tenantId}-${environmentId}-${workflowKey}-${randomUUID().slice(0, 8)}`;

    try {
      await this.client.schedule.create({
        scheduleId: id,
        spec: { cronExpressions: [cronExpr] },
        action: await this.startWorkflowAction(
          "schedrun",
          { tenantId, environmentId, workflowKey },
          snapshot,
        ),
      });
    } catch (_e) {
      // Most commonly an invalid cron expression — surface a 400, not a 500.
      throw new BadRequestException(
        "Could not create schedule — check the cron expression (e.g. '0 9 * * 1-5').",
      );
    }

    // Invariant: never leave a schedule running while the workflow is deactivated. If the workflow
    // is inactive IN THIS ENV, create the schedule PAUSED (a fresh Temporal schedule is unpaused
    // by default).
    const paused = !(await this.graphs.isActive(
      tenantId,
      environmentId,
      workflowKey,
    ));
    if (paused) await this.pauseHandle(id, true);

    await getPrisma().schedule.create({
      data: {
        id,
        tenantId,
        environmentId,
        workflowKey,
        cron: cronExpr,
        paused,
      },
    });
    return {
      id,
      workflowKey,
      cron: cronExpr,
      paused,
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
    environmentId: string,
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
    const snapshot = await this.graphs.getLatest(
      tenantId,
      environmentId,
      workflowKey,
    );
    if (!snapshot) return;
    const id = `poll-${tenantId}-${environmentId}-${workflowKey}`;

    // Delete-then-create so the schedule always reflects the latest graph + interval
    // (simpler + more robust than an in-place update of spec + action). Also clears the
    // LEGACY (pre-env-scoped) id if THIS env owns it — normally the boot reconcile already
    // migrated it, but this is the safety net that guarantees a legacy id can never keep
    // firing env-less.
    await this.deleteHandleQuiet(id);
    await this.clearLegacyScheduleIfOwned(
      `poll-${tenantId}-${workflowKey}`,
      environmentId,
    );
    await this.client.schedule.create({
      scheduleId: id,
      spec: { intervals: [{ every: everySeconds * 1000 }] },
      action: await this.startWorkflowAction(
        "pollrun",
        { tenantId, environmentId, workflowKey },
        snapshot,
      ),
    });
    // Invariant: a deactivated workflow's schedule must not fire. The delete-then-create above
    // makes a fresh (unpaused) schedule on every save — re-pause it if the workflow is inactive
    // in this env, else a normal edit silently re-arms a deactivated poll trigger.
    const paused = !(await this.graphs.isActive(
      tenantId,
      environmentId,
      workflowKey,
    ));
    if (paused) await this.pauseHandle(id, true);
    await getPrisma().schedule.upsert({
      where: { id },
      create: {
        id,
        tenantId,
        environmentId,
        workflowKey,
        cron: `every ${everySeconds}s`,
        paused,
      },
      update: { cron: `every ${everySeconds}s`, paused },
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
    environmentId: string,
    workflowKey: string,
    graph: GraphDef,
  ): Promise<void> {
    const start = graph.nodes.find((n) => n.id === graph.startNodeId);
    if (!start || start.type !== "scheduleTrigger") return;
    const cron = String((start.config as { cron?: string })?.cron ?? "").trim();
    if (!cron) return;
    const snapshot = await this.graphs.getLatest(
      tenantId,
      environmentId,
      workflowKey,
    );
    if (!snapshot) return;
    const id = `cron-${tenantId}-${environmentId}-${workflowKey}`;

    await this.deleteHandleQuiet(id);
    await this.clearLegacyScheduleIfOwned(
      `cron-${tenantId}-${workflowKey}`,
      environmentId,
    );
    await this.client.schedule.create({
      scheduleId: id,
      spec: { cronExpressions: [cron] },
      action: await this.startWorkflowAction(
        "cronrun",
        { tenantId, environmentId, workflowKey },
        snapshot,
      ),
    });
    // Invariant (see syncPollSchedule): re-pause the freshly-created cron schedule if the workflow
    // is deactivated in this env, so editing an inactive workflow doesn't re-arm its trigger.
    const paused = !(await this.graphs.isActive(
      tenantId,
      environmentId,
      workflowKey,
    ));
    if (paused) await this.pauseHandle(id, true);
    await getPrisma().schedule.upsert({
      where: { id },
      create: { id, tenantId, environmentId, workflowKey, cron, paused },
      update: { cron, paused },
    });
  }

  /** The env's schedules, enriched with the next fire time from Temporal. */
  async list(tenantId: string, environmentId: string): Promise<ScheduleView[]> {
    const rows = await getPrisma().schedule.findMany({
      where: { tenantId, environmentId },
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
    await this.deleteHandleQuiet(id);
    await getPrisma()
      .schedule.delete({ where: { id } })
      .catch(() => undefined);
  }

  /**
   * Tear down EVERY schedule a workflow owns IN THIS ENV — used when the workflow is deleted so
   * no Temporal schedule outlives the graph and fires against a missing definition. Covers the
   * auto poll/cron schedules (deterministic ids), any user-created cron schedules (DB rows +
   * their Temporal handles), and — best-effort — the legacy (pre-env-scoped) ids, so a
   * not-yet-reconciled legacy schedule can't keep firing after its workflow is gone. Best-effort
   * per handle (a missing one is fine).
   */
  async teardownForWorkflow(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
  ): Promise<void> {
    for (const id of [
      `poll-${tenantId}-${environmentId}-${workflowKey}`,
      `cron-${tenantId}-${environmentId}-${workflowKey}`,
    ]) {
      await this.deleteHandleQuiet(id);
    }
    // Legacy no-env ids (the boot reconcile normally migrated them — this is the delete-path
    // safety net). Ownership-guarded: only cleared when THIS env owns the legacy row, so a
    // sandbox delete can't kill the default env's not-yet-reconciled schedule.
    for (const legacyId of [
      `poll-${tenantId}-${workflowKey}`,
      `cron-${tenantId}-${workflowKey}`,
    ]) {
      await this.clearLegacyScheduleIfOwned(legacyId, environmentId);
    }
    const rows = await getPrisma().schedule.findMany({
      where: { tenantId, environmentId, workflowKey },
      select: { id: true },
    });
    for (const r of rows) {
      await this.deleteHandleQuiet(r.id);
    }
    await getPrisma()
      .schedule.deleteMany({ where: { tenantId, environmentId, workflowKey } })
      .catch(() => undefined);
  }

  /**
   * Activate / deactivate a WORKFLOW (n8n parity) — flips the env-scoped activation flag AND
   * brings the SAME env's Temporal cron/poll schedules in line (schedules are env-scoped now, so
   * a sandbox toggle pauses/resumes sandbox's schedules — never prod's). Ordering matters so no
   * window fires against intent:
   *  - deactivate: pause the schedules FIRST, then write flag=false (webhook/form keep working in
   *    the tiny gap, but nothing fires that shouldn't);
   *  - activate: write flag=true FIRST, then unpause the schedules.
   * Covers ALL of the workflow's Schedule rows in the env (poll/cron/manual) uniformly. The
   * create-time invariant (schedules made paused when inactive) is the durable guarantee; this is
   * the immediate effect on the existing schedules. A failed pause propagates (pauseHandle
   * re-raises) so deactivation can't falsely report success while a schedule keeps firing.
   *
   * Known-narrow residual windows (no cross-service transaction): (a) a graph SAVE racing a
   * deactivate can recreate a schedule unpaused if its `isActive` read lands before the flag
   * commits; (b) a Temporal outage during the best-effort save-time re-pause. Both self-heal on the
   * next save or toggle; closing them fully would need a fire-time activity gate in the interpreter.
   */
  async setActive(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
    active: boolean,
  ): Promise<void> {
    const rows = await getPrisma().schedule.findMany({
      where: { tenantId, environmentId, workflowKey },
      select: { id: true },
    });
    if (!active) {
      for (const r of rows) await this.pauseHandle(r.id, true);
      await getPrisma().schedule.updateMany({
        where: { tenantId, environmentId, workflowKey },
        data: { paused: true },
      });
      await this.graphs.setActive(tenantId, environmentId, workflowKey, false);
    } else {
      await this.graphs.setActive(tenantId, environmentId, workflowKey, true);
      for (const r of rows) await this.pauseHandle(r.id, false);
      await getPrisma().schedule.updateMany({
        where: { tenantId, environmentId, workflowKey },
        data: { paused: false },
      });
    }
  }

  /**
   * One-time boot reconcile (env-scoped-schedules cutover): migrate every Schedule row still
   * carrying a LEGACY (no-env) Temporal id to the new env-scoped identity. Detectable because
   * the migration backfilled `environmentId` on every row while the string id kept its old
   * format — a legacy id never contains the row's env id (a uuid). Per row:
   *  - auto poll/cron ids: re-run the sync (creates the new-format Temporal schedule + row,
   *    deletes the legacy Temporal schedule), then drop the legacy row;
   *  - user-created `sched-` ids: recreate under a new-format id from the CURRENT latest
   *    snapshot (acceptable snapshot refresh for a one-time migration), preserving cron +
   *    paused, then delete the legacy Temporal schedule + row.
   * Idempotent (a second run finds no legacy rows) and per-row best-effort — one bad row must
   * not strand the rest. Callers (ScheduleReconcileService) must treat a thrown error as
   * "Temporal/DB unavailable — warn, don't block boot"; the sync-time legacy deletes are the
   * safety net.
   */
  async reconcileLegacyScheduleIds(): Promise<ReconcileResult> {
    const rows = await getPrisma().schedule.findMany();
    const legacy = rows.filter((r) => !r.id.includes(r.environmentId));
    let migrated = 0;
    let failed = 0;
    for (const row of legacy) {
      try {
        if (row.id.startsWith("poll-") || row.id.startsWith("cron-")) {
          const snapshot = await this.graphs.getLatest(
            row.tenantId,
            row.environmentId,
            row.workflowKey,
          );
          if (snapshot) {
            // Recreates under the new id AND deletes the legacy Temporal schedule + row
            // (clearLegacySchedule inside the sync). No-ops if the graph's start node is no
            // longer the matching trigger type — the explicit cleanup below still runs.
            if (row.id.startsWith("poll-")) {
              await this.syncPollSchedule(
                row.tenantId,
                row.environmentId,
                row.workflowKey,
                snapshot.graph,
              );
            } else {
              await this.syncCronSchedule(
                row.tenantId,
                row.environmentId,
                row.workflowKey,
                snapshot.graph,
              );
            }
          }
          // Orphan (graph gone) or non-trigger graph: make sure the legacy schedule + row die.
          await this.clearLegacySchedule(row.id);
        } else {
          await this.recreateUserSchedule(row);
        }
        migrated++;
      } catch {
        failed++;
      }
    }
    return { migrated, failed };
  }

  /** Recreate a user-created (sched-) legacy schedule under the env-scoped id, preserving its
   *  cron + paused state; pins the CURRENT latest snapshot (one-time migration trade-off).
   *  The new id is DETERMINISTIC (the legacy id's uuid suffix is reused), so a concurrent
   *  boot on another replica — or a crash-retry after a partial run — converges on the SAME
   *  schedule instead of minting duplicates that would double-fire the user's cron. */
  private async recreateUserSchedule(row: {
    id: string;
    tenantId: string;
    environmentId: string;
    workflowKey: string;
    cron: string;
    paused: boolean;
    createdAt: Date;
  }): Promise<void> {
    const { tenantId, environmentId, workflowKey } = row;
    const snapshot = await this.graphs.getLatest(
      tenantId,
      environmentId,
      workflowKey,
    );
    if (snapshot) {
      // Legacy format: `sched-${tenantId}-${workflowKey}-${uuid8}` — carry the suffix over.
      const id = `sched-${tenantId}-${environmentId}-${workflowKey}-${row.id.slice(-8)}`;
      try {
        await this.client.schedule.create({
          scheduleId: id,
          spec: { cronExpressions: [row.cron] },
          action: await this.startWorkflowAction(
            "schedrun",
            { tenantId, environmentId, workflowKey },
            snapshot,
          ),
        });
      } catch (e) {
        // Deterministic id: "already exists" (another replica won the race, or a prior
        // partial run got this far) is convergence, not failure. Anything else propagates
        // so the row counts as failed and the legacy schedule is left for the next boot.
        const exists = await this.client.schedule
          .getHandle(id)
          .describe()
          .then(() => true)
          .catch(() => false);
        if (!exists) throw e;
      }
      const paused =
        row.paused ||
        !(await this.graphs.isActive(tenantId, environmentId, workflowKey));
      if (paused) await this.pauseHandle(id, true);
      await getPrisma().schedule.upsert({
        where: { id },
        create: {
          id,
          tenantId,
          environmentId,
          workflowKey,
          cron: row.cron,
          paused,
          // Preserve the original creation time — the list sorts by it.
          createdAt: row.createdAt,
        },
        update: { cron: row.cron, paused },
      });
    }
    // Orphan (graph gone) → no recreation; either way the legacy identity dies.
    await this.clearLegacySchedule(row.id);
  }

  /**
   * The shared startWorkflow action all four schedule kinds fire: same runGraph workflow as a
   * manual run, graph SNAPSHOT pinned, env threaded into the run ctx so scheduled runs land in
   * their environment (env-scoped creds/secrets/notifications/poll cursors). One builder so a
   * new run-ctx field can't be added to one schedule kind and missed in another.
   *
   * THERE IS DELIBERATELY NO `input` PARAMETER (#991). A schedule carries no trigger data —
   * nothing arrives when a cron fires — so EVERY scheduled run starts with `{}`, whatever the
   * graph declares. `sampleInput` is the MANUAL-run default and only that (`startExecution`
   * resolves `body.input → sampleInput → {}`), which is what the canvas has always promised the
   * author: *"Only used when you run this manually."*
   *
   * This used to be a parameter, and the four call sites disagreed about it: `create` and the
   * legacy reconcile passed `startSampleInput(graph) ?? {}` while the cron/poll syncs passed a
   * literal `{}` — so one graph's two schedules could start the same run with two different
   * inputs (#991; #982 claimed all four already agreed, they didn't). Deleting the parameter is
   * what keeps them equal — a property of the signature, not of four call sites remembering.
   *
   * Do not add it back. Feeding `sampleInput` to a schedule would INVERT #979: a production 9am
   * firing would carry whatever an author typed into a field labelled "sample input", which is
   * precisely the "manual run gets data the real trigger never sends" bug #979 fixed, only aimed
   * at production instead of the test run. Parameterizing a scheduled run is a legitimate want,
   * but it is a real `Schedule.input` column with its own UI — not the graph's test data.
   */
  private async startWorkflowAction(
    runIdPrefix: "schedrun" | "pollrun" | "cronrun",
    scope: { tenantId: string; environmentId: string; workflowKey: string },
    snapshot: GraphSnapshot,
  ): Promise<ScheduleOptionsAction> {
    const { tenantId, environmentId, workflowKey } = scope;
    const budget = await getBudget(tenantId);
    return {
      type: "startWorkflow",
      workflowType: RUN_GRAPH_WORKFLOW,
      taskQueue: TASK_QUEUE,
      // Temporal appends the scheduled time to make each run's id unique.
      workflowId: `${runIdPrefix}-${tenantId}-${environmentId}-${workflowKey}`,
      args: [
        snapshot.graph,
        // A fresh literal per action, never a shared const: this object is handed to the Temporal
        // client and a shared one could be mutated for every schedule at once.
        {},
        {
          tenantId,
          environmentId,
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
    };
  }

  /** Best-effort delete of a legacy (no-env) schedule: the Temporal handle AND its DB row.
   *  Unguarded — reconcile-only (the caller has already established the row is legacy). */
  private async clearLegacySchedule(legacyId: string): Promise<void> {
    await this.deleteHandleQuiet(legacyId);
    await getPrisma()
      .schedule.deleteMany({ where: { id: legacyId } })
      .catch(() => undefined);
  }

  /**
   * Ownership-guarded legacy cleanup for the sync/teardown safety net. The legacy no-env id is
   * a SINGLE shared namespace per (tenant, workflowKey) and the migration assigned its row to
   * the DEFAULT env — so only the env that owns the row may clear it. Without the guard, a
   * sandbox save/delete would kill the default env's not-yet-reconciled schedule (and its row,
   * making the loss permanent). A row-less Temporal handle is an orphan that can still be
   * firing env-less — always deleted.
   */
  private async clearLegacyScheduleIfOwned(
    legacyId: string,
    environmentId: string,
  ): Promise<void> {
    let row: { environmentId: string } | null;
    try {
      row = await getPrisma().schedule.findUnique({
        where: { id: legacyId },
        select: { environmentId: true },
      });
    } catch {
      return; // DB hiccup — leave the legacy id to the boot reconcile
    }
    if (!row) {
      await this.deleteHandleQuiet(legacyId); // orphan handle, no registry row
      return;
    }
    if (row.environmentId !== environmentId) return; // another env owns it — don't cross envs
    await this.clearLegacySchedule(legacyId);
  }

  /** Delete a Temporal schedule handle, swallowing NotFound/any failure (idempotent cleanup). */
  private async deleteHandleQuiet(id: string): Promise<void> {
    try {
      await this.client.schedule.getHandle(id).delete();
    } catch {
      /* no such schedule */
    }
  }

  /** Pause/unpause a Temporal schedule by id. Tolerates a genuinely-missing schedule (a Schedule
   *  row without a live Temporal schedule — the same inconsistency `list()` tolerates) but RE-RAISES
   *  a real failure: a deactivation that couldn't actually pause must fail loudly, not report
   *  success while the schedule keeps firing (the schedule/poll path has no other gate). */
  private async pauseHandle(id: string, paused: boolean): Promise<void> {
    const handle = this.client.schedule.getHandle(id);
    try {
      if (paused) await handle.pause("workflow deactivated");
      else await handle.unpause("workflow activated");
    } catch (e) {
      // Distinguish "schedule doesn't exist" (tolerable) from a real error by probing describe():
      // if describe ALSO fails the schedule is gone (nothing to pause); otherwise it exists and the
      // pause genuinely failed — propagate so the caller (setActive) doesn't falsely succeed.
      const gone = await handle
        .describe()
        .then(() => false)
        .catch(() => true);
      if (gone) return;
      throw e;
    }
  }

  async setPaused(
    tenantId: string,
    id: string,
    paused: boolean,
  ): Promise<void> {
    const row = await this.assertOwner(tenantId, id);
    // Don't let the per-schedule RESUME route re-arm a workflow that's been DEACTIVATED in the
    // schedule's env — that would restart an automatic recurring trigger while the activation flag
    // still says inactive (schedules fire straight to the worker with no gate). Reactivate the
    // workflow instead.
    if (
      !paused &&
      !(await this.graphs.isActive(
        tenantId,
        row.environmentId,
        row.workflowKey,
      ))
    ) {
      throw new ConflictException(
        "Workflow is inactive — reactivate it to resume its schedules",
      );
    }
    const handle = this.client.schedule.getHandle(id);
    if (paused) await handle.pause("paused via API");
    else await handle.unpause("resumed via API");
    await getPrisma().schedule.update({ where: { id }, data: { paused } });
  }

  /** Fire the schedule's workflow immediately (in addition to its cron). Refused when the workflow
   *  is deactivated in the schedule's env (this is the schedule's automatic action — use a manual
   *  run to test instead). */
  async trigger(tenantId: string, id: string): Promise<void> {
    const row = await this.assertOwner(tenantId, id);
    if (
      !(await this.graphs.isActive(
        tenantId,
        row.environmentId,
        row.workflowKey,
      ))
    ) {
      throw new ConflictException(
        "Workflow is inactive — reactivate it to trigger its schedule",
      );
    }
    await this.client.schedule.getHandle(id).trigger();
  }

  private async assertOwner(
    tenantId: string,
    id: string,
  ): Promise<{ workflowKey: string; environmentId: string }> {
    const row = await getPrisma().schedule.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Schedule not found");
    if (row.tenantId !== tenantId) {
      throw new ForbiddenException("Schedule belongs to another tenant");
    }
    return { workflowKey: row.workflowKey, environmentId: row.environmentId };
  }
}

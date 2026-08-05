import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { getPrisma } from "@naary/db";
import type { GraphDef } from "@naary/dsl";
import { TracedClass } from "@naary/observability";
import type { Principal } from "../auth/tenant.decorator";
import { PermissionsService } from "../permissions/permissions.service";
import { SchedulesService } from "../schedules/schedules.service";
import { GraphsService } from "./graphs.service";

/**
 * A workflow key is `[a-z0-9]` words joined by single hyphens — exactly what the canvas' `slugify`
 * produces (apps/web/src/screens/canvas/flow.tsx). Enforced HERE and only here: existing keys were
 * never server-validated (POST /graphs still takes any string), so applying the rule retroactively
 * would break saves; applying it to the rename target means every key minted from today on is
 * URL-safe, schedule-id-safe and MCP-tool-name-safe.
 */
const KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_KEY_LENGTH = 64;

/** How long the rewrite may take. Prisma's default interactive-transaction budget is 5s, which the
 *  `Execution` updateMany can exceed on a workflow with a long run history. */
const RENAME_TRANSACTION_MS = 30_000;

export interface RenameKeyResult {
  workflowKey: string;
  previousKey: string;
  /** Every retired key that now resolves to `workflowKey` (this rename's, plus any earlier ones). */
  aliases: string[];
}

/**
 * Rename a workflow's KEY, keeping the old key resolvable (#904).
 *
 * ## Rewrite what we own; alias what we don't
 *
 * `workflowKey` is a DENORMALIZED string in ~18 tables with no foreign key, so nothing cascades. The
 * rename therefore REWRITES every one of those rows in a single transaction — which is why run
 * history, schedules, pins, tags, grants, evals and the webhook/form/chat endpoints all simply
 * FOLLOW the workflow with no read-path changes anywhere.
 *
 * What it cannot rewrite is everything that holds the key OUTSIDE our database:
 *   - `executeSubWorkflow.workflowKey` / `forEach.workflowKey` in OTHER graphs' node configs,
 *   - MCP tool names + `run_workflow` arguments in external agents' configs,
 *   - the args of in-flight Temporal runs and already-armed schedule handles,
 *   - public-API / `naary` CLI callers and bookmarked canvas URLs.
 * Those keep working because the old key is registered as an ALIAS and every lookup resolves
 * through it (`resolveWorkflowKey` in `@naary/db`, shared by the API and the worker).
 *
 * ## Why the public URLs were never at risk
 *
 * A registered webhook/form/chat URL carries the endpoint's OPAQUE uuid, not the workflow key — the
 * key only lives in the row's `workflowId` column, which this rewrite updates. A third party's URL
 * is byte-identical before and after.
 */
@Injectable()
@TracedClass()
export class WorkflowKeyRenameService {
  constructor(
    private readonly graphs: GraphsService,
    private readonly schedules: SchedulesService,
    @Optional() private readonly permissions?: PermissionsService,
  ) {}

  /**
   * @param workflowKey the key to rename — may itself be a retired alias.
   * @param newKey the key to move to.
   * @param actor the user-facing caller; `edit` is asserted in EVERY environment that holds a
   *  definition under this key (see the §4 note on the permission choice, below).
   */
  async rename(
    tenantId: string,
    workflowKey: string,
    newKey: string,
    actor?: Principal,
  ): Promise<RenameKeyResult> {
    const p = getPrisma();
    const target = newKey.trim();
    if (!KEY_RE.test(target) || target.length > MAX_KEY_LENGTH) {
      throw new BadRequestException(
        `'${target}' is not a valid workflow key — use lowercase letters, digits and single hyphens (max ${MAX_KEY_LENGTH} characters).`,
      );
    }
    // Rename BY a retired key too: an old bookmark / CLI script must be able to drive the rename.
    const current = await this.graphs.liveKey(tenantId, workflowKey);
    if (current === target) {
      throw new BadRequestException(
        "That is already this workflow's key — nothing to rename.",
      );
    }

    // Every environment that holds a definition under this key. The rename is TENANT-WIDE (a key is
    // one logical identity that copy-on-promote replicates per env), so a partial rename would leave
    // sandbox and prod disagreeing and would break the next promote.
    const envRows = await p.graphDefinition.findMany({
      where: { tenantId, workflowKey: current },
      distinct: ["environmentId"],
      select: { environmentId: true },
    });
    if (envRows.length === 0) {
      throw new NotFoundException(`No workflow '${workflowKey}'`);
    }
    const envIds = envRows.map((r) => r.environmentId);

    // §4 permission: `edit`, in EVERY env the key exists in.
    //
    // `edit` (not `delete`/`share`, not owner/admin) is defensible precisely BECAUSE this is an
    // alias and not a hard rename: no external reference breaks, and `WorkflowGrantKey` + the
    // tag-derived key list are rewritten in the SAME transaction, so nobody gains or loses access.
    // That is the direct rebuttal to §4's tag-escalation precedent ("an edit-only member could grant
    // themselves access just by tagging"): here the grants move WITH the workflow, in lockstep.
    // Requiring it per-env is what stops a sandbox-only editor from renaming prod's copy.
    if (actor) {
      if (!this.permissions) {
        // Fail CLOSED: an actor implies a user-facing call site — authz must run.
        throw new Error(
          "WorkflowKeyRenameService: PermissionsService is not wired",
        );
      }
      for (const environmentId of envIds) {
        await this.permissions.assertCan(actor, "edit", current, environmentId);
      }
    }

    await this.assertKeyAvailable(tenantId, target);

    // The auto poll/cron schedule ids are DERIVED from the key
    // (`poll-${tenantId}-${environmentId}-${workflowKey}`), so their rows cannot simply be
    // rewritten: the row would keep an id whose handle the next `syncPollSchedule` no longer
    // recomputes, and the sync would create a SECOND handle — double firing. They are dropped here
    // and recreated under the new id below. User-created `sched-` rows keep their random id and are
    // merely re-pointed: their id embeds the old key only cosmetically, every operation on them goes
    // through the stored `id`, and their start args resolve through the alias.
    const autoSchedules = await p.schedule.findMany({
      where: { tenantId, workflowKey: current },
      select: { id: true, environmentId: true },
    });
    const autoScheduleIds = autoSchedules
      .filter((s) => s.id.startsWith("poll-") || s.id.startsWith("cron-"))
      .map((s) => s.id);

    const move = { workflowKey: target };
    const byKey = { tenantId, workflowKey: current };
    try {
      await p.$transaction(
        async (tx) => {
          // Re-assert availability INSIDE the transaction: the check above is a fast, friendly
          // pre-flight, this one is the one that counts. (Residual race: two renames targeting the
          // same new key in the same tenant within the same instant can both pass under Postgres'
          // default READ COMMITTED. It cannot corrupt anything — the loser simply merges into the
          // winner's key — and there is no constraint to express it with, because GraphDefinition
          // is versioned and so has no unique on (tenantId, workflowKey).)
          const taken = await tx.graphDefinition.findFirst({
            where: { tenantId, workflowKey: target },
            select: { workflowKey: true },
          });
          if (taken) {
            throw new ConflictException(
              `A workflow already uses the key '${target}'.`,
            );
          }

          // --- the definition + its authoring/runtime rows -----------------------------------
          await tx.graphDefinition.updateMany({ where: byKey, data: move });
          await tx.workflowActivation.updateMany({ where: byKey, data: move });
          await tx.pinnedData.updateMany({ where: byKey, data: move });
          await tx.pollState.updateMany({ where: byKey, data: move });
          await tx.evalDataset.updateMany({ where: byKey, data: move });
          await tx.evalRun.updateMany({ where: byKey, data: move });
          await tx.selfHealSetting.updateMany({ where: byKey, data: move });
          await tx.workflowFixProposal.updateMany({ where: byKey, data: move });
          await tx.builderSession.updateMany({ where: byKey, data: move });
          // The error-handler binding points BOTH ways: this workflow's handler, and every other
          // workflow that nominates THIS one as its handler.
          await tx.errorHandler.updateMany({ where: byKey, data: move });
          await tx.errorHandler.updateMany({
            where: { tenantId, errorWorkflowKey: current },
            data: { errorWorkflowKey: target },
          });

          // --- history: run + eval + promotion lineage FOLLOW the workflow --------------------
          // Decision 2 in the issue. An alias means this is the SAME entity under a new name, so
          // its history is its own. Rewriting `Execution.workflowKey` (rather than alias-expanding
          // every read) is what makes the run list, the run detail, the data search, the RBAC run
          // filter, the per-workflow rollups and the cost insights all follow with ZERO read-path
          // changes. UsageEvent needs nothing: it has no workflowKey — usage joins via Execution.
          await tx.execution.updateMany({ where: byKey, data: move });
          await tx.promotion.updateMany({ where: byKey, data: move });

          // --- tags + permission grants (both are TENANT-wide, not env-scoped) ----------------
          await tx.workflowTag.updateMany({ where: byKey, data: move });
          // WorkflowGrantKey has no tenantId column — it hangs off a grant, which hangs off a
          // group, which is the tenant's. Resolve the tenant's grant ids FIRST and filter the write
          // by a plain `in`, rather than putting a two-hop relation filter inside an `updateMany`:
          // same tenant-scoping guarantee, but expressed as an ordinary column predicate that
          // cannot depend on relation-filter support in a write.
          const grantIds = (
            await tx.workflowGrant.findMany({
              where: { group: { tenantId } },
              select: { id: true },
            })
          ).map((g) => g.id);
          if (grantIds.length > 0) {
            await tx.workflowGrantKey.updateMany({
              where: { workflowKey: current, grantId: { in: grantIds } },
              data: move,
            });
          }

          // --- trigger endpoints (the column is `workflowId`, not `workflowKey`) --------------
          // The PUBLIC URL is the endpoint's opaque uuid and is untouched: a webhook/form/chat URL
          // already handed to a third party keeps working, byte-identical.
          const byWorkflowId = { tenantId, workflowId: current };
          const moveWorkflowId = { workflowId: target };
          await tx.webhookEndpoint.updateMany({
            where: byWorkflowId,
            data: moveWorkflowId,
          });
          await tx.formEndpoint.updateMany({
            where: byWorkflowId,
            data: moveWorkflowId,
          });
          await tx.chatEndpoint.updateMany({
            where: byWorkflowId,
            data: moveWorkflowId,
          });

          // --- schedules ---------------------------------------------------------------------
          await tx.schedule.deleteMany({
            where: { tenantId, id: { in: autoScheduleIds } },
          });
          await tx.schedule.updateMany({ where: byKey, data: move });

          // --- the alias itself ---------------------------------------------------------------
          // Keep aliases ONE HOP deep: everything that already resolved to the old key is
          // re-pointed at the new one, so `resolveWorkflowKey` never has to walk a chain.
          await tx.workflowKeyAlias.updateMany({
            where: { tenantId, workflowKey: current },
            data: move,
          });
          await tx.workflowKeyAlias.create({
            data: {
              tenantId,
              alias: current,
              workflowKey: target,
              createdBy: actor
                ? (actor.email ?? actor.subject ?? "api-token")
                : null,
            },
          });
        },
        { timeout: RENAME_TRANSACTION_MS },
      );
    } catch (e) {
      // ONLY a real constraint violation becomes a 409: a composite-PK clash (an orphan row already
      // sitting under the target key) is the collision this message describes. Everything else — the
      // transaction budget above, a dropped connection, a Prisma validation error — propagates
      // untouched, because telling someone to "pick a different key" when the write actually TIMED
      // OUT is the wrong diagnostic on precisely the failure mode this rewrite is most likely to
      // hit. The transaction rolled back either way, so the workflow is untouched.
      const code = (e as { code?: string } | null)?.code;
      if (code === "P2002" || code === "P2003") {
        throw new ConflictException(
          `Could not rename '${current}' to '${target}' — something already occupies that key. ` +
            "Pick a different key.",
        );
      }
      throw e;
    }

    // The cached scope='selected' key list (WorkflowGrantKey ∪ tag-carried keys) still holds the
    // OLD key. Without this a restricted member would be 403'd on the NEW key for the cache's TTL —
    // alias resolution cannot fix that, because the new key resolves to itself. Mirrors every
    // group/grant write in GroupsService.
    this.permissions?.invalidateTenant(tenantId);

    // Rebuild the derived Temporal schedule handles, NEW FIRST then old (below). A duplicate tick in
    // the overlap is harmless — the old handle's args carry the old key, which resolves through the
    // alias to the same workflow AND the same PollState cursor row (rewritten above), so a poll
    // trigger re-dedupes exactly as it would have. A GAP would not be harmless, hence the ordering.
    // Best-effort per env, like every other schedule side effect: a Temporal hiccup must not fail a
    // rename that is already durable.
    for (const environmentId of envIds) {
      const snapshot = await this.graphs
        .getLatest(tenantId, environmentId, target)
        .catch(() => null);
      if (!snapshot) continue;
      await this.syncDerivedSchedules(
        tenantId,
        environmentId,
        target,
        snapshot.graph,
      );
    }
    // Now retire the old handles. `teardownForWorkflow` reconstructs the derived ids from the key,
    // so passing the OLD key kills exactly `poll-…-<old>` / `cron-…-<old>` (plus the legacy no-env
    // shapes); its row-level deletes are no-ops because nothing carries the old key any more, which
    // is why the user-created `sched-` rows and their live handles survive untouched.
    for (const environmentId of envIds) {
      await this.schedules
        .teardownForWorkflow(tenantId, environmentId, current)
        .catch(() => undefined);
    }

    return {
      workflowKey: target,
      previousKey: current,
      aliases: (
        await p.workflowKeyAlias.findMany({
          where: { tenantId, workflowKey: target },
          select: { alias: true },
          orderBy: { createdAt: "asc" },
        })
      ).map((r) => r.alias),
    };
  }

  /**
   * 409 unless `key` is free for this tenant: not a live workflow in ANY environment, and not a
   * retired alias of another workflow.
   *
   * The second half is the answer to "what if someone later creates a NEW workflow whose derived key
   * equals a retired alias" — see also `GraphsService.upsert`, which rejects rather than silently
   * resolving such a save onto the aliased workflow.
   */
  private async assertKeyAvailable(
    tenantId: string,
    key: string,
  ): Promise<void> {
    const p = getPrisma();
    const [live, alias] = await Promise.all([
      p.graphDefinition.findFirst({
        where: { tenantId, workflowKey: key },
        select: { workflowKey: true },
      }),
      p.workflowKeyAlias.findUnique({
        where: { tenantId_alias: { tenantId, alias: key } },
        select: { workflowKey: true },
      }),
    ]);
    if (live) {
      throw new ConflictException(`A workflow already uses the key '${key}'.`);
    }
    if (alias) {
      throw new ConflictException(
        `The key '${key}' is retired — it still resolves to '${alias.workflowKey}'. ` +
          "Delete that workflow to free the key, or pick a different one.",
      );
    }
  }

  /** The two DERIVED-id schedules a trigger graph owns, re-created under the new key. Deliberately
   *  built from SchedulesService's EXISTING public surface only — the rename adds no code to that
   *  file. Both no-op when the graph's entry node isn't the matching trigger type. */
  private async syncDerivedSchedules(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
    graph: GraphDef,
  ): Promise<void> {
    await this.schedules
      .syncPollSchedule(tenantId, environmentId, workflowKey, graph)
      .catch(() => undefined);
    await this.schedules
      .syncCronSchedule(tenantId, environmentId, workflowKey, graph)
      .catch(() => undefined);
    await this.schedules
      .syncKafkaSchedule(tenantId, environmentId, workflowKey, graph)
      .catch(() => undefined);
    await this.schedules
      .syncMqttSchedule(tenantId, environmentId, workflowKey, graph)
      .catch(() => undefined);
  }
}

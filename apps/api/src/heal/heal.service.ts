/**
 * Self-healing (Phase 2): the per-workflow opt-in, the proposal inbox, and the decision path.
 *
 * THE APPLY LIVES HERE, not in the workflow, and that is the load-bearing design choice. Approving
 * a proposal writes a new workflow version, and `graphs.save()` already owns everything that
 * means: the §4 save gate (which enforces `edit` on the actor), the content hash, the version
 * increment, `savedBy`, and the form-asset ownership check. Re-implementing any of that next to a
 * Temporal activity would be a second copy of the most consequential write in the product — and
 * this codebase already shows what that costs, with HMAC approval-token minting duplicated in two
 * files, each commented "must match" the other.
 *
 * So authorization is not re-derived here: it is inherited by calling the same function a manual
 * save calls, with the same principal. A user who may approve a RUN does not thereby gain the
 * ability to rewrite a workflow.
 */
import {
  ConflictException,
  Injectable,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { Client, Connection } from "@temporalio/client";
import { healDecisionSignal, type HealDecisionInput } from "@naary/contracts";
import { getPrisma, resolveWorkflowKey } from "@naary/db";
import type { GraphDef } from "@naary/dsl";
import { connectTemporal } from "../temporal/client";
import type { Principal } from "../auth/tenant.decorator";
import { GraphsService } from "../graphs/graphs.service";
import { GraphGeneratorService } from "../graphs/graph-generator.service";
import { PermissionsService } from "../permissions/permissions.service";
import { NotificationsService } from "../notifications/notifications.service";
import { startHealWorker, type HealWorkerHandle } from "./heal-worker";

export interface FixProposalView {
  id: string;
  workflowKey: string;
  runId: string;
  failureSummary: string;
  baseVersion: number;
  diffSummary: { add: number; chg: number; del: number; total: number };
  status: string;
  appliedVersion: number | null;
  createdAt: string;
}

@Injectable()
export class HealService implements OnModuleInit, OnModuleDestroy {
  private client!: Client;
  private connection!: Connection;
  private worker: HealWorkerHandle | null = null;

  constructor(
    private readonly graphs: GraphsService,
    private readonly generator: GraphGeneratorService,
    private readonly perms: PermissionsService,
    private readonly notifications: NotificationsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const { client, connection } = await connectTemporal();
    this.client = client;
    this.connection = connection;
    // Fail-soft by construction: startHealWorker returns null rather than throwing, so a Temporal
    // problem stops proposals being generated without stopping the API from serving.
    this.worker = await startHealWorker({
      graphs: this.graphs,
      generator: this.generator,
      client,
      // The real notifier. Until this was wired, `notifyProposal` only logged — so a proposal
      // was discoverable solely by visiting the inbox, which is a poor property for a feature
      // whose whole premise is telling you something broke.
      notify: async (proposalId) => {
        const row = await getPrisma().workflowFixProposal.findUnique({
          where: { id: proposalId },
          select: {
            tenantId: true,
            environmentId: true,
            workflowKey: true,
            failureSummary: true,
          },
        });
        if (!row) return;
        await this.notifications.sendFixProposal(
          row.tenantId,
          row.environmentId,
          {
            workflowKey: row.workflowKey,
            failureSummary: row.failureSummary,
            proposalId,
          },
        );
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.shutdown().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }

  // ── opt-in ────────────────────────────────────────────────────────────────────────────────

  async isEnabled(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
  ): Promise<boolean> {
    // Composite-PK read: a retired key returns null, which reads as "self-healing is off" rather
    // than as an error — resolve before the lookup (#904).
    const row = await getPrisma().selfHealSetting.findUnique({
      where: {
        tenantId_environmentId_workflowKey: {
          tenantId,
          environmentId,
          workflowKey: await resolveWorkflowKey(tenantId, workflowKey),
        },
      },
      select: { enabled: true },
    });
    return row?.enabled === true;
  }

  /** Turning self-healing on for a workflow is an EDIT of that workflow's behaviour, so it takes
   *  the same permission — not merely `run`. */
  async setEnabled(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
    enabled: boolean,
    actor?: Principal,
  ): Promise<{ enabled: boolean }> {
    // `edit`, not `run`: switching self-healing on changes what the workflow does when it fails,
    // and authorizes spending the tenant's model budget on it. Checked through PermissionsService
    // directly — GraphsService's own `assertActor` wrapper is private, and there is no reason for
    // this to go through the graph service at all.
    const key = await resolveWorkflowKey(tenantId, workflowKey);
    if (actor) {
      await this.perms.assertCan(actor, "edit", key, environmentId);
    }
    await getPrisma().selfHealSetting.upsert({
      where: {
        tenantId_environmentId_workflowKey: {
          tenantId,
          environmentId,
          workflowKey: key,
        },
      },
      create: { tenantId, environmentId, workflowKey: key, enabled },
      update: { enabled },
    });
    return { enabled };
  }

  // ── the inbox ─────────────────────────────────────────────────────────────────────────────

  async list(
    tenantId: string,
    environmentId: string,
    status = "pending",
  ): Promise<FixProposalView[]> {
    const rows = await getPrisma().workflowFixProposal.findMany({
      where: { tenantId, environmentId, status },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return rows.map((r) => this.toView(r));
  }

  /** One proposal, with the PROPOSED GRAPH — the reviewer needs it to see the diff. */
  async get(
    tenantId: string,
    id: string,
  ): Promise<FixProposalView & { proposedGraph: GraphDef }> {
    const row = await this.owned(tenantId, id);
    return {
      ...this.toView(row),
      proposedGraph: row.proposedGraph as unknown as GraphDef,
    };
  }

  // ── the decision ──────────────────────────────────────────────────────────────────────────

  /**
   * Approve a proposal: write the fix, then tell the workflow it can stop waiting.
   *
   * STALENESS IS CHECKED AGAINST THE LIVE LATEST, not against a flag. Approval can arrive days
   * after the proposal was generated, and in that time the workflow may have been edited by hand.
   * Applying then would silently revert those edits — a self-healing feature that eats a
   * colleague's work is worse than one that occasionally asks you to re-run it. The row is marked
   * `stale` and the caller is told which versions disagree.
   */
  async approve(
    tenantId: string,
    id: string,
    actor?: Principal,
  ): Promise<{ status: string; appliedVersion?: number }> {
    const row = await this.owned(tenantId, id);
    if (row.status !== "pending") {
      throw new ConflictException(
        `This proposal is already ${row.status}; it can't be approved again.`,
      );
    }

    const latest = await this.graphs.getLatest(
      tenantId,
      row.environmentId,
      row.workflowKey,
    );
    if (!latest) {
      await this.close(id, "stale", actor);
      throw new ConflictException(
        "That workflow no longer exists, so this fix can't be applied.",
      );
    }
    if (latest.version !== row.baseVersion) {
      await this.close(id, "stale", actor);
      throw new ConflictException(
        `This fix was written against v${row.baseVersion}, but the workflow is now ` +
          `v${latest.version}. Applying it would discard the changes made since, so it has been ` +
          `marked stale — re-run the fix against the current version.`,
      );
    }

    // The workflow's CURRENT display name. `GraphSnapshot` carries only {graph, contentHash,
    // version}, and `upsert` needs a name — passing the key instead would silently rename the
    // workflow to its slug the first time a fix was ever approved.
    const named = await getPrisma().graphDefinition.findFirst({
      where: {
        tenantId,
        environmentId: row.environmentId,
        workflowKey: row.workflowKey,
      },
      orderBy: { version: "desc" },
      select: { name: true },
    });

    // CLAIM THE PROPOSAL BEFORE WRITING ANYTHING.
    //
    // The first version read `status === "pending"`, wrote the version, and only THEN recorded the
    // decision — so two reviewers clicking at once both read pending, both called upsert(), and one
    // proposal produced two workflow versions. My own test covered "already decided is refused",
    // which is the sequential case and says nothing about the concurrent one; review caught it.
    //
    // `updateMany` with `status: "pending"` in the WHERE is a compare-and-set: exactly one caller
    // can transition the row, and `count` says whether it was us. The intermediate `applying` state
    // exists so a crash between here and the save leaves a row that is visibly stuck rather than
    // one that looks decided.
    const claimed = await getPrisma().workflowFixProposal.updateMany({
      where: { id, status: "pending" },
      data: { status: "applying" },
    });
    if (claimed.count !== 1) {
      throw new ConflictException(
        "Someone else is deciding this proposal right now — reload to see the outcome.",
      );
    }

    // The real save path: `edit` gate, content hash, version increment, savedBy. Nothing about
    // authorization is decided here — it is decided there, by the same code a manual save uses.
    let saved: { version: number };
    try {
      saved = await this.graphs.upsert(
        tenantId,
        row.environmentId,
        row.workflowKey,
        named?.name ?? row.workflowKey,
        row.proposedGraph as unknown as GraphDef,
        actor,
        `Self-healing fix for run ${row.runId}`,
      );
    } catch (err) {
      // The save was refused — most often by the `edit` gate, which is the point of routing
      // through it. Hand the row back so the proposal stays actionable instead of stranded in
      // `applying` forever.
      await getPrisma().workflowFixProposal.updateMany({
        where: { id, status: "applying" },
        data: { status: "pending" },
      });
      throw err;
    }

    await this.finalize(id, "applied", actor, saved.version);
    await this.signal(healWorkflowId(row.runId), {
      approved: true,
      by: actorName(actor),
      appliedVersion: saved.version,
    });
    return { status: "applied", appliedVersion: saved.version };
  }

  async reject(
    tenantId: string,
    id: string,
    actor?: Principal,
  ): Promise<{ status: string }> {
    const row = await this.owned(tenantId, id);
    if (row.status !== "pending") {
      throw new ConflictException(`This proposal is already ${row.status}.`);
    }
    await this.close(id, "rejected", actor);
    await this.signal(healWorkflowId(row.runId), {
      approved: false,
      by: actorName(actor),
    });
    return { status: "rejected" };
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────

  private async owned(tenantId: string, id: string) {
    const row = await getPrisma().workflowFixProposal.findUnique({
      where: { id },
    });
    // Tenant scoping is an existence check, not a 403: a proposal belonging to someone else must
    // not be distinguishable from one that never existed.
    if (!row || row.tenantId !== tenantId) {
      throw new NotFoundException("Proposal not found");
    }
    return row;
  }

  /** Record the outcome of a proposal this caller has already CLAIMED (status `applying`). */
  private async finalize(
    id: string,
    status: string,
    actor?: Principal,
    appliedVersion?: number,
  ): Promise<void> {
    await getPrisma().workflowFixProposal.updateMany({
      where: { id, status: "applying" },
      data: {
        status,
        decidedBy: actorName(actor),
        decidedAt: new Date(),
        ...(appliedVersion !== undefined ? { appliedVersion } : {}),
      },
    });
  }

  private async close(
    id: string,
    status: string,
    actor?: Principal,
    appliedVersion?: number,
  ): Promise<void> {
    // Guarded on `pending` so a decision can never overwrite one already recorded — two reviewers
    // clicking at once must not produce two different outcomes for one proposal.
    await getPrisma().workflowFixProposal.updateMany({
      where: { id, status: "pending" },
      data: {
        status,
        decidedBy: actorName(actor),
        decidedAt: new Date(),
        ...(appliedVersion !== undefined ? { appliedVersion } : {}),
      },
    });
  }

  /** Best-effort: the decision is already recorded in Postgres, which is what the UI reads. An
   *  unreachable workflow only means it waits out its own expiry timer. */
  private async signal(
    workflowId: string,
    payload: HealDecisionInput,
  ): Promise<void> {
    try {
      await this.client.workflow
        .getHandle(workflowId)
        .signal(healDecisionSignal, payload);
    } catch {
      /* the row is the source of truth; the workflow will expire on its own */
    }
  }

  private toView(r: {
    id: string;
    workflowKey: string;
    runId: string;
    failureSummary: string;
    baseVersion: number;
    diffSummary: unknown;
    status: string;
    appliedVersion: number | null;
    createdAt: Date;
  }): FixProposalView {
    return {
      id: r.id,
      workflowKey: r.workflowKey,
      runId: r.runId,
      failureSummary: r.failureSummary,
      baseVersion: r.baseVersion,
      diffSummary: r.diffSummary as FixProposalView["diffSummary"],
      status: r.status,
      appliedVersion: r.appliedVersion,
      createdAt: r.createdAt.toISOString(),
    };
  }
}

/** The heal workflow's id — derived from the run id, exactly as the interpreter derives it when
 *  it starts the child. Both sides compute it the same way rather than storing it. */
function healWorkflowId(runId: string): string {
  return `${runId}-heal`;
}

/** Display identity for the audit trail — never a credential. Mirrors the save path's `savedBy`. */
function actorName(actor?: Principal): string | undefined {
  return actor ? (actor.email ?? actor.subject ?? "api-token") : undefined;
}

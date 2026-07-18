import { Injectable, Optional } from "@nestjs/common";
import { getPrisma, Prisma } from "@naary/db";
import type { Principal } from "../auth/tenant.decorator";
import {
  PermissionsService,
  type WorkflowAction,
} from "../permissions/permissions.service";

/**
 * Pinned node outputs — AUTHORING-ONLY sample data (design SINGLE-NODE-EXECUTION.md §4). A pin
 * lets you build downstream nodes against a saved output without re-running upstream. The
 * interpreter NEVER reads pins — a real run always executes upstream — so a pin can't leak into
 * production. All ops are tenant+env-scoped (Slice 6b): a sandbox pin is invisible to prod.
 * `environmentId` arrives RESOLVED (the controller calls resolveEnvId at the boundary).
 *
 * RBAC (slice G1): pins GET is `view`-gated, pin PUT/DELETE `edit`-gated — for a user-facing
 * actor only. Internal callers (the single-node test's autofill writes) pass no actor: the
 * test route asserted `run` at its own boundary.
 */
@Injectable()
export class PinsService {
  constructor(@Optional() private readonly permissions?: PermissionsService) {}

  private async assertActor(
    actor: Principal | undefined,
    action: WorkflowAction,
    workflowKey: string,
    environmentId: string,
  ): Promise<void> {
    if (!actor) return;
    if (!this.permissions) {
      // Fail CLOSED: an actor implies a user-facing call site — authz must run.
      throw new Error("PinsService: PermissionsService is not wired");
    }
    await this.permissions.assertCan(actor, action, workflowKey, environmentId);
  }

  /** All pins for a workflow in this env, as `{ [nodeId]: output }` (what the canvas overlays). */
  async list(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
    actor?: Principal,
  ): Promise<Record<string, unknown>> {
    await this.assertActor(actor, "view", workflowKey, environmentId);
    const rows = await getPrisma().pinnedData.findMany({
      where: { tenantId, environmentId, workflowKey },
      select: { nodeId: true, output: true },
    });
    return Object.fromEntries(rows.map((r) => [r.nodeId, r.output]));
  }

  /** Pin (or replace) a node's sample output in this env. Edit-gated for a user actor. */
  async set(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
    nodeId: string,
    output: unknown,
    actor?: Principal,
  ): Promise<void> {
    await this.assertActor(actor, "edit", workflowKey, environmentId);
    const value = output as Prisma.InputJsonValue;
    await getPrisma().pinnedData.upsert({
      where: {
        tenantId_environmentId_workflowKey_nodeId: {
          tenantId,
          environmentId,
          workflowKey,
          nodeId,
        },
      },
      create: { tenantId, environmentId, workflowKey, nodeId, output: value },
      update: { output: value },
    });
  }

  /** Clear a node's pin in this env. Returns true if one existed. Edit-gated for a user actor. */
  async clear(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
    nodeId: string,
    actor?: Principal,
  ): Promise<boolean> {
    await this.assertActor(actor, "edit", workflowKey, environmentId);
    const res = await getPrisma().pinnedData.deleteMany({
      where: { tenantId, environmentId, workflowKey, nodeId },
    });
    return res.count > 0;
  }
}

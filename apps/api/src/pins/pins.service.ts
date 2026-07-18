import { Injectable } from "@nestjs/common";
import { getPrisma, Prisma } from "@naary/db";

/**
 * Pinned node outputs — AUTHORING-ONLY sample data (design SINGLE-NODE-EXECUTION.md §4). A pin
 * lets you build downstream nodes against a saved output without re-running upstream. The
 * interpreter NEVER reads pins — a real run always executes upstream — so a pin can't leak into
 * production. All ops are tenant+env-scoped (Slice 6b): a sandbox pin is invisible to prod.
 * `environmentId` arrives RESOLVED (the controller calls resolveEnvId at the boundary).
 */
@Injectable()
export class PinsService {
  /** All pins for a workflow in this env, as `{ [nodeId]: output }` (what the canvas overlays). */
  async list(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
  ): Promise<Record<string, unknown>> {
    const rows = await getPrisma().pinnedData.findMany({
      where: { tenantId, environmentId, workflowKey },
      select: { nodeId: true, output: true },
    });
    return Object.fromEntries(rows.map((r) => [r.nodeId, r.output]));
  }

  /** Pin (or replace) a node's sample output in this env. */
  async set(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
    nodeId: string,
    output: unknown,
  ): Promise<void> {
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

  /** Clear a node's pin in this env. Returns true if one existed. */
  async clear(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
    nodeId: string,
  ): Promise<boolean> {
    const res = await getPrisma().pinnedData.deleteMany({
      where: { tenantId, environmentId, workflowKey, nodeId },
    });
    return res.count > 0;
  }
}

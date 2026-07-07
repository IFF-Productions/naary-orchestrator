import { Injectable } from "@nestjs/common";
import { getPrisma, Prisma } from "@naary/db";

/**
 * Pinned node outputs — AUTHORING-ONLY sample data (design SINGLE-NODE-EXECUTION.md §4). A pin
 * lets you build downstream nodes against a saved output without re-running upstream. The
 * interpreter NEVER reads pins — a real run always executes upstream — so a pin can't leak into
 * production. All ops are tenant-scoped.
 */
@Injectable()
export class PinsService {
  /** All pins for a workflow, as `{ [nodeId]: output }` (what the canvas overlays). */
  async list(
    tenantId: string,
    workflowKey: string,
  ): Promise<Record<string, unknown>> {
    const rows = await getPrisma().pinnedData.findMany({
      where: { tenantId, workflowKey },
      select: { nodeId: true, output: true },
    });
    return Object.fromEntries(rows.map((r) => [r.nodeId, r.output]));
  }

  /** Pin (or replace) a node's sample output. */
  async set(
    tenantId: string,
    workflowKey: string,
    nodeId: string,
    output: unknown,
  ): Promise<void> {
    const value = output as Prisma.InputJsonValue;
    await getPrisma().pinnedData.upsert({
      where: {
        tenantId_workflowKey_nodeId: { tenantId, workflowKey, nodeId },
      },
      create: { tenantId, workflowKey, nodeId, output: value },
      update: { output: value },
    });
  }

  /** Clear a node's pin. Returns true if one existed. */
  async clear(
    tenantId: string,
    workflowKey: string,
    nodeId: string,
  ): Promise<boolean> {
    const res = await getPrisma().pinnedData.deleteMany({
      where: { tenantId, workflowKey, nodeId },
    });
    return res.count > 0;
  }
}

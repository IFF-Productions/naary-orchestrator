import { createHash } from "node:crypto";
import { BadRequestException, Injectable } from "@nestjs/common";
import { getPrisma } from "@naary/db";
import { canonicalize, type GraphDef, validateGraph } from "@naary/dsl";

/** sha256 of the canonical (key-sorted) graph. Server-side — keeps `node:crypto`
 *  out of the DSL (which is bundled into the deterministic workflow). */
export function hashGraph(graph: GraphDef): string {
  return createHash("sha256").update(canonicalize(graph)).digest("hex");
}

export interface GraphSnapshot {
  graph: GraphDef;
  contentHash: string;
  version: number;
}

/**
 * Versioned graph store (Slice #5). `upsert` content-hashes the graph and only
 * bumps the version when the hash changes; `getLatest` returns the newest version
 * for a (tenantId, workflowKey). Execution start snapshots one version so a later
 * edit can't corrupt an in-flight run.
 */
@Injectable()
export class GraphsService {
  async upsert(
    tenantId: string,
    workflowKey: string,
    name: string,
    graph: GraphDef,
  ): Promise<GraphSnapshot> {
    // Reject a malformed graph BEFORE it can be persisted/started (QA#8): the
    // interpreter also guards at runtime (terminal invalid_graph), but catching it
    // here keeps bad graphs out of the DB entirely.
    const check = validateGraph(graph);
    if (!check.valid) {
      throw new BadRequestException(`Invalid graph: ${check.error}`);
    }
    const contentHash = hashGraph(graph);
    const latest = await this.latestRow(tenantId, workflowKey);
    if (latest && latest.contentHash === contentHash) {
      return {
        graph: latest.graph as unknown as GraphDef,
        contentHash,
        version: latest.version,
      };
    }
    const version = (latest?.version ?? 0) + 1;
    const row = await getPrisma().graphDefinition.create({
      data: {
        tenantId,
        workflowKey,
        name,
        graph: graph as object,
        contentHash,
        version,
      },
    });
    return {
      graph: row.graph as unknown as GraphDef,
      contentHash,
      version: row.version,
    };
  }

  async getLatest(
    tenantId: string,
    workflowKey: string,
  ): Promise<GraphSnapshot | null> {
    const row = await this.latestRow(tenantId, workflowKey);
    return row
      ? {
          graph: row.graph as unknown as GraphDef,
          contentHash: row.contentHash,
          version: row.version,
        }
      : null;
  }

  private latestRow(tenantId: string, workflowKey: string) {
    return getPrisma().graphDefinition.findFirst({
      where: { tenantId, workflowKey },
      orderBy: { version: "desc" },
    });
  }
}

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

/** Listing row: identity + latest version, no graph body. */
export interface GraphSummary {
  workflowKey: string;
  name: string;
  version: number;
  updatedAt: string;
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

  /** One entry per workflowKey (its latest version), newest first — for the
   *  Workflows list. Names/keys only; no graph bodies. */
  async list(tenantId: string): Promise<GraphSummary[]> {
    const rows = await getPrisma().graphDefinition.findMany({
      where: { tenantId },
      orderBy: { version: "desc" },
    });
    const latest = new Map<string, GraphSummary>();
    for (const r of rows) {
      if (!latest.has(r.workflowKey)) {
        latest.set(r.workflowKey, {
          workflowKey: r.workflowKey,
          name: r.name,
          version: r.version,
          updatedAt: r.createdAt.toISOString(),
        });
      }
    }
    return [...latest.values()];
  }

  /** Latest graph for a key, WITH its name + version — for opening into the canvas. */
  async getLatestNamed(
    tenantId: string,
    workflowKey: string,
  ): Promise<{
    workflowKey: string;
    name: string;
    version: number;
    graph: GraphDef;
  } | null> {
    const row = await this.latestRow(tenantId, workflowKey);
    return row
      ? {
          workflowKey,
          name: row.name,
          version: row.version,
          graph: row.graph as unknown as GraphDef,
        }
      : null;
  }

  private latestRow(tenantId: string, workflowKey: string) {
    return getPrisma().graphDefinition.findFirst({
      where: { tenantId, workflowKey },
      orderBy: { version: "desc" },
    });
  }

  /** The workflowKey of this workflow's error handler, or null if none is bound. */
  async getErrorHandler(
    tenantId: string,
    workflowKey: string,
  ): Promise<string | null> {
    const row = await getPrisma().errorHandler.findUnique({
      where: { tenantId_workflowKey: { tenantId, workflowKey } },
    });
    return row?.errorWorkflowKey ?? null;
  }

  /** Bind (or, with null, clear) this workflow's error handler. */
  async setErrorHandler(
    tenantId: string,
    workflowKey: string,
    errorWorkflowKey: string | null,
  ): Promise<void> {
    if (!errorWorkflowKey) {
      await getPrisma().errorHandler.deleteMany({
        where: { tenantId, workflowKey },
      });
      return;
    }
    await getPrisma().errorHandler.upsert({
      where: { tenantId_workflowKey: { tenantId, workflowKey } },
      create: { tenantId, workflowKey, errorWorkflowKey },
      update: { errorWorkflowKey },
    });
  }
}

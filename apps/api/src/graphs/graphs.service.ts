import { createHash } from "node:crypto";
import { BadRequestException, Injectable } from "@nestjs/common";
import { getPrisma } from "@naary/db";
import { canonicalize, type GraphDef, validateGraph } from "@naary/dsl";
import { TracedClass } from "@naary/observability";
// Runtime config validation is imported from the registry module DIRECTLY (not via the package
// index) so it never rides the worker's `@naary/dsl` import surface — that's what keeps zod out of
// the deterministic workflow bundle (Tier-1 rule 2). Deep `dist/` path because the repo uses
// classic `moduleResolution: node`, which doesn't honor package `exports` subpaths for types.
import { validateGraphConfigs } from "@naary/dsl/dist/registry";

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
  /** Whether the workflow's automatic triggers fire (n8n parity). Default true. */
  active: boolean;
}

/**
 * Versioned graph store (Slice #5). `upsert` content-hashes the graph and only
 * bumps the version when the hash changes; `getLatest` returns the newest version
 * for a (tenantId, workflowKey). Execution start snapshots one version so a later
 * edit can't corrupt an in-flight run.
 */
@Injectable()
@TracedClass()
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
    // Per-node config validation (Phase 3). Lenient on missing fields (drafts still save), strict
    // on present values — so a `method:"FETCH"` or `url:42` is caught here, not at run time. The
    // graph is persisted verbatim below; we validate but never store a parsed/stripped result.
    const configErrors = validateGraphConfigs(graph);
    if (configErrors.length > 0) {
      const summary = configErrors
        .map(
          (e) =>
            `${e.nodeId} (${e.nodeType}): ${e.issues
              .map((i) => `${i.path || "config"} ${i.message}`)
              .join("; ")}`,
        )
        .join(" | ");
      throw new BadRequestException(`Invalid node config — ${summary}`);
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
    const [rows, inactive] = await Promise.all([
      getPrisma().graphDefinition.findMany({
        where: { tenantId },
        orderBy: { version: "desc" },
      }),
      this.inactiveKeys(tenantId), // one query; everything else is active by default
    ]);
    const latest = new Map<string, GraphSummary>();
    for (const r of rows) {
      if (!latest.has(r.workflowKey)) {
        latest.set(r.workflowKey, {
          workflowKey: r.workflowKey,
          name: r.name,
          version: r.version,
          updatedAt: r.createdAt.toISOString(),
          active: !inactive.has(r.workflowKey),
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

  /** A SPECIFIC version's snapshot (for re-running a run at a chosen version).
   *  Tenant- + key-scoped; null if that (key, version) doesn't exist for the tenant. */
  async getVersion(
    tenantId: string,
    workflowKey: string,
    version: number,
  ): Promise<GraphSnapshot | null> {
    const row = await getPrisma().graphDefinition.findUnique({
      where: {
        tenantId_workflowKey_version: { tenantId, workflowKey, version },
      },
    });
    return row
      ? {
          graph: row.graph as unknown as GraphDef,
          contentHash: row.contentHash,
          version: row.version,
        }
      : null;
  }

  /** Every stored version of a workflowKey, newest first — identity only, no graph
   *  bodies (cheap; powers the "re-run at version" picker). */
  async listVersions(
    tenantId: string,
    workflowKey: string,
  ): Promise<{ version: number; contentHash: string; createdAt: string }[]> {
    const rows = await getPrisma().graphDefinition.findMany({
      where: { tenantId, workflowKey },
      orderBy: { version: "desc" },
      select: { version: true, contentHash: true, createdAt: true },
    });
    return rows.map((r) => ({
      version: r.version,
      contentHash: r.contentHash,
      createdAt: r.createdAt.toISOString(),
    }));
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

  /** Whether this workflow's automatic triggers may fire. ABSENCE ⇒ ACTIVE (see the
   *  WorkflowActivation model note): existing workflows have no row and must keep working. */
  async isActive(tenantId: string, workflowKey: string): Promise<boolean> {
    const row = await getPrisma().workflowActivation.findUnique({
      where: { tenantId_workflowKey: { tenantId, workflowKey } },
    });
    return row?.active ?? true;
  }

  /** The set of workflowKeys this tenant has explicitly DEACTIVATED (rows with active=false).
   *  Used to annotate the workflow list without an N+1 (everything else is active by default). */
  async inactiveKeys(tenantId: string): Promise<Set<string>> {
    const rows = await getPrisma().workflowActivation.findMany({
      where: { tenantId, active: false },
      select: { workflowKey: true },
    });
    return new Set(rows.map((r) => r.workflowKey));
  }

  /** Set this workflow's activation flag (upsert). Callers that also pause/unpause the workflow's
   *  Temporal schedules must sequence those around this write (see SchedulesService.setActive). */
  async setActive(
    tenantId: string,
    workflowKey: string,
    active: boolean,
  ): Promise<void> {
    await getPrisma().workflowActivation.upsert({
      where: { tenantId_workflowKey: { tenantId, workflowKey } },
      create: { tenantId, workflowKey, active },
      update: { active },
    });
  }

  /**
   * Delete a workflow and everything that points at it, in one transaction: all graph versions,
   * its authoring/runtime rows (activation, pins, poll cursor, error-handler bindings in BOTH
   * directions) and its triggers (webhook / form / chat endpoints). Temporal SCHEDULES are torn
   * down separately by the caller (SchedulesService.teardownForWorkflow) since they're an external
   * resource. Execution history is intentionally KEPT (it's an audit record).
   *
   * Returns false if there was no graph under this key (→ the controller 404s).
   */
  async deleteWorkflow(
    tenantId: string,
    workflowKey: string,
  ): Promise<boolean> {
    const existed = await getPrisma().graphDefinition.findFirst({
      where: { tenantId, workflowKey },
      select: { workflowKey: true },
    });
    if (!existed) return false;

    const p = getPrisma();
    await p.$transaction([
      p.graphDefinition.deleteMany({ where: { tenantId, workflowKey } }),
      p.workflowActivation.deleteMany({ where: { tenantId, workflowKey } }),
      p.pinnedData.deleteMany({ where: { tenantId, workflowKey } }),
      p.pollState.deleteMany({ where: { tenantId, workflowKey } }),
      // Error-handler bindings where this key is EITHER the failing workflow or the handler.
      p.errorHandler.deleteMany({
        where: {
          tenantId,
          OR: [{ workflowKey }, { errorWorkflowKey: workflowKey }],
        },
      }),
      // Triggers reference the graph key as `workflowId`.
      p.webhookEndpoint.deleteMany({
        where: { tenantId, workflowId: workflowKey },
      }),
      p.formEndpoint.deleteMany({
        where: { tenantId, workflowId: workflowKey },
      }),
      p.chatEndpoint.deleteMany({
        where: { tenantId, workflowId: workflowKey },
      }),
    ]);
    return true;
  }
}

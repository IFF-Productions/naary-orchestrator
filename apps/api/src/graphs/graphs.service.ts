import { createHash } from "node:crypto";
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { getPrisma } from "@naary/db";
import {
  canonicalize,
  diffGraphs,
  type GraphDef,
  type GraphDiff,
  validateGraph,
} from "@naary/dsl";
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
    environmentId: string,
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
    // Version is per (tenant, ENVIRONMENT, workflowKey) — a save in sandbox and prod for the same
    // key version independently (else they'd collide on the new composite unique).
    const latest = await this.latestRow(tenantId, environmentId, workflowKey);
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
        environmentId,
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
    environmentId: string,
    workflowKey: string,
  ): Promise<GraphSnapshot | null> {
    const row = await this.latestRow(tenantId, environmentId, workflowKey);
    return row
      ? {
          graph: row.graph as unknown as GraphDef,
          contentHash: row.contentHash,
          version: row.version,
        }
      : null;
  }

  /** One entry per workflowKey (its latest version), newest first — for the
   *  Workflows list. Names/keys only; no graph bodies. Scoped to the active environment. */
  async list(tenantId: string, environmentId: string): Promise<GraphSummary[]> {
    const [rows, inactive] = await Promise.all([
      getPrisma().graphDefinition.findMany({
        where: { tenantId, environmentId },
        orderBy: { version: "desc" },
      }),
      this.inactiveKeys(tenantId, environmentId), // active-by-default within the env
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
    environmentId: string,
    workflowKey: string,
  ): Promise<{
    workflowKey: string;
    name: string;
    version: number;
    graph: GraphDef;
  } | null> {
    const row = await this.latestRow(tenantId, environmentId, workflowKey);
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
    environmentId: string,
    workflowKey: string,
    version: number,
  ): Promise<GraphSnapshot | null> {
    const row = await getPrisma().graphDefinition.findUnique({
      where: {
        tenantId_environmentId_workflowKey_version: {
          tenantId,
          environmentId,
          workflowKey,
          version,
        },
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

  /**
   * Structural diff between two stored versions of a workflowKey (workflow diff). Loads both
   * snapshots in the caller's env and returns what changed (nodes/edges added/removed/reconfigured).
   * Throws NotFound if either version is missing.
   */
  async diffVersions(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
    fromVersion: number,
    toVersion: number,
  ): Promise<GraphDiff & { fromVersion: number; toVersion: number }> {
    const [from, to] = await Promise.all([
      this.getVersion(tenantId, environmentId, workflowKey, fromVersion),
      this.getVersion(tenantId, environmentId, workflowKey, toVersion),
    ]);
    if (!from) {
      throw new NotFoundException(
        `No version ${fromVersion} for workflow '${workflowKey}'`,
      );
    }
    if (!to) {
      throw new NotFoundException(
        `No version ${toVersion} for workflow '${workflowKey}'`,
      );
    }
    return { fromVersion, toVersion, ...diffGraphs(from.graph, to.graph) };
  }

  /** Every stored version of a workflowKey, newest first — identity only, no graph
   *  bodies (cheap; powers the "re-run at version" picker). */
  async listVersions(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
  ): Promise<{ version: number; contentHash: string; createdAt: string }[]> {
    const rows = await getPrisma().graphDefinition.findMany({
      where: { tenantId, environmentId, workflowKey },
      orderBy: { version: "desc" },
      select: { version: true, contentHash: true, createdAt: true },
    });
    return rows.map((r) => ({
      version: r.version,
      contentHash: r.contentHash,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  private latestRow(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
  ) {
    return getPrisma().graphDefinition.findFirst({
      where: { tenantId, environmentId, workflowKey },
      orderBy: { version: "desc" },
    });
  }

  /**
   * PROMOTE a workflow definition from one env to another (design ENVIRONMENTS.md §6, Slice 3):
   * copy the source env's graph (a chosen version, default = latest) into the target env as a NEW
   * version (content-hashed like a save — a no-op version if the target already has that exact
   * graph), and record a `Promotion` audit row. Creds/connections are NOT copied — the target env
   * binds to its own. Returns the source + target versions.
   */
  async promote(
    tenantId: string,
    workflowKey: string,
    fromEnvId: string,
    toEnvId: string,
    actor: string,
    fromVersion?: number,
  ): Promise<{ fromVersion: number; toVersion: number; contentHash: string }> {
    if (fromEnvId === toEnvId) {
      throw new BadRequestException(
        "Source and target environments must differ.",
      );
    }
    const source =
      fromVersion === undefined
        ? await this.latestRow(tenantId, fromEnvId, workflowKey)
        : await getPrisma().graphDefinition.findUnique({
            where: {
              tenantId_environmentId_workflowKey_version: {
                tenantId,
                environmentId: fromEnvId,
                workflowKey,
                version: fromVersion,
              },
            },
          });
    if (!source) {
      throw new NotFoundException(
        fromVersion === undefined
          ? `No '${workflowKey}' graph in the source environment.`
          : `No version ${fromVersion} of '${workflowKey}' in the source environment.`,
      );
    }
    // Write into the target env (re-validated + content-hashed; identical graph → reuses version).
    const snap = await this.upsert(
      tenantId,
      toEnvId,
      workflowKey,
      source.name,
      source.graph as unknown as GraphDef,
    );
    await getPrisma().promotion.create({
      data: {
        tenantId,
        workflowKey,
        fromEnvId,
        toEnvId,
        fromVersion: source.version,
        toVersion: snap.version,
        actor,
      },
    });
    return {
      fromVersion: source.version,
      toVersion: snap.version,
      contentHash: snap.contentHash,
    };
  }

  /** Promotion history for a workflow (newest first) — the lineage/audit list. */
  async listPromotions(
    tenantId: string,
    workflowKey: string,
  ): Promise<
    {
      fromEnvId: string;
      toEnvId: string;
      fromVersion: number;
      toVersion: number;
      actor: string;
      createdAt: string;
    }[]
  > {
    const rows = await getPrisma().promotion.findMany({
      where: { tenantId, workflowKey },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return rows.map((r) => ({
      fromEnvId: r.fromEnvId,
      toEnvId: r.toEnvId,
      fromVersion: r.fromVersion,
      toVersion: r.toVersion,
      actor: r.actor,
      createdAt: r.createdAt.toISOString(),
    }));
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
  async isActive(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
  ): Promise<boolean> {
    const row = await getPrisma().workflowActivation.findUnique({
      where: {
        tenantId_environmentId_workflowKey: {
          tenantId,
          environmentId,
          workflowKey,
        },
      },
    });
    return row?.active ?? true;
  }

  /** The set of workflowKeys DEACTIVATED in this environment (rows with active=false).
   *  Used to annotate the workflow list without an N+1 (everything else is active by default). */
  async inactiveKeys(
    tenantId: string,
    environmentId: string,
  ): Promise<Set<string>> {
    const rows = await getPrisma().workflowActivation.findMany({
      where: { tenantId, environmentId, active: false },
      select: { workflowKey: true },
    });
    return new Set(rows.map((r) => r.workflowKey));
  }

  /** Set this workflow's activation flag (upsert). Callers that also pause/unpause the workflow's
   *  Temporal schedules must sequence those around this write (see SchedulesService.setActive). */
  async setActive(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
    active: boolean,
  ): Promise<void> {
    await getPrisma().workflowActivation.upsert({
      where: {
        tenantId_environmentId_workflowKey: {
          tenantId,
          environmentId,
          workflowKey,
        },
      },
      create: { tenantId, environmentId, workflowKey, active },
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
    environmentId: string,
    workflowKey: string,
    /** True only when deleting the DEFAULT env's copy. The shared (not-yet-env-scoped) rows —
     *  poll/error-handler/triggers, keyed by (tenant, workflowKey) — are removed ONLY then,
     *  so deleting a non-default (sandbox) copy of a key can't wipe the default/prod copy's
     *  webhooks. Those tables env-scope in later slices; this gate goes away with them.
     *  (Pins env-scoped in 6b and moved out of this gate.) */
    deleteShared: boolean,
  ): Promise<boolean> {
    const existed = await getPrisma().graphDefinition.findFirst({
      where: { tenantId, environmentId, workflowKey },
      select: { workflowKey: true },
    });
    if (!existed) return false;

    const p = getPrisma();
    // Always delete THIS env's GraphDefinition + WorkflowActivation + pins (env-scoped, 6b).
    const ops = [
      p.graphDefinition.deleteMany({
        where: { tenantId, environmentId, workflowKey },
      }),
      p.workflowActivation.deleteMany({
        where: { tenantId, environmentId, workflowKey },
      }),
      p.pinnedData.deleteMany({
        where: { tenantId, environmentId, workflowKey },
      }),
    ];
    // The shared, tenant-wide rows/triggers belong to the default env's copy — only remove them
    // when deleting THAT copy (else a sandbox delete kills prod's webhooks for the same key).
    if (deleteShared) {
      ops.push(
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
      );
    }
    await p.$transaction(ops);
    return true;
  }
}

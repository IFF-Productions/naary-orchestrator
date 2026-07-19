import { createHash } from "node:crypto";
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
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
import type { Principal } from "../auth/tenant.decorator";
import {
  PermissionsService,
  type WorkflowAction,
} from "../permissions/permissions.service";

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
  /** Organizational tags (tenant-wide per workflowKey — NOT env-scoped). Never permissions. */
  tags: { id: string; name: string; color: string | null }[];
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
  /** @Optional so the many `new GraphsService()` test/CLI constructions still work; when an
   *  ACTOR is passed to a method the service must be wired (fail CLOSED, never skip). */
  constructor(@Optional() private readonly permissions?: PermissionsService) {}

  /** In-service permission assert (RBAC-GROUPS.md §4): no actor = internal/trigger caller —
   *  never checked; with an actor the check must actually run (missing wiring throws). */
  private async assertActor(
    actor: Principal | undefined,
    action: WorkflowAction,
    workflowKey: string,
    environmentId: string | undefined,
  ): Promise<void> {
    if (!actor) return;
    await this.perms().assertCan(actor, action, workflowKey, environmentId);
  }

  private perms(): PermissionsService {
    if (!this.permissions) {
      // A user-facing call site passed an actor but the service was constructed without
      // PermissionsService — a wiring bug. Fail closed rather than silently skip authz.
      throw new Error("GraphsService: PermissionsService is not wired");
    }
    return this.permissions;
  }

  async upsert(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
    name: string,
    graph: GraphDef,
    /** The user-facing caller, when there is one. Gates the save (§4): an EXISTING key
     *  needs `edit`; a NEW key needs `canCreate` (its own verb, 'all'-scope only, §8.3).
     *  Absent for internal callers (promote's copy-in, seeds) — those are pre-authorized. */
    actor?: Principal,
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
    // §4 save gate, on the row we already read (no extra query): an existing key is an EDIT;
    // a new key is a CREATE — its own permission, never inferred from edit (§8.3).
    if (actor) {
      if (latest) {
        await this.assertActor(actor, "edit", workflowKey, environmentId);
      } else {
        await this.perms().assertCanCreate(actor, environmentId);
      }
    }
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
   *  Workflows list. Names/keys only; no graph bodies. Scoped to the active environment.
   *  With an ACTOR, the list is FILTERED to the keys they may view (§4 — list endpoints
   *  filter; single-resource endpoints 403). */
  async list(
    tenantId: string,
    environmentId: string,
    actor?: Principal,
  ): Promise<GraphSummary[]> {
    const [rows, inactive] = await Promise.all([
      getPrisma().graphDefinition.findMany({
        where: { tenantId, environmentId },
        orderBy: { version: "desc" },
      }),
      this.inactiveKeys(tenantId, environmentId), // active-by-default within the env
    ]);
    let latest = new Map<string, GraphSummary>();
    for (const r of rows) {
      if (!latest.has(r.workflowKey)) {
        latest.set(r.workflowKey, {
          workflowKey: r.workflowKey,
          name: r.name,
          version: r.version,
          updatedAt: r.createdAt.toISOString(),
          active: !inactive.has(r.workflowKey),
          tags: [],
        });
      }
    }
    if (actor) {
      const viewable = await this.perms().filterViewable(
        actor,
        [...latest.keys()],
        environmentId,
      );
      latest = new Map(viewable.map((k) => [k, latest.get(k)!]));
    }
    // Attach tags in ONE batched query (no N+1). Tags are TENANT-WIDE per workflowKey (not
    // env-scoped) — authoring metadata like the name, so every env shows the same chips.
    const keys = [...latest.keys()];
    if (keys.length > 0) {
      const tagRows = await getPrisma().workflowTag.findMany({
        where: { tenantId, workflowKey: { in: keys } },
        include: { tag: true },
        orderBy: { tag: { name: "asc" } },
      });
      for (const wt of tagRows) {
        latest.get(wt.workflowKey)?.tags.push({
          id: wt.tag.id,
          name: wt.tag.name,
          color: wt.tag.color,
        });
      }
    }
    return [...latest.values()];
  }

  /** Latest graph for a key, WITH its name + version — for opening into the canvas.
   *  Asserts `view` for a user-facing actor (403 BEFORE the read — no existence oracle). */
  async getLatestNamed(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
    actor?: Principal,
  ): Promise<{
    workflowKey: string;
    name: string;
    version: number;
    graph: GraphDef;
  } | null> {
    await this.assertActor(actor, "view", workflowKey, environmentId);
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
    actor?: Principal,
  ): Promise<GraphDiff & { fromVersion: number; toVersion: number }> {
    await this.assertActor(actor, "view", workflowKey, environmentId);
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
    actor?: Principal,
  ): Promise<{ version: number; contentHash: string; createdAt: string }[]> {
    await this.assertActor(actor, "view", workflowKey, environmentId);
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
    /** The user-facing caller. share = promote (§8.2); the grant must match the promote's
     *  SOURCE environment — you promote what you can see/share FROM. */
    principal?: Principal,
  ): Promise<{ fromVersion: number; toVersion: number; contentHash: string }> {
    await this.assertActor(principal, "share", workflowKey, fromEnvId);
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

  /** Promotion history for a workflow (newest first) — the lineage/audit list.
   *  View-gated for a user-facing actor against the caller's ACTIVE env (`environmentId`,
   *  resolved by the controller — promotions are cross-env lineage, so the active env is
   *  the natural anchor for the §4 view check). */
  async listPromotions(
    tenantId: string,
    workflowKey: string,
    actor?: Principal,
    environmentId?: string,
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
    await this.assertActor(actor, "view", workflowKey, environmentId);
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

  /** The workflowKey of this workflow's error handler, or null if none is bound.
   *  View-gated for a user-facing actor; run-start reads pass no actor (internal). */
  async getErrorHandler(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
    actor?: Principal,
  ): Promise<string | null> {
    await this.assertActor(actor, "view", workflowKey, environmentId);
    const row = await getPrisma().errorHandler.findUnique({
      where: {
        tenantId_environmentId_workflowKey: {
          tenantId,
          environmentId,
          workflowKey,
        },
      },
    });
    return row?.errorWorkflowKey ?? null;
  }

  /** Bind (or, with null, clear) this workflow's error handler in this env. Edit-gated. */
  async setErrorHandler(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
    errorWorkflowKey: string | null,
    actor?: Principal,
  ): Promise<void> {
    await this.assertActor(actor, "edit", workflowKey, environmentId);
    if (!errorWorkflowKey) {
      await getPrisma().errorHandler.deleteMany({
        where: { tenantId, environmentId, workflowKey },
      });
      return;
    }
    await getPrisma().errorHandler.upsert({
      where: {
        tenantId_environmentId_workflowKey: {
          tenantId,
          environmentId,
          workflowKey,
        },
      },
      create: { tenantId, environmentId, workflowKey, errorWorkflowKey },
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
  ): Promise<boolean> {
    const existed = await getPrisma().graphDefinition.findFirst({
      where: { tenantId, environmentId, workflowKey },
      select: { workflowKey: true },
    });
    if (!existed) return false;

    const p = getPrisma();
    // Always delete THIS env's rows: graph, activation, pins, error-handler bindings, and the
    // trigger endpoints (all env-scoped now) — a sandbox delete can no longer wipe prod's
    // webhooks for the same key, and no longer orphans its own.
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
      // Bindings where this key is EITHER the failing workflow or the handler.
      p.errorHandler.deleteMany({
        where: {
          tenantId,
          environmentId,
          OR: [{ workflowKey }, { errorWorkflowKey: workflowKey }],
        },
      }),
      // Triggers reference the graph key as `workflowId`.
      p.webhookEndpoint.deleteMany({
        where: { tenantId, environmentId, workflowId: workflowKey },
      }),
      p.formEndpoint.deleteMany({
        where: { tenantId, environmentId, workflowId: workflowKey },
      }),
      p.chatEndpoint.deleteMany({
        where: { tenantId, environmentId, workflowId: workflowKey },
      }),
      // Poll cursors are env-scoped now (env-scoped-schedules slice) — always deleted for
      // THIS env, like every other row. The former deleteShared gate is gone with it.
      p.pollState.deleteMany({
        where: { tenantId, environmentId, workflowKey },
      }),
    ];
    await p.$transaction(ops);
    return true;
  }
}

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
  type NodeDef,
  validateGraph,
  validateGraphToolPolicy,
} from "@naary/dsl";
import { TracedClass } from "@naary/observability";
// Runtime config validation is imported from the registry module DIRECTLY (not via the package
// index) so it never rides the worker's `@naary/dsl` import surface — that's what keeps zod out of
// the deterministic workflow bundle (Tier-1 rule 2). Deep `dist/` path because the repo uses
// classic `moduleResolution: node`, which doesn't honor package `exports` subpaths for types.
import { validateGraphConfigs } from "@naary/dsl/dist/registry";
import type { Principal } from "../auth/tenant.decorator";
import { extractMcpServerTool } from "../mcp/mcp-exposed";
import { NotificationsService } from "../notifications/notifications.service";
import {
  PermissionsService,
  type WorkflowAction,
} from "../permissions/permissions.service";
import { GuardrailsService } from "../settings/guardrails.service";

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
 * The node type of a stored graph's ENTRY node, or null when it can't be resolved.
 *
 * Defensive on purpose: `graph` arrives as Prisma JSON, so a legacy or hand-edited row may
 * not have the shape the DSL type promises. A listing endpoint must never 500 because one
 * row is odd — an unresolvable entry just means "no trigger to offer" for that workflow.
 */
function entryNodeType(graph: unknown): string | null {
  const g = graph as
    | { startNodeId?: unknown; nodes?: { id?: unknown; type?: unknown }[] }
    | null
    | undefined;
  if (!g || typeof g.startNodeId !== "string" || !Array.isArray(g.nodes))
    return null;
  const entry = g.nodes.find((n) => n?.id === g.startNodeId);
  return typeof entry?.type === "string" ? entry.type : null;
}

/** Listing row: identity + latest version, no graph body. */
export interface GraphSummary {
  workflowKey: string;
  name: string;
  version: number;
  updatedAt: string;
  /** Whether the workflow's automatic triggers fire (n8n parity). Default true. */
  active: boolean;
  /**
   * The node type of the graph's ENTRY node (`startNodeId`), e.g. "formTrigger" — null if the
   * graph has no resolvable entry. This is exactly the eligibility rule the hosted-endpoint
   * registrations enforce (extractFormDefinition / extractChatDefinition both require the
   * entry node to be their trigger), so a client can offer a PICKER of eligible workflows
   * instead of asking a user to type a workflow key and find out on submit.
   *
   * Free to compute: `list` already reads the full rows, graph body included.
   */
  entryType: string | null;
  /** Organizational tags (tenant-wide per workflowKey — NOT env-scoped). Never permissions. */
  tags: { id: string; name: string; color: string | null }[];
}

/** A workflow opted in to being hosted as an MCP tool (its entry node is an `mcpServerTrigger`),
 *  plus the tool name/description read from that node. Consumed by the MCP server (flavor B). */
export interface McpExposedWorkflowInfo {
  workflowKey: string;
  name: string;
  version: number;
  updatedAt: string;
  /** The node's configured MCP tool name; absent ⇒ server derives `run_<workflowKey>`. */
  toolName?: string;
  /** The node's configured tool description shown to the calling agent. */
  toolDescription?: string;
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
   *  ACTOR is passed to a method the service must be wired (fail CLOSED, never skip).
   *  `notifications` is optional for the same reason — promotion notifications (Slice 4)
   *  are best-effort and simply skipped when unwired. */
  constructor(
    @Optional() private readonly permissions?: PermissionsService,
    @Optional() private readonly notifications?: NotificationsService,
    /** @Optional for the same reason as the others (many `new GraphsService()` test/CLI
     *  constructions). Unwired ⇒ the tool-policy save gate is skipped, which is safe: it is
     *  DEFENSE IN DEPTH, and the worker enforces the same policy in-activity regardless. */
    @Optional() private readonly guardrails?: GuardrailsService,
  ) {}

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
    /** Optional commit note for this version (#488, API/CLI-settable). */
    saveMessage?: string,
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
    // Agent guardrails (#576 AC1, save half): reject a graph that calls a tool this workspace's
    // policy denies, and reject a forced-approval tool placed INSIDE an agent's in-loop `tools[]`
    // (a durable approval pause is impossible mid-activity — see validateGraphToolPolicy). This is
    // one of THREE enforcement points; the worker independently enforces the same policy in the
    // activity and the interpreter pauses on a forced-approval tool node.
    if (this.guardrails) {
      const policy = await this.guardrails.get(tenantId);
      const toolErrors = validateGraphToolPolicy(graph, policy);
      if (toolErrors.length > 0) {
        const summary = toolErrors
          .map((e) => `${e.nodeId} (${e.nodeType}): ${e.message}`)
          .join(" | ");
        throw new BadRequestException(`Guardrail policy — ${summary}`);
      }
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
      // The hash covers the GRAPH only, so a pure RENAME lands here: identical graph, new
      // display name. Returning early without writing silently DROPPED the rename — the
      // canvas kept showing the new name until a reload, then reverted to the old one.
      // Persist the name on the latest row rather than minting a version: a version is a
      // graph snapshot identified by contentHash, and renaming isn't a new snapshot. Earlier
      // versions keep the name they were saved under, which is what a history should show.
      // The `edit` gate above already ran, so this is authorized.
      if (name !== latest.name) {
        await getPrisma().graphDefinition.update({
          where: { id: latest.id },
          data: { name },
        });
      }
      return {
        graph: latest.graph as unknown as GraphDef,
        contentHash,
        version: latest.version,
      };
    }
    const version = (latest?.version ?? 0) + 1;
    // #488: record WHO saved (a display string — email for a user, "api-token" for a token; NULL
    // for internal/promote copy-in, which is actor-less by design) and the optional WHY.
    const savedBy = actor
      ? (actor.email ?? actor.subject ?? "api-token")
      : null;
    const row = await getPrisma().graphDefinition.create({
      data: {
        tenantId,
        environmentId,
        workflowKey,
        name,
        graph: graph as object,
        contentHash,
        version,
        savedBy,
        saveMessage: saveMessage?.trim() || null,
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
          entryType: entryNodeType(r.graph),
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

  /**
   * The tenant's workflows that OPT IN to being hosted as MCP tools (docs/design/MCP-SERVER.md §5,
   * flavor B) — i.e. whose LATEST graph's ENTRY node is an `mcpServerTrigger` (matched like the
   * form endpoint's entry check, not "contains one anywhere"). Composes on `list()` so RBAC view
   * filtering + env scoping are reused, then enriches the subset with one batched `distinct` body
   * fetch (the `connectionUsageCounts` pattern — no N+1) to read each entry node's tool config.
   */
  async listMcpExposed(
    tenantId: string,
    environmentId: string,
    actor?: Principal,
  ): Promise<McpExposedWorkflowInfo[]> {
    const summaries = await this.list(tenantId, environmentId, actor);
    if (summaries.length === 0) return [];
    const keys = summaries.map((s) => s.workflowKey);
    const rows = await getPrisma().graphDefinition.findMany({
      where: { tenantId, environmentId, workflowKey: { in: keys } },
      orderBy: [{ workflowKey: "asc" }, { version: "desc" }],
      distinct: ["workflowKey"],
      select: { workflowKey: true, graph: true },
    });
    const bodies = new Map(
      rows.map((r) => [r.workflowKey, r.graph as GraphDef | null]),
    );
    const out: McpExposedWorkflowInfo[] = [];
    for (const s of summaries) {
      const graph = bodies.get(s.workflowKey);
      if (!graph) continue;
      // Pure ENTRY-node opt-in check (unit-tested in mcp-exposed.spec.ts).
      const tool = extractMcpServerTool(graph);
      if (!tool) continue;
      out.push({
        workflowKey: s.workflowKey,
        name: s.name,
        version: s.version,
        updatedAt: s.updatedAt,
        ...tool,
      });
    }
    return out;
  }

  /**
   * How many nodes reference each connection, across the tenant's LATEST graphs in this env
   * (#471, the Integrations "used by N nodes" count). Env-scoped — connections are env-scoped,
   * so a prod connection must not count sandbox usage. Generic over node type: any node whose
   * `config.connectionId` matches counts (http / integration / mcpTool / sqlQuery today, plus
   * any future connection-bearing node). A connection with no references is simply absent →
   * callers read it as 0. No actor gating: this is an internal aggregate for the owner's
   * Integrations screen, not a per-workflow read.
   */
  async connectionUsageCounts(
    tenantId: string,
    environmentId: string,
  ): Promise<Record<string, number>> {
    // Fetch ONLY the latest body per workflowKey — `distinct` + workflowKey-led order pushes a
    // Postgres DISTINCT ON, so we don't ship every historical version's graph JSON just to
    // dedupe in memory. The `seen` guard below stays as a defensive backstop (a no-op once the
    // DB deduped).
    const rows = await getPrisma().graphDefinition.findMany({
      where: { tenantId, environmentId },
      orderBy: [{ workflowKey: "asc" }, { version: "desc" }],
      distinct: ["workflowKey"],
      select: { workflowKey: true, graph: true },
    });
    const seen = new Set<string>();
    const counts: Record<string, number> = {};
    for (const r of rows) {
      if (seen.has(r.workflowKey)) continue;
      seen.add(r.workflowKey);
      const nodes = (r.graph as { nodes?: NodeDef[] } | null)?.nodes ?? [];
      for (const node of nodes) {
        const cid = node?.config?.connectionId;
        if (typeof cid === "string" && cid) {
          counts[cid] = (counts[cid] ?? 0) + 1;
        }
      }
    }
    return counts;
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
  ): Promise<
    {
      version: number;
      contentHash: string;
      createdAt: string;
      savedBy: string | null;
      saveMessage: string | null;
    }[]
  > {
    await this.assertActor(actor, "view", workflowKey, environmentId);
    const rows = await getPrisma().graphDefinition.findMany({
      where: { tenantId, environmentId, workflowKey },
      orderBy: { version: "desc" },
      select: {
        version: true,
        contentHash: true,
        createdAt: true,
        savedBy: true,
        saveMessage: true,
      },
    });
    return rows.map((r) => ({
      version: r.version,
      contentHash: r.contentHash,
      createdAt: r.createdAt.toISOString(),
      savedBy: r.savedBy ?? null,
      saveMessage: r.saveMessage ?? null,
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
    // Slice 4 (REDESIGN-FUNCTIONALITY-GAPS.md): announce the promotion to the TARGET env's
    // notification channels (onPromotion opt-in). Best-effort AFTER the promote is durable —
    // a notification problem must never fail (or roll back) the promote itself.
    if (this.notifications) {
      try {
        const envs = await getPrisma().environment.findMany({
          where: { tenantId, id: { in: [fromEnvId, toEnvId] } },
          select: { id: true, name: true },
        });
        const envName = (id: string) =>
          envs.find((e) => e.id === id)?.name ?? id;
        await this.notifications.sendPromotion(tenantId, toEnvId, {
          workflowKey,
          fromEnv: envName(fromEnvId),
          toEnv: envName(toEnvId),
          version: snap.version,
        });
      } catch {
        // Best-effort — the promote already succeeded.
      }
    }
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

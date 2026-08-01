import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { getPrisma, resolveWorkflowKey } from "@naary/db";
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
import { FormAssetService } from "../forms/form-asset.service";
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
/**
 * Every `logoAssetId` referenced by a formTrigger in this graph (deduped).
 *
 * A list rather than a single value because nothing forbids more than one formTrigger node in a saved
 * graph — only one can be the ENTRY, but a draft can carry others, and a check that only looked at the
 * entry would let a foreign id ride along in a node that later becomes the entry.
 */
function formLogoAssetIds(graph: unknown): string[] {
  const nodes = (graph as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];
  const ids = new Set<string>();
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const n = node as { type?: unknown; config?: unknown };
    if (n.type !== "formTrigger") continue;
    const branding = (n.config as { branding?: unknown } | undefined)?.branding;
    const id = (branding as { logoAssetId?: unknown } | undefined)?.logoAssetId;
    if (typeof id === "string" && id) ids.add(id);
  }
  return [...ids];
}

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
    /** @Optional for the same reason as the others (many `new GraphsService()` test/CLI
     *  constructions), but the logo check FAILS CLOSED when it's unwired and a graph actually carries
     *  a logo — see the upsert() gate. It cannot be skipped: the asset route is deliberately not
     *  tenant-scoped, so an unverified foreign id is served successfully, not 404'd. */
    @Optional() private readonly formAssets?: FormAssetService,
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

  /**
   * A possibly-RETIRED key → the key that is live today (#904).
   *
   * MUST run BEFORE the §4 permission assert, not just before the DB read: a rename rewrites
   * `WorkflowGrantKey` and the tag-derived key list to the new key, so checking a grant against a
   * retired key would 403 a user who genuinely has access.
   *
   * `upsert` is the ONE method that does NOT resolve — see the note there.
   */
  async liveKey(tenantId: string, workflowKey: string): Promise<string> {
    return resolveWorkflowKey(tenantId, workflowKey);
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
    // #904 — the ONE key-bearing path that REFUSES to resolve an alias.
    //
    // Every other lookup resolves a retired key silently, because that is the whole point of an
    // alias. `upsert` cannot: it is the only operation that can MINT a workflow, so "no graph under
    // this key" is ambiguous between "save my renamed workflow via its old key" and "create a brand
    // new workflow that happens to derive this key". Resolving would let a NEW workflow silently
    // land as another workflow's next version; creating would fork the renamed one. So it refuses,
    // loudly, naming where the key went — the caller (canvas, CLI, v1) re-addresses and retries.
    // A canvas opened at a retired key never hits this: `getLatestNamed` hands back the LIVE key.
    const live = await this.liveKey(tenantId, workflowKey);
    if (live !== workflowKey) {
      throw new ConflictException({
        message:
          `The workflow key '${workflowKey}' was renamed to '${live}'. ` +
          `Save to '${live}' instead — '${workflowKey}' still resolves for reads and runs, but it ` +
          "can't be re-used for a new workflow.",
        code: "WORKFLOW_KEY_RENAMED",
        workflowKey,
        renamedTo: live,
      });
    }
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
    // A formTrigger logo is an asset id WE issued, and it must belong to THIS tenant+environment.
    // Without this check a tenant could paste an id learned from another workspace's public form and
    // serve it as their own — cross-tenant hotlinking of an image we host and pay to serve. The zod
    // schema only checks the id's shape; ownership needs a lookup, so it lives here. Rejected at save
    // rather than dropped on read, because an author pasting the wrong id deserves to be told.
    //
    // FAILS CLOSED, and that matters: `GET /forms/assets/:id` is deliberately NOT tenant-scoped (the
    // anonymous browser rendering a hosted form has no tenant context), so an unverified foreign id is
    // served SUCCESSFULLY — it does not 404. Treating an unwired verifier as "skip" would therefore
    // leave cross-tenant hotlinking wide open on every DI-less save path (scripts, seeds, the CLI).
    // Note the gate only trips when a graph actually CARRIES a logo, so the many bare
    // `new GraphsService()` constructions keep working untouched.
    const logoIds = formLogoAssetIds(graph);
    if (logoIds.length > 0) {
      if (!this.formAssets) {
        throw new Error(
          "Cannot verify a form logo's ownership: FormAssetService is not wired into GraphsService. " +
            "Refusing to save rather than accept an unverified asset id (the asset route is not " +
            "tenant-scoped, so a foreign id would be served, not rejected).",
        );
      }
      for (const assetId of logoIds) {
        const owned = await this.formAssets.ownedBy(
          assetId,
          tenantId,
          environmentId,
        );
        if (!owned) {
          throw new BadRequestException(
            `Logo asset ${assetId} does not belong to this workspace environment — re-upload it here.`,
          );
        }
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
   *  Asserts `view` for a user-facing actor (403 BEFORE the read — no existence oracle).
   *
   *  Returns the LIVE key, not the one asked for (#904): opening a bookmarked canvas URL under a
   *  retired key must hand the client the current key, or its next save would be refused by
   *  `upsert`'s alias guard. This is the redirect half of "old keys keep resolving". */
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
    const key = await this.liveKey(tenantId, workflowKey);
    await this.assertActor(actor, "view", key, environmentId);
    const row = await this.latestRow(tenantId, environmentId, key);
    return row
      ? {
          workflowKey: key,
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
    // Composite findUnique — it can't route through `latestRow`, and a miss here is `null`, not an
    // error, so the alias MUST be resolved before the read or a rerun-at-version of a pre-rename
    // run would silently look like "that version doesn't exist".
    const key = await this.liveKey(tenantId, workflowKey);
    const row = await getPrisma().graphDefinition.findUnique({
      where: {
        tenantId_environmentId_workflowKey_version: {
          tenantId,
          environmentId,
          workflowKey: key,
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
    const key = await this.liveKey(tenantId, workflowKey);
    await this.assertActor(actor, "view", key, environmentId);
    const [from, to] = await Promise.all([
      this.getVersion(tenantId, environmentId, key, fromVersion),
      this.getVersion(tenantId, environmentId, key, toVersion),
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
    const key = await this.liveKey(tenantId, workflowKey);
    await this.assertActor(actor, "view", key, environmentId);
    const rows = await getPrisma().graphDefinition.findMany({
      where: { tenantId, environmentId, workflowKey: key },
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

  /** The central by-key graph read. Alias-resolving (#904) — so a run started from another graph's
   *  `executeSubWorkflow` node, an armed schedule's args, an MCP tool, a CLI call or a bookmarked
   *  canvas URL still finds the workflow after its key was renamed. `upsert` passes a key it has
   *  already checked itself (it refuses aliases), so the extra lookup there is a no-op. */
  private async latestRow(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
  ) {
    const key = await this.liveKey(tenantId, workflowKey);
    return getPrisma().graphDefinition.findFirst({
      where: { tenantId, environmentId, workflowKey: key },
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
    // Alias-resolved up front (#904): a promote driven by a retired key (a CLI script, a v1 caller)
    // must move the workflow it names, and the key it writes into the TARGET env has to be the live
    // one — `upsert` below refuses an alias by design.
    const key = await this.liveKey(tenantId, workflowKey);
    await this.assertActor(principal, "share", key, fromEnvId);
    if (fromEnvId === toEnvId) {
      throw new BadRequestException(
        "Source and target environments must differ.",
      );
    }
    const source =
      fromVersion === undefined
        ? await this.latestRow(tenantId, fromEnvId, key)
        : await getPrisma().graphDefinition.findUnique({
            where: {
              tenantId_environmentId_workflowKey_version: {
                tenantId,
                environmentId: fromEnvId,
                workflowKey: key,
                version: fromVersion,
              },
            },
          });
    if (!source) {
      throw new NotFoundException(
        fromVersion === undefined
          ? `No '${key}' graph in the source environment.`
          : `No version ${fromVersion} of '${key}' in the source environment.`,
      );
    }
    // Write into the target env (re-validated + content-hashed; identical graph → reuses version).
    const snap = await this.upsert(
      tenantId,
      toEnvId,
      key,
      source.name,
      source.graph as unknown as GraphDef,
    );
    await getPrisma().promotion.create({
      data: {
        tenantId,
        workflowKey: key,
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
          workflowKey: key,
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
    const key = await this.liveKey(tenantId, workflowKey);
    await this.assertActor(actor, "view", key, environmentId);
    const rows = await getPrisma().promotion.findMany({
      where: { tenantId, workflowKey: key },
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
    const key = await this.liveKey(tenantId, workflowKey);
    await this.assertActor(actor, "view", key, environmentId);
    const row = await getPrisma().errorHandler.findUnique({
      where: {
        tenantId_environmentId_workflowKey: {
          tenantId,
          environmentId,
          workflowKey: key,
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
    // BOTH keys resolve: the workflow being bound, and the handler it nominates (a user picking a
    // handler from a stale list, or a CLI passing a retired key, must still bind the right graph).
    const key = await this.liveKey(tenantId, workflowKey);
    await this.assertActor(actor, "edit", key, environmentId);
    if (!errorWorkflowKey) {
      await getPrisma().errorHandler.deleteMany({
        where: { tenantId, environmentId, workflowKey: key },
      });
      return;
    }
    const handler = await this.liveKey(tenantId, errorWorkflowKey);
    await getPrisma().errorHandler.upsert({
      where: {
        tenantId_environmentId_workflowKey: {
          tenantId,
          environmentId,
          workflowKey: key,
        },
      },
      create: {
        tenantId,
        environmentId,
        workflowKey: key,
        errorWorkflowKey: handler,
      },
      update: { errorWorkflowKey: handler },
    });
  }

  /** Whether this workflow's automatic triggers may fire. ABSENCE ⇒ ACTIVE (see the
   *  WorkflowActivation model note): existing workflows have no row and must keep working. */
  async isActive(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
  ): Promise<boolean> {
    const key = await this.liveKey(tenantId, workflowKey);
    const row = await getPrisma().workflowActivation.findUnique({
      where: {
        tenantId_environmentId_workflowKey: {
          tenantId,
          environmentId,
          workflowKey: key,
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
    const key = await this.liveKey(tenantId, workflowKey);
    await getPrisma().workflowActivation.upsert({
      where: {
        tenantId_environmentId_workflowKey: {
          tenantId,
          environmentId,
          workflowKey: key,
        },
      },
      create: { tenantId, environmentId, workflowKey: key, active },
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
    const key = await this.liveKey(tenantId, workflowKey);
    const existed = await getPrisma().graphDefinition.findFirst({
      where: { tenantId, environmentId, workflowKey: key },
      select: { workflowKey: true },
    });
    if (!existed) return false;

    const p = getPrisma();
    // Does the workflow survive in ANOTHER environment? Aliases are TENANT-wide, so they may only
    // be released once the LAST env's copy is gone — otherwise a sandbox delete would strand prod's
    // sub-workflow references and armed schedules on an unresolvable key.
    const elsewhere = await p.graphDefinition.findFirst({
      where: {
        tenantId,
        workflowKey: key,
        environmentId: { not: environmentId },
      },
      select: { workflowKey: true },
    });
    // Always delete THIS env's rows: graph, activation, pins, error-handler bindings, and the
    // trigger endpoints (all env-scoped now) — a sandbox delete can no longer wipe prod's
    // webhooks for the same key, and no longer orphans its own.
    const ops = [
      p.graphDefinition.deleteMany({
        where: { tenantId, environmentId, workflowKey: key },
      }),
      p.workflowActivation.deleteMany({
        where: { tenantId, environmentId, workflowKey: key },
      }),
      p.pinnedData.deleteMany({
        where: { tenantId, environmentId, workflowKey: key },
      }),
      // Bindings where this key is EITHER the failing workflow or the handler.
      p.errorHandler.deleteMany({
        where: {
          tenantId,
          environmentId,
          OR: [{ workflowKey: key }, { errorWorkflowKey: key }],
        },
      }),
      // Triggers reference the graph key as `workflowId`.
      p.webhookEndpoint.deleteMany({
        where: { tenantId, environmentId, workflowId: key },
      }),
      p.formEndpoint.deleteMany({
        where: { tenantId, environmentId, workflowId: key },
      }),
      p.chatEndpoint.deleteMany({
        where: { tenantId, environmentId, workflowId: key },
      }),
      // Poll cursors are env-scoped now (env-scoped-schedules slice) — always deleted for
      // THIS env, like every other row. The former deleteShared gate is gone with it.
      p.pollState.deleteMany({
        where: { tenantId, environmentId, workflowKey: key },
      }),
    ];
    // Free the retired keys with the last copy (#904). Without this, deleting a renamed workflow
    // would leave its old keys permanently reserved — `upsert` refuses to save under a retired
    // alias, so nobody could ever re-use the name. Deleting the workflow IS the release path.
    if (!elsewhere) {
      ops.push(
        p.workflowKeyAlias.deleteMany({
          where: { tenantId, workflowKey: key },
        }),
      );
    }
    await p.$transaction(ops);
    return true;
  }
}

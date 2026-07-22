import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { All, BadRequestException, Controller, Req, Res } from "@nestjs/common";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { ApiExcludeController } from "@nestjs/swagger";
import type { GraphDef } from "@naary/dsl";
import { ApiTokenService } from "../auth/api-token.service";
import { Public } from "../auth/public.decorator";
import type { Principal } from "../auth/tenant.decorator";
import { ExecutionsService } from "../executions/executions.service";
import { GraphGeneratorService } from "../graphs/graph-generator.service";
import { EnvironmentsService } from "../environments/environments.service";
import { GraphsService } from "../graphs/graphs.service";
import { PermissionsService } from "../permissions/permissions.service";
import type { McpCreateWorkflowArgs } from "./mcp.server";
import { buildMcpServer } from "./mcp.server";

/** Light top-level shape guard (upsert's validateGraph does the deep checks) so a non-graph
 *  arg is a clean 400, not a 500. */
function asGraphDef(g: Record<string, unknown>): GraphDef {
  if (
    !Array.isArray(g.nodes) ||
    !Array.isArray(g.edges) ||
    typeof g.startNodeId !== "string"
  ) {
    throw new BadRequestException(
      "graph must have { nodes: [], edges: [], startNodeId: string }",
    );
  }
  return g as unknown as GraphDef;
}

/** A stable-ish workflowKey from a name + short random suffix (avoids collisions across
 *  separate creates of the same name). */
function deriveWorkflowKey(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 40) || "workflow";
  return `${slug}-${randomBytes(3).toString("hex")}`;
}

/** Nest/Express parses the JSON body onto the request; the transport wants that parsed value. */
type McpRequest = IncomingMessage & { body?: unknown };

/** A JSON-RPC 2.0 error envelope (what MCP speaks) for failures before the transport runs. */
function rpcError(
  status: number,
  code: number,
  message: string,
  res: ServerResponse,
): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
  );
}

/**
 * The naary MCP server endpoint (design §3). Mounted OUTSIDE the global bearer AuthGuard
 * (`@Public()`) because MCP auth is handled here: an `Authorization: Bearer nry_…` token is
 * verified with the SAME ApiTokenService the guard uses, yielding the session's tenantId — the
 * one and only tenant scope for every tool call.
 *
 * Stateful Streamable HTTP (ticket #469): a POST carrying an MCP `initialize` request opens a
 * SESSION — the transport mints an `mcp-session-id`, we build the tenant-scoped server ONCE and
 * keep the { transport, server, tenantId } tuple in a per-instance map. Subsequent requests carry
 * that id:
 *   - POST  → dispatch to the session's transport (tool calls, notifications).
 *   - GET   → open the server→client SSE stream on the same transport (was 405).
 *   - DELETE→ terminate the session on the same transport (session close; was 405).
 * A first POST with no session id must be an `initialize` (otherwise 400); any other method with
 * no/unknown session id is rejected. Tenant scope is frozen at initialize and re-checked on every
 * subsequent request: a session id belonging to another tenant is indistinguishable from an
 * unknown one (both 404) so a session can never cross tenants.
 *
 * The session map is in-memory and per-API-instance — inherent to the SDK's Streamable HTTP model
 * (this is the NestJS control plane, not the Temporal worker; Tier-1 rule 7 is about the latter).
 * A multi-instance API would need sticky routing; an idle session with no DELETE leaks its map
 * entry until process exit (follow-up: an idle-timeout sweep).
 *
 * Params are typed as Node's IncomingMessage/ServerResponse (what the SDK transport expects);
 * the Express objects Nest passes at runtime extend them.
 */
// Not a REST endpoint — an MCP Streamable-HTTP (JSON-RPC) transport documented in
// docs/design/MCP-SERVER.md. Excluded from the OpenAPI schema so it doesn't render as a
// bogus @All route; consumers connect with an MCP client, not curl.
@ApiExcludeController()
@Controller("mcp")
export class McpController {
  /**
   * Live MCP sessions, keyed by the transport's `mcp-session-id`. Each entry owns the tenant it was
   * initialized for; GET/DELETE/subsequent-POST must present a matching tenant or the session is
   * treated as unknown (404). Populated on `onsessioninitialized`, evicted on the transport's
   * `onclose` (fires on DELETE / terminate).
   */
  private readonly sessions = new Map<
    string,
    {
      transport: StreamableHTTPServerTransport;
      server: ReturnType<typeof buildMcpServer>;
      tenantId: string;
    }
  >();

  constructor(
    private readonly tokens: ApiTokenService,
    private readonly graphs: GraphsService,
    private readonly executions: ExecutionsService,
    private readonly generator: GraphGeneratorService,
    private readonly environments: EnvironmentsService,
    private readonly permissions: PermissionsService,
  ) {}

  @Public()
  @All()
  async handle(
    @Req() req: McpRequest,
    @Res() res: ServerResponse,
  ): Promise<void> {
    const method = req.method ?? "";
    if (method !== "POST" && method !== "GET" && method !== "DELETE") {
      // PUT/PATCH/etc. are not part of the Streamable HTTP transport.
      rpcError(
        405,
        -32000,
        "Method not allowed — the MCP endpoint speaks POST, GET (SSE) and DELETE.",
        res,
      );
      return;
    }

    // Every method authenticates: the token yields the tenant scope AND, for a request bound to
    // an existing session, the tenant we match the session against.
    const auth = await this.authenticate(req);
    if (!auth) {
      rpcError(
        401,
        -32001,
        "Unauthorized — send Authorization: Bearer nry_… (an naary API token).",
        res,
      );
      return;
    }
    const { tenantId } = auth;

    const sessionId = this.sessionIdHeader(req);

    // A request carrying a session id must resolve to a live session OWNED BY THIS TENANT. A
    // missing session (or one belonging to another tenant) is a single, indistinguishable 404 —
    // never leak that a foreign session id exists.
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session || session.tenantId !== tenantId) {
        rpcError(404, -32001, "Unknown MCP session.", res);
        return;
      }
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    // No session id. Only a POST that is an `initialize` may open one; a bare GET/DELETE (or a
    // non-initialize POST) has nothing to dispatch to.
    if (method !== "POST" || !isInitializeRequest(req.body)) {
      rpcError(
        400,
        -32000,
        method === "POST"
          ? "Missing mcp-session-id — send an `initialize` request first to open a session."
          : "Missing mcp-session-id header.",
        res,
      );
      return;
    }

    await this.openSession(auth, req, res);
  }

  /**
   * Open a new MCP session for an `initialize` POST: build the tenant-scoped server once, hand it a
   * session-minting transport, and register the { transport, server, tenantId } tuple keyed by the
   * generated session id so later GET/DELETE/POST on this session resolve to it.
   */
  private async openSession(
    auth: { id: string; tenantId: string; environmentId: string | null },
    req: McpRequest,
    res: ServerResponse,
  ): Promise<void> {
    const { tenantId } = auth;

    // A token bound to an environment operates in it; an unbound token falls back to the
    // tenant's default env (design §Slice 4 — endpoint/token's env wins).
    const envId =
      auth.environmentId ?? (await this.environments.defaultEnvId(tenantId));

    // MCP auths OUTSIDE the AuthGuard, so the §4a token stamping is mirrored here: in a
    // workspace with ≥1 WorkflowGrant this token is a RESTRICTED subject (member+tokenId)
    // and every tool call below threads it as the actor — same first-grant cliff, same
    // union-of-groups resolution as v1/SPA callers. Zero grants ⇒ no actor (full access,
    // today's behavior). Scope is FROZEN here for the session's lifetime.
    const actor: Principal | undefined =
      (await this.permissions.isTenantEnforced(tenantId))
        ? { tenantId, role: "member", tokenId: auth.id }
        : undefined;

    // Flavor B (design §5): expose only workflows that OPT IN via an `mcpServerTrigger` entry
    // node — each becomes its own tool (its configured toolName/description). Opt-in, not
    // expose-all: a workflow without the node is still runnable via the generic run_workflow.
    // Best-effort — a listing hiccup just means no per-workflow tools this session.
    // View-FILTERED for a restricted token (never expose tools it can't see).
    const exposedWorkflows = await this.graphs
      .listMcpExposed(tenantId, envId, actor)
      .catch(() => []);

    // Deps are pre-scoped to the token's tenantId — a tool can't reach another tenant.
    const server = buildMcpServer({
      tenantId,
      listWorkflows: () => this.graphs.list(tenantId, envId, actor),
      // G3 (§8.4): run reads/decisions are gated on the run's workflow for a
      // restricted token — same actor threading as runWorkflow.
      getRun: (runId) => this.executions.getState(runId, tenantId, actor),
      runWorkflow: (workflowKey, input) =>
        this.executions
          .start(tenantId, envId, input, workflowKey, undefined, actor)
          .then((r) => ({ runId: r.workflowId })),
      // Per-workflow (flavor B) tools are AUTOMATIC external triggers → activation-gated
      // (refused when the workflow is inactive, like the form/webhook ingress), unlike the
      // operator-facing run_workflow above which mirrors the ungated manual "Run".
      runExposedWorkflow: (workflowKey, input) =>
        this.executions
          .startMcpTrigger(tenantId, envId, input, workflowKey)
          .then((r) => ({ runId: r.workflowId })),
      createWorkflow: (args) =>
        this.createWorkflow(tenantId, envId, args, actor),
      approve: (runId, approved, note) =>
        this.executions.approve(runId, approved, tenantId, note, actor),
      exposedWorkflows,
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // Register the session under the tenant it was born in the moment the id is minted.
      onsessioninitialized: (sid) => {
        this.sessions.set(sid, { transport, server, tenantId });
      },
    });
    // The session — not the response — owns the teardown: fires on DELETE / terminate, evicting
    // the map entry and closing the server. (A POST response ending does NOT end the session.)
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) this.sessions.delete(sid);
      void server.close();
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  /** The `mcp-session-id` request header, normalized to a single string (or undefined). */
  private sessionIdHeader(req: McpRequest): string | undefined {
    const raw = req.headers["mcp-session-id"];
    return Array.isArray(raw) ? raw[0] : raw;
  }

  /**
   * create_workflow: draft a graph from a `prompt` (AI builder) or accept an agent-authored
   * `graph`, and optionally persist it. Same generate + upsert paths as the REST/canvas flow, so
   * validation, versioning, and (for a prompt) BYOK provider use are identical.
   */
  private async createWorkflow(
    tenantId: string,
    environmentId: string,
    { prompt, name, graph, save, workflowKey }: McpCreateWorkflowArgs,
    /** Restricted-token subject (§4a) — gates the save (edit vs canCreate) in upsert. */
    actor?: Principal,
  ) {
    let draftName: string;
    let draftGraph: GraphDef;
    if (prompt?.trim()) {
      const gen = await this.generator.generate(
        tenantId,
        environmentId,
        prompt,
      );
      draftName = name?.trim() || gen.name;
      draftGraph = gen.graph;
    } else if (graph) {
      draftName = name?.trim() || "Workflow";
      draftGraph = asGraphDef(graph);
    } else {
      throw new BadRequestException("Provide either `prompt` or `graph`.");
    }

    if (!save) return { name: draftName, graph: draftGraph, saved: false };

    const key = workflowKey?.trim() || deriveWorkflowKey(draftName);
    const snap = await this.graphs.upsert(
      tenantId,
      environmentId,
      key,
      draftName,
      draftGraph,
      actor,
    );
    return {
      name: draftName,
      graph: draftGraph,
      saved: true,
      workflowKey: key,
      version: snap.version,
      contentHash: snap.contentHash,
    };
  }

  /** Resolve a `nry_` bearer token to its row id + tenantId + bound env (env is null if the
   *  token isn't pinned to one), or null if absent/invalid. The id is the token's RBAC subject
   *  identity (§4a) when the workspace is under group enforcement. */
  private async authenticate(req: McpRequest): Promise<{
    id: string;
    tenantId: string;
    environmentId: string | null;
  } | null> {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    return this.tokens.verify(header.slice("Bearer ".length).trim());
  }
}

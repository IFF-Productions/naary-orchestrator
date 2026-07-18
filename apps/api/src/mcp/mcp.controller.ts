import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { All, BadRequestException, Controller, Req, Res } from "@nestjs/common";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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
 * Stateless (sessionIdGenerator: undefined): a fresh server + transport per POST, closed when
 * the response ends. The read-only tools need no server→client stream or session state, so GET
 * (SSE) / DELETE (session close) are 405 for now — a later slice enables them for streaming.
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
    if (req.method !== "POST") {
      rpcError(
        405,
        -32000,
        "Method not allowed — this MCP server is POST-only for now.",
        res,
      );
      return;
    }

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

    // A token bound to an environment operates in it; an unbound token falls back to the
    // tenant's default env (design §Slice 4 — endpoint/token's env wins).
    const envId =
      auth.environmentId ?? (await this.environments.defaultEnvId(tenantId));

    // MCP auths OUTSIDE the AuthGuard, so the §4a token stamping is mirrored here: in a
    // workspace with ≥1 WorkflowGrant this token is a RESTRICTED subject (member+tokenId)
    // and every tool call below threads it as the actor — same first-grant cliff, same
    // union-of-groups resolution as v1/SPA callers. Zero grants ⇒ no actor (full access,
    // today's behavior).
    const actor: Principal | undefined =
      (await this.permissions.isTenantEnforced(tenantId))
        ? { tenantId, role: "member", tokenId: auth.id }
        : undefined;

    // Fetch the tenant's workflows up front so each can be exposed as its own tool (flavor B).
    // Best-effort — a listing hiccup just means no per-workflow tools this session.
    // View-FILTERED for a restricted token (never expose tools it can't see).
    const exposedWorkflows = await this.graphs
      .list(tenantId, envId, actor)
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
      createWorkflow: (args) =>
        this.createWorkflow(tenantId, envId, args, actor),
      approve: (runId, approved, note) =>
        this.executions.approve(runId, approved, tenantId, note, actor),
      exposedWorkflows,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    // Tear down when the client disconnects — no lingering server/transport per request.
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
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

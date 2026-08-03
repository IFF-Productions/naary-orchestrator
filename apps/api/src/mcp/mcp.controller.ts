import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  All,
  BadRequestException,
  Controller,
  type OnModuleDestroy,
  Req,
  Res,
} from "@nestjs/common";
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
import { mcpSessionMode } from "../config";

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

/**
 * How long a session may sit untouched before the sweep closes it (#1065).
 *
 * 30 minutes is chosen against the CLIENT's behaviour, not ours: Claude Desktop / Cursor hold a
 * session open across a user's whole working session, and a person can easily leave one idle over
 * a meal. Anything much shorter turns "come back to your editor" into an unexplained 404, which is
 * the failure this work exists to reduce — so the leak is traded down, not off.
 */
const SESSION_IDLE_MS = 30 * 60_000;

/** How often the janitor runs. Coarse on purpose: this reclaims memory, it does not enforce a
 *  deadline, so a session may live up to one interval past its idle window. */
const SWEEP_INTERVAL_MS = 60_000;

/** How long an expired session id is remembered so its OWNER gets a truthful message. Comfortably
 *  longer than a client's retry/backoff, far shorter than the process. */
const EXPIRED_MEMORY_MS = 60 * 60_000;

/** Hard cap on remembered ids, so a burst of short sessions can't outpace the TTL sweep. */
const EXPIRED_MAX = 500;

/** A JSON-RPC 2.0 error envelope (what MCP speaks) for failures before the transport runs. */
function rpcError(
  status: number,
  code: number,
  message: string,
  res: ServerResponse,
  /** The failing request's `id`, echoed so a client can correlate the error with the call it
   *  made. JSON-RPC allows null only when the id could not be determined — and an
   *  uncorrelatable error is part of why #1063 surfaced to the user as an opaque
   *  "probe failed" with nothing to act on. */
  id: string | number | null = null,
): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id }));
}

/**
 * The `id` to echo on a pre-transport error — that of a SINGLE request, or `null`.
 *
 * A JSON-RPC batch deliberately yields null: this path emits ONE error object, but a batch
 * carries N messages with N ids, so echoing the first would tell the client that message #1
 * failed when the rejection was about the batch as a whole. A mis-correlated id is worse than
 * an absent one — null is exactly what the spec reserves for "the id could not be determined".
 * (If this path ever answers batches per-message, that array of errors can carry real ids.)
 */
function requestId(body: unknown): string | number | null {
  if (Array.isArray(body)) return null;
  if (!body || typeof body !== "object") return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

/**
 * Is this POST body an `initialize` — for ROUTING purposes only (#1063)?
 *
 * Deliberately a METHOD check, not the SDK's `isInitializeRequest`. That helper is a strict
 * full-schema parse (`InitializeRequestSchema.safeParse`) requiring `params.protocolVersion`,
 * `params.capabilities` AND `params.clientInfo{name,version}`. A version-negotiation probe is
 * minimal by design, so it failed that parse and we told the client to "send an `initialize`
 * request first" — advice that cannot be acted on, because it had just sent one. No MCP client
 * could complete a handshake.
 *
 * Validation is not skipped, it is DELEGATED: `StreamableHTTPServerTransport.handleRequest`
 * validates the initialize itself and answers a malformed one with a spec-compliant JSON-RPC
 * error naming the offending field — a message the client can actually fix. Routing decides
 * WHERE the request goes; the transport decides whether it is well-formed.
 *
 * Batches count: JSON-RPC batching is legal in protocol 2025-03-26 (dropped in 2025-06-18), and
 * a batched initialize is still an initialize to a router.
 */
function looksLikeInitialize(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some(
    (m) =>
      !!m &&
      typeof m === "object" &&
      (m as { method?: unknown }).method === "initialize",
  );
}

/**
 * The naary MCP server endpoint (design §3). Mounted OUTSIDE the global bearer AuthGuard
 * (`@Public()`) because MCP auth is handled here: an `Authorization: Bearer nry_…` token is
 * verified with the SAME ApiTokenService the guard uses, yielding the session's tenantId — the
 * one and only tenant scope for every tool call.
 *
 * TWO MODES (#1065). `MCP_SESSION_MODE` selects; STATELESS is the default.
 *
 * STATELESS — every request builds its own server + transport and closes both. No session map, so
 * any API container can answer anything and a `docker rollout` interrupts nothing. Costs one
 * `listMcpExposed` per call and forecloses the server→client stream (no subscriptions, no
 * server-initiated logging) — neither of which anything here uses today. GET is refused with a
 * message naming the mode; DELETE is a no-op 204.
 *
 * STATEFUL — the original design, below, kept as the recovery lever. Whether real MCP clients
 * REQUIRE the GET stream to hold a connection could not be verified before shipping, so this
 * exists to fix a broken client without a rollback.
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
 * TWO consequences, and only one of them is now handled (#1065):
 *   - An idle session no longer leaks: a sweep closes anything untouched for SESSION_IDLE_MS, and
 *     the owner of a swept session is told so rather than getting a bare "unknown".
 *   - A MULTI-INSTANCE API still needs sticky routing or a shared store. `docker rollout` scales
 *     the API to 2 during a deploy, so a session minted on one container can be answered by the
 *     other — and every session dies when the old container retires. That is the remaining half of
 *     #1065 and the prerequisite for MCP subscriptions/logging, which assume a durable session.
 *
 * Params are typed as Node's IncomingMessage/ServerResponse (what the SDK transport expects);
 * the Express objects Nest passes at runtime extend them.
 */
// Not a REST endpoint — an MCP Streamable-HTTP (JSON-RPC) transport documented in
// docs/design/MCP-SERVER.md. Excluded from the OpenAPI schema so it doesn't render as a
// bogus @All route; consumers connect with an MCP client, not curl.
@ApiExcludeController()
@Controller("mcp")
export class McpController implements OnModuleDestroy {
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
      /** Wall-clock of the last request dispatched to this session — the idle sweep's input. */
      lastSeenAt: number;
    }
  >();

  /**
   * Sessions THIS instance evicted for idleness, so the owner can be told why (#1065).
   *
   * Without this, an expired session and a never-existent one give the same "Unknown MCP session",
   * and a user whose client sat idle over lunch has no way to tell a bug from a timeout.
   *
   * TENANT-MATCHED on read, which is the whole reason this is safe. The 404 above is deliberately
   * indistinguishable between "no such session" and "someone else's session" — saying "expired"
   * to a stranger would confirm that an id they guessed once existed. So a tombstone only ever
   * speaks to the tenant that owned the session; everyone else still gets the flat answer.
   *
   * Only OUR evictions land here. A session lost to a deploy leaves no tombstone — the process
   * that held it is gone — which is exactly why the generic message names a deploy as a cause
   * rather than pretending we can always tell.
   */
  private readonly expired = new Map<
    string,
    { tenantId: string; at: number }
  >();

  /** The idle sweep's timer, cleared on shutdown so a test/worker process can exit. */
  private sweepTimer?: ReturnType<typeof setInterval>;

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

    // STATELESS (#1065, the default): no session map at all, so nothing below about session ids
    // applies. Diverting here rather than threading conditionals through the stateful path keeps
    // the two modes readable as two modes.
    if (mcpSessionMode() === "stateless") {
      await this.handleStateless(auth, req, res);
      return;
    }

    const sessionId = this.sessionIdHeader(req);

    // A request carrying a session id must resolve to a live session OWNED BY THIS TENANT. A
    // missing session (or one belonging to another tenant) is a single, indistinguishable 404 —
    // never leak that a foreign session id exists.
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session || session.tenantId !== tenantId) {
        rpcError(
          404,
          -32001,
          this.unknownSessionMessage(sessionId, tenantId),
          res,
        );
        return;
      }
      // Touch BEFORE dispatching: a long-running tool call must not look idle for its duration,
      // and a GET holding the SSE stream open would otherwise be swept mid-stream.
      session.lastSeenAt = Date.now();
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    // No session id. Only a POST that is an `initialize` may open one; a bare GET/DELETE (or a
    // non-initialize POST) has nothing to dispatch to. The check is on the METHOD only — see
    // looksLikeInitialize for why the SDK's strict schema helper cannot be the gate (#1063).
    if (method !== "POST" || !looksLikeInitialize(req.body)) {
      rpcError(
        400,
        // Invalid Request — the standard code for a well-formed JSON-RPC message that cannot be
        // processed in this state, rather than the server-defined -32000 this used to send.
        -32600,
        method === "POST"
          ? "Missing mcp-session-id — send an `initialize` request first to open a session."
          : "Missing mcp-session-id header — open a session with an `initialize` POST, then send " +
              "its `mcp-session-id` on every later request (GET opens the stream for an EXISTING session).",
        res,
        requestId(req.body),
      );
      return;
    }

    await this.openSession(auth, req, res);
  }

  /**
   * Build a tenant-scoped `McpServer` for this token. Extracted from `openSession` because the
   * STATELESS path (#1065) needs the identical server per request — one construction site means
   * the two modes cannot drift on tenant scoping, actor derivation or which tools are exposed,
   * which is the part that would be a security bug rather than a behaviour difference.
   */
  private async buildScopedServer(auth: {
    id: string;
    tenantId: string;
    environmentId: string | null;
  }): Promise<ReturnType<typeof buildMcpServer>> {
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
    return server;
  }

  /**
   * Serve one MCP request with no session state at all (#1065).
   *
   * WHY THIS MODE EXISTS. Stateful Streamable HTTP keeps `{ transport, server }` in a map on ONE
   * API container. `docker rollout` scales the API to 2, so a session minted on container A 404s
   * whenever B answers, and every session dies when A retires. The SDK exposes no way to adopt a
   * session id elsewhere (`sessionId` is a getter, `_initialized` is private), and sticky routing
   * needs stable per-container hostnames that rollout deliberately removes. Stateless deletes the
   * shared state rather than trying to share it: any container can answer anything, and a deploy
   * interrupts nothing.
   *
   * A FRESH TRANSPORT PER REQUEST IS MANDATORY, not tidiness. The SDK throws
   * "Stateless transport cannot be reused across requests" on a second `handleRequest` — reuse
   * would collide JSON-RPC message ids between concurrent clients. So the server is rebuilt too,
   * which is the real cost: one `listMcpExposed` query per call where stateful paid it per
   * session. Accepted knowingly — it also means a workflow that just opted in shows up on the
   * NEXT call rather than requiring a reconnect, which was its own reported confusion.
   *
   * GET IS REFUSED, and that is the honest answer rather than a gap. GET opens the server→client
   * SSE stream, which presupposes a session to stream INTO; there isn't one, and nothing in
   * `mcp.server.ts` pushes server-initiated messages anyway (no subscriptions, no logging — every
   * tool is request/response). Refusing with a message that names the mode beats accepting a
   * stream that can never deliver anything.
   */
  private async handleStateless(
    auth: { id: string; tenantId: string; environmentId: string | null },
    req: McpRequest,
    res: ServerResponse,
  ): Promise<void> {
    const method = req.method ?? "";
    if (method === "GET") {
      rpcError(
        405,
        -32000,
        "This MCP endpoint is stateless — there is no server→client stream to open. " +
          "Send tool calls as POSTs; no session id is needed.",
        res,
        requestId(req.body),
      );
      return;
    }
    if (method === "DELETE") {
      // Terminating a session that does not exist is a no-op, not an error: a spec-compliant
      // client sends DELETE on disconnect and must not be told its cleanup failed.
      res.writeHead(204);
      res.end();
      return;
    }

    const server = await this.buildScopedServer(auth);
    // `sessionIdGenerator: undefined` is what puts the SDK in stateless mode — session validation
    // is skipped entirely, so an `mcp-session-id` header from a client that once spoke to a
    // stateful deployment is ignored rather than 404'd.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } finally {
      // Both are per-request now, so both must go — otherwise "no session leak" is traded for a
      // per-REQUEST leak, which is strictly worse. try/catch each: the response is already
      // written by here, so a throw would surface as an unhandled rejection on a request the
      // client considers answered.
      try {
        await transport.close();
      } catch {
        /* best-effort teardown */
      }
      try {
        await server.close();
      } catch {
        /* best-effort teardown */
      }
    }
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
    const server = await this.buildScopedServer(auth);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // Register the session under the tenant it was born in the moment the id is minted.
      onsessioninitialized: (sid) => {
        this.sessions.set(sid, {
          transport,
          server,
          tenantId,
          lastSeenAt: Date.now(),
        });
        // A reused id would otherwise keep reporting "expired" for a session that is live again.
        this.expired.delete(sid);
        this.startSweep();
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

    // If the SDK REJECTED the initialize (malformed params — the case routing now lets through,
    // #1063), `onsessioninitialized` never fired, so nothing registered this transport and its
    // `onclose` teardown would never run either. Close it here or a client retrying a bad
    // handshake allocates a server per attempt.
    // try/catch, not `.catch()` — the response has already been written by this point, so a
    // throw here (including from a close() that doesn't return a promise) would surface as an
    // unhandled rejection on a request the client already considers answered.
    if (!transport.sessionId) {
      try {
        await transport.close();
      } catch {
        /* best-effort teardown */
      }
      try {
        await server.close();
      } catch {
        /* best-effort teardown */
      }
    }
  }

  /** The `mcp-session-id` request header, normalized to a single string (or undefined). */
  private sessionIdHeader(req: McpRequest): string | undefined {
    const raw = req.headers["mcp-session-id"];
    return Array.isArray(raw) ? raw[0] : raw;
  }

  /**
   * What to say when a session id doesn't resolve (#1065).
   *
   * The 404 stays a 404 in every case — this only chooses the prose. The owner of a session WE
   * swept gets the true reason; everyone else gets a message that names the causes without
   * claiming to know which one applies, because for the two we cannot observe (a deploy replaced
   * the process; the id was never real) we genuinely cannot tell.
   *
   * The tenant match is load-bearing, not incidental: an unmatched id must read exactly like an
   * unknown one, or the wording becomes an oracle for which session ids exist.
   */
  private unknownSessionMessage(sessionId: string, tenantId: string): string {
    const tomb = this.expired.get(sessionId);
    if (tomb && tomb.tenantId === tenantId) {
      return (
        `MCP session expired after ${Math.round(SESSION_IDLE_MS / 60_000)} minutes idle. ` +
        `Re-initialize to start a new one.`
      );
    }
    return (
      "Unknown MCP session — it may have expired, or ended when the server was redeployed. " +
      "Re-initialize to start a new one."
    );
  }

  /**
   * Start the idle sweep on first session, not at construction.
   *
   * Nest instantiates this controller in every API process including ones that never see an MCP
   * request; a timer created eagerly would tick forever for nothing. Lazily started and
   * `unref()`d, so it never holds the event loop open — a test or a shutting-down process exits
   * with the timer still armed, which is the behaviour we want from a janitor.
   */
  private startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  /**
   * Close sessions no request has touched for `SESSION_IDLE_MS`.
   *
   * Why this exists (#1065): only an explicit DELETE evicted a session, so a client that simply
   * went away left its map entry AND its built `McpServer` alive until the process exited. Every
   * abandoned session was a permanent leak, and the exposure grows with uptime.
   *
   * Closing the TRANSPORT rather than deleting the map entry directly: `transport.onclose` is what
   * owns teardown (it deletes the entry and closes the server), so going through it keeps one
   * teardown path instead of two that can drift. The entry is tombstoned first, because onclose
   * runs synchronously enough that writing it afterwards would race the next request.
   */
  private sweep(): void {
    const now = Date.now();
    for (const [sid, s] of this.sessions) {
      if (now - s.lastSeenAt < SESSION_IDLE_MS) continue;
      this.rememberExpired(sid, s.tenantId, now);
      void Promise.resolve(s.transport.close()).catch(() => {
        // Best-effort: a transport that fails to close must not stop the sweep from reaching the
        // rest of the map, and there is no client waiting on this.
        this.sessions.delete(sid);
      });
    }
    // Tombstones are a courtesy, not state anyone depends on — expire them on the same pass so
    // this map cannot become the leak the sweep was written to fix.
    for (const [sid, t] of this.expired) {
      if (now - t.at > EXPIRED_MEMORY_MS) this.expired.delete(sid);
    }
  }

  private rememberExpired(
    sessionId: string,
    tenantId: string,
    at: number,
  ): void {
    // Bounded by count as well as by time: a burst of short-lived sessions must not outrun the
    // TTL sweep above. Oldest insertion goes first (Map preserves insertion order).
    if (this.expired.size >= EXPIRED_MAX) {
      const oldest = this.expired.keys().next().value;
      if (oldest !== undefined) this.expired.delete(oldest);
    }
    this.expired.set(sessionId, { tenantId, at });
  }

  /** Nest lifecycle: stop the janitor so a shutting-down process (or a test) isn't kept alive. */
  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
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

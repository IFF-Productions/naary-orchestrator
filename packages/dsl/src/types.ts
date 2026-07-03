/**
 * The graph DSL: the data a workflow is compiled to and the interpreter walks.
 * Platform-agnostic — no Temporal, no I/O. (CLAUDE.md: interpreter, not codegen.)
 */

export type NodeType =
  | "start"
  | "webhookTrigger" // Slice #4: entry node whose output is the inbound event
  | "agent"
  | "mcpTool" // Slice #4: calls a remote MCP server tool via a connection
  | "httpRequest" // calls a plain HTTP/REST endpoint; output is {status,headers,body}
  | "sqlQuery" // runs a read-only query against a tenant DB; output is {rows,rowCount}
  | "set" // builds a plain object from static fields + upstream bindings (pure, no I/O)
  | "executeSubWorkflow" // runs another saved graph as a child run; output is {status,ctx}
  | "humanApproval"
  | "end";

export interface NodeDef {
  id: string;
  type: NodeType;
  /** Node-specific configuration, e.g. the agent node's canned output. */
  config?: Record<string, unknown>;
}

/**
 * Slice #4 — bind one MCP tool argument to an upstream node's output.
 * `from` is the producing node id; `path` is an optional dotted path into that
 * node's output (e.g. "pull_request.number", "output.category"). Resolved purely
 * in the interpreter (deterministic graph-traversal work), never in the activity.
 */
export interface ArgBinding {
  from: string;
  path?: string;
}

/** Start node: an optional sample trigger input used for manual/test runs. */
export interface StartNodeConfig {
  sampleInput?: Record<string, unknown>;
}

/** Human-approval node config. The interpreter reads `timeoutHours` to bound the
 *  durable wait (auto-reject on elapse); title/instructions are display-only (the
 *  UI reads them from the graph). */
export interface ApprovalNodeConfig {
  title?: string;
  instructions?: string;
  /** Auto-reject if no decision within this many hours (omitted = wait forever). */
  timeoutHours?: number;
}

export interface McpToolNodeConfig {
  connectionId: string;
  tool: string;
  /** Static arguments, merged under any resolved bindings. */
  arguments?: Record<string, unknown>;
  /** argName → upstream output binding; overrides a static key of the same name. */
  argumentBindings?: Record<string, ArgBinding>;
  /** Flat per-call cost metered into the run budget (Slice #6 / Arch§4.6). */
  costUsd?: number;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * HTTP Request node — call a plain HTTP/REST endpoint. Output is the structured
 * response `{ status, headers, body }`, so the graph branches on it via an
 * `EdgeCondition` on `<nodeId>.status`.
 *
 * SECURITY (CLAUDE.md Tier-1 rule 4 / Sec#2): this `config` rides in the graph
 * snapshot → Temporal history. Auth material must NEVER live here — it comes only
 * via `connectionId`, resolved + attached IN the activity. Treat `headers`/`url`/
 * `body` as non-secret; the UI offers a connection picker, not a free-text
 * Authorization field. The egress (SSRF) check runs in the activity on the
 * fully-resolved URL.
 */
export interface HttpRequestNodeConfig {
  method: HttpMethod;
  /** Target URL (https only — enforced by the egress guard at call time). */
  url: string;
  /** Static, NON-SECRET headers. Auth must come via `connectionId`, not here. */
  headers?: Record<string, string>;
  /** Static query params, appended to the URL. */
  query?: Record<string, string>;
  /** JSON request body (object or string). Ignored for GET. */
  body?: unknown;
  /** field path (e.g. "url", "body.userId", "query.q", "headers.X-Trace") →
   *  upstream output binding; overrides the static value at that path. */
  argumentBindings?: Record<string, ArgBinding>;
  /** Optional connection supplying the auth header (resolved in-activity). */
  connectionId?: string;
  /** When true, a response status ≥ 400 fails the node (non-retryable) instead of
   *  being returned for the graph to branch on. Default false. */
  failOnErrorStatus?: boolean;
  /** Abort the request after this many ms (default applied in the activity). */
  timeoutMs?: number;
  /** Flat per-call cost metered into the run budget (Arch§4.6) — HTTP has no
   *  token cost, so spend is operator-configured. */
  costUsd?: number;
}

/**
 * SQL query node — run a single READ-ONLY query against a tenant's database
 * (Postgres or MSSQL; the engine comes from the connection, not here). Output is
 * `{ rows, rowCount }`.
 *
 * SECURITY: the `sql` text is STATIC and passed verbatim — bindings fill the
 * positional `params` array ONLY, never the query string (anything else
 * reintroduces SQL injection). Auth is the connection's DSN, resolved + used IN
 * the activity (never in this config, which rides in workflow history).
 * Placeholder style is engine-specific: `$1..$n` (Postgres) / `@p1..@pn` (MSSQL).
 */
export interface SqlQueryNodeConfig {
  /** A `postgres`/`mssql` connection; its stored DSN is read in-activity. */
  connectionId: string;
  /** Static query text with positional placeholders. Never built from bindings. */
  sql: string;
  /** Static positional parameter values (the base for bindings). */
  params?: unknown[];
  /** 1-based param index → upstream output binding; fills/overrides that position. */
  paramBindings?: Record<number, ArgBinding>;
  /** Per-query timeout (ms) — Postgres statement_timeout / MSSQL request timeout. */
  statementTimeoutMs?: number;
  /** Flat per-call cost metered into the run budget (Arch§4.6). */
  costUsd?: number;
}

/**
 * Set (Edit Fields) node — build a plain JSON object to pass downstream. Output is
 * exactly the built object (REPLACE-only: there is no implicit "input" to merge
 * with — bind explicitly from an upstream node id if you want a prior value).
 * Downstream nodes read fields via `<nodeId>.<field>`.
 *
 * PURE: this is deterministic graph work (no I/O, no secrets), resolved in the
 * interpreter like `resolveMcpArguments`/`resolveHttpRequest`. `fields` is the
 * static base; each `fieldBindings` entry fills/overrides the value at its dotted
 * path from an upstream output.
 */
export interface SetNodeConfig {
  /** Static base object (the values typed into the node). */
  fields?: Record<string, unknown>;
  /** dotted field path (e.g. "user.id", "total") → upstream output binding;
   *  overrides the static value at that path. */
  fieldBindings?: Record<string, ArgBinding>;
}

/**
 * Execute Sub-workflow node — run another of the tenant's saved graphs as a
 * durable CHILD run, wait for it, and expose its result. Output is
 * `{ status, output }` — the child's terminal status + a bounded projection of its
 * node outputs (internal `__*` keys dropped) — so the parent graph can branch on
 * `<nodeId>.status` and read child results via `<nodeId>.output.*`.
 *
 * The child graph is resolved by `workflowKey` (latest version) IN an activity
 * (I/O), then launched with `wf.executeChild` (deterministic). Only `workflowKey`
 * — never a secret — lives in this config. The child input is built purely in the
 * interpreter from `input` + `inputBindings`; when neither is set the child
 * receives the parent's trigger input.
 */
export interface ExecuteSubWorkflowNodeConfig {
  /** The saved-graph key to run as a child (this tenant's latest version). */
  workflowKey: string;
  /** Static base for the child's input object. */
  input?: Record<string, unknown>;
  /** dotted input path → upstream output binding; fills/overrides that path. */
  inputBindings?: Record<string, ArgBinding>;
}

/**
 * Slice #6 — a structured, PURE edge predicate (never code/eval). Evaluated
 * against the run `ctx` to decide whether to take the edge. `path` is a dotted
 * path into ctx (e.g. "agent.output.category"); `op` compares the resolved value
 * to `value`. An edge with no condition is unconditional (linear/parallel).
 */
export interface EdgeCondition {
  path: string;
  op: "eq" | "neq" | "in" | "exists" | "gt" | "lt";
  value?: unknown;
}

export interface EdgeDef {
  from: string;
  to: string;
  condition?: EdgeCondition;
}

export interface GraphDef {
  nodes: NodeDef[];
  edges: EdgeDef[];
  startNodeId: string;
}

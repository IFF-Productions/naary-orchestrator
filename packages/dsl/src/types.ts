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
  | "renameKeys" // pure: remap/drop keys of an upstream object
  | "filter" // pure: keep array items matching a per-item predicate
  | "aggregate" // pure: collapse an array (collect/count/sum/first/last)
  | "dateTime" // current time / timestamp math via an activity (clock read is I/O)
  | "merge" // fan-in join: run once after all inbound branches arrive; combine outputs
  | "hmac" // signs a payload with a `signing` connection's key (activity); output is the digest
  | "jwt" // mints an HS256 JWT signed by a `signing` connection's key (activity)
  | "totp" // generates the current RFC-6238 TOTP code from a `signing` connection's seed
  | "sendEmail" // sends an email via an `smtp` connection (activity)
  | "executeSubWorkflow" // runs another saved graph as a child run; output is {status,output}
  | "wait" // durable delay (Temporal timer); no output
  | "stopAndError" // terminal: fail the run with a message
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
 * Rename Keys node — reshape an upstream object by renaming and/or dropping its
 * top-level keys. PURE (deterministic ctx read, no I/O). Output is the reshaped
 * object; downstream reads `<nodeId>.<newKey>`.
 */
export interface RenameKeysNodeConfig {
  /** Upstream node id whose output object to reshape. */
  from: string;
  /** Optional dotted path into that output to pick the object to reshape. */
  path?: string;
  /** oldKey → newKey. Keys not listed are kept as-is (unless dropped). */
  rename?: Record<string, string>;
  /** Top-level keys to remove from the output. */
  drop?: string[];
}

/**
 * Filter node — keep the items of an upstream ARRAY that match a per-item predicate.
 * PURE (deterministic ctx read, no I/O). The predicate is the same structured
 * `EdgeCondition` used on edges, evaluated against each item (so `condition.path` is
 * relative to the item). Output is the filtered array; a non-array source yields `[]`.
 */
export interface FilterNodeConfig {
  /** Upstream node id whose output holds the array. */
  from: string;
  /** Optional dotted path into that output to reach the array. */
  path?: string;
  /** Per-item predicate (reuses the edge-condition op set). */
  condition: EdgeCondition;
}

/** Aggregate operations over an upstream array. */
export type AggregateOp =
  "collect" | "count" | "sum" | "min" | "max" | "avg" | "first" | "last";

/**
 * Aggregate node — collapse an upstream ARRAY into a single value. PURE. `collect`
 * → the array of `field` values (or whole items when `field` is omitted); `count` →
 * length; `sum` → numeric sum over `field`; `first`/`last` → an end item. Output is
 * `{ result }` so a graph can branch on `<nodeId>.result`.
 */
export interface AggregateNodeConfig {
  /** Upstream node id whose output holds the array. */
  from: string;
  /** Optional dotted path into that output to reach the array. */
  path?: string;
  operation: AggregateOp;
  /** Field to collect/sum from each item (dotted path, relative to the item). */
  field?: string;
}

/**
 * Date & Time node — output the current time, or do timestamp math on an upstream
 * value. The clock read is non-deterministic, so it runs in an ACTIVITY (CLAUDE.md
 * rule 2/3: time out of workflow code). Output is `{ iso, epochMs }`.
 */
export interface DateTimeNodeConfig {
  /** "now" (default) reads the clock in-activity; or bind an upstream epoch-ms
   *  number / ISO string to operate on instead. */
  source?: "now" | ArgBinding;
  /** Seconds to add to the base (may be negative). */
  addSeconds?: number;
}

/**
 * HMAC node — sign a payload with a `signing` connection's secret key. The KEY is
 * never in config (only `connectionId`); it's read + used IN the activity
 * (CLAUDE.md rule 4). Output is `{ digest }` (the MAC, hex/base64). `payload` is
 * static; `payloadBinding` overrides it from an upstream output (objects are
 * JSON-stringified before signing).
 */
export interface HmacNodeConfig {
  /** A `signing` connection; its stored key is read in-activity. */
  connectionId: string;
  algorithm?: "sha256" | "sha1";
  /** Static payload to sign (string, or object → JSON). */
  payload?: unknown;
  /** Upstream binding whose value replaces `payload`. */
  payloadBinding?: ArgBinding;
  /** Output digest encoding. Default "hex". */
  encoding?: "hex" | "base64";
}

/**
 * JWT node — mint an HS256 JSON Web Token signed by a `signing` connection's key
 * (read + used IN the activity, never in config). Output is `{ token }`. `claims`
 * is the static payload; each `claimsBindings` entry fills/overrides a claim from
 * an upstream output. `iat`/`exp` are set by the signer.
 */
export interface JwtNodeConfig {
  /** A `signing` connection; its stored key is the HS256 secret. */
  connectionId: string;
  /** Static claims (the base payload). */
  claims?: Record<string, unknown>;
  /** claim path → upstream output binding; fills/overrides that claim. */
  claimsBindings?: Record<string, ArgBinding>;
  /** Token lifetime in seconds (sets `exp`). Omitted = no expiry. */
  expiresInSeconds?: number;
}

/**
 * TOTP node — generate the current RFC-6238 time-based one-time code from a base32
 * seed stored in a `signing` connection (the seed is read + used IN the activity,
 * never in config/history; the clock read is why this is an activity). Output is
 * `{ code }`. No bindings — the seed comes from the connection, the time from the
 * clock.
 */
export interface TotpNodeConfig {
  /** A `signing` connection whose secret is the base32 TOTP seed. */
  connectionId: string;
  /** Number of digits (default 6). */
  digits?: number;
  /** Time step in seconds (default 30). */
  period?: number;
  /** HMAC algorithm (default "sha1", per most authenticator apps). */
  algorithm?: "sha1" | "sha256" | "sha512";
}

/**
 * Send Email node — send a message via an `smtp` connection. The connection's SMTP
 * URI (with credentials) is read + used IN the activity (never in config/history).
 * Static `to`/`subject`/`text`/`html` are the base; each `fieldBindings` entry
 * fills/overrides that field from an upstream output. Output is `{ messageId }`.
 */
export interface SendEmailNodeConfig {
  /** An `smtp` connection; its stored URI is read in-activity. */
  connectionId: string;
  /** From address. If omitted, the activity falls back to the SMTP URI's user. */
  from?: string;
  to?: string;
  subject?: string;
  /** Plain-text body. */
  text?: string;
  /** HTML body (optional; sent alongside/instead of text). */
  html?: string;
  /** field ("to"|"subject"|"text"|"html") → upstream output binding. */
  fieldBindings?: Record<string, ArgBinding>;
  /** Flat per-send cost metered into the run budget (Arch§4.6). */
  costUsd?: number;
}

/**
 * Merge node — fan-IN join. A node with N inbound edges; the interpreter runs it
 * ONCE, when the last inbound branch arrives, and writes a combined output to
 * `ctx[mergeId]`. Lets the diamond pattern (fan-out → parallel work → recombine)
 * work without duplicating the merge or its downstream.
 *
 * PURE: deterministic graph work (no I/O, no secrets) — the combine reads the
 * inbound parents' outputs from ctx. v1 supports UNCONDITIONAL fan-in only
 * (a conditional edge into a merge is rejected by `validateGraph`, since a branch
 * that never fires would strand the join); loops back through a merge are undefined.
 */
export interface MergeNodeConfig {
  /** How to combine the inbound parents' outputs. "array" (default) →
   *  `[parent1, …, parentN]` in declared inbound-edge order; "object" →
   *  `Object.assign({}, …parents)`. */
  mode?: "array" | "object";
}

/**
 * Wait node — pause the run for a fixed duration, then continue. Backed by a
 * durable Temporal timer (`wf.sleep`), so the pause survives worker crashes and
 * costs nothing while waiting — never a busy-loop (CLAUDE.md rule 5). No output.
 */
export interface WaitNodeConfig {
  /** How long to pause, in seconds. <= 0 / omitted = no wait (pass through). */
  durationSeconds?: number;
}

/**
 * Stop and Error node — terminate the run as a failure with a message. Terminal:
 * nothing downstream runs. The message is static, non-secret display text (it
 * surfaces in the run's history/timeline).
 */
export interface StopAndErrorNodeConfig {
  /** Shown as the run's failure reason. */
  message?: string;
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

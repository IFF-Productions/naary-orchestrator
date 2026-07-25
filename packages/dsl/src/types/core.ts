/**
 * The graph DSL: the data a workflow is compiled to and the interpreter walks.
 * Platform-agnostic — no Temporal, no I/O. (CLAUDE.md: interpreter, not codegen.)
 */

export type NodeType =
  | "start"
  | "webhookTrigger" // Slice #4: entry node whose output is the inbound event
  | "errorTrigger" // entry node for an error-handler graph; output is the failure context
  | "pollTrigger" // entry node: polls a URL on an interval; output is {changed, body}
  | "scheduleTrigger" // entry node: runs the graph on a cron schedule (control-plane synced)
  | "formTrigger" // entry node: started by a hosted public form; output is the submitted fields
  | "chatTrigger" // entry node: started by a hosted chat message; output is { message, sessionId }
  | "mcpServerTrigger" // entry node: hosts the workflow as a tool on naary's MCP server; output is the invocation args
  | "agent"
  | "codeAgent" // runs an agentic coding CLI (Claude Code/Cursor/Copilot) as a BYOK activity
  | "textToSpeech" // synthesizes text → an audio object in storage (BYOK); output is a ref + metadata
  | "mcpTool" // Slice #4: calls a remote MCP server tool via a connection
  | "integration" // native provider action (GitHub/Jira/…) via a catalog + connection
  | "httpRequest" // calls a plain HTTP/REST endpoint; output is {status,headers,body}
  | "graphQL" // POSTs a GraphQL query/mutation; output is {data,errors,httpStatus}
  | "sqlQuery" // runs a read-only query against a tenant DB; output is {rows,rowCount}
  | "sqlExec" // runs a WRITE (INSERT/UPDATE/DELETE) in a txn; output is {rowsAffected}
  | "set" // builds a plain object from static fields + upstream bindings (pure, no I/O)
  | "renameKeys" // pure: remap/drop keys of an upstream object
  | "text" // pure: string ops (upper/lower/trim/replace/split/join/substring/regex)
  | "filter" // pure: keep array items matching a per-item predicate
  | "aggregate" // pure: collapse an array (collect/count/sum/first/last)
  | "listOps" // pure: sort / limit / dedupe an array → array
  | "compareDatasets" // pure: diff two arrays by a key → {added,removed,changed,same}
  | "xml" // parse XML→object / build object→XML (activity; fast-xml-parser)
  | "htmlExtract" // pull values out of an HTML string by CSS selector (activity)
  | "vectorUpsert" // RAG: embed text chunks + store them in the tenant vector store (activity)
  | "vectorQuery" // RAG: embed a query + return the top-k nearest stored chunks (activity)
  | "markdown" // convert an HTML string → Markdown (activity; node-html-parser)
  | "noOp" // does nothing; a structural/placeholder node — output {}
  | "splitOut" // items model: opens a per-item region — reads an array, runs the region once per item
  | "loopEnd" // items model: closes a per-item region — collects the region's per-item outputs → array
  | "csv" // parse CSV text→rows / build rows→CSV text (activity; papaparse)
  | "json" // pure: parse JSON text→value / stringify value→text
  | "number" // pure: arithmetic on numbers (add/sub/mul/div/mod/pow/round/floor/ceil/abs)
  | "encode" // encode/decode a string: base64 / base64url / hex / url (activity)
  | "dateTime" // current time / timestamp math via an activity (clock read is I/O)
  | "merge" // fan-in join: run once after all inbound branches arrive; combine outputs
  | "if" // boolean gate: combine N predicates with AND/OR → output {result}
  | "switch" // multi-way router: first matching rule → output {matched}; branch edges on it
  | "hmac" // signs a payload with a `signing` connection's key (activity); output is the digest
  | "jwt" // mints an HS256 JWT signed by a `signing` connection's key (activity)
  | "totp" // generates the current RFC-6238 TOTP code from a `signing` connection's seed
  | "hash" // one-way digest of a value (sha256/512/1/md5) — no key/connection needed
  | "random" // generate a UUID / random hex / base64 / alphanumeric / int (activity)
  | "sendEmail" // sends an email via an `smtp` connection (activity)
  | "rssRead" // fetches + parses an RSS/Atom feed (egress-guarded activity); output is {items}
  | "executeSubWorkflow" // runs another saved graph as a child run; output is {status,output}
  | "forEach" // runs a saved graph once per array item (child run per item); output is an array
  | "wait" // durable delay (Temporal timer); no output
  | "stopAndError" // terminal: fail the run with a message
  | "respondToWebhook" // sets the HTTP response the webhook ingress returns (pure)
  | "code" // runs sandboxed user JS (QuickJS/WASM activity); output is its return value
  | "humanApproval"
  | "end";

export interface NodeDef {
  id: string;
  type: NodeType;
  /**
   * Optional author-set display name (n8n's node name). DISPLAY ONLY — execution, edge
   * conditions, and `{{ … }}` expressions all key on the immutable `id`, never `name`, so
   * renaming a node can't break references or the interpreter. Absent ⇒ the UI shows the
   * derived type label. The canvas edits it in config-space (`config.__name`) and lifts it here.
   */
  name?: string;
  /** Node-specific configuration, e.g. the agent node's canned output. */
  config?: Record<string, unknown>;
  /**
   * What to do when this node throws (n8n's per-node "On Error"). "stop" (default) fails
   * the run — the workflow-level error handler, if bound, then fires. "continue" catches
   * the failure, writes `{ error }` as this node's output, and proceeds — so the graph can
   * branch on `<nodeId>.error` (exists) to handle it inline (n8n's error-output branch).
   */
  onError?: "stop" | "continue";
  /**
   * Per-node retry policy for the activity nodes that support it (n8n's "Retry On Fail",
   * but backed by Temporal — so UNBOUNDED, exponential, and crash-surviving, vs n8n's hard
   * 5-tries / 5s cap). Overrides the node's default Temporal RetryPolicy. Only honored for
   * idempotent-ish activity nodes (agent/mcpTool/httpRequest/sqlQuery/rssRead); ignored for
   * pure nodes and the at-most-once nodes (sqlExec/sendEmail/code), whose retry would risk
   * a double-effect. A non-retryable provider error (e.g. 401/429) still won't retry.
   */
  retry?: NodeRetryPolicy;
}

/** Author-facing retry knobs mapped onto the activity's Temporal RetryPolicy. */
export interface NodeRetryPolicy {
  /** Total attempts (default 3). Temporal allows far more than n8n's cap of 5. */
  maxAttempts?: number;
  /** Wait before the 2nd attempt, in seconds (default 1). */
  initialIntervalSeconds?: number;
  /** Multiplier applied to the wait each attempt (default 2 = exponential backoff). */
  backoffCoefficient?: number;
  /** Cap on the per-attempt wait, in seconds (optional). */
  maxIntervalSeconds?: number;
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

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Slice #6 — a structured, PURE edge predicate (never code/eval). Evaluated
 * against the run `ctx` to decide whether to take the edge. `path` is a dotted
 * path into ctx (e.g. "agent.output.category"); `op` compares the resolved value
 * to `value`. An edge with no condition is unconditional (linear/parallel).
 */
/** Comparison operators for a structured predicate. All are PURE + deterministic (no
 *  eval): value/string/number/emptiness checks, plus `regex` (a deterministic `RegExp`
 *  test). `isEmpty`/`notEmpty`/`exists` ignore `value`. */
export type ConditionOp =
  | "eq"
  | "neq"
  | "in"
  | "exists"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "regex"
  | "isEmpty"
  | "notEmpty";

export interface EdgeCondition {
  path: string;
  op: ConditionOp;
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

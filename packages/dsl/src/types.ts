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
  | "agent"
  | "mcpTool" // Slice #4: calls a remote MCP server tool via a connection
  | "httpRequest" // calls a plain HTTP/REST endpoint; output is {status,headers,body}
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

/** Start node: an optional sample trigger input used for manual/test runs. */
export interface StartNodeConfig {
  sampleInput?: Record<string, unknown>;
}

/**
 * Schedule Trigger — an ENTRY node that makes the graph run on a cron schedule (n8n's
 * Schedule Trigger). The control plane syncs a Temporal cron Schedule when a graph with this
 * start node is saved (like pollTrigger's interval sync). In the interpreter it's a passthrough
 * of the run input (the scheduled run carries no external event). `cron` is a standard 5/6-field
 * expression, e.g. "0 9 * * 1-5" (weekdays 9am).
 */
export interface ScheduleTriggerNodeConfig {
  /** Cron expression (Temporal/standard). */
  cron: string;
}

/** One field on a form-trigger's hosted form. */
export interface FormFieldDef {
  /** Key in the submitted data object (and the trigger node's output). */
  key: string;
  /** Human label shown above the input. */
  label: string;
  type: "text" | "textarea" | "number" | "email" | "select";
  required?: boolean;
  placeholder?: string;
  /** Choices for `type: "select"`. */
  options?: string[];
}

/**
 * Form trigger — the run starts from a hosted public form (design docs/design/FORM-TRIGGER.md).
 * The submitted `{ key: value }` becomes the trigger node's output (like `webhookTrigger`'s
 * output IS the event). The public form-serving + submit endpoint is a later slice; this is
 * just the node + its field schema.
 */
export interface FormTriggerNodeConfig {
  title?: string;
  description?: string;
  /** Submit-button label (default "Submit"). */
  submitLabel?: string;
  fields: FormFieldDef[];
}

/**
 * Chat trigger — the run starts from a hosted chat message (docs/design/CHAT-TRIGGER-RAG.md).
 * The inbound `{ message, sessionId }` becomes the trigger node's output (like `formTrigger`'s output
 * IS the submitted fields). The public chat page + durable per-session workflow are later slices;
 * this is just the node + its widget presentation.
 */
export interface ChatTriggerNodeConfig {
  /** Widget heading. */
  title?: string;
  /** Sub-heading shown under the title. */
  description?: string;
  /** Placeholder text in the message input. */
  placeholder?: string;
  /** The assistant's opening message shown before the first user turn. */
  greeting?: string;
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
   *  token cost, so spend is operator-configured. Metered PER PAGE when paginating. */
  costUsd?: number;
  /** Auto-follow pages and return the accumulated items. The whole loop runs in the
   *  activity (side-effecting), so the workflow stays deterministic. Omit for a single call. */
  pagination?: HttpPaginationConfig;
}

/**
 * HTTP pagination — the activity fetches pages until a stop condition and returns the
 * concatenated items as the node's `body`. Every page URL is re-checked by the egress
 * guard (a response-supplied `next` URL is attacker-influenceable → SSRF).
 */
export interface HttpPaginationConfig {
  /** How the next page is located:
   *  - `cursor`: read a token from each response, send it as a query param next time;
   *  - `page`: increment a numeric page query param each request;
   *  - `url`: follow an absolute next-page URL found in each response. */
  mode: "cursor" | "page" | "url";
  /** Dotted path (into the response body) to the array of items to accumulate. Omit
   *  when the body itself is the array. */
  itemsPath?: string;
  /** `cursor` mode: dotted path in the body to the next cursor; empty/absent → stop. */
  cursorPath?: string;
  /** `cursor` mode: the query-param name that carries the cursor (default `cursor`). */
  cursorParam?: string;
  /** `page` mode: the query-param name to increment (default `page`). */
  pageParam?: string;
  /** `page` mode: the first page number (default 1). */
  startPage?: number;
  /** `url` mode: dotted path in the body to the absolute next-page URL; empty/absent → stop. */
  nextUrlPath?: string;
  /** Stop when a page yields no items (default true). */
  stopOnEmpty?: boolean;
  /** Hard cap on pages fetched — a safety bound (default 10, clamped to 100). */
  maxPages?: number;
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
 * sqlExec node — a WRITE (INSERT/UPDATE/DELETE) against a tenant database, run inside
 * a transaction that COMMITs on success and ROLLBACKs on error. Same binding rules as
 * sqlQuery (bindings only fill positional params, never the SQL text). SEPARATE from
 * sqlQuery on purpose: a write node is a clear, explicit intent the reviewer/canvas can
 * see. The activity runs AT-MOST-ONCE (writes aren't idempotent — no Temporal retries).
 */
export interface SqlExecNodeConfig {
  /** A `postgres`/`mssql`/`mysql` connection; its stored DSN is read in-activity. */
  connectionId: string;
  /** Static write statement with positional placeholders. Never built from bindings. */
  sql: string;
  /** Static positional parameter values (the base for bindings). */
  params?: unknown[];
  /** 1-based param index → upstream output binding; fills/overrides that position. */
  paramBindings?: Record<number, ArgBinding>;
  /** Per-statement timeout (ms). */
  statementTimeoutMs?: number;
  /** Flat per-call cost metered into the run budget. */
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

/** String operations for the Text node (n8n's string expression methods, as a node). */
export type TextOp =
  | "upper"
  | "lower"
  | "trim"
  | "replace"
  | "split"
  | "join"
  | "substring"
  | "length"
  | "regexExtract";

/**
 * Text node — one string operation on an upstream value. PURE (deterministic ctx read, no
 * I/O; regex uses `RegExp`, invalid patterns fail closed to null). Output is `{ result }`.
 * The input is coerced to a string for most ops; `join` expects an array. Covers the common
 * string transforms users otherwise reach for the Code node to do.
 */
export interface TextNodeConfig {
  operation: TextOp;
  /** Upstream node id whose output holds the input value. */
  from: string;
  /** Optional dotted path into that output. */
  path?: string;
  /** replace: the substring (or regex source when `useRegex`); regexExtract: the pattern. */
  search?: string;
  /** replace: the replacement text (supports $1 groups when `useRegex`). */
  replacement?: string;
  /** replace: treat `search` as a global regex. */
  useRegex?: boolean;
  /** split: the delimiter (default ","); join: the glue (default ","). */
  separator?: string;
  /** substring: start index (default 0). */
  start?: number;
  /** substring: end index (exclusive; omitted = to the end). */
  end?: number;
  /** regexExtract: capture group to return (default 0 = whole match). */
  group?: number;
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
 * List Ops node — reshape an upstream ARRAY into another array. PURE. `sort` orders
 * by `field` (item-relative dotted path; whole item if omitted) ascending/descending
 * (numbers numerically, else by string); `limit` takes the first `count`; `dedupe`
 * removes duplicates by `field` value (or whole-item JSON when omitted), keeping
 * first occurrence. Output is the resulting array; non-array source → [].
 */
export interface ListOpsNodeConfig {
  from: string;
  path?: string;
  operation: "sort" | "limit" | "dedupe";
  /** Item-relative field for sort/dedupe. */
  field?: string;
  /** Sort direction (default "asc"). */
  order?: "asc" | "desc";
  /** Max items for limit. */
  count?: number;
}

/**
 * Compare Datasets node — diff two upstream ARRAYS by a key field. PURE. Output is
 * `{ added, removed, changed, same }`: rows only in B (added), only in A (removed),
 * in both but not deep-equal (changed — `{ key, a, b }`), and identical (same).
 */
export interface CompareDatasetsNodeConfig {
  /** Left array (the baseline). */
  a: ArgBinding;
  /** Right array (the comparison). */
  b: ArgBinding;
  /** Item field whose value identifies a row in both arrays. */
  key: string;
}

/**
 * XML node — convert between XML text and an object. `parse` turns an XML string
 * (from `from`/`path`) into an object; `build` serializes an upstream object to an
 * XML string. Runs in an ACTIVITY (reuses fast-xml-parser). Output: the object
 * (parse) or `{ xml }` (build).
 */
export interface XmlNodeConfig {
  operation: "parse" | "build";
  /** Upstream node id whose output holds the XML string (parse) or object (build). */
  from: string;
  /** Optional dotted path into that output. */
  path?: string;
}

/**
 * CSV node — convert between CSV text and an array of rows (n8n's Spreadsheet File, CSV).
 * `parse` turns CSV text (from `from`/`path`) into rows (objects keyed by the header row
 * when `header`, else arrays); `build` serializes an upstream array of objects to CSV text.
 * Output: the rows array (parse) or `{ csv }` (build). Runs in an ACTIVITY (parser out of
 * the deterministic bundle, like `xml`). No secrets, no egress.
 */
export interface CsvNodeConfig {
  operation: "parse" | "build";
  /** Upstream node id whose output holds the CSV string (parse) or rows array (build). */
  from: string;
  /** Optional dotted path into that output. */
  path?: string;
  /** parse: treat the first row as the header (default true). build: emit a header row. */
  header?: boolean;
  /** Field delimiter (default ","). */
  delimiter?: string;
}

/** What the Random node generates. */
export type RandomOp = "uuid" | "hex" | "base64" | "alphanumeric" | "int";

/**
 * Random (Generate) node — produce a fresh random value (n8n's Crypto "Generate"): a UUID v4,
 * random hex/base64url of `length` bytes, an alphanumeric string of `length` chars, or a
 * uniform integer in `[min, max]`. Runs in an ACTIVITY because randomness is non-deterministic
 * (must not touch workflow code). No inputs — it generates. Output is `{ value }`.
 */
export interface RandomNodeConfig {
  operation: RandomOp;
  /** hex/base64: number of random bytes; alphanumeric: number of chars (default 16). */
  length?: number;
  /** int: inclusive lower bound (default 0). */
  min?: number;
  /** int: inclusive upper bound (default 100). */
  max?: number;
}

/** Encode/decode operations for the Encode node. */
export type EncodeOp =
  | "base64Encode"
  | "base64Decode"
  | "base64urlEncode"
  | "base64urlDecode"
  | "hexEncode"
  | "hexDecode"
  | "urlEncode"
  | "urlDecode";

/**
 * Encode node — convert a string to/from base64, base64url, hex, or URL-encoding (n8n's
 * base64Encode/urlEncode string methods). Output is `{ result }`. Runs in an ACTIVITY (uses
 * Node's Buffer, which isn't in the deterministic workflow bundle). No secrets, no egress.
 */
export interface EncodeNodeConfig {
  operation: EncodeOp;
  /** Upstream node id whose output holds the input string. */
  from: string;
  /** Optional dotted path into that output. */
  path?: string;
}

/** Arithmetic operations for the Number node. Binary use `a` and `b`; unary use `a`. */
export type MathOp =
  | "add"
  | "subtract"
  | "multiply"
  | "divide"
  | "modulo"
  | "power"
  | "round"
  | "floor"
  | "ceil"
  | "abs";

/**
 * Number (Math) node — one arithmetic operation. Operands come from a static value or an
 * upstream binding (coerced with Number()). Binary ops (add/subtract/multiply/divide/
 * modulo/power) use `a` and `b`; unary ops (round/floor/ceil/abs) use `a` (round honors
 * `precision`). PURE + deterministic → runs in the interpreter. Output is `{ result }`.
 */
export interface NumberNodeConfig {
  operation: MathOp;
  /** Left operand (static). */
  a?: number;
  /** Left operand from an upstream output (overrides `a`). */
  aBinding?: ArgBinding;
  /** Right operand (static; binary ops only). */
  b?: number;
  /** Right operand from an upstream output (overrides `b`). */
  bBinding?: ArgBinding;
  /** round: decimal places to keep (default 0). */
  precision?: number;
}

/**
 * JSON node — parse a JSON string into a value, or stringify a value into JSON text. PURE
 * (JSON.parse/stringify are deterministic ES built-ins — no I/O, no activity). `parse` output
 * IS the parsed value (object/array/…); `stringify` output is `{ json }`. Invalid JSON on
 * parse throws a node failure (so `onError: continue` can branch on it).
 */
export interface JsonNodeConfig {
  operation: "parse" | "stringify";
  /** Upstream node id whose output holds the JSON string (parse) or value (stringify). */
  from: string;
  /** Optional dotted path into that output. */
  path?: string;
  /** stringify: indent width for pretty-printing (0/omitted = compact). */
  indent?: number;
}

/** One field to pull out of an HTML document by CSS selector (HTML Extract node). */
export interface HtmlExtraction {
  /** Output key on the node's result object. */
  key: string;
  /** CSS selector (tag/class/id/attribute/descendant), e.g. "h1", ".price", "a.more". */
  selector: string;
  /** What to read from the matched element: its text (default), inner HTML, or an
   *  attribute's value. */
  return?: "text" | "html" | "attribute";
  /** Attribute name when `return` is "attribute" (e.g. "href"). */
  attribute?: string;
  /** Return every match as an array (default: just the first match's value). */
  all?: boolean;
}

/**
 * HTML Extract node — pull structured values out of an HTML string with CSS selectors
 * (n8n's HTML node, Extract operation). The HTML comes from an upstream node (`from`/`path`,
 * e.g. an `httpRequest` body); each extraction reads text / inner HTML / an attribute of
 * its selector's match(es). Output is `{ [key]: value }`.
 *
 * Runs in an ACTIVITY (like `xml`) to keep the HTML parser out of the deterministic
 * workflow bundle. No secrets, no egress (the fetch is a separate `httpRequest` node).
 */
export interface HtmlExtractNodeConfig {
  /** Upstream node id whose output holds the HTML string. */
  from: string;
  /** Optional dotted path into that output (e.g. "body"). */
  path?: string;
  /** The fields to extract. */
  extractions: HtmlExtraction[];
}

/** Markdown node — convert an upstream HTML string to Markdown. Output is `{ markdown }`. */
export interface MarkdownNodeConfig {
  /** Upstream node id whose output holds the HTML string. */
  from: string;
  /** Optional dotted path into that output (e.g. "body"). */
  path?: string;
}

/** splitOut (items model) — opens a per-item region over an upstream ARRAY. On iteration `i` the
 *  node's output IS `array[i]`; the linear region between it and its `loopEnd` runs once per item.
 *  See docs/design/ITEMS-MODEL-CURRENT-ITEM.md §0.2. */
export interface SplitOutNodeConfig {
  /** Upstream node id whose output holds (or contains, via `path`) the array to split. */
  from: string;
  /** Optional dotted path into that output pointing at the array. */
  path?: string;
}

/** loopEnd (items model) — closes a per-item region. Its output is the ARRAY of the region node it
 *  binds to (`from`), one element per iteration. After it, the run is back to a single value. */
export interface LoopEndNodeConfig {
  /** The region node whose per-iteration output to collect into an array. */
  from: string;
}

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
 * Hash node — a one-way digest of a value (n8n's String.hash()). Unlike `hmac`/`jwt`/`totp`
 * there is NO key or connection: it just hashes. `input` is the static value; `inputBinding`
 * overrides it from an upstream output (objects are JSON-stringified before hashing). Output
 * is `{ digest }`. Runs in an ACTIVITY (node:crypto isn't in the deterministic bundle).
 */
export interface HashNodeConfig {
  /** Digest algorithm (default "sha256"). */
  algorithm?: "sha256" | "sha512" | "sha1" | "md5";
  /** Static value to hash (string, or object → JSON). */
  input?: unknown;
  /** Upstream binding whose value replaces `input`. */
  inputBinding?: ArgBinding;
  /** Output digest encoding (default "hex"). */
  encoding?: "hex" | "base64";
}

/**
 * JWT node — mint an HS256 JSON Web Token signed by a `signing` connection's key
 * (read + used IN the activity, never in config). Output is `{ token }`. `claims`
 * is the static payload; each `claimsBindings` entry fills/overrides a claim from
 * an upstream output. `iat`/`exp` are set by the signer.
 */
export interface JwtNodeConfig {
  /** A `signing` connection; its stored secret is the HS256 shared key, or (for
   *  RS256) a PEM PKCS#8 RSA PRIVATE key. */
  connectionId: string;
  /** Signature algorithm (default "HS256"). */
  algorithm?: "HS256" | "RS256";
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
 * For Each node — map an upstream ARRAY by running a saved graph (`workflowKey`) as
 * a durable child run ONCE PER ITEM (the item is the child's input), concurrently.
 * Output is an array of `{ status, output }` (the same bounded projection as
 * `executeSubWorkflow`), in item order — so downstream can filter/aggregate it.
 * Only `workflowKey`/`tenantId` cross the boundary (no secrets). Bounded by an item
 * cap and the sub-workflow depth cap.
 */
export interface ForEachNodeConfig {
  /** The saved-graph key to run per item (this tenant's latest version). */
  workflowKey: string;
  /** Upstream node id whose output holds the array to iterate. */
  from: string;
  /** Optional dotted path into that output to reach the array. */
  path?: string;
}

/**
 * RSS Read node — fetch an RSS 2.0 / Atom feed and parse it into normalized items
 * `{ title, link, summary, published, id }`. The fetch + parse (I/O) run in an
 * ACTIVITY, egress-guarded (https + public host) like httpRequest. Output is
 * `{ items, count }`. `url` is non-secret; `urlBinding` can override it from an
 * upstream output.
 */
export interface RssReadNodeConfig {
  /** Feed URL (https). */
  url: string;
  /** Upstream binding whose value replaces `url`. */
  urlBinding?: ArgBinding;
  /** Abort the fetch after this many ms (default applied in the activity). */
  timeoutMs?: number;
}

/**
 * Poll Trigger — an ENTRY node that fetches a URL and only signals downstream when
 * the source has CHANGED since the last poll. The change is detected against a
 * per-(tenant, workflow, node) cursor persisted across runs (side-effecting, so the
 * compare + fetch happen in an activity). The graph is run on `intervalSeconds` by a
 * Temporal interval Schedule the control plane syncs when a poll graph is saved.
 * Output: `{ changed: boolean, body: unknown }` — branch on `<id>.changed`.
 */
export interface PollTriggerNodeConfig {
  /** URL to poll (https). */
  url: string;
  /** How often to run the workflow, in seconds (the Schedule interval). */
  intervalSeconds: number;
  /** Dotted path into the fetched JSON whose value is the change key (e.g.
   *  "items.0.id"). Omitted = the whole response body is the key (hashed). */
  changeKey?: string;
}

/**
 * Respond to Webhook node — set the HTTP response the webhook ingress should return
 * synchronously (for graphs triggered by a webhook). PURE: it records the response
 * into run state; the run then CONTINUES (respond fast, keep working). `body` is
 * static; `bodyBinding` overrides it from an upstream output. If the run never
 * reaches this node in time, the ingress falls back to a 202.
 */
export interface RespondToWebhookNodeConfig {
  /** HTTP status to return (default 200). */
  statusCode?: number;
  /** Static response body (JSON). */
  body?: unknown;
  /** Upstream binding whose value replaces `body`. */
  bodyBinding?: ArgBinding;
  /** Static, non-secret response headers. */
  headers?: Record<string, string>;
}

/**
 * Code node — run arbitrary user JavaScript in a sandbox (QuickJS compiled to WASM;
 * no host access, memory + wall-clock capped). It runs in an ACTIVITY (QuickJS has
 * Date/Math.random → non-deterministic). The code executes as
 * `(function($input,$ctx){ <code> })(...)` — `$input` is the run's entry input,
 * `$ctx` is a `{nodeId: output}` map of upstream outputs — and its RETURN VALUE
 * becomes this node's output. No secrets, no network.
 */
export interface CodeNodeConfig {
  /** The user JavaScript. Use `return <value>` to produce the node's output. */
  code: string;
  /** Wall-clock cap in ms (default 2000, capped at 5000). */
  timeoutMs?: number;
  /** Memory cap in MB (default 64, capped at 128). */
  memoryMb?: number;
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
/**
 * IF node — a boolean gate (n8n's IF). Evaluates `conditions` and COMBINES them with AND
 * (all must hold) or OR (any), producing `{ result: boolean }`. This adds boolean
 * combination that a single edge condition / Switch rule can't express. The author draws a
 * true-edge (`<ifId>.result eq true`) and a false-edge (`eq false`). PURE (reuses
 * `evaluateCondition`, no eval).
 */
export interface IfNodeConfig {
  /** Combine the conditions: "and" (default, all hold) or "or" (any holds). */
  combine?: "and" | "or";
  /** The predicates (same op set as edges/filter/switch). Empty ⇒ result is false. */
  conditions: EdgeCondition[];
}

/** One named branch of a Switch node — a label plus the predicate that selects it. */
export interface SwitchRule {
  /** The branch label; also the value written to `{ matched }` when this rule wins. */
  name: string;
  /** Structured predicate (same op set as edges/filter), evaluated against `ctx`. */
  condition: EdgeCondition;
}

/**
 * Switch node — multi-way router (n8n's Switch, Rules mode). Evaluates `rules` IN ORDER
 * against the run context and outputs `{ matched }` = the FIRST matching rule's name, or
 * `fallback` when none match. PURE (reuses `evaluateCondition`, no I/O). The author draws
 * one outgoing edge per branch with `eq` on `<switchId>.matched` — one node instead of N
 * hand-wired conditional edges on the source.
 */
export interface SwitchNodeConfig {
  /** Ordered branches; the first whose condition holds wins. */
  rules: SwitchRule[];
  /** `matched` value when no rule matches (default "default"). */
  fallback?: string;
}

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
  /**
   * "duration" (default) = pause for a fixed time; "webhook" = pause DURABLY until an
   * external system POSTs the run's resume URL (survives crashes / days, like approval).
   */
  mode?: "duration" | "webhook";
  /** duration mode: how long to pause, in seconds. <= 0 / omitted = no wait (pass through). */
  durationSeconds?: number;
  /**
   * webhook mode: optional max seconds to wait before auto-continuing (a durable timer,
   * so it survives a crash). <= 0 / omitted = wait forever until resumed. On timeout the
   * node's output is `{ resumed: false, timedOut: true }` so a graph can branch on it.
   */
  timeoutSeconds?: number;
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

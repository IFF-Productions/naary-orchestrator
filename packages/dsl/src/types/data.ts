import type { ArgBinding, HttpMethod } from "./core";

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
 * GraphQL node: POST a query/mutation to a GraphQL endpoint. Mechanically an extension of REST
 * (a single POST of `{ query, variables }`), so it runs the SAME hardened HTTP machinery as
 * `httpRequest` in-activity (SSRF egress guard, `$secrets` resolution) — it just owns the GraphQL
 * body shape and surfaces `{ data, errors, httpStatus }` as first-class output (GraphQL returns
 * 200-with-`errors`, so `errors` deserves its own field, not `<id>.body.errors`).
 *
 * SECURITY (Tier-1 rule 4): auth headers carry a secret via `{{ $secrets.NAME }}`, resolved
 * in-activity — never a plaintext token in config. (A `connectionId`-based auth is a follow-up.)
 */
export interface GraphQLNodeConfig {
  /** GraphQL endpoint URL (https only — enforced by the egress guard at call time). */
  url: string;
  /** The GraphQL document (query or mutation). */
  query: string;
  /** Variables object. String values may embed `{{ node.path }}` (upstream) or `{{ $secrets.NAME }}`
   *  (resolved in-activity). */
  variables?: Record<string, unknown>;
  /** Static headers. A secret auth header uses `{{ $secrets.NAME }}` (resolved in-activity). */
  headers?: Record<string, string>;
  /** field path (e.g. "url", "variables.id", "headers.X-Trace") → upstream output binding;
   *  overrides the static value at that path. */
  argumentBindings?: Record<string, ArgBinding>;
  /** When true, a non-empty GraphQL `errors` array fails the node (non-retryable) instead of being
   *  returned for the graph to branch on. Default false. */
  failOnErrors?: boolean;
  /** Abort the request after this many ms (default applied in the activity). */
  timeoutMs?: number;
  /** Flat per-call cost metered into the run budget (Arch§4.6) — operator-configured. */
  costUsd?: number;
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
/**
 * `kafkaPublish` — produce ONE message to a topic (pub/sub design #1086, slice 1).
 *
 * Publish only. Consuming needs something that holds a connection, which is slice 2 — so this
 * node is a plain request/response activity: connect, produce, disconnect.
 *
 * `correlationId`/`replyTopic` are here from the start ON PURPOSE. They are useful immediately
 * with no consumer of ours (an external service reads reply-to and answers wherever it is told,
 * including a `wait(webhook)` resume URL), and adding them later would mean rewriting every graph
 * authored in the meantime.
 */
export interface KafkaPublishNodeConfig {
  /** A `kafka` connection; its brokers + SASL credentials are read in-activity. */
  connectionId: string;
  /** Topic to produce to. Templates resolve before the activity runs. */
  topic: string;
  /** Message body. A non-string is JSON-stringified by the activity, never here. */
  value: unknown;
  /** Partition key. Same key ⇒ same partition ⇒ per-key ordering; omitted ⇒ round-robin. */
  key?: string;
  /** Extra message headers, merged UNDER the correlation headers below (which win). */
  headers?: Record<string, string>;
  /** Written as the `correlationId` header — the join key a reply is matched on later. */
  correlationId?: string;
  /** Written as the `replyTo` header. Where a consumer should send its response. */
  replyTopic?: string;
  /**
   * Broker acknowledgement level. -1 = all in-sync replicas (default, safest), 1 = leader only,
   * 0 = fire-and-forget. Deliberately NOT defaulted to 0: a publish that cannot be observed to
   * have failed is indistinguishable from one that worked.
   */
  acks?: -1 | 0 | 1;
  /** Per-publish timeout (ms). */
  timeoutMs?: number;
  /** Flat per-call cost metered into the run budget (Arch§4.6). */
  costUsd?: number;
}

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

/** A Firestore `where` clause. `field` is a Firestore FIELD path (`address.city`), which is
 *  unrelated to the document's URL path — it rides in the request body. */
export interface FirestoreFilterSpec {
  field: string;
  /** `==` `!=` `<` `<=` `>` `>=` `array-contains` `array-contains-any` `in` `not-in`. */
  op: string;
  /** Compared after the same plain-JSON → typed-value encoding the document data gets. */
  value?: unknown;
}

/** A Firestore sort key. `direction` is "asc" (default) or "desc". */
export interface FirestoreOrderBySpec {
  field: string;
  direction?: string;
}

/**
 * firestoreQuery node — READ Cloud Firestore. Output is
 * `{ documents, count, truncated }`, where each document is
 * `{ id, name, data, createTime?, updateTime? }` and `data` is PLAIN JSON: the node
 * converts Firestore's typed wire values (`{"integerValue":"5"}`) on the way out, so the
 * author never sees them.
 *
 * SECURITY: `projectId`/`databaseId`/`collection`/`documentId` all land in the REST URL
 * path, so each is validated and percent-encoded (@naary/firestore's `encodeSegment`) —
 * a `documentId` containing `/` would otherwise address a different document. This is the
 * analogue of sqlQuery's "the SQL text is STATIC". Auth is the connection's Google OAuth
 * access token, resolved + used IN the activity — never in this config, which rides in
 * workflow history.
 */
export interface FirestoreQueryNodeConfig {
  /** A `firestore` connection holding a Google OAuth access token. */
  connectionId: string;
  /** `get` one document, `list` a collection, or `query` it with filters. */
  action?: string;
  /** Google Cloud project id. */
  projectId: string;
  /** Firestore database id; defaults to `(default)`. */
  databaseId?: string;
  /** Collection path — `users`, or a subcollection like `users/ada/orders`. */
  collection: string;
  /** Required by `get`. */
  documentId?: string;
  /** Bindings for documentId / projectId / collection from upstream node outputs. */
  argumentBindings?: Record<string, ArgBinding>;
  /** `query` filters, combined with AND. */
  filters?: FirestoreFilterSpec[];
  /** Sort keys (`query` and `list`). */
  orderBy?: FirestoreOrderBySpec[];
  /** Max documents (default 100, clamped to 1000). */
  limit?: number;
  /** Max `list` pages to walk (default 10, clamped to 100). */
  maxPages?: number;
  /** Treat a single-key `{"<type>Value": …}` object as a literal Firestore value. Off by default. */
  typedValues?: boolean;
  /** Per-call timeout (ms). */
  timeoutMs?: number;
  /** Flat per-call cost metered into the run budget (Arch§4.6). */
  costUsd?: number;
}

/**
 * firestoreWrite node — WRITE one Cloud Firestore document. `data` is PLAIN JSON; the node
 * wraps each value in its Firestore type. Output is `{ name, documentId, deleted }`.
 *
 * SEPARATE from firestoreQuery on purpose, exactly as sqlExec is from sqlQuery: a write is
 * an explicit intent the canvas and the reviewer can see, and it runs AT-MOST-ONCE (no
 * Temporal retries) because `create` assigns a server id — a retry would create a SECOND
 * document.
 */
export interface FirestoreWriteNodeConfig {
  /** A `firestore` connection holding a Google OAuth access token. */
  connectionId: string;
  /** `set` (create-or-replace), `create` (server id), `update` (merge), `delete`. */
  action?: string;
  projectId: string;
  databaseId?: string;
  collection: string;
  /** Required by set/update/delete; optional for `create` (else Firestore assigns one). */
  documentId?: string;
  /** The document, as plain JSON. */
  data?: Record<string, unknown>;
  /** Bindings for `data` fields / documentId from upstream node outputs. */
  argumentBindings?: Record<string, ArgBinding>;
  /** `update` only — field paths to merge. Defaults to `data`'s own top-level keys.
   *  Firestore DELETES every field outside the mask, so the default matters. */
  updateMask?: string[];
  /** Treat a single-key `{"<type>Value": …}` object as a literal Firestore value. Off by default. */
  typedValues?: boolean;
  /** Per-call timeout (ms). */
  timeoutMs?: number;
  /** Flat per-call cost metered into the run budget. */
  costUsd?: number;
}

/** vectorUpsert (RAG) — embed one or more text chunks and store them in the tenant's vector store
 *  under `collection`. `from`/`path` resolve to a string or string[]. Output `{ upserted }`. */
export interface VectorUpsertNodeConfig {
  /** Logical namespace within the tenant (e.g. "docs"). */
  collection: string;
  /** Upstream node id whose output holds the chunk text (string) or chunks (string[]). */
  from: string;
  /** Optional dotted path into that output. */
  path?: string;
}

/** vectorQuery (RAG) — embed a query string and return the `topK` nearest stored chunks from
 *  `collection`. Output `{ matches: [{ chunkText, score, metadata? }] }`. */
export interface VectorQueryNodeConfig {
  collection: string;
  /** Upstream node id whose output holds the query string. */
  from: string;
  path?: string;
  /** How many nearest chunks to return (default 4). */
  topK?: number;
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

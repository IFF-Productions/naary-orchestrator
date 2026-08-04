import type { ConditionOp, NodeType } from "./types";

/**
 * The canonical, machine-readable registry of every node type: what it does, its group, and
 * a compact hint of its key config. ONE source of truth shared by the AI workflow builder
 * (grounds the model + bounds structured output) and any future MCP server that exposes
 * "which nodes exist" to an external agent.
 *
 * `Record<NodeType, …>` makes this EXHAUSTIVE: adding a NodeType without a catalog entry is a
 * compile error — so the AI's node knowledge can never silently go stale (the bug this fixes).
 * Keep summaries compact — they ride in the generation prompt (token cost).
 */
export type NodeGroup =
  | "trigger"
  | "ai"
  | "data-source"
  | "transform"
  | "flow"
  | "crypto"
  | "comms"
  | "terminal";

export interface NodeCatalogEntry {
  group: NodeGroup;
  /** One line: what it does + where its output lands (e.g. `<id>.status`). */
  summary: string;
  /** Compact key-config hint for an author; omit for no-config nodes. */
  config?: string;
  /** Entry nodes can be a graph's `startNodeId` (exactly one per graph). */
  entry?: boolean;
  /**
   * This entry node accepts `config.sampleInput` — the payload a manual run falls back to (#983).
   * A subset of `entry`, not a synonym: schedule/poll triggers are entries whose real trigger
   * passes `{}`, so they carry no sample (see `TriggerSampleInputConfig`).
   *
   * The canvas gates its "Sample input (JSON)" field on this rather than on a hand-written node
   * list, so a trigger added later can't quietly ship without the field. Lives HERE, not in
   * ./registry, because the web imports it — registry pulls zod into the browser bundle.
   */
  sampleInput?: boolean;
}

export const NODE_CATALOG: Record<NodeType, NodeCatalogEntry> = {
  // --- Triggers / entry ---
  start: {
    group: "trigger",
    entry: true,
    sampleInput: true,
    summary: "Manual/API entry point. config.sampleInput seeds test runs.",
    config: "{ sampleInput? }",
  },
  webhookTrigger: {
    group: "trigger",
    entry: true,
    sampleInput: true,
    summary:
      "Started by an inbound HTTP webhook; its output IS the event payload.",
    config: "{ sampleInput? }",
  },
  errorTrigger: {
    group: "trigger",
    entry: true,
    sampleInput: true,
    summary:
      "Entry of an error-handler workflow; runs when another flow fails.",
    config: "{ sampleInput? }",
  },
  pollTrigger: {
    group: "trigger",
    entry: true,
    summary:
      "Polls a URL on an interval; output {changed, body}. Branch on <id>.changed.",
    config: "{ url, intervalSeconds, changeKey? }",
  },
  scheduleTrigger: {
    group: "trigger",
    entry: true,
    summary:
      "Runs the workflow on a cron schedule (synced server-side on save).",
    config: '{ cron: "0 9 * * 1-5" }',
  },
  formTrigger: {
    group: "trigger",
    entry: true,
    sampleInput: true,
    summary:
      "Started by a hosted public form; its output IS the submitted fields {key: value}.",
    config:
      "{ title?, description?, submitLabel?, fields: [{ key, label, type: text|textarea|number|email|select, required?, options? }], sampleInput? }",
  },
  chatTrigger: {
    group: "trigger",
    entry: true,
    sampleInput: true,
    summary:
      "Started by a hosted chat message; its output IS { message, sessionId }.",
    config: "{ title?, description?, placeholder?, greeting?, sampleInput? }",
  },
  mcpServerTrigger: {
    group: "trigger",
    entry: true,
    sampleInput: true,
    summary:
      "Hosts this workflow as a tool on naary's MCP server; an external agent invokes it and its output IS the invocation args.",
    config: "{ toolName?, description?, sampleInput? }",
  },
  // --- AI ---
  agent: {
    group: "ai",
    summary: "Calls an LLM; output at <id>.output.",
    config:
      '{ provider:"anthropic", model:"claude-opus-4-8", systemPrompt, outputSchema? }',
  },
  codeAgent: {
    group: "ai",
    summary:
      "Runs an agentic coding CLI (Claude Code/Cursor/Copilot); output at <id>.output.",
    config: '{ tool?:"claude", prompt, maxTurns?, maxBudgetUsd? }',
  },
  textToSpeech: {
    group: "ai",
    summary:
      "Synthesizes text to speech (BYOK); the audio goes to object storage and the output is a reference + metadata at <id>.output (audio/format/bytes/voice).",
    config: '{ provider?:"openai", text|textBinding, voice?, model?, format? }',
  },
  mcpTool: {
    group: "ai",
    summary: "Calls a remote tool over MCP via a connection.",
    config: "{ connectionId, tool, argumentBindings?:{ <arg>:{from,path} } }",
  },
  integration: {
    group: "ai",
    summary:
      "Native provider action (GitHub/Jira/…) via a connection; output {status,ok,body}. Branch on <id>.status.",
    config:
      "{ provider, action, connectionId, fields?:{ <field>:value }, fieldBindings?:{ <field>:{from,path} } }",
  },
  // --- Data sources ---
  httpRequest: {
    group: "data-source",
    summary:
      "HTTP/REST call; output {status,headers,body}. Branch on <id>.status. With pagination, body is the combined items array.",
    config:
      "{ method, url, headers?, query?, body?, connectionId?, pagination?: { mode: cursor|page|url, itemsPath?, cursorPath?, cursorParam?, pageParam?, nextUrlPath?, maxPages? } }",
  },
  graphQL: {
    group: "data-source",
    summary:
      "GraphQL query/mutation (POST); output {data,errors,httpStatus}. Branch on <id>.errors (GraphQL returns 200-with-errors) or read <id>.data. A secret auth header uses {{ $secrets.NAME }}.",
    config: "{ url, query, variables?, headers? }",
  },
  kafkaPublish: {
    group: "data-source",
    summary:
      "Publish one message to a Kafka topic; output {topic,partition,offset}. At-most-once — never retried.",
    config: "{ connectionId, topic, value, key?, correlationId?, replyTopic? }",
  },
  sqlQuery: {
    group: "data-source",
    summary: "Read-only SQL against a tenant DB; output {rows,rowCount}.",
    config: '{ connectionId, sql, paramBindings?:{ "1":{from,path} } }',
  },
  sqlExec: {
    group: "data-source",
    summary:
      "SQL write (INSERT/UPDATE/DELETE) in a txn; output {rowsAffected}. At-most-once.",
    config: "{ connectionId, sql, paramBindings? }",
  },
  firestoreQuery: {
    group: "data-source",
    summary:
      "Read Cloud Firestore (get one document / list a collection / query it with filters); output {documents,count,truncated}. Each document's `data` is PLAIN JSON — the node converts Firestore's typed values both ways.",
    config:
      "{ connectionId, projectId, collection, action?:'get'|'list'|'query', documentId?, filters?, orderBy?, limit? }",
  },
  firestoreWrite: {
    group: "data-source",
    summary:
      "Write ONE Cloud Firestore document (set/create/update/delete); output {name,documentId,deleted}. `data` is plain JSON. At-most-once.",
    config:
      "{ connectionId, projectId, collection, action?:'set'|'create'|'update'|'delete', documentId?, data?, updateMask? }",
  },
  rssRead: {
    group: "data-source",
    summary: "Fetch + parse an RSS/Atom feed; output {items,count}.",
    config: "{ url }",
  },
  // --- Transform (mostly pure) ---
  set: {
    group: "transform",
    summary:
      "Build an object from static fields + upstream bindings (replace-only).",
    config: "{ fields?, fieldBindings?:{ path:{from,path} } }",
  },
  renameKeys: {
    group: "transform",
    summary: "Rename/drop top-level keys of an upstream object.",
    config: "{ from, path?, rename?, drop? }",
  },
  text: {
    group: "transform",
    summary: "String op on a value → {result}.",
    config:
      "{ operation:'upper|lower|trim|replace|split|join|substring|length|regexExtract', from, path? }",
  },
  filter: {
    group: "transform",
    summary:
      "Keep array items matching a predicate; output the filtered array.",
    config: "{ from, path?, condition:{path,op,value} }",
  },
  aggregate: {
    group: "transform",
    summary:
      "Collapse an array → {result} (collect/count/sum/min/max/avg/first/last).",
    config: "{ from, path?, operation, field? }",
  },
  listOps: {
    group: "transform",
    summary: "Sort / limit / dedupe an array → array.",
    config:
      "{ from, path?, operation:'sort|limit|dedupe', field?, order?, count? }",
  },
  compareDatasets: {
    group: "transform",
    summary: "Diff two arrays by key → {added,removed,changed,same}.",
    config: "{ a:{from,path}, b:{from,path}, key }",
  },
  xml: {
    group: "transform",
    summary: "Parse XML→object / build object→XML.",
    config: "{ operation:'parse|build', from, path? }",
  },
  htmlExtract: {
    group: "transform",
    summary: "Pull values out of HTML by CSS selector → { [key]:value }.",
    config:
      "{ from, path?, extractions:[{key,selector,return?,attribute?,all?}] }",
  },
  markdown: {
    group: "transform",
    summary: "Convert an HTML string to Markdown → { markdown }.",
    config: "{ from, path? }",
  },
  vectorUpsert: {
    group: "data-source",
    summary:
      "RAG: embed text chunk(s) and store them in the tenant vector store → { upserted }.",
    config: "{ collection, from, path? }",
  },
  vectorQuery: {
    group: "data-source",
    summary:
      "RAG: embed a query and return the top-k nearest stored chunks → { matches }.",
    config: "{ collection, from, path?, topK? }",
  },
  noOp: {
    group: "flow",
    summary: "Does nothing; a structural/placeholder node. Output is {}.",
    config: "{}",
  },
  retry: {
    group: "flow",
    summary:
      "Opens a RETRY region: every node up to its retryEnd repeats as a unit until an attempt " +
      "succeeds, or maxAttempts is reached. For transient multi-step failures (fetch → parse), " +
      "where retrying has to restart at the fetch.",
    config:
      "{ maxAttempts?, initialIntervalSeconds?, backoffCoefficient?, maxIntervalSeconds? }",
  },
  retryEnd: {
    group: "flow",
    summary:
      "Closes a retry region. Nodes with effects that can't be undone (sendEmail, sqlExec, code, " +
      "integration writes) are refused inside the region — move them after this node.",
    config: "{}",
  },
  splitOut: {
    group: "flow",
    summary:
      "Items model: split an array and run the linear region up to loopEnd once per item.",
    config: "{ from, path? }",
  },
  loopEnd: {
    group: "flow",
    summary:
      "Items model: close a splitOut region — collect the bound node's per-item outputs → array.",
    config: "{ from }",
  },
  csv: {
    group: "transform",
    summary: "Parse CSV text→rows / build rows→{csv}.",
    config: "{ operation:'parse|build', from, path?, header?, delimiter? }",
  },
  json: {
    group: "transform",
    summary: "Parse JSON string→value / stringify value→{json}.",
    config: "{ operation:'parse|stringify', from, path?, indent? }",
  },
  number: {
    group: "transform",
    summary: "One arithmetic op on operands → {result}.",
    config:
      "{ operation:'add|subtract|multiply|divide|modulo|power|round|floor|ceil|abs', a?, aBinding?, b?, bBinding?, precision? }",
  },
  encode: {
    group: "transform",
    summary: "Encode/decode a string → {result} (base64/base64url/hex/url).",
    config:
      "{ operation:'base64Encode|base64Decode|hexEncode|hexDecode|urlEncode|urlDecode', from, path? }",
  },
  dateTime: {
    group: "transform",
    summary: "Current time or timestamp math; output {iso,epochMs}.",
    config: "{ source:'now'|{from,path}, addSeconds? }",
  },
  // --- Flow / control ---
  merge: {
    group: "flow",
    summary:
      "Fan-in join: runs once after ALL inbound branches arrive; combines them. Inbound edges must be UNCONDITIONAL.",
    config: "{ mode:'array|object' }",
  },
  if: {
    group: "flow",
    summary:
      "Boolean gate: combine predicates with AND/OR → {result}. Branch edges on <id>.result eq true/false.",
    config: "{ combine:'and|or', conditions:[{path,op,value}] }",
  },
  switch: {
    group: "flow",
    summary:
      "Multi-way router: first matching rule → {matched}. Branch edges on <id>.matched.",
    config: "{ rules:[{name,condition:{path,op,value}}], fallback? }",
  },
  executeSubWorkflow: {
    group: "flow",
    summary:
      "Run another SAVED workflow by key; output {status,output}. Reference only a workflowKey the user already has.",
    config: "{ workflowKey, input?, inputBindings? }",
  },
  forEach: {
    group: "flow",
    summary:
      "Run a saved workflow once per array item; output array of {status,output}.",
    config: "{ workflowKey, from, path? }",
  },
  wait: {
    group: "flow",
    summary:
      "Durable pause (survives restarts): a fixed delay, or until an external system calls the run's resume URL.",
    config:
      "{ mode?: 'duration' | 'webhook', durationSeconds?, timeoutSeconds? }",
  },
  humanApproval: {
    group: "flow",
    summary:
      "Pause until a person approves/rejects (can wait days). Continue on approve; run stops on reject. Optional routing (approvers), SLA, reminder/escalation timers, and a structured context card.",
    config:
      "{ title?, instructions?, timeoutHours?, approvers?: { emails?, groupIds? }, slaHours?, remindAfterHours?: number[], escalateAfterHours?, escalateTo?, contextFields?: { key: expression } }",
  },
  respondToWebhook: {
    group: "flow",
    summary:
      "Set the synchronous HTTP response for a webhook flow (run then continues).",
    config: "{ statusCode?, body?, headers? }",
  },
  code: {
    group: "flow",
    summary: "Run sandboxed JS ($input, $ctx); the return value is the output.",
    config: "{ code }",
  },
  // --- Crypto ---
  hmac: {
    group: "crypto",
    summary: "Sign a payload with a `signing` connection's key → {digest}.",
    config: "{ connectionId, algorithm?, payload?, payloadBinding? }",
  },
  jwt: {
    group: "crypto",
    summary: "Mint a signed JWT via a `signing` connection → {token}.",
    config:
      "{ connectionId, algorithm?, claims?, claimsBindings?, expiresInSeconds? }",
  },
  totp: {
    group: "crypto",
    summary:
      "Current RFC-6238 TOTP code from a `signing` connection seed → {code}.",
    config: "{ connectionId, digits?, period?, algorithm? }",
  },
  hash: {
    group: "crypto",
    summary: "Keyless one-way digest of a value → {digest} (sha256/512/1/md5).",
    config: "{ algorithm?, encoding?, input?, inputBinding? }",
  },
  random: {
    group: "crypto",
    summary:
      "Generate a random value → {value} (uuid/hex/base64/alphanumeric/int).",
    config:
      "{ operation:'uuid|hex|base64|alphanumeric|int', length?, min?, max? }",
  },
  // --- Comms ---
  sendEmail: {
    group: "comms",
    summary:
      "Send an email via an `smtp` connection → {messageId}. At-most-once.",
    config: "{ connectionId, to?, subject?, text?, html?, fieldBindings? }",
  },
  // --- Terminal ---
  stopAndError: {
    group: "terminal",
    summary: "Fail the run with a message. Terminal.",
    config: "{ message? }",
  },
  end: { group: "terminal", summary: "Marks the end of the workflow." },
};

/** Every node type, from the catalog (exhaustive by construction). */
export const NODE_TYPES = Object.keys(NODE_CATALOG) as NodeType[];

/**
 * Does this node type accept `config.sampleInput` (#983)? The canvas asks before rendering the
 * "Sample input (JSON)" field. Own-property check, not `NODE_CATALOG[type]?.sampleInput`, so a
 * hostile deserialized type like `"constructor"` reads as false rather than walking the prototype.
 */
export function acceptsSampleInput(type: NodeType): boolean {
  return (
    Object.prototype.hasOwnProperty.call(NODE_CATALOG, type) &&
    NODE_CATALOG[type].sampleInput === true
  );
}

// Exhaustive list of edge/predicate operators (Record → keys enforces all ConditionOp members).
const CONDITION_OP_PRESENCE: Record<ConditionOp, true> = {
  eq: true,
  neq: true,
  in: true,
  exists: true,
  gt: true,
  lt: true,
  gte: true,
  lte: true,
  contains: true,
  notContains: true,
  startsWith: true,
  endsWith: true,
  regex: true,
  isEmpty: true,
  notEmpty: true,
};
export const CONDITION_OPS = Object.keys(
  CONDITION_OP_PRESENCE,
) as ConditionOp[];

/** Render the catalog as compact prompt text for the AI workflow builder. */
export function nodeCatalogPrompt(): string {
  return (Object.entries(NODE_CATALOG) as [NodeType, NodeCatalogEntry][])
    .map(
      ([type, e]) =>
        `"${type}"${e.entry ? " [entry]" : ""}: ${e.summary}${e.config ? ` config: ${e.config}` : ""}`,
    )
    .join("\n");
}

// n8n CORE node types (the non-app primitives) mapped to OUR DSL node types.
//
// Source: n8n-io/n8n@master `packages/nodes-base/nodes`, taken as the exact complement
// of the 240 app integrations in ./n8n-integration-catalog.ts (67 nodes, disjoint + complete).
// `mapsTo` / `coverage` describe how far OUR interpreter covers each — update as we build.
//
// coverage:
//   'covered' — a dedicated DSL node does the same job
//   'partial' — approximated (e.g. branching via EdgeConditions, waits via humanApproval)
//   'gap'     — a real capability we don't have yet (roadmap candidate)
//   'na'      — n8n-internal / editor-only; not a competitive gap

/** Node types our DSL interpreter supports today (packages/dsl types.ts). */
export type DslNodeType =
  | "start"
  | "webhookTrigger"
  | "errorTrigger"
  | "pollTrigger"
  | "agent"
  | "mcpTool"
  | "httpRequest"
  | "sqlQuery"
  | "set"
  | "renameKeys"
  | "dateTime"
  | "merge"
  | "filter"
  | "aggregate"
  | "listOps"
  | "compareDatasets"
  | "xml"
  | "hmac"
  | "jwt"
  | "totp"
  | "sendEmail"
  | "wait"
  | "stopAndError"
  | "code"
  | "executeSubWorkflow"
  | "forEach"
  | "rssRead"
  | "respondToWebhook"
  | "humanApproval"
  | "end";

/** '*schedule' = covered as a platform feature (Temporal Schedules /
 *  SchedulesService), not an in-graph node. */
export type PlatformFeatureRef = "*schedule";

/** '*edges' = handled by EdgeConditions on the graph, not a node. */
export type DslCoverageRef = DslNodeType | "*edges" | PlatformFeatureRef;

export type CoreNodeGroup =
  | "Triggers"
  | "Flow control"
  | "HTTP & API"
  | "Agent & AI"
  | "Human in the loop"
  | "Data transformation"
  | "Code & scripting"
  | "Files & binary"
  | "Communication"
  | "Utility & security"
  | "Internal / dev-only"
  | "Organization";

export type Coverage = "covered" | "partial" | "gap" | "na";

export interface CoreNodeType {
  /** n8n display name. */
  name: string;
  slug: string;
  /** Source directory in n8n's nodes-base. */
  n8nNode: string;
  group: CoreNodeGroup;
  /** Our DSL node type(s) that cover it; [] when it's a gap/na. */
  mapsTo: DslCoverageRef[];
  coverage: Coverage;
  note?: string;
}

export const N8N_CORE_NODE_TYPES: CoreNodeType[] = [
  // ── Triggers
  {
    name: "Manual Trigger",
    slug: "manual-trigger",
    n8nNode: "ManualTrigger",
    group: "Triggers",
    mapsTo: ["start"],
    coverage: "covered",
  },
  {
    name: "Webhook",
    slug: "webhook",
    n8nNode: "Webhook",
    group: "Triggers",
    mapsTo: ["webhookTrigger"],
    coverage: "covered",
  },
  {
    name: "Schedule Trigger",
    slug: "schedule",
    n8nNode: "Schedule",
    group: "Triggers",
    mapsTo: ["*schedule"],
    coverage: "covered",
    note: "Covered as a platform feature — Temporal Schedules (SchedulesService + Schedules UI), a cron bound to a saved workflow, not an in-graph node.",
  },
  {
    name: "Cron (legacy)",
    slug: "cron",
    n8nNode: "Cron",
    group: "Triggers",
    mapsTo: ["*schedule"],
    coverage: "covered",
    note: "Covered via Temporal Schedules (cron expressions); same feature as Schedule Trigger.",
  },
  {
    name: "Interval",
    slug: "interval",
    n8nNode: "Interval",
    group: "Triggers",
    mapsTo: ["*schedule"],
    coverage: "covered",
    note: "Covered via Temporal Schedules; same feature as Schedule Trigger.",
  },
  {
    name: "n8n Trigger",
    slug: "n-8n-trigger",
    n8nNode: "N8nTrigger",
    group: "Triggers",
    mapsTo: [],
    coverage: "gap",
    note: "Fires on internal platform events.",
  },
  {
    name: "Workflow Trigger",
    slug: "workflow-trigger",
    n8nNode: "WorkflowTrigger",
    group: "Triggers",
    mapsTo: [],
    coverage: "gap",
    note: "Fires on workflow lifecycle events.",
  },
  {
    name: "Error Trigger",
    slug: "error-trigger",
    n8nNode: "ErrorTrigger",
    group: "Triggers",
    mapsTo: ["errorTrigger"],
    coverage: "covered",
    note: "errorTrigger entry node — a failing run auto-starts its bound error-handler graph (detached, ParentClosePolicy.ABANDON) with the failure context; loop-guarded.",
  },
  {
    name: "Poll Trigger",
    slug: "poll-trigger",
    n8nNode: "PollTrigger (n8n polling triggers)",
    group: "Triggers",
    mapsTo: ["pollTrigger"],
    coverage: "covered",
    note: "pollTrigger entry node — a Temporal interval Schedule runs the graph every intervalSeconds; the node fetches the URL and only fires downstream when a change key (or the whole body) differs from a persisted per-(tenant,workflow,node) cursor.",
  },
  {
    name: "SSE Trigger",
    slug: "sse-trigger",
    n8nNode: "SseTrigger",
    group: "Triggers",
    mapsTo: [],
    coverage: "gap",
    note: "Server-sent-events source.",
  },
  {
    name: "Local File Trigger",
    slug: "local-file-trigger",
    n8nNode: "LocalFileTrigger",
    group: "Triggers",
    mapsTo: [],
    coverage: "gap",
    note: "Filesystem watch; out of scope for a durable cloud runtime.",
  },
  {
    name: "Email Trigger (IMAP)",
    slug: "email-read-imap",
    n8nNode: "EmailReadImap",
    group: "Triggers",
    mapsTo: [],
    coverage: "gap",
    note: "Inbound email start.",
  },
  // ── Flow control
  {
    name: "If",
    slug: "if",
    n8nNode: "If",
    group: "Flow control",
    mapsTo: ["*edges"],
    coverage: "partial",
    note: "Branching is expressed as EdgeConditions, not a node.",
  },
  {
    name: "Switch",
    slug: "switch",
    n8nNode: "Switch",
    group: "Flow control",
    mapsTo: ["*edges"],
    coverage: "partial",
    note: "Multi-way branch via EdgeConditions on node output.",
  },
  {
    name: "Filter",
    slug: "filter",
    n8nNode: "Filter",
    group: "Flow control",
    mapsTo: ["filter"],
    coverage: "covered",
    note: "filter node — keeps array-VALUE items matching a structured predicate (reuses EdgeCondition). We operate on an array value, not n8n's implicit per-item stream.",
  },
  {
    name: "Merge",
    slug: "merge",
    n8nNode: "Merge",
    group: "Flow control",
    mapsTo: ["merge"],
    coverage: "covered",
    note: "merge node — fan-in join (array/object combine). v1 supports unconditional fan-in; conditional/loop joins out of scope.",
  },
  {
    name: "Loop Over Items (Split in Batches)",
    slug: "split-in-batches",
    n8nNode: "SplitInBatches",
    group: "Flow control",
    mapsTo: ["forEach"],
    coverage: "partial",
    note: "forEach runs a saved sub-workflow once per array item (child run per item, capped), not an in-graph batch loop; sequential/batch modes are follow-ups.",
  },
  {
    name: "Wait",
    slug: "wait",
    n8nNode: "Wait",
    group: "Flow control",
    mapsTo: ["wait"],
    coverage: "covered",
    note: "wait node — durable timed delay via wf.sleep (plus humanApproval for signal-based waits).",
  },
  {
    name: "Execute Sub-workflow",
    slug: "execute-workflow",
    n8nNode: "ExecuteWorkflow",
    group: "Flow control",
    mapsTo: ["executeSubWorkflow"],
    coverage: "covered",
    note: "executeSubWorkflow node — runs a saved graph as a durable child run; bounded {status,output} projection; depth-capped.",
  },
  {
    name: "Respond to Webhook",
    slug: "respond-to-webhook",
    n8nNode: "RespondToWebhook",
    group: "Flow control",
    mapsTo: ["respondToWebhook"],
    coverage: "covered",
    note: "respondToWebhook node — the ingress waits (bounded) for the node to set a response and returns it synchronously; set-and-continue. Opt-in per graph.",
  },
  {
    name: "Stop and Error",
    slug: "stop-and-error",
    n8nNode: "StopAndError",
    group: "Flow control",
    mapsTo: ["stopAndError"],
    coverage: "covered",
    note: "stopAndError node — terminal, fails the run with a message (non-retryable ApplicationFailure).",
  },
  {
    name: "No Operation",
    slug: "no-op",
    n8nNode: "NoOp",
    group: "Flow control",
    mapsTo: [],
    coverage: "na",
    note: "Pass-through; trivial, not a real gap.",
  },
  // ── HTTP & API
  {
    name: "HTTP Request",
    slug: "http-request",
    n8nNode: "HttpRequest",
    group: "HTTP & API",
    mapsTo: ["httpRequest"],
    coverage: "covered",
  },
  {
    name: "GraphQL",
    slug: "graph-q-l",
    n8nNode: "GraphQL",
    group: "HTTP & API",
    mapsTo: ["httpRequest"],
    coverage: "partial",
    note: "GraphQL reachable via httpRequest; no dedicated node.",
  },
  // ── Agent & AI
  {
    name: "Message an Agent",
    slug: "message-an-agent",
    n8nNode: "MessageAnAgent",
    group: "Agent & AI",
    mapsTo: ["agent"],
    coverage: "partial",
    note: "Our agent node is the LLM call; no multi-agent messaging.",
  },
  {
    name: "AI Transform",
    slug: "ai-transform",
    n8nNode: "AiTransform",
    group: "Agent & AI",
    mapsTo: ["agent"],
    coverage: "partial",
    note: "LLM-assisted field transform; approximate with an agent node.",
  },
  {
    name: "Evaluation",
    slug: "evaluation",
    n8nNode: "Evaluation",
    group: "Agent & AI",
    mapsTo: [],
    coverage: "gap",
    note: "LLM output evaluation/scoring.",
  },
  // ── Human in the loop
  {
    name: "n8n Form",
    slug: "form",
    n8nNode: "Form",
    group: "Human in the loop",
    mapsTo: ["humanApproval"],
    coverage: "partial",
    note: "Form collects input mid-run; humanApproval is the closest durable-wait primitive.",
  },
  // ── Data transformation
  {
    name: "Edit Fields (Set)",
    slug: "set",
    n8nNode: "Set",
    group: "Data transformation",
    mapsTo: ["set"],
    coverage: "covered",
    note: "set node — builds an object from static fields + upstream bindings (replace-only).",
  },
  {
    name: "Item Lists / Split Out / Aggregate",
    slug: "item-lists",
    n8nNode: "ItemLists",
    group: "Data transformation",
    mapsTo: ["aggregate", "listOps"],
    coverage: "covered",
    note: "aggregate (collect/count/sum/first/last) + listOps (sort/limit/dedupe) over an array value. splitOut is a follow-up.",
  },
  {
    name: "Rename Keys",
    slug: "rename-keys",
    n8nNode: "RenameKeys",
    group: "Data transformation",
    mapsTo: ["renameKeys"],
    coverage: "covered",
    note: "renameKeys node — remap/drop an upstream object's keys (pure).",
  },
  {
    name: "Compare Datasets",
    slug: "compare-datasets",
    n8nNode: "CompareDatasets",
    group: "Data transformation",
    mapsTo: ["compareDatasets"],
    coverage: "covered",
    note: "compareDatasets node — diffs two arrays by a key into added/removed/changed/same (pure).",
  },
  {
    name: "Date & Time",
    slug: "date-time",
    n8nNode: "DateTime",
    group: "Data transformation",
    mapsTo: ["dateTime"],
    coverage: "covered",
    note: "dateTime node — current time / timestamp math (clock read is an activity).",
  },
  {
    name: "Markdown",
    slug: "markdown",
    n8nNode: "Markdown",
    group: "Data transformation",
    mapsTo: [],
    coverage: "gap",
    note: "Markdown<->HTML conversion.",
  },
  {
    name: "HTML",
    slug: "html",
    n8nNode: "Html",
    group: "Data transformation",
    mapsTo: [],
    coverage: "gap",
    note: "HTML template/extract.",
  },
  {
    name: "HTML Extract (legacy)",
    slug: "html-extract",
    n8nNode: "HtmlExtract",
    group: "Data transformation",
    mapsTo: [],
    coverage: "gap",
  },
  {
    name: "XML",
    slug: "xml",
    n8nNode: "Xml",
    group: "Data transformation",
    mapsTo: ["xml"],
    coverage: "covered",
    note: "xml node — parse XML->object / build object->XML (fast-xml-parser, in an activity).",
  },
  {
    name: "Transform",
    slug: "transform",
    n8nNode: "Transform",
    group: "Data transformation",
    mapsTo: [],
    coverage: "gap",
    note: "Generic item transform.",
  },
  {
    name: "Data Table",
    slug: "data-table",
    n8nNode: "DataTable",
    group: "Data transformation",
    mapsTo: [],
    coverage: "gap",
    note: "n8n's built-in row store; sqlQuery targets external DBs instead.",
  },
  // ── Code & scripting
  {
    name: "Code",
    slug: "code",
    n8nNode: "Code",
    group: "Code & scripting",
    mapsTo: ["code"],
    coverage: "covered",
    note: "code node — user JS in a QuickJS/WASM sandbox (activity, since QuickJS is non-deterministic); no host access, memory + wall-clock capped.",
  },
  {
    name: "Function (legacy)",
    slug: "function",
    n8nNode: "Function",
    group: "Code & scripting",
    mapsTo: [],
    coverage: "gap",
    note: "Legacy code node.",
  },
  {
    name: "Function Item (legacy)",
    slug: "function-item",
    n8nNode: "FunctionItem",
    group: "Code & scripting",
    mapsTo: [],
    coverage: "gap",
    note: "Legacy per-item code node.",
  },
  // ── Files & binary
  {
    name: "Read/Write Files from Disk",
    slug: "files",
    n8nNode: "Files",
    group: "Files & binary",
    mapsTo: [],
    coverage: "gap",
    note: "Local disk I/O; large payloads should go to object storage per CLAUDE.md.",
  },
  {
    name: "Read Binary File",
    slug: "read-binary-file",
    n8nNode: "ReadBinaryFile",
    group: "Files & binary",
    mapsTo: [],
    coverage: "gap",
  },
  {
    name: "Read Binary Files",
    slug: "read-binary-files",
    n8nNode: "ReadBinaryFiles",
    group: "Files & binary",
    mapsTo: [],
    coverage: "gap",
  },
  {
    name: "Write Binary File",
    slug: "write-binary-file",
    n8nNode: "WriteBinaryFile",
    group: "Files & binary",
    mapsTo: [],
    coverage: "gap",
  },
  {
    name: "Convert to/from Binary Data",
    slug: "move-binary-data",
    n8nNode: "MoveBinaryData",
    group: "Files & binary",
    mapsTo: [],
    coverage: "gap",
  },
  {
    name: "Spreadsheet File (CSV/XLSX)",
    slug: "spreadsheet-file",
    n8nNode: "SpreadsheetFile",
    group: "Files & binary",
    mapsTo: [],
    coverage: "gap",
    note: "CSV/XLSX parse+generate.",
  },
  {
    name: "Read PDF",
    slug: "read-pdf",
    n8nNode: "ReadPdf",
    group: "Files & binary",
    mapsTo: [],
    coverage: "gap",
  },
  {
    name: "Edit Image",
    slug: "edit-image",
    n8nNode: "EditImage",
    group: "Files & binary",
    mapsTo: [],
    coverage: "gap",
  },
  {
    name: "Compression",
    slug: "compression",
    n8nNode: "Compression",
    group: "Files & binary",
    mapsTo: [],
    coverage: "gap",
    note: "Zip/unzip.",
  },
  {
    name: "iCalendar",
    slug: "i-calendar",
    n8nNode: "ICalendar",
    group: "Files & binary",
    mapsTo: [],
    coverage: "gap",
    note: "Generate .ics files.",
  },
  // ── Communication
  {
    name: "Send Email (SMTP)",
    slug: "email-send",
    n8nNode: "EmailSend",
    group: "Communication",
    mapsTo: ["sendEmail"],
    coverage: "covered",
    note: "sendEmail node — outbound SMTP via an `smtp` connection (SSRF-guarded, at-most-once).",
  },
  {
    name: "RSS Read",
    slug: "rss-feed-read",
    n8nNode: "RssFeedRead",
    group: "Communication",
    mapsTo: ["rssRead"],
    coverage: "covered",
    note: "rssRead node — fetches + parses an RSS/Atom feed (egress-guarded) into an items array.",
  },
  // ── Utility & security
  {
    name: "Crypto",
    slug: "crypto",
    n8nNode: "Crypto",
    group: "Utility & security",
    mapsTo: ["hmac"],
    coverage: "partial",
    note: "hmac node signs via a `signing` connection; plain hashing/other algos are follow-ups.",
  },
  {
    name: "JWT",
    slug: "jwt",
    n8nNode: "Jwt",
    group: "Utility & security",
    mapsTo: ["jwt"],
    coverage: "covered",
    note: "jwt node — mints HS256/RS256 tokens via a `signing` connection.",
  },
  {
    name: "TOTP",
    slug: "totp",
    n8nNode: "Totp",
    group: "Utility & security",
    mapsTo: ["totp"],
    coverage: "covered",
    note: "totp node — RFC-6238 code generation from a `signing` connection seed.",
  },
  {
    name: "SSH",
    slug: "ssh",
    n8nNode: "Ssh",
    group: "Utility & security",
    mapsTo: [],
    coverage: "gap",
    note: "Remote command over SSH.",
  },
  {
    name: "Execute Command",
    slug: "execute-command",
    n8nNode: "ExecuteCommand",
    group: "Utility & security",
    mapsTo: [],
    coverage: "gap",
    note: "Shell exec on the host; disallowed by our activity model.",
  },
  // ── Internal / dev-only
  {
    name: "DebugHelper",
    slug: "debug-helper",
    n8nNode: "DebugHelper",
    group: "Internal / dev-only",
    mapsTo: [],
    coverage: "na",
    note: "n8n dev/test helper.",
  },
  {
    name: "Simulate",
    slug: "simulate",
    n8nNode: "Simulate",
    group: "Internal / dev-only",
    mapsTo: [],
    coverage: "na",
    note: "Test scaffolding node.",
  },
  {
    name: "E2E Test",
    slug: "e-2e-test",
    n8nNode: "E2eTest",
    group: "Internal / dev-only",
    mapsTo: [],
    coverage: "na",
    note: "n8n's own e2e test node.",
  },
  {
    name: "Dynamic Credential Check",
    slug: "dynamic-credential-check",
    n8nNode: "DynamicCredentialCheck",
    group: "Internal / dev-only",
    mapsTo: [],
    coverage: "na",
    note: "Internal credential test.",
  },
  {
    name: "Execution Data",
    slug: "execution-data",
    n8nNode: "ExecutionData",
    group: "Internal / dev-only",
    mapsTo: [],
    coverage: "na",
    note: "Annotate execution metadata.",
  },
  {
    name: "Time Saved",
    slug: "time-saved",
    n8nNode: "TimeSaved",
    group: "Internal / dev-only",
    mapsTo: [],
    coverage: "na",
    note: "Internal metrics node.",
  },
  {
    name: "Customer Datastore (training)",
    slug: "n-8n-training-customer-datastore",
    n8nNode: "N8nTrainingCustomerDatastore",
    group: "Internal / dev-only",
    mapsTo: [],
    coverage: "na",
    note: "Tutorial/training node.",
  },
  {
    name: "Customer Messenger (training)",
    slug: "n-8n-training-customer-messenger",
    n8nNode: "N8nTrainingCustomerMessenger",
    group: "Internal / dev-only",
    mapsTo: [],
    coverage: "na",
    note: "Tutorial/training node.",
  },
  // ── Organization
  {
    name: "Sticky Note",
    slug: "sticky-note",
    n8nNode: "StickyNote",
    group: "Organization",
    mapsTo: [],
    coverage: "na",
    note: "Editor-only canvas annotation; no runtime behavior.",
  },
];

/** Capabilities n8n has as first-class nodes that our DSL lacks (excludes 'na'). */
export function dslGaps(): CoreNodeType[] {
  return N8N_CORE_NODE_TYPES.filter((n) => n.coverage === "gap");
}

/** Coverage rollup across the core node types. */
export function coverageSummary(): Record<Coverage, number> {
  return N8N_CORE_NODE_TYPES.reduce((acc, n) => ((acc[n.coverage] += 1), acc), {
    covered: 0,
    partial: 0,
    gap: 0,
    na: 0,
  } as Record<Coverage, number>);
}

/**
 * TYPED-DSL (docs/design/TYPED-DSL.md) — one runtime SCHEMA per node config.
 *
 * This is the zod layer of the DSL. From each node's `config` schema we derive:
 *   - TS types      (`z.infer`, below) — the source of truth Phase 2 points the interpreter at,
 *                    replacing the hand-written *NodeConfig interfaces in types.ts.
 *   - runtime validation (`nodeConfigSchema(type).safeParse`) — for the API / save path.
 *   - JSON Schema   (`nodeConfigJsonSchema` / zod v4 `z.toJSONSchema`) — concrete per-node config
 *                    for enriching the generator prompt (the generator itself stays plain-text; see
 *                    the design doc's Phase 1b result).
 *
 * TIER-1 LANDMINE (CLAUDE.md rule 2): zod is RUNTIME validation and must NEVER be evaluated
 * inside the deterministic Temporal workflow bundle. This module is therefore DELIBERATELY NOT
 * re-exported from `./index` — the worker's `@naary/dsl` import surface stays zod-free. Only the
 * API, the generator, activities, and tests import this file (directly or via a subpath). The
 * interpreter consumes the erased TYPES only (`import type`), never these schema VALUES.
 *
 * Coverage: every config-bearing node type has a concrete schema; the three config-less entry/exit
 * nodes (webhookTrigger, errorTrigger, end) use the permissive fallback. Each concrete schema is a
 * faithful port of its interface, enforced at build time by the `Exact<…>` parity guards at the
 * bottom — a drift makes the guard resolve to `never` and fails `tsc -b`, naming the culprit.
 */
import { z } from "zod";
import type {
  AggregateNodeConfig,
  ApprovalNodeConfig,
  CodeNodeConfig,
  CompareDatasetsNodeConfig,
  ConditionOp,
  CsvNodeConfig,
  DateTimeNodeConfig,
  EncodeNodeConfig,
  ExecuteSubWorkflowNodeConfig,
  FilterNodeConfig,
  ForEachNodeConfig,
  HashNodeConfig,
  HmacNodeConfig,
  HtmlExtractNodeConfig,
  MarkdownNodeConfig,
  HttpRequestNodeConfig,
  IfNodeConfig,
  JsonNodeConfig,
  JwtNodeConfig,
  ListOpsNodeConfig,
  McpToolNodeConfig,
  MergeNodeConfig,
  NodeType,
  NumberNodeConfig,
  FormTriggerNodeConfig,
  PollTriggerNodeConfig,
  RandomNodeConfig,
  RenameKeysNodeConfig,
  RespondToWebhookNodeConfig,
  RssReadNodeConfig,
  ScheduleTriggerNodeConfig,
  SendEmailNodeConfig,
  SetNodeConfig,
  SqlExecNodeConfig,
  SqlQueryNodeConfig,
  StartNodeConfig,
  StopAndErrorNodeConfig,
  SwitchNodeConfig,
  TextNodeConfig,
  TotpNodeConfig,
  WaitNodeConfig,
  XmlNodeConfig,
} from "./types";

/** {from, path?} upstream-output binding (mirrors ArgBinding in types.ts). */
const argBinding = z.object({ from: z.string(), path: z.string().optional() });

/**
 * The operator set as a LITERAL tuple, so `z.enum` infers the exact `ConditionOp` union (a plain
 * `ConditionOp[]` would widen `op` to `string` and break the parity guards below). The two
 * assertions keep it honest: `satisfies` rejects a bogus op; `_opsComplete` rejects an omission.
 */
const CONDITION_OP_VALUES = [
  "eq",
  "neq",
  "in",
  "exists",
  "gt",
  "lt",
  "gte",
  "lte",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "regex",
  "isEmpty",
  "notEmpty",
] as const satisfies readonly ConditionOp[];
type _opsComplete = ConditionOp extends (typeof CONDITION_OP_VALUES)[number]
  ? true
  : never;
const _opsComplete: _opsComplete = true; // fails the build if a ConditionOp is missing above
void _opsComplete;

/** Structured edge/predicate condition (mirrors EdgeCondition in types.ts). */
const edgeCondition = z.object({
  path: z.string(),
  op: z.enum(CONDITION_OP_VALUES),
  value: z.unknown().optional(),
});

/** One HTML Extract field (mirrors HtmlExtraction in types.ts). */
const htmlExtraction = z.object({
  key: z.string(),
  selector: z.string(),
  return: z.enum(["text", "html", "attribute"]).optional(),
  attribute: z.string().optional(),
  all: z.boolean().optional(),
});

/**
 * Concrete config schema per node type. Each mirrors its hand-written `*NodeConfig` interface
 * (agent has none today — it's the flagship node whose config was fully untyped, so this is the
 * first type it gets). Enum operations use inline literal arrays so `z.enum` preserves the exact
 * union; the per-node parity guard then proves completeness against the interface.
 */
const CONFIG_SCHEMAS = {
  // --- Triggers / entry ---
  start: z.object({
    sampleInput: z.record(z.string(), z.unknown()).optional(),
  }),
  scheduleTrigger: z.object({ cron: z.string() }),
  formTrigger: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    submitLabel: z.string().optional(),
    fields: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        type: z.enum(["text", "textarea", "number", "email", "select"]),
        required: z.boolean().optional(),
        placeholder: z.string().optional(),
        options: z.array(z.string()).optional(),
      }),
    ),
  }),
  pollTrigger: z.object({
    url: z.string(),
    intervalSeconds: z.number(),
    changeKey: z.string().optional(),
  }),

  // --- AI ---
  agent: z.object({
    // provider/model/systemPrompt are OPTIONAL on purpose: runAgent defaults provider→anthropic
    // and model→claude-opus-4-8 and tolerates a missing systemPrompt (activities.ts), so a
    // save-gate must accept whatever the runtime does — requiring them would reject valid graphs
    // whose author never touched the dropdown. (agent has no *NodeConfig interface, so no parity
    // guard; this shape is verified by the corpus round-trip test instead.)
    provider: z.string().optional(),
    model: z.string().optional(),
    systemPrompt: z.string().optional(),
    /** Sampling temperature (0–2); omitted ⇒ provider default. */
    temperature: z.number().optional(),
    /** Per-node output cap; omitted ⇒ MAX_OUTPUT_TOKENS. */
    maxOutputTokens: z.number().optional(),
    /** JSON-schema-ish object describing the agent's structured output, if any. */
    outputSchema: z.record(z.string(), z.unknown()).optional(),
  }),
  mcpTool: z.object({
    connectionId: z.string(),
    tool: z.string(),
    arguments: z.record(z.string(), z.unknown()).optional(),
    argumentBindings: z.record(z.string(), argBinding).optional(),
    costUsd: z.number().optional(),
  }),

  // --- Data sources ---
  httpRequest: z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    query: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
    argumentBindings: z.record(z.string(), argBinding).optional(),
    connectionId: z.string().optional(),
    failOnErrorStatus: z.boolean().optional(),
    timeoutMs: z.number().optional(),
    costUsd: z.number().optional(),
    pagination: z
      .object({
        mode: z.enum(["cursor", "page", "url"]),
        itemsPath: z.string().optional(),
        cursorPath: z.string().optional(),
        cursorParam: z.string().optional(),
        pageParam: z.string().optional(),
        startPage: z.number().optional(),
        nextUrlPath: z.string().optional(),
        stopOnEmpty: z.boolean().optional(),
        maxPages: z.number().optional(),
      })
      .optional(),
  }),
  sqlQuery: z.object({
    connectionId: z.string(),
    sql: z.string(),
    params: z.array(z.unknown()).optional(),
    paramBindings: z.record(z.number(), argBinding).optional(),
    statementTimeoutMs: z.number().optional(),
    costUsd: z.number().optional(),
  }),
  sqlExec: z.object({
    connectionId: z.string(),
    sql: z.string(),
    params: z.array(z.unknown()).optional(),
    paramBindings: z.record(z.number(), argBinding).optional(),
    statementTimeoutMs: z.number().optional(),
    costUsd: z.number().optional(),
  }),
  rssRead: z.object({
    url: z.string(),
    urlBinding: argBinding.optional(),
    timeoutMs: z.number().optional(),
  }),

  // --- Transform ---
  set: z.object({
    fields: z.record(z.string(), z.unknown()).optional(),
    fieldBindings: z.record(z.string(), argBinding).optional(),
  }),
  renameKeys: z.object({
    from: z.string(),
    path: z.string().optional(),
    rename: z.record(z.string(), z.string()).optional(),
    drop: z.array(z.string()).optional(),
  }),
  text: z.object({
    operation: z.enum([
      "upper",
      "lower",
      "trim",
      "replace",
      "split",
      "join",
      "substring",
      "length",
      "regexExtract",
    ]),
    from: z.string(),
    path: z.string().optional(),
    search: z.string().optional(),
    replacement: z.string().optional(),
    useRegex: z.boolean().optional(),
    separator: z.string().optional(),
    start: z.number().optional(),
    end: z.number().optional(),
    group: z.number().optional(),
  }),
  filter: z.object({
    from: z.string(),
    path: z.string().optional(),
    condition: edgeCondition,
  }),
  aggregate: z.object({
    from: z.string(),
    path: z.string().optional(),
    operation: z.enum([
      "collect",
      "count",
      "sum",
      "min",
      "max",
      "avg",
      "first",
      "last",
    ]),
    field: z.string().optional(),
  }),
  listOps: z.object({
    from: z.string(),
    path: z.string().optional(),
    operation: z.enum(["sort", "limit", "dedupe"]),
    field: z.string().optional(),
    order: z.enum(["asc", "desc"]).optional(),
    count: z.number().optional(),
  }),
  compareDatasets: z.object({
    a: argBinding,
    b: argBinding,
    key: z.string(),
  }),
  xml: z.object({
    operation: z.enum(["parse", "build"]),
    from: z.string(),
    path: z.string().optional(),
  }),
  htmlExtract: z.object({
    from: z.string(),
    path: z.string().optional(),
    extractions: z.array(htmlExtraction),
  }),
  markdown: z.object({
    from: z.string(),
    path: z.string().optional(),
  }),
  csv: z.object({
    operation: z.enum(["parse", "build"]),
    from: z.string(),
    path: z.string().optional(),
    header: z.boolean().optional(),
    delimiter: z.string().optional(),
  }),
  json: z.object({
    operation: z.enum(["parse", "stringify"]),
    from: z.string(),
    path: z.string().optional(),
    indent: z.number().optional(),
  }),
  number: z.object({
    operation: z.enum([
      "add",
      "subtract",
      "multiply",
      "divide",
      "modulo",
      "power",
      "round",
      "floor",
      "ceil",
      "abs",
    ]),
    a: z.number().optional(),
    aBinding: argBinding.optional(),
    b: z.number().optional(),
    bBinding: argBinding.optional(),
    precision: z.number().optional(),
  }),
  encode: z.object({
    operation: z.enum([
      "base64Encode",
      "base64Decode",
      "base64urlEncode",
      "base64urlDecode",
      "hexEncode",
      "hexDecode",
      "urlEncode",
      "urlDecode",
    ]),
    from: z.string(),
    path: z.string().optional(),
  }),
  dateTime: z.object({
    source: z.union([z.literal("now"), argBinding]).optional(),
    addSeconds: z.number().optional(),
  }),

  // --- Flow / control ---
  merge: z.object({ mode: z.enum(["array", "object"]).optional() }),
  if: z.object({
    combine: z.enum(["and", "or"]).optional(),
    conditions: z.array(edgeCondition),
  }),
  switch: z.object({
    rules: z.array(z.object({ name: z.string(), condition: edgeCondition })),
    fallback: z.string().optional(),
  }),
  executeSubWorkflow: z.object({
    workflowKey: z.string(),
    input: z.record(z.string(), z.unknown()).optional(),
    inputBindings: z.record(z.string(), argBinding).optional(),
  }),
  forEach: z.object({
    workflowKey: z.string(),
    from: z.string(),
    path: z.string().optional(),
  }),
  code: z.object({
    code: z.string(),
    timeoutMs: z.number().optional(),
    memoryMb: z.number().optional(),
  }),
  wait: z.object({
    mode: z.enum(["duration", "webhook"]).optional(),
    durationSeconds: z.number().optional(),
    timeoutSeconds: z.number().optional(),
  }),
  humanApproval: z.object({
    title: z.string().optional(),
    instructions: z.string().optional(),
    timeoutHours: z.number().optional(),
  }),
  respondToWebhook: z.object({
    statusCode: z.number().optional(),
    body: z.unknown().optional(),
    bodyBinding: argBinding.optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }),

  // --- Crypto ---
  hmac: z.object({
    connectionId: z.string(),
    algorithm: z.enum(["sha256", "sha1"]).optional(),
    payload: z.unknown().optional(),
    payloadBinding: argBinding.optional(),
    encoding: z.enum(["hex", "base64"]).optional(),
  }),
  jwt: z.object({
    connectionId: z.string(),
    algorithm: z.enum(["HS256", "RS256"]).optional(),
    claims: z.record(z.string(), z.unknown()).optional(),
    claimsBindings: z.record(z.string(), argBinding).optional(),
    expiresInSeconds: z.number().optional(),
  }),
  totp: z.object({
    connectionId: z.string(),
    digits: z.number().optional(),
    period: z.number().optional(),
    algorithm: z.enum(["sha1", "sha256", "sha512"]).optional(),
  }),
  hash: z.object({
    algorithm: z.enum(["sha256", "sha512", "sha1", "md5"]).optional(),
    input: z.unknown().optional(),
    inputBinding: argBinding.optional(),
    encoding: z.enum(["hex", "base64"]).optional(),
  }),
  random: z.object({
    operation: z.enum(["uuid", "hex", "base64", "alphanumeric", "int"]),
    length: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),

  // --- Comms ---
  sendEmail: z.object({
    connectionId: z.string(),
    from: z.string().optional(),
    to: z.string().optional(),
    subject: z.string().optional(),
    text: z.string().optional(),
    html: z.string().optional(),
    fieldBindings: z.record(z.string(), argBinding).optional(),
    costUsd: z.number().optional(),
  }),

  // --- Terminal ---
  stopAndError: z.object({ message: z.string().optional() }),
} satisfies Partial<Record<NodeType, z.ZodTypeAny>>;

/**
 * Fallback for the config-less nodes (webhookTrigger, errorTrigger, end): any object of config
 * keys. Keeps the schema total over NodeType so `nodeConfigSchema` never returns undefined.
 */
const PERMISSIVE_CONFIG = z.record(z.string(), z.unknown());

/** The config schema for a node type — concrete when defined, else permissive. Uses an
 *  OWN-property check (not `[type]`/`in`) so a hostile deserialized `type` like `"__proto__"` or
 *  `"constructor"` can't reach up the prototype chain and return a non-schema value. */
export function nodeConfigSchema(type: NodeType): z.ZodTypeAny {
  return hasConcreteConfig(type)
    ? (CONFIG_SCHEMAS as Record<string, z.ZodTypeAny>)[type]
    : PERMISSIVE_CONFIG;
}

/** True when `type` has a concrete (non-fallback) schema. Own-property check (see above);
 *  `hasOwnProperty.call` rather than `Object.hasOwn` so it works under the es2021 lib. */
export function hasConcreteConfig(type: NodeType): boolean {
  return Object.prototype.hasOwnProperty.call(CONFIG_SCHEMAS, type);
}

/** The config field names for a node type (top-level keys of its object schema). Empty for the
 *  permissive fallback / config-less nodes. Lets other packages (e.g. the web's Simple-mode
 *  catalog) assert their hand-curated field lists only reference keys that actually exist. */
export function nodeConfigKeys(type: NodeType): string[] {
  const schema = nodeConfigSchema(type);
  return schema instanceof z.ZodObject ? Object.keys(schema.shape) : [];
}

/** One node's config-validation failure: the offending node + its per-field zod issues. */
export interface NodeConfigError {
  nodeId: string;
  nodeType: NodeType;
  issues: { path: string; message: string }[];
}

/**
 * Validate every node's config against its schema — the save-path GATE (Phase 3). Deliberately
 * LENIENT on MISSING fields (each concrete schema is `.partial()`d) so an in-progress draft — e.g.
 * an httpRequest whose `url` isn't filled yet — still saves; it's STRICT on PRESENT values, so a
 * genuinely wrong `method:"FETCH"` or `url:42` is rejected. This never rejects a known-good graph
 * for incompleteness (the risk of a naïve full-parse gate). Config-less/fallback nodes are skipped.
 *
 * GATE ONLY: returns errors; the caller must persist the ORIGINAL graph bytes unchanged — do NOT
 * store a parsed result (zod strips unmodeled keys → silent data loss).
 */
export function validateGraphConfigs(graph: {
  nodes: { id: string; type: NodeType; config?: Record<string, unknown> }[];
}): NodeConfigError[] {
  const errors: NodeConfigError[] = [];
  for (const node of graph.nodes) {
    if (!hasConcreteConfig(node.type)) continue; // permissive/config-less → nothing to check
    const schema = nodeConfigSchema(node.type);
    // All concrete schemas are ZodObjects; `.partial()` keeps present-value checks, drops
    // required-ness so a draft with unfilled fields isn't rejected on save.
    const lenient = schema instanceof z.ZodObject ? schema.partial() : schema;
    const res = lenient.safeParse(node.config ?? {});
    if (!res.success) {
      errors.push({
        nodeId: node.id,
        nodeType: node.type,
        issues: res.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }
  }
  return errors;
}

/**
 * A concrete stand-in for "any JSON value". Anthropic's structured-output validator REJECTS an
 * empty `{}` sub-schema ("Empty schema that accepts any JSON value is not supported") — the exact
 * bug in ai-generate-503-empty-schema. zod emits `{}` for `z.unknown()` / open records, so we
 * replace those with this explicit union before handing the schema to the generator.
 */
const ANY_JSON_VALUE = {
  anyOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
    { type: "array" },
    { type: "object" },
  ],
} as const;

/** Recursively replace every empty-`{}` sub-schema (and open `additionalProperties: {}`) with a
 *  concrete union, so the result is safe for Anthropic strict structured output. */
function sanitizeForStructuredOutput(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeForStructuredOutput);
  if (node && typeof node === "object") {
    const keys = Object.keys(node as object);
    if (keys.length === 0) return { ...ANY_JSON_VALUE }; // empty {} → concrete union
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = sanitizeForStructuredOutput(v);
    }
    return out;
  }
  return node;
}

/**
 * The node's config as a JSON Schema (zod v4 native), sanitized for strict structured output.
 * Concrete node types yield real `properties`/`required` with NO empty `{}` sub-schemas.
 */
export function nodeConfigJsonSchema(type: NodeType): Record<string, unknown> {
  const raw = z.toJSONSchema(nodeConfigSchema(type));
  return sanitizeForStructuredOutput(raw) as Record<string, unknown>;
}

// --- Derived TS types (Phase 2 points the interpreter's *NodeConfig at these) ------------------
export type StartConfig = z.infer<typeof CONFIG_SCHEMAS.start>;
export type FormTriggerConfig = z.infer<typeof CONFIG_SCHEMAS.formTrigger>;
export type ScheduleTriggerConfig = z.infer<
  typeof CONFIG_SCHEMAS.scheduleTrigger
>;
export type PollTriggerConfig = z.infer<typeof CONFIG_SCHEMAS.pollTrigger>;
export type AgentConfig = z.infer<typeof CONFIG_SCHEMAS.agent>;
export type McpToolConfig = z.infer<typeof CONFIG_SCHEMAS.mcpTool>;
export type HttpRequestConfig = z.infer<typeof CONFIG_SCHEMAS.httpRequest>;
export type SqlQueryConfig = z.infer<typeof CONFIG_SCHEMAS.sqlQuery>;
export type SqlExecConfig = z.infer<typeof CONFIG_SCHEMAS.sqlExec>;
export type RssReadConfig = z.infer<typeof CONFIG_SCHEMAS.rssRead>;
export type SetConfig = z.infer<typeof CONFIG_SCHEMAS.set>;
export type RenameKeysConfig = z.infer<typeof CONFIG_SCHEMAS.renameKeys>;
export type TextConfig = z.infer<typeof CONFIG_SCHEMAS.text>;
export type FilterConfig = z.infer<typeof CONFIG_SCHEMAS.filter>;
export type AggregateConfig = z.infer<typeof CONFIG_SCHEMAS.aggregate>;
export type ListOpsConfig = z.infer<typeof CONFIG_SCHEMAS.listOps>;
export type CompareDatasetsConfig = z.infer<
  typeof CONFIG_SCHEMAS.compareDatasets
>;
export type XmlConfig = z.infer<typeof CONFIG_SCHEMAS.xml>;
export type HtmlExtractConfig = z.infer<typeof CONFIG_SCHEMAS.htmlExtract>;
export type MarkdownConfig = z.infer<typeof CONFIG_SCHEMAS.markdown>;
export type CsvConfig = z.infer<typeof CONFIG_SCHEMAS.csv>;
export type JsonConfig = z.infer<typeof CONFIG_SCHEMAS.json>;
export type NumberConfig = z.infer<typeof CONFIG_SCHEMAS.number>;
export type EncodeConfig = z.infer<typeof CONFIG_SCHEMAS.encode>;
export type DateTimeConfig = z.infer<typeof CONFIG_SCHEMAS.dateTime>;
export type MergeConfig = z.infer<typeof CONFIG_SCHEMAS.merge>;
export type IfConfig = z.infer<typeof CONFIG_SCHEMAS.if>;
export type SwitchConfig = z.infer<typeof CONFIG_SCHEMAS.switch>;
export type ExecuteSubWorkflowConfig = z.infer<
  typeof CONFIG_SCHEMAS.executeSubWorkflow
>;
export type ForEachConfig = z.infer<typeof CONFIG_SCHEMAS.forEach>;
export type CodeConfig = z.infer<typeof CONFIG_SCHEMAS.code>;
export type WaitConfig = z.infer<typeof CONFIG_SCHEMAS.wait>;
export type HumanApprovalConfig = z.infer<typeof CONFIG_SCHEMAS.humanApproval>;
export type RespondToWebhookConfig = z.infer<
  typeof CONFIG_SCHEMAS.respondToWebhook
>;
export type HmacConfig = z.infer<typeof CONFIG_SCHEMAS.hmac>;
export type JwtConfig = z.infer<typeof CONFIG_SCHEMAS.jwt>;
export type TotpConfig = z.infer<typeof CONFIG_SCHEMAS.totp>;
export type HashConfig = z.infer<typeof CONFIG_SCHEMAS.hash>;
export type RandomConfig = z.infer<typeof CONFIG_SCHEMAS.random>;
export type SendEmailConfig = z.infer<typeof CONFIG_SCHEMAS.sendEmail>;
export type StopAndErrorConfig = z.infer<typeof CONFIG_SCHEMAS.stopAndError>;

// --- Compile-time parity guards (Phase-2 safety) -----------------------------------------------
// Each inferred config type must be MUTUALLY assignable with its hand-written interface, so Phase 2
// can replace the interface with `z.infer` at every call site without a behavior change. `tsc -b`
// enforces this — a divergence makes `Exact<…>` resolve to `never` and the `true` assignment fails
// the build, naming exactly which node drifted. (agent has no interface — it's new type surface.)
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const _configParity: {
  start: Exact<StartConfig, StartNodeConfig>;
  scheduleTrigger: Exact<ScheduleTriggerConfig, ScheduleTriggerNodeConfig>;
  formTrigger: Exact<FormTriggerConfig, FormTriggerNodeConfig>;
  pollTrigger: Exact<PollTriggerConfig, PollTriggerNodeConfig>;
  mcpTool: Exact<McpToolConfig, McpToolNodeConfig>;
  httpRequest: Exact<HttpRequestConfig, HttpRequestNodeConfig>;
  sqlQuery: Exact<SqlQueryConfig, SqlQueryNodeConfig>;
  sqlExec: Exact<SqlExecConfig, SqlExecNodeConfig>;
  rssRead: Exact<RssReadConfig, RssReadNodeConfig>;
  set: Exact<SetConfig, SetNodeConfig>;
  renameKeys: Exact<RenameKeysConfig, RenameKeysNodeConfig>;
  text: Exact<TextConfig, TextNodeConfig>;
  filter: Exact<FilterConfig, FilterNodeConfig>;
  aggregate: Exact<AggregateConfig, AggregateNodeConfig>;
  listOps: Exact<ListOpsConfig, ListOpsNodeConfig>;
  compareDatasets: Exact<CompareDatasetsConfig, CompareDatasetsNodeConfig>;
  xml: Exact<XmlConfig, XmlNodeConfig>;
  htmlExtract: Exact<HtmlExtractConfig, HtmlExtractNodeConfig>;
  markdown: Exact<MarkdownConfig, MarkdownNodeConfig>;
  csv: Exact<CsvConfig, CsvNodeConfig>;
  json: Exact<JsonConfig, JsonNodeConfig>;
  number: Exact<NumberConfig, NumberNodeConfig>;
  encode: Exact<EncodeConfig, EncodeNodeConfig>;
  dateTime: Exact<DateTimeConfig, DateTimeNodeConfig>;
  merge: Exact<MergeConfig, MergeNodeConfig>;
  if: Exact<IfConfig, IfNodeConfig>;
  switch: Exact<SwitchConfig, SwitchNodeConfig>;
  executeSubWorkflow: Exact<
    ExecuteSubWorkflowConfig,
    ExecuteSubWorkflowNodeConfig
  >;
  forEach: Exact<ForEachConfig, ForEachNodeConfig>;
  code: Exact<CodeConfig, CodeNodeConfig>;
  wait: Exact<WaitConfig, WaitNodeConfig>;
  humanApproval: Exact<HumanApprovalConfig, ApprovalNodeConfig>;
  respondToWebhook: Exact<RespondToWebhookConfig, RespondToWebhookNodeConfig>;
  hmac: Exact<HmacConfig, HmacNodeConfig>;
  jwt: Exact<JwtConfig, JwtNodeConfig>;
  totp: Exact<TotpConfig, TotpNodeConfig>;
  hash: Exact<HashConfig, HashNodeConfig>;
  random: Exact<RandomConfig, RandomNodeConfig>;
  sendEmail: Exact<SendEmailConfig, SendEmailNodeConfig>;
  stopAndError: Exact<StopAndErrorConfig, StopAndErrorNodeConfig>;
} = {
  start: true,
  scheduleTrigger: true,
  formTrigger: true,
  pollTrigger: true,
  mcpTool: true,
  httpRequest: true,
  sqlQuery: true,
  sqlExec: true,
  rssRead: true,
  set: true,
  renameKeys: true,
  text: true,
  filter: true,
  aggregate: true,
  listOps: true,
  compareDatasets: true,
  xml: true,
  htmlExtract: true,
  markdown: true,
  csv: true,
  json: true,
  number: true,
  encode: true,
  dateTime: true,
  merge: true,
  if: true,
  switch: true,
  executeSubWorkflow: true,
  forEach: true,
  code: true,
  wait: true,
  humanApproval: true,
  respondToWebhook: true,
  hmac: true,
  jwt: true,
  totp: true,
  hash: true,
  random: true,
  sendEmail: true,
  stopAndError: true,
};
void _configParity;

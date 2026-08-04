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
 * Coverage: every config-bearing node type has a concrete schema; the remaining config-less
 * structural nodes (end, noOp, retryEnd) use the permissive fallback. `webhookTrigger`/`errorTrigger`
 * were on that fallback until #983 gave every entry node a `sampleInput`. Each concrete schema is a
 * faithful port of its interface, enforced at build time by the `Exact<…>` parity guards at the
 * bottom — a drift makes the guard resolve to `never` and fails `tsc -b`, naming the culprit.
 */
import { z } from "zod";
import { hasNestedQuantifier } from "./branch";
import {
  MAX_CONTENT_RULE_PATTERN_LENGTH,
  PII_KIND_VALUES,
  type AgentGuardrailPolicy,
} from "./guardrails";
import { hasForbiddenPathSegment, isPollutingKey } from "./mcp-args";
import type {
  AggregateNodeConfig,
  ApprovalNodeConfig,
  CodeNodeConfig,
  CompareDatasetsNodeConfig,
  ConditionOp,
  CsvNodeConfig,
  DateTimeNodeConfig,
  EncodeNodeConfig,
  ErrorTriggerNodeConfig,
  ExecuteSubWorkflowNodeConfig,
  FilterNodeConfig,
  FirestoreQueryNodeConfig,
  FirestoreWriteNodeConfig,
  ForEachNodeConfig,
  HashNodeConfig,
  HmacNodeConfig,
  HtmlExtractNodeConfig,
  MarkdownNodeConfig,
  VectorUpsertNodeConfig,
  VectorQueryNodeConfig,
  RetryNodeConfig,
  SplitOutNodeConfig,
  LoopEndNodeConfig,
  CodeAgentNodeConfig,
  GraphQLNodeConfig,
  HttpRequestNodeConfig,
  IfNodeConfig,
  JsonNodeConfig,
  JwtNodeConfig,
  ListOpsNodeConfig,
  McpToolNodeConfig,
  IntegrationNodeConfig,
  MergeNodeConfig,
  NodeType,
  NumberNodeConfig,
  FormTriggerNodeConfig,
  ChatTriggerNodeConfig,
  McpServerTriggerNodeConfig,
  PollTriggerNodeConfig,
  KafkaTriggerNodeConfig,
  RandomNodeConfig,
  RenameKeysNodeConfig,
  RespondToWebhookNodeConfig,
  RssReadNodeConfig,
  ScheduleTriggerNodeConfig,
  SendEmailNodeConfig,
  SetNodeConfig,
  SqlExecNodeConfig,
  KafkaPublishNodeConfig,
  SqlQueryNodeConfig,
  StartNodeConfig,
  StopAndErrorNodeConfig,
  SwitchNodeConfig,
  TextNodeConfig,
  TextToSpeechNodeConfig,
  TotpNodeConfig,
  WaitNodeConfig,
  WebhookTriggerNodeConfig,
  XmlNodeConfig,
} from "./types";

/** {from, path?} upstream-output binding (mirrors ArgBinding in types.ts). */
const argBinding = z.object({ from: z.string(), path: z.string().optional() });

/**
 * Save-gate for binding-record KEYS (#591): the key is a dotted output path that
 * `setByPath` walks, so a `__proto__`/`constructor`/`prototype` segment would let a
 * saved graph pollute `Object.prototype` in the shared workflow isolate. The
 * interpreter-side resolvers also skip such keys (defense in depth) — this rejects
 * them up front with a clear save error.
 */
const bindingKey = z.string().refine((k) => !hasForbiddenPathSegment(k), {
  message:
    "binding key must not contain __proto__/constructor/prototype segments",
});

/**
 * Save-gate for a LITERAL data key a node writes into a plain object — a form field's `key`, a
 * `renameKeys` target (issue #761).
 *
 * These names can't work end to end, so accepting them means accepting silent data loss. Writing a
 * string to `obj.__proto__` is a **no-op**: the value is simply discarded, with no error anywhere. A
 * form field keyed `__proto__` therefore validated, passed the required check, started the run — and
 * arrived at the workflow absent. Nor can any JSON Schema paper over it: ajv skips a `__proto__`
 * property entirely, applying neither `pattern` nor `required`, so a headless client validating
 * locally gets a different answer than the endpoint.
 *
 * Rejected at SAVE (not at submit) because it is an authoring mistake, and failing the visitor for the
 * author's typo is the wrong end. Matches the stance the codebase already takes on binding keys above
 * and on `POLLUTING_KEYS` in the n8n importer.
 *
 * `isPollutingKey`, not `hasForbiddenPathSegment`: these are literal names, and a flat key containing a
 * dot (`user.email`) is perfectly legitimate — splitting it would refuse safe keys.
 */
const dataKey = z.string().refine((k) => !isPollutingKey(k), {
  message:
    "key must not be __proto__, constructor or prototype — a value written to one of those names is silently discarded and never reaches the workflow",
});

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
 * The shared ENTRY-node sample input (zod mirror of `TriggerSampleInputConfig` — see it for why
 * schedule/poll are excluded). Spread into each entry schema rather than copied, so the six
 * declarations can't drift into six slightly different rules (#983, #805).
 */
const triggerSampleInput = {
  sampleInput: z.record(z.string(), z.unknown()).optional(),
};

/**
 * Concrete config schema per node type. Each mirrors its hand-written `*NodeConfig` interface
 * (agent has none today — it's the flagship node whose config was fully untyped, so this is the
 * first type it gets). Enum operations use inline literal arrays so `z.enum` preserves the exact
 * union; the per-node parity guard then proves completeness against the interface.
 */
const CONFIG_SCHEMAS = {
  // --- Triggers / entry ---
  start: z.object({ ...triggerSampleInput }),
  webhookTrigger: z.object({ ...triggerSampleInput }),
  errorTrigger: z.object({ ...triggerSampleInput }),
  scheduleTrigger: z.object({ cron: z.string() }),
  formTrigger: z.object({
    ...triggerSampleInput,
    title: z.string().optional(),
    description: z.string().optional(),
    submitLabel: z.string().optional(),
    fields: z.array(
      z.object({
        // #761: a `__proto__`/`constructor`/`prototype` key silently discards its submitted value.
        key: dataKey,
        label: z.string(),
        type: z.enum(["text", "textarea", "number", "email", "select"]),
        required: z.boolean().optional(),
        placeholder: z.string().optional(),
        options: z.array(z.string()).optional(),
      }),
    ),
    // Optional form content-template reference (fields come from its `field` blocks; see the
    // FormTriggerNodeConfig doc). Deleted/missing → fall back to inline `fields`.
    templateId: z.string().optional(),
    // Hosted-page presentation (see FormBrandingConfig). The two constrained fields are validated
    // HERE as well as re-projected on read, because both reach an anonymous browser in a position
    // where a bad value is an injection rather than a cosmetic bug.
    branding: z
      .object({
        successTitle: z.string().max(200).optional(),
        successMessage: z.string().max(2_000).optional(),
        // https ONLY. A `javascript:` or `data:` URL here would be stored XSS on our own origin,
        // triggerable by anyone holding the public form link; `http:` is refused too, because
        // downgrading a visitor who just submitted over TLS is our fault, not theirs.
        //
        // `z.url({ protocol })` does the parse — deliberately NOT a hand-rolled regex, which is how
        // `javascript:https://x`-style bypasses get in, and not `new URL` either (this package is
        // platform-agnostic and carries no DOM/Node lib types).
        //
        // The extra refine rejects embedded credentials, which `z.url` accepts. Not pedantry: the
        // canvas and the success card SHOW this target to a human, and `https://trusted.com@evil.com`
        // reads as `trusted.com` to a person while resolving to `evil.com`. Refusing it means what we
        // display can't be a lie.
        redirectUrl: z
          .url({ protocol: /^https$/ })
          .max(2_000)
          .refine((raw) => !/^https:\/\/[^/?#]*@/i.test(raw), {
            message:
              "Redirect URL must not embed credentials (user:pass@host) — it reads as a different site than it resolves to.",
          })
          .optional(),
        // Exactly `#rrggbb`. This value is interpolated into a CSS custom property, and CSS `var()`
        // substitution can land inside `url()` — so anything looser than a fixed-length hex literal
        // is an injection surface, not a validation nicety.
        accentColor: z
          .string()
          .regex(
            /^#[0-9a-fA-F]{6}$/,
            "Accent colour must be a 6-digit hex colour like #d4562a.",
          )
          .optional(),
        theme: z.enum(["light", "dark", "auto"]).optional(),
        desktopColumns: z.union([z.literal(1), z.literal(2)]).optional(),
        width: z.enum(["narrow", "wide"]).optional(),
        // An asset id WE issued, not a URL — see FormBrandingConfig.logoAssetId for why a
        // tenant-supplied URL is refused. This is a SHAPE check (a uuid) only; ownership is verified
        // separately by the graphs service, which REJECTS the save when the id belongs to another
        // tenant/environment. An id that is ours but whose object has since gone renders a broken
        // image (the asset route 404s) — it does not silently fall back to no logo.
        logoAssetId: z
          .string()
          .regex(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
            "Logo must be an uploaded asset id.",
          )
          .optional(),
        logoAlt: z.string().max(120).optional(),
      })
      .optional(),
  }),
  chatTrigger: z.object({
    ...triggerSampleInput,
    title: z.string().optional(),
    description: z.string().optional(),
    placeholder: z.string().optional(),
    greeting: z.string().optional(),
    /** Opt in to the durable per-session workflow (§2.1b, option A). */
    durableSession: z.boolean().optional(),
  }),
  mcpServerTrigger: z.object({
    ...triggerSampleInput,
    toolName: z.string().optional(),
    description: z.string().optional(),
  }),
  pollTrigger: z.object({
    url: z.string(),
    intervalSeconds: z.number(),
    changeKey: z.string().optional(),
  }),
  kafkaTrigger: z.object({
    ...triggerSampleInput,
    connectionId: z.string(),
    topic: z.string(),
    groupId: z.string(),
    intervalSeconds: z.number().optional(),
    maxMessages: z.number().optional(),
    maxWaitMs: z.number().optional(),
    fromBeginning: z.boolean().optional(),
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
    /** MCP tools the agent may call mid-reasoning (#449). Each references a tenant MCP
     *  connection + a remote tool; the model decides when to call them, and the loop runs
     *  IN the agent activity (the token+tool resolution never crosses the workflow boundary).
     *  Empty/absent ⇒ a single structured call (the historical behaviour, byte-identical).
     *  NOTE: with tools and NO `outputSchema`, the agent returns free text ({ text }); add an
     *  `outputSchema` to force a structured final answer after the tool loop. */
    tools: z
      .array(
        z.object({
          /** Tenant MCP connection the tool call authenticates through. */
          connectionId: z.string(),
          /** Remote tool name on that MCP server. */
          tool: z.string(),
          /** Name exposed to the model (defaults to `tool`). */
          name: z.string().optional(),
          /** What the tool does — the model reads this to decide when to call it. */
          description: z.string().optional(),
          /** JSON Schema for the tool's arguments; omitted ⇒ open object. */
          inputSchema: z.record(z.string(), z.unknown()).optional(),
          /** Flat per-call cost (parity with the mcpTool node — MCP tools carry no token
           *  cost, so spend is operator-configured and folded into the node's costUsd). */
          costUsd: z.number().optional(),
        }),
      )
      .optional(),
    /** Max reasoning+tool steps before the loop must produce a final answer (default 8). */
    maxToolSteps: z.number().int().positive().optional(),
    /** Multi-agent handoff (#580 Phase 1). Zod mirror of `AgentHandoff` in handoff.ts —
     *  that module owns the shape (it must stay zod-free for the workflow bundle), and
     *  test/handoff.spec.ts type-asserts the two agree. Mutually exclusive with
     *  `outputSchema`: the handoff DERIVES the schema (an enum of target names), which is
     *  what makes an invalid route unrepresentable. Graph-level wiring (targets resolve,
     *  edges carry the right condition) is enforced by `validateGraph`, not here — it
     *  needs the edges, which a per-node config schema never sees. */
    handoff: z
      .object({
        targets: z
          .array(
            z.object({
              to: z.string(),
              name: z.string().optional(),
              description: z.string().optional(),
            }),
          )
          .min(1),
        payloadSchema: z.record(z.string(), z.unknown()).optional(),
        explain: z.boolean().optional(),
      })
      .optional(),
    /** Opt-in Anthropic prompt caching of the (stable) system prompt. Default OFF: it only
     *  pays off for HIGH-VOLUME agents reusing the same large system prompt within Anthropic's
     *  ~5-min cache TTL — a one-shot call PAYS a ~25% cache-WRITE premium with no read to offset
     *  it. Enable only for a hot, large-prompt agent. Anthropic no-ops caching below its minimum
     *  cacheable block size, so a short prompt with this on is simply unaffected. */
    cacheSystemPrompt: z.boolean().optional(),
  }),
  codeAgent: z.object({
    /**
     * The coding CLI to run. Each has its OWN pinned sandbox image (deploy/sandbox/<tool>.Dockerfile)
     * that the runner selects — a node never names an image. The custom `error` matters because an
     * API-authored or imported graph naming a tool we don't have must fail the save gate with a
     * sentence that says what to change, not a bare enum complaint.
     */
    tool: z
      .enum(["claude", "cursor", "copilot", "gemini"], {
        error:
          "codeAgent `tool` must be one of: claude, cursor, copilot, gemini. Each runs in its own isolated sandbox image; add that tool's credential in Integrations → Code Agent first.",
      })
      .optional(),
    prompt: z.string(),
    /**
     * JSON Schema for STRUCTURED output — same shape as the agent node's `outputSchema`. When set,
     * the run returns a validated object on `output.structured` alongside the usual text.
     *
     * Enforced by the CLI (`claude --json-schema`), NOT by prompting: the model is constrained, and
     * the envelope carries the parsed object. Only the `claude` driver supports it today — the
     * activity REFUSES a schema on a driver that doesn't, rather than silently handing back
     * unvalidated text, which would be a successful-looking wrong run.
     */
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    systemPrompt: z.string().optional(),
    model: z.string().optional(),
    maxTurns: z.number().int().positive().optional(),
    maxBudgetUsd: z.number().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    // "read" (default) = in-worker plan-mode run, no repo. "write" = clone `repo` and let the
    // CLI edit it in the isolated sandbox, returning a diff (Slice 2c). Write is gated OFF at the
    // worker (CODE_AGENT_WRITE_ENABLED) until the runner is wired on the deploy host.
    mode: z.enum(["read", "write"]).optional(),
    /** "owner/name" of the repo to clone (write mode). */
    repo: z.string().optional(),
    /** Base branch to clone (write mode); defaults to the repo's default branch. */
    branch: z.string().optional(),
    /** The GitHub App connection that authorizes the clone (write mode). The install token is
     *  resolved in-activity and used to clone OUTSIDE the sandbox — it never enters the sandbox. */
    connectionId: z.string().optional(),
    /** Write mode + PR (#444): commit the sandbox's edits to a node-owned branch, push, open a PR. */
    openPr: z.boolean().optional(),
    prTitle: z.string().optional(),
    prBody: z.string().optional(),
    commitMessage: z.string().optional(),
    /** Head branch to create/push (node-owned, force-pushed). Defaults to `naary/code-agent/<runId>`. */
    headBranch: z.string().optional(),
    // Positive: a manual fallback cost only makes sense > 0 (a negative would REDUCE the
    // run's accumulated __costUsd; a 0 defeats the never-zero fallback intent).
    costUsd: z.number().positive().optional(),
  }),
  // textToSpeech (#689) — BYOK synthesis; the audio itself is offloaded to object storage by the
  // activity, so nothing here carries bytes. `text` is min(1) so a present-but-empty value is a
  // save-time error (an empty synthesis would be a billable zero-character call); a node that gets
  // its text from upstream uses `textBinding` instead — the save gate below requires one of the two.
  textToSpeech: z.object({
    provider: z.enum(["openai"]).optional(),
    text: z.string().min(1).optional(),
    textBinding: argBinding.optional(),
    voice: z.string().optional(),
    model: z.string().optional(),
    format: z.enum(["mp3", "opus", "aac", "flac", "wav", "pcm"]).optional(),
    // OpenAI's documented range. Clamped here so a bad graph fails at save, not mid-run.
    speed: z.number().min(0.25).max(4).optional(),
    timeoutMs: z.number().int().positive().optional(),
    // Positive for the same reason as codeAgent's: a 0 would defeat the never-zero fallback.
    costUsd: z.number().positive().optional(),
  }),
  mcpTool: z.object({
    connectionId: z.string(),
    tool: z.string(),
    arguments: z.record(z.string(), z.unknown()).optional(),
    argumentBindings: z.record(bindingKey, argBinding).optional(),
    costUsd: z.number().optional(),
  }),

  // Native integration node — provider/action index into INTEGRATION_CATALOG; the
  // catalog (not zod) enforces per-action required fields (see validateIntegrationConfig).
  integration: z.object({
    provider: z.string(),
    action: z.string(),
    connectionId: z.string(),
    fields: z.record(z.string(), z.unknown()).optional(),
    fieldBindings: z.record(bindingKey, argBinding).optional(),
  }),

  // --- Data sources ---
  httpRequest: z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    query: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
    argumentBindings: z.record(bindingKey, argBinding).optional(),
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
  graphQL: z.object({
    url: z.string(),
    query: z.string(),
    variables: z.record(z.string(), z.unknown()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    argumentBindings: z.record(bindingKey, argBinding).optional(),
    failOnErrors: z.boolean().optional(),
    timeoutMs: z.number().optional(),
    costUsd: z.number().optional(),
  }),
  kafkaPublish: z.object({
    connectionId: z.string(),
    topic: z.string(),
    value: z.unknown(),
    key: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    correlationId: z.string().optional(),
    replyTopic: z.string().optional(),
    // -1 is the DEFAULT (all in-sync replicas). 0 is expressible but never implied — a publish
    // nobody acknowledges cannot be distinguished from one that failed.
    acks: z.union([z.literal(-1), z.literal(0), z.literal(1)]).optional(),
    timeoutMs: z.number().optional(),
    costUsd: z.number().optional(),
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
  firestoreQuery: z.object({
    connectionId: z.string(),
    action: z.string().optional(),
    projectId: z.string(),
    databaseId: z.string().optional(),
    collection: z.string(),
    documentId: z.string().optional(),
    argumentBindings: z.record(bindingKey, argBinding).optional(),
    filters: z
      .array(
        z.object({
          field: z.string(),
          op: z.string(),
          value: z.unknown().optional(),
        }),
      )
      .optional(),
    orderBy: z
      .array(z.object({ field: z.string(), direction: z.string().optional() }))
      .optional(),
    limit: z.number().optional(),
    maxPages: z.number().optional(),
    typedValues: z.boolean().optional(),
    timeoutMs: z.number().optional(),
    costUsd: z.number().optional(),
  }),
  firestoreWrite: z.object({
    connectionId: z.string(),
    action: z.string().optional(),
    projectId: z.string(),
    databaseId: z.string().optional(),
    collection: z.string(),
    documentId: z.string().optional(),
    data: z.record(dataKey, z.unknown()).optional(),
    argumentBindings: z.record(bindingKey, argBinding).optional(),
    updateMask: z.array(z.string()).optional(),
    typedValues: z.boolean().optional(),
    timeoutMs: z.number().optional(),
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
    fieldBindings: z.record(bindingKey, argBinding).optional(),
  }),
  renameKeys: z.object({
    from: z.string(),
    path: z.string().optional(),
    // The VALUE is the new key name this node writes, so it takes the same guard as a form field
    // key (#761): renaming something to `__proto__` discards it silently. The source side stays a
    // plain string — it only ever reads.
    rename: z.record(z.string(), dataKey).optional(),
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
  vectorUpsert: z.object({
    collection: z.string(),
    from: z.string(),
    path: z.string().optional(),
  }),
  vectorQuery: z.object({
    collection: z.string(),
    from: z.string(),
    path: z.string().optional(),
    topK: z.number().optional(),
  }),
  retry: z.object({
    maxAttempts: z.number().optional(),
    initialIntervalSeconds: z.number().optional(),
    backoffCoefficient: z.number().optional(),
    maxIntervalSeconds: z.number().optional(),
  }),
  splitOut: z.object({
    from: z.string(),
    path: z.string().optional(),
  }),
  loopEnd: z.object({
    from: z.string(),
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
    inputBindings: z.record(bindingKey, argBinding).optional(),
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
    // --- Routing + SLA/escalation/context (REDESIGN-FUNCTIONALITY-GAPS.md Slice 1) ---
    approvers: z
      .object({
        emails: z.array(z.string()).optional(),
        groupIds: z.array(z.string()).optional(),
      })
      .optional(),
    slaHours: z.number().positive().optional(),
    remindAfterHours: z
      .array(z.number().positive())
      .max(5)
      .refine((a) => a.every((v, i) => i === 0 || v > a[i - 1]), {
        message: "remindAfterHours must be strictly ascending",
      })
      .optional(),
    escalateAfterHours: z.number().positive().optional(),
    escalateTo: z.string().optional(),
    // Values may contain {{ }} expressions — resolved in-activity at pause time.
    contextFields: z.record(z.string(), z.string()).optional(),
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
    claimsBindings: z.record(bindingKey, argBinding).optional(),
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
    // A reusable email Template (docs/design/TEMPLATE-EDITOR.md). When set, the worker loads the
    // template's blocks + subject and renders them (via renderEmailHtml, `{{ }}` against ctx) into
    // the html/subject — overriding the inline html/subject. The stored id (never the blocks) rides
    // the graph; the blocks are loaded in-activity by (tenant, env, id).
    templateId: z.string().optional(),
    fieldBindings: z.record(bindingKey, argBinding).optional(),
    costUsd: z.number().optional(),
  }),

  // --- Terminal ---
  stopAndError: z.object({ message: z.string().optional() }),
} satisfies Partial<Record<NodeType, z.ZodTypeAny>>;

/**
 * Fallback for the config-less structural nodes (end, noOp, retryEnd): any object of config keys.
 * Keeps the schema total over NodeType so `nodeConfigSchema` never returns undefined.
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
    // Conditional-required check (zod `.partial()` can't express cross-field rules, and a
    // `.superRefine` would defeat the lenient .partial() above): a codeAgent in WRITE mode needs
    // a repo + a GitHub App connection, else the run only fails at execution. `mode:"write"` is a
    // present value (not a missing draft field), so enforcing it at save is consistent with the
    // gate. Mirrors the integration node's separate catalog validation.
    const cfg = node.config ?? {};
    if (node.type === "codeAgent" && cfg.mode === "write") {
      const missing = ["repo", "connectionId"].filter((k) => !cfg[k]);
      if (missing.length) {
        errors.push({
          nodeId: node.id,
          nodeType: node.type,
          issues: missing.map((k) => ({
            path: k,
            message: `codeAgent write mode requires \`${k}\`.`,
          })),
        });
      }
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
export type WebhookTriggerConfig = z.infer<
  typeof CONFIG_SCHEMAS.webhookTrigger
>;
export type ErrorTriggerConfig = z.infer<typeof CONFIG_SCHEMAS.errorTrigger>;
export type FormTriggerConfig = z.infer<typeof CONFIG_SCHEMAS.formTrigger>;
export type ChatTriggerConfig = z.infer<typeof CONFIG_SCHEMAS.chatTrigger>;
export type McpServerTriggerConfig = z.infer<
  typeof CONFIG_SCHEMAS.mcpServerTrigger
>;
export type ScheduleTriggerConfig = z.infer<
  typeof CONFIG_SCHEMAS.scheduleTrigger
>;
export type PollTriggerConfig = z.infer<typeof CONFIG_SCHEMAS.pollTrigger>;
export type KafkaTriggerConfig = z.infer<typeof CONFIG_SCHEMAS.kafkaTrigger>;
export type AgentConfig = z.infer<typeof CONFIG_SCHEMAS.agent>;
export type CodeAgentConfig = z.infer<typeof CONFIG_SCHEMAS.codeAgent>;
export type TextToSpeechConfig = z.infer<typeof CONFIG_SCHEMAS.textToSpeech>;
export type McpToolConfig = z.infer<typeof CONFIG_SCHEMAS.mcpTool>;
export type IntegrationConfig = z.infer<typeof CONFIG_SCHEMAS.integration>;
export type HttpRequestConfig = z.infer<typeof CONFIG_SCHEMAS.httpRequest>;
export type GraphQLConfig = z.infer<typeof CONFIG_SCHEMAS.graphQL>;
export type KafkaPublishConfig = z.infer<typeof CONFIG_SCHEMAS.kafkaPublish>;
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
export type VectorUpsertConfig = z.infer<typeof CONFIG_SCHEMAS.vectorUpsert>;
export type VectorQueryConfig = z.infer<typeof CONFIG_SCHEMAS.vectorQuery>;
export type RetryConfig = z.infer<typeof CONFIG_SCHEMAS.retry>;
export type SplitOutConfig = z.infer<typeof CONFIG_SCHEMAS.splitOut>;
export type LoopEndConfig = z.infer<typeof CONFIG_SCHEMAS.loopEnd>;
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
export type FirestoreQueryConfig = z.infer<
  typeof CONFIG_SCHEMAS.firestoreQuery
>;
export type FirestoreWriteConfig = z.infer<
  typeof CONFIG_SCHEMAS.firestoreWrite
>;
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
  webhookTrigger: Exact<WebhookTriggerConfig, WebhookTriggerNodeConfig>;
  errorTrigger: Exact<ErrorTriggerConfig, ErrorTriggerNodeConfig>;
  scheduleTrigger: Exact<ScheduleTriggerConfig, ScheduleTriggerNodeConfig>;
  formTrigger: Exact<FormTriggerConfig, FormTriggerNodeConfig>;
  chatTrigger: Exact<ChatTriggerConfig, ChatTriggerNodeConfig>;
  mcpServerTrigger: Exact<McpServerTriggerConfig, McpServerTriggerNodeConfig>;
  pollTrigger: Exact<PollTriggerConfig, PollTriggerNodeConfig>;
  kafkaTrigger: Exact<KafkaTriggerConfig, KafkaTriggerNodeConfig>;
  codeAgent: Exact<CodeAgentConfig, CodeAgentNodeConfig>;
  textToSpeech: Exact<TextToSpeechConfig, TextToSpeechNodeConfig>;
  mcpTool: Exact<McpToolConfig, McpToolNodeConfig>;
  integration: Exact<IntegrationConfig, IntegrationNodeConfig>;
  httpRequest: Exact<HttpRequestConfig, HttpRequestNodeConfig>;
  graphQL: Exact<GraphQLConfig, GraphQLNodeConfig>;
  kafkaPublish: Exact<KafkaPublishConfig, KafkaPublishNodeConfig>;
  sqlQuery: Exact<SqlQueryConfig, SqlQueryNodeConfig>;
  sqlExec: Exact<SqlExecConfig, SqlExecNodeConfig>;
  firestoreQuery: Exact<FirestoreQueryConfig, FirestoreQueryNodeConfig>;
  firestoreWrite: Exact<FirestoreWriteConfig, FirestoreWriteNodeConfig>;
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
  vectorUpsert: Exact<VectorUpsertConfig, VectorUpsertNodeConfig>;
  vectorQuery: Exact<VectorQueryConfig, VectorQueryNodeConfig>;
  retry: Exact<RetryConfig, RetryNodeConfig>;
  splitOut: Exact<SplitOutConfig, SplitOutNodeConfig>;
  loopEnd: Exact<LoopEndConfig, LoopEndNodeConfig>;
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
  webhookTrigger: true,
  errorTrigger: true,
  scheduleTrigger: true,
  formTrigger: true,
  chatTrigger: true,
  mcpServerTrigger: true,
  pollTrigger: true,
  kafkaTrigger: true,
  codeAgent: true,
  textToSpeech: true,
  mcpTool: true,
  integration: true,
  httpRequest: true,
  graphQL: true,
  kafkaPublish: true,
  sqlQuery: true,
  sqlExec: true,
  firestoreQuery: true,
  firestoreWrite: true,
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
  vectorUpsert: true,
  vectorQuery: true,
  retry: true,
  splitOut: true,
  loopEnd: true,
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

// ---------------------------------------------------------------------------------------------
// Agent guardrail policy (#576) — the zod layer for the PER-WORKSPACE policy
// ---------------------------------------------------------------------------------------------
// The pure evaluator + types live in ./guardrails (zod-free, reachable from the deterministic
// workflow bundle). This schema is the API's write gate for `TenantSettings.agentGuardrails`, and
// lives HERE for the same reason every other schema does: registry.ts is the one module the
// package index does NOT re-export, so zod never enters the workflow bundle.

/** A tool glob. Bounded so a policy row can't become a pathological pattern list. */
const toolGlob = z.string().min(1).max(200);
const toolGlobList = z.array(toolGlob).max(200);

const contentRuleSchema = z
  .object({
    label: z.string().min(1).max(80),
    kind: z.enum(["keyword", "regex"]),
    pattern: z.string().min(1).max(MAX_CONTENT_RULE_PATTERN_LENGTH),
    action: z.enum(["fail", "strip"]).optional(),
    ignoreCase: z.boolean().optional(),
  })
  // Reject an unsafe regex AT SAVE TIME rather than silently treating it as non-matching at run
  // time (which would look like a guardrail that quietly does nothing). Same structural
  // catastrophic-backtracking test the edge-condition `regex` operator uses (#598).
  .refine(
    (r) => r.kind !== "regex" || !hasNestedQuantifier(r.pattern),
    "regex rule has a nested quantifier (catastrophic-backtracking risk) — rewrite it",
  )
  .refine((r) => {
    if (r.kind !== "regex") return true;
    try {
      new RegExp(r.pattern);
      return true;
    } catch {
      return false;
    }
  }, "regex rule is not a valid pattern");

/** Runtime schema for {@link AgentGuardrailPolicy}. `strict()` so a typo'd key is a 400 rather
 *  than a silently-ignored (and therefore unenforced) rule. */
export const agentGuardrailPolicySchema = z
  .object({
    tools: z
      .object({
        allow: toolGlobList.optional(),
        deny: toolGlobList.optional(),
        requireApproval: toolGlobList.optional(),
      })
      .strict()
      .optional(),
    input: z.array(contentRuleSchema).max(100).optional(),
    output: z.array(contentRuleSchema).max(100).optional(),
    redact: z
      .object({
        enabled: z.boolean().optional(),
        kinds: z.array(z.enum(PII_KIND_VALUES)).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Compile-time proof that the zod shape and the hand-written interface agree (same guard the
 *  node configs use — drift resolves to `never` and fails `tsc -b`). */
type GuardrailPolicyParity = Exact<
  z.infer<typeof agentGuardrailPolicySchema>,
  AgentGuardrailPolicy
>;
const _guardrailParity: GuardrailPolicyParity = true;
void _guardrailParity;

/** A stored `TenantSettings.agentGuardrails` value that does not match the schema. */
export class InvalidGuardrailPolicyError extends Error {
  constructor(readonly issues: { path: string; message: string }[]) {
    super(
      `Invalid agent guardrail policy — ${issues
        .map((i) => `${i.path || "policy"} ${i.message}`)
        .join("; ")}`,
    );
    this.name = "InvalidGuardrailPolicyError";
  }
}

/**
 * Parse a stored/incoming policy. `null`/`undefined` ⇒ the empty policy (no guardrails).
 *
 * FAILS CLOSED, LOUDLY: a value that does not parse THROWS rather than degrading to "no
 * guardrails". A governance control that silently stops enforcing because a row got malformed is
 * the worst failure mode available; a visible error on the node/route is recoverable.
 */
export function parseAgentGuardrailPolicy(
  value: unknown,
): AgentGuardrailPolicy {
  if (value === null || value === undefined) return {};
  const res = agentGuardrailPolicySchema.safeParse(value);
  if (!res.success) {
    throw new InvalidGuardrailPolicyError(
      res.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    );
  }
  return res.data;
}

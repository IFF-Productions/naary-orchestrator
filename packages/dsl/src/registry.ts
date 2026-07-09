/**
 * TYPED-DSL Phase 1 (docs/design/TYPED-DSL.md) — one runtime SCHEMA per node config.
 *
 * This is the zod layer of the DSL. From each node's `config` schema we derive:
 *   - TS types      (`z.infer`, below) — will replace the hand-written *NodeConfig interfaces
 *   - runtime validation (`nodeConfigSchema(type).safeParse`) — for the API / save path
 *   - JSON Schema   (`nodeConfigJsonSchema` / zod v4 `z.toJSONSchema`) — CONCRETE per-node config
 *                    for the AI generator's structured output (fixes the empty-`{}` bug the
 *                    right way — see docs/design/ai-generate notes).
 *
 * TIER-1 LANDMINE (CLAUDE.md rule 2): zod is RUNTIME validation and must NEVER be evaluated
 * inside the deterministic Temporal workflow bundle. This module is therefore DELIBERATELY NOT
 * re-exported from `./index` — the worker's `@naary/dsl` import surface stays zod-free. Only the
 * API, the generator, activities, and tests import this file (directly or via a subpath). The
 * interpreter consumes the erased TYPES only (`import type`), never these schema VALUES.
 *
 * Phase 1 covers the 8 nodes the generator + forms care about most; every other node type falls
 * back to a permissive schema so the graph still validates while the sweep continues.
 */
import { z } from "zod";
import type {
  ApprovalNodeConfig,
  ConditionOp,
  HttpRequestNodeConfig,
  IfNodeConfig,
  NodeType,
  SendEmailNodeConfig,
  SetNodeConfig,
  SwitchNodeConfig,
  WaitNodeConfig,
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

/**
 * Concrete config schemas for the Phase-1 node set. Each mirrors its hand-written
 * `*NodeConfig` interface in types.ts (agent has none today — it's the flagship node whose
 * config was fully untyped, so this is the first type it gets).
 */
const CONFIG_SCHEMAS = {
  agent: z.object({
    provider: z.string(),
    model: z.string(),
    systemPrompt: z.string(),
    /** JSON-schema-ish object describing the agent's structured output, if any. */
    outputSchema: z.record(z.string(), z.unknown()).optional(),
  }),

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
  }),

  humanApproval: z.object({
    title: z.string().optional(),
    instructions: z.string().optional(),
    timeoutHours: z.number().optional(),
  }),

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

  wait: z.object({
    mode: z.enum(["duration", "webhook"]).optional(),
    durationSeconds: z.number().optional(),
    timeoutSeconds: z.number().optional(),
  }),

  set: z.object({
    fields: z.record(z.string(), z.unknown()).optional(),
    fieldBindings: z.record(z.string(), argBinding).optional(),
  }),

  if: z.object({
    combine: z.enum(["and", "or"]).optional(),
    conditions: z.array(edgeCondition),
  }),

  switch: z.object({
    rules: z.array(z.object({ name: z.string(), condition: edgeCondition })),
    fallback: z.string().optional(),
  }),
} satisfies Partial<Record<NodeType, z.ZodTypeAny>>;

/**
 * Fallback for node types not yet migrated: any object of config keys. Keeps the graph schema
 * total over NodeType while the concrete sweep (Phase 2) continues — a node without a concrete
 * schema still validates structurally instead of blocking the whole graph.
 */
const PERMISSIVE_CONFIG = z.record(z.string(), z.unknown());

/** The config schema for a node type — concrete when migrated, else permissive. */
export function nodeConfigSchema(type: NodeType): z.ZodTypeAny {
  return (
    (CONFIG_SCHEMAS as Record<string, z.ZodTypeAny>)[type] ?? PERMISSIVE_CONFIG
  );
}

/** True when `type` has a concrete (non-fallback) schema — i.e. is migrated. */
export function hasConcreteConfig(type: NodeType): boolean {
  return type in CONFIG_SCHEMAS;
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
 * Concrete node types yield real `properties`/`required` with NO empty `{}` sub-schemas — exactly
 * what the AI generator needs to FILL config instead of emitting an empty object.
 */
export function nodeConfigJsonSchema(type: NodeType): Record<string, unknown> {
  const raw = z.toJSONSchema(nodeConfigSchema(type));
  return sanitizeForStructuredOutput(raw) as Record<string, unknown>;
}

// --- Derived TS types (Phase 2 will point the interpreter's *NodeConfig at these) --------------
export type AgentConfig = z.infer<typeof CONFIG_SCHEMAS.agent>;
export type HttpRequestConfig = z.infer<typeof CONFIG_SCHEMAS.httpRequest>;
export type HumanApprovalConfig = z.infer<typeof CONFIG_SCHEMAS.humanApproval>;
export type SendEmailConfig = z.infer<typeof CONFIG_SCHEMAS.sendEmail>;
export type WaitConfig = z.infer<typeof CONFIG_SCHEMAS.wait>;
export type SetConfig = z.infer<typeof CONFIG_SCHEMAS.set>;
export type IfConfig = z.infer<typeof CONFIG_SCHEMAS.if>;
export type SwitchConfig = z.infer<typeof CONFIG_SCHEMAS.switch>;

// --- Compile-time parity guards (Phase-2 safety) -----------------------------------------------
// Each inferred config type must be MUTUALLY assignable with its hand-written interface, so Phase 2
// can replace the interface with `z.infer` at every call site without a behavior change. `tsc -b`
// enforces this — a divergence makes `Exact<…>` resolve to `never` and the `true` assignment fails
// the build, naming exactly which node drifted. (agent has no interface — it's new type surface.)
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const _configParity: {
  httpRequest: Exact<HttpRequestConfig, HttpRequestNodeConfig>;
  humanApproval: Exact<HumanApprovalConfig, ApprovalNodeConfig>;
  sendEmail: Exact<SendEmailConfig, SendEmailNodeConfig>;
  wait: Exact<WaitConfig, WaitNodeConfig>;
  set: Exact<SetConfig, SetNodeConfig>;
  if: Exact<IfConfig, IfNodeConfig>;
  switch: Exact<SwitchConfig, SwitchNodeConfig>;
} = {
  httpRequest: true,
  humanApproval: true,
  sendEmail: true,
  wait: true,
  set: true,
  if: true,
  switch: true,
};
void _configParity;

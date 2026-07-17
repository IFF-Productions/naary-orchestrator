/**
 * Runtime-free typed accessor for a node's OUTPUT — the mirror of node-config.ts (which types the
 * config side). The interpreter stores each node's result in the run ctx bag keyed by node id
 * (`ctx[node.id] = …`); a consumer (the web UI, the API, notification formatting) that reads
 * `ctx.<id>` back out otherwise only sees `unknown` and reaches for a hand-written `as` cast — the
 * exact hole that let a reader read `ctx.codeAgent.result` (the real path is `.output.result`) with
 * no compile error.
 *
 * `NodeOutputMap` names, per node kind, the shape the interpreter actually WRITES (often a subset of
 * the activity's result — e.g. httpRequest exposes `{ status, headers, body }`, renaming httpStatus
 * → status). `getNodeOutput(ctx, id, "codeAgent")` returns that shape, so `.result` vs `.output.result`
 * becomes a compile error instead of a silent undefined.
 *
 * The map is only trustworthy if it matches reality — so each structured entry is ANCHORED at its
 * write site in the interpreter with `satisfies NodeOutputMap[<kind>]` (a type-only annotation:
 * erased at compile, emitted JS byte-identical, so the deterministic workflow is untouched — Tier-1
 * rule 2). If an activity's output drifts from the map, that write fails to compile in the same PR.
 *
 * Nodes whose output is genuinely dynamic (the pure transforms — set/text/filter/json/… — return an
 * arbitrary resolved value; trigger nodes echo the trigger event) map to `unknown`: typing a shape
 * nobody reads would be speculative and get subtly wrong, reintroducing the very failure mode.
 *
 * Zod-free by construction, like node-config.ts: `import type` only, so nothing here pulls a runtime
 * schema into the worker's deterministic bundle. Runtime validation of an output (safeParse) belongs
 * on the consumer side, not in this type map.
 */
import type { NodeType } from "./types";

/** node kind → the shape the interpreter writes to `ctx[node.id]`. Structured/consumed/branchable
 *  nodes get a real shape (anchored by `satisfies` at the write site); pure transforms + trigger
 *  echoes map to `unknown`. Exhaustiveness is enforced by `_mapCoversAllNodes` below. */
export interface NodeOutputMap {
  // --- entry / triggers: echo the trigger event / __input (arbitrary) ---
  start: unknown;
  webhookTrigger: unknown;
  errorTrigger: unknown;
  scheduleTrigger: unknown;
  formTrigger: unknown;
  chatTrigger: unknown;
  pollTrigger: { changed: boolean; body: unknown };

  // --- AI / tools (structured, cost-accumulating) ---
  agent: {
    status: "ok";
    output: Record<string, unknown>;
    model: string;
    costUsd: number;
  };
  codeAgent: {
    status: "ok";
    output: {
      result: string;
      tool: string;
      sessionId?: string;
      /** Write-mode diff (Slice 2c): the inline unified-diff string, or a claim-check reference
       *  `{ __claimCheck, bytes }` when large (shape mirrors @naary/storage's ClaimCheck; inlined
       *  so the DSL stays dependency-free). Absent in read mode. */
      diff?: string | { __claimCheck: string; bytes: number };
    };
    costUsd: number;
  };
  mcpTool: { status: "ok"; content: unknown; costUsd: number };
  integration: {
    status: "ok";
    httpStatus: number;
    ok: boolean;
    body: unknown;
  };

  // --- I/O nodes the graph branches on ---
  httpRequest: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  };
  graphQL: { data: unknown; errors: unknown; httpStatus: number };
  sqlQuery: { rows: unknown; rowCount: number };
  sqlExec: { rowsAffected: number };
  sendEmail: { messageId: string };
  rssRead: { items: unknown; count: number };
  executeSubWorkflow: { status: string; output: Record<string, unknown> };
  respondToWebhook: { statusCode: number };

  // --- crypto / util (single-field results) ---
  hmac: { digest: string };
  hash: { digest: string };
  jwt: { token: string };
  totp: { code: string };
  random: { value: unknown };

  // --- pure transforms: output is a resolved value of arbitrary shape ---
  set: unknown;
  renameKeys: unknown;
  text: unknown;
  filter: unknown;
  aggregate: unknown;
  listOps: unknown;
  compareDatasets: unknown;
  xml: unknown;
  htmlExtract: unknown;
  markdown: unknown;
  vectorUpsert: unknown;
  vectorQuery: unknown;
  csv: unknown;
  json: unknown;
  number: unknown;
  encode: unknown;
  dateTime: unknown;
  merge: unknown;
  if: unknown;
  switch: unknown;
  code: unknown;

  // --- control / structural / config-less (no meaningful typed output) ---
  splitOut: unknown;
  loopEnd: unknown;
  forEach: unknown;
  wait: unknown;
  stopAndError: unknown;
  humanApproval: unknown;
  noOp: unknown;
  end: unknown;
}

// Build fails if a NodeType is missing a NodeOutputMap entry (keeps the map exhaustive — a new
// node type can't be added without deciding its output shape here).
type _mapCoversAllNodes = NodeType extends keyof NodeOutputMap ? true : never;
const _mapCheck: _mapCoversAllNodes = true;
void _mapCheck;

/** The typed output of a given node kind (map-derived). */
export type NodeOutput<T extends NodeType> = NodeOutputMap[T];

/**
 * Read node `id`'s output from the run ctx, typed by its node kind. Returns `undefined` when the
 * node hasn't run (or was pruned dead in an items region), so callers use optional chaining.
 *
 * This is a type-only narrowing (a cast, like `asNodeConfig`) — the shape guarantee comes from the
 * `satisfies` anchor at the interpreter's write site, not a runtime check here. `_type` is
 * consumed at the type level only.
 */
export function getNodeOutput<T extends NodeType>(
  ctx: Record<string, unknown>,
  id: string,
  _type: T,
): NodeOutput<T> | undefined {
  return ctx[id] as NodeOutput<T> | undefined;
}

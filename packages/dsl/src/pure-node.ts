import {
  resolveAggregate,
  resolveCompareDatasets,
  resolveFilter,
  resolveListOps,
} from "./array-nodes";
import { resolveIf } from "./if-node";
import { resolveJson } from "./json-node";
import { resolveNumber } from "./number-node";
import { resolveRenameKeys } from "./rename-keys";
import { resolveSet } from "./set-node";
import { resolveSwitch } from "./switch-node";
import { resolveTemplates } from "./template";
import { resolveText } from "./text-node";
import type {
  AggregateNodeConfig,
  CompareDatasetsNodeConfig,
  FilterNodeConfig,
  IfNodeConfig,
  JsonNodeConfig,
  ListOpsNodeConfig,
  NodeDef,
  NumberNodeConfig,
  RenameKeysNodeConfig,
  SetNodeConfig,
  SwitchNodeConfig,
  TextNodeConfig,
} from "./types";

/**
 * Node types whose output is a pure function of config + ctx (no I/O, no secrets) — so they can be
 * run OUTSIDE the durable interpreter for single-node "Test" (design SINGLE-NODE-EXECUTION.md
 * slice 2). Activity nodes (agent/http/sql/…) and control nodes (wait/approval/forEach) are not
 * here — those need the Temporal path (slice 3) or a full run.
 */
const PURE_NODE_TYPES = new Set<string>([
  "set",
  "renameKeys",
  "text",
  "filter",
  "aggregate",
  "listOps",
  "compareDatasets",
  "switch",
  "if",
  "json",
  "number",
]);

export function isPureNode(type: string): boolean {
  return PURE_NODE_TYPES.has(type);
}

/**
 * Run a PURE node against a context (nodeId → output) and return its output — the SAME resolvers +
 * template resolution the interpreter uses, so the result is identical to a real run. Throws if the
 * node type isn't pure (guard with isPureNode first).
 */
export function runPureNode(
  node: NodeDef,
  ctx: Record<string, unknown>,
): unknown {
  const cfg = resolveTemplates(
    (node.config ?? {}) as Record<string, unknown>,
    ctx,
  );
  switch (node.type) {
    case "set":
      return resolveSet(cfg as unknown as SetNodeConfig, ctx);
    case "renameKeys":
      return resolveRenameKeys(cfg as unknown as RenameKeysNodeConfig, ctx);
    case "text":
      return resolveText(cfg as unknown as TextNodeConfig, ctx);
    case "filter":
      return resolveFilter(cfg as unknown as FilterNodeConfig, ctx);
    case "aggregate":
      return resolveAggregate(cfg as unknown as AggregateNodeConfig, ctx);
    case "listOps":
      return resolveListOps(cfg as unknown as ListOpsNodeConfig, ctx);
    case "compareDatasets":
      return resolveCompareDatasets(
        cfg as unknown as CompareDatasetsNodeConfig,
        ctx,
      );
    case "switch":
      return resolveSwitch(cfg as unknown as SwitchNodeConfig, ctx);
    case "if":
      return resolveIf(cfg as unknown as IfNodeConfig, ctx);
    case "json":
      return resolveJson(cfg as unknown as JsonNodeConfig, ctx);
    case "number":
      return resolveNumber(cfg as unknown as NumberNodeConfig, ctx);
    default:
      throw new Error(`Node type "${node.type}" is not a pure node`);
  }
}

// Node-handler contract (Phase 1 of the run-graph split — leaf handlers extracted
// VERBATIM behind a registry; zero behavior change). DETERMINISTIC TEMPORAL WORKFLOW
// CODE — CLAUDE.md Tier-1 rules apply: no I/O, no clock, no randomness; all side
// effects go through the SAME activity proxies run-graph.ts uses. The `activities`
// import is TYPE-ONLY so no I/O code enters the deterministic bundle.
import type { NodeDef } from "@naary/dsl";
import type * as activities from "../../activities";
import type { RunGraphCtx } from "../types";

export interface NodeHandlerCtx {
  node: NodeDef;
  /** Already template-resolved by the engine (`resolveTemplates` over ctx). */
  cfg: Record<string, unknown>;
  /** Mutable shared context; the handler writes `ctx[node.id]`. */
  ctx: Record<string, unknown>;
  /** Non-secret run context (tenantId/environmentId/workflowKey/…). */
  runCtx: RunGraphCtx;
  /** Single source of truth for an activity's `meta` (env-scoped cred reads). */
  metaFor: (nodeId: string) => activities.AgentMeta;
}

/** A cost-bearing handler returns its `costUsd` DELTA (the dispatch accumulates it +
 *  stamps `ctx.__costUsd`); a pure/void handler returns nothing. */
export type NodeHandlerResult = { costUsd?: number } | void;
export type NodeHandler = (c: NodeHandlerCtx) => Promise<NodeHandlerResult>;

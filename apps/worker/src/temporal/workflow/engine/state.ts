// Engine state + context "bag" (Phase 2 of the run-graph split — the traversal
// ENGINE extracted out of runGraph, zero behavior change). TYPE-ONLY module: erased at
// runtime, nothing to replay. The single mutable `EngineState` object replaces the
// former closure `let`s (costUsd/status/approval/…) so the engine can live in its own
// modules while still reading+mutating the run's state; run-graph.ts owns the object
// and passes it in via the `Engine` bag. DETERMINISM (CLAUDE.md Tier-1): this is pure
// data threading — no I/O, no clock, no new/removed/reordered command — so relocating
// the engine behind it is replay-identical (same argument as Phase 1's leaf registry).
import type {
  ApprovalInput,
  ExecutionStatus,
  ResumeInput,
  WebhookResponse,
} from "@naary/contracts";
import type {
  GraphDef,
  ItemsRegion,
  NodeDef,
  RetryRegion,
} from "@naary/dsl";
import type * as activities from "../../activities";
import type { RunGraphCtx } from "../types";

/**
 * The run's shared mutable state — every field was a closure `let`/`const` inside
 * runGraph before the split. Held by ONE object so the extracted engine functions
 * (execNode/execChain) can read+mutate it uniformly through the {@link Engine} bag.
 * The signal handlers write it (`approval`, `budgetResumeCount`), the stateQuery reads
 * it (`status`/`currentNodeId`/`costUsd`), and `syncStatus`/`pauseOnBudget` do both.
 */
export interface EngineState {
  /** Deterministic per-run spend accumulator (activity-returned costs only). */
  costUsd: number;
  /** Circuit-breaker / per-cap node counter. */
  stepCount: number;
  /** Running total of per-item region trace bytes this segment (aggregate cap). */
  traceBytes: number;
  /** MONOTONIC budget-resume counter — a single Signal wakes ALL parked waiters. */
  budgetResumeCount: number;
  /** Set by approvalSignal when a human decides a humanApproval gate. */
  approval?: ApprovalInput;
  /** Set by resumeSignal when an external system resumes a wait/webhook run. */
  webhookResume?: ResumeInput;
  /** The synchronous response a respondToWebhook node set (exposed via a query). */
  webhookResponse?: WebhookResponse;
  /** Current execution status (running / awaiting_x / terminal). */
  status: ExecutionStatus;
  /** The node currently executing — surfaced via the stateQuery. */
  currentNodeId: string;
  /** The node a run actually THREW on (#525 fan-out fix). Set once, at the throwing node
   *  (first-writer-wins), so it's exact even across concurrent branches where the shared
   *  `currentNodeId` races. Undefined until a node throws; the failure stamp prefers it. */
  failedNodeId?: string;
  /** Fan-in arrival counts per merge node id (Slice N5). */
  mergeArrivals: Record<string, number>;
}

/**
 * The context "bag" passed to the extracted engine functions. Everything the engine
 * needs comes from here — no closure captures from runGraph. `syncStatus`/`pauseOnBudget`
 * stay DEFINED in run-graph.ts (they touch the setExecutionStatus/refreshBudget proxies +
 * runCtx) and are passed in as callbacks; `execNode`/`execChain` reference each other, so
 * they are wired as fields (each call site does `engine.execNode(…)` / `engine.execChain(…)`).
 */
export interface Engine {
  state: EngineState;
  /** Mutable shared run context (`ctx[nodeId]` outputs + `__*` bookkeeping). */
  ctx: Record<string, unknown>;
  /** The run's trigger input — re-passed to continueAsNew. */
  input: unknown;
  /** Non-secret run context (tenantId/environmentId/caps/…). */
  runCtx: RunGraphCtx;
  /** The version-pinned graph snapshot this run walks. */
  graph: GraphDef;
  /** id → node lookup, precomputed once. */
  nodeById: Map<string, NodeDef>;
  /** All graph node ids — powers the unresolved-input diagnostic. */
  nodeIdSet: Set<string>;
  /** merge node id → inbound parent ids in DECLARED edge order (in-degree). */
  mergeParents: Map<string, string[]>;
  /** splitOut id → its items-model region (precomputed, pure). */
  itemsRegionBySplit: Map<string, ItemsRegion>;
  /** `retry` node id → its drawn region (validated at save). Empty for graphs with no retry node. */
  retryRegionByStart: Map<string, RetryRegion>;
  /** merge ids owned by an A4 region's per-item pass (excluded from top-level joins). */
  a4RegionMergeIds: Set<string>;
  /** Single source of truth for every activity's `meta` (env-scoped cred reads). */
  metaFor: (nodeId: string) => activities.AgentMeta;
  /** Push status+cost to the Runs read-model (defined in run-graph.ts). */
  syncStatus: () => Promise<void>;
  /** Park the run as awaiting_budget until a budgetResume Signal (defined in run-graph.ts). */
  pauseOnBudget: () => Promise<void>;
  /** Per-node timing wrapper around one node's side effect. */
  execNode: (node: NodeDef) => Promise<ExecutionStatus | null>;
  /** Walk a chain from a start node id (topLevel drives continueAsNew). */
  execChain: (
    startId: string,
    topLevel: boolean,
  ) => Promise<ExecutionStatus | null>;
}

/**
 * Pure view-model helpers for the redesigned Run Detail screen: per-node run
 * states derived from the REAL execution state (ctx keys = executed nodes),
 * step ordering, time formatting, and edge branch labels. No I/O, no JSX.
 */
import type { EdgeCondition, GraphDef, NodeType } from "@naary/dsl";
import type { IconName } from "../../../components";
import type { HttpFailure, RunEvent } from "../../../lib/api";
import { isFailure, isTerminal } from "../../../lib/run-status";

/* ---------------- Step states ---------------- */

/** The design's per-node states: done (ran) · waiting (paused here) · running ·
 *  error (died here) · pending (still ahead of the run) · skipped (branch not taken). */
export type StepState =
  "done" | "waiting" | "running" | "error" | "pending" | "skipped";

/** Foreground color per state (CSS var). */
export const STEP_FG: Record<StepState, string> = {
  done: "var(--state-done)",
  waiting: "var(--state-paused)",
  running: "var(--state-running)",
  error: "var(--state-error)",
  pending: "var(--ink-3)",
  skipped: "var(--ink-3)",
};

/** The badge word shown on nodes / the detail card. */
export const STEP_WORD: Record<StepState, string> = {
  done: "done",
  waiting: "waiting",
  running: "running",
  error: "failed",
  pending: "pending",
  skipped: "skipped",
};

/** Node ids that produced output = executed (internal __ keys are bookkeeping). */
export function executedNodeIds(
  graph: GraphDef,
  ctx: Record<string, unknown>,
): Set<string> {
  const ids = new Set(graph.nodes.map((n) => n.id));
  return new Set(Object.keys(ctx).filter((k) => ids.has(k)));
}

/**
 * Derive each node's StepState from the real run state. Unexecuted nodes are
 * "pending" while the run can still reach them (forward-reachable from the
 * current node on a live run, or downstream of a failure), and "skipped"
 * (branch not taken) otherwise.
 */
export function computeStepStates(
  graph: GraphDef,
  ctx: Record<string, unknown>,
  currentNodeId: string,
  status: string,
  /** #525 — node ids the interpreter stamped as having run, for a FAILED run whose ctx
   *  came back empty. ADDITIVE to the ctx-derived set (ctx wins when present), so
   *  completed/running runs are unaffected; a failed run's upstream nodes show done. */
  stampedExecuted?: string[],
): Record<string, StepState> {
  const executed = executedNodeIds(graph, ctx);
  for (const id of stampedExecuted ?? []) executed.add(id);
  // The entry trigger produced the run itself — a run existing means it fired,
  // even though only its payload (ctx.__input), not a node output, is recorded.
  executed.add(graph.startNodeId);
  const terminal = isTerminal(status);
  const failure = isFailure(status);
  const paused =
    status === "awaiting_approval" || status === "awaiting_webhook";

  // Forward reachability from the current node (what could still run).
  const reachable = new Set<string>();
  if (currentNodeId) {
    const queue = [currentNodeId];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      for (const e of graph.edges) {
        if (e.from === id && !reachable.has(e.to)) {
          reachable.add(e.to);
          queue.push(e.to);
        }
      }
    }
  }

  const out: Record<string, StepState> = {};
  for (const n of graph.nodes) {
    if (n.id === currentNodeId && failure) out[n.id] = "error";
    else if (n.id === currentNodeId && !terminal)
      out[n.id] = paused ? "waiting" : "running";
    // The node the run ENDED on after completing successfully still ran — but a terminal
    // `end` node is a passthrough that writes no ctx output, so it isn't in `executed`.
    // Without this it would fall through to "skipped"; on a completed run its currentNodeId
    // is that end node, so mark it done (also makes the STEPS count include it).
    else if (n.id === currentNodeId && terminal && !failure) out[n.id] = "done";
    else if (executed.has(n.id)) out[n.id] = "done";
    else if (reachable.has(n.id) && (!terminal || failure))
      // Ahead of a live run, or downstream of the node a failed run died on —
      // these would have run; they are not a branch the run chose against.
      out[n.id] = "pending";
    else out[n.id] = "skipped";
  }
  return out;
}

/** Stable step order for the timeline: BFS depth from the start node, then
 *  declaration order (matches the decompiled canvas layout left→right). */
export function stepOrder(graph: GraphDef): string[] {
  const depth = new Map<string, number>([[graph.startNodeId, 0]]);
  const queue = [graph.startNodeId];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const d = depth.get(id) ?? 0;
    for (const e of graph.edges) {
      if (e.from === id && !depth.has(e.to)) {
        depth.set(e.to, d + 1);
        queue.push(e.to);
      }
    }
  }
  return graph.nodes
    .map((n, i) => ({ id: n.id, d: depth.get(n.id) ?? 0, i }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((x) => x.id);
}

/* ---------------- Node icons ---------------- */

/** DSL node type → icon glyph for the step tiles (existing icon set). */
export function nodeIcon(type: NodeType): IconName {
  switch (type) {
    case "start":
    case "webhookTrigger":
    case "errorTrigger":
    case "pollTrigger":
    case "scheduleTrigger":
    case "formTrigger":
    case "chatTrigger":
      return "bolt";
    case "agent":
    case "codeAgent":
    case "vectorUpsert":
    case "vectorQuery":
      return "agent";
    // Waveform glyph — the closest honest mark for synthesized audio.
    case "textToSpeech":
      return "activity";
    case "mcpTool":
    case "integration":
      return "mcp";
    case "httpRequest":
    case "graphQL":
    case "rssRead":
    case "respondToWebhook":
      return "http";
    case "sqlQuery":
    case "sqlExec":
      return "grid";
    case "if":
    case "switch":
    case "merge":
    case "splitOut":
    case "loopEnd":
    case "forEach":
    case "executeSubWorkflow":
    case "noOp":
      return "router";
    case "humanApproval":
      return "approval";
    case "wait":
      return "clock";
    case "hmac":
    case "jwt":
    case "totp":
    case "hash":
    case "random":
      return "key";
    case "sendEmail":
      return "external";
    case "stopAndError":
      return "alert";
    case "end":
      return "end";
    default:
      return "edit"; // transforms (set, text, csv, …) + anything new
  }
}

/* ---------------- History-derived times ---------------- */

/** Real timestamps out of the curated Temporal history: when the run started,
 *  the last recorded event (= when a paused run went idle), and — for failed
 *  runs — the failure detail the history carries. */
export function historyTimes(events: RunEvent[] | null): {
  startedAt: string | null;
  lastAt: string | null;
  errorDetail: string | null;
  errorHttp: HttpFailure | null;
} {
  if (!events || events.length === 0)
    return {
      startedAt: null,
      lastAt: null,
      errorDetail: null,
      errorHttp: null,
    };
  const startedAt =
    events.find((e) => e.kind === "started" && e.at)?.at ?? null;
  let lastAt: string | null = null;
  for (const e of events) if (e.at) lastAt = e.at;
  // Prefer the FIRST error's detail — the ROOT cause. A failed run records the specific
  // activityTaskFailed ("Missing or invalid provider credential") BEFORE the generic
  // workflowExecutionFailed wrapper ("Activity task failed"); taking the last would surface
  // the wrapper. For a workflow-level failure (stopAndError) the first error IS that message.
  // Take the message AND the captured call off the SAME event: a run can record an
  // activityTaskFailed and a workflowExecutionFailed, and pairing one event's message with
  // another's request/response would show a call that isn't the one the message describes.
  const errorEvent = events.find((e) => e.kind === "error" && e.detail);
  return {
    startedAt,
    lastAt,
    errorDetail: errorEvent?.detail ?? null,
    errorHttp: errorEvent?.http ?? null,
  };
}

/** "Tue Jul 15, 14:31" (the design's timestamp form), in the viewer's locale. */
export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  })}, ${d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })}`;
}

/* ---------------- Per-node timing (Slice 2 — worker-stamped, never fabricated) ---------------- */

/** One node's timing window from the run state's nodeTimes map (epoch ms, workflow
 *  time). `n`/`totalMs` aggregate repeated passes (loops / items regions). */
export interface NodeTime {
  s: number;
  f: number;
  n?: number;
  totalMs?: number;
}

/** Shape-checked read of one node's timing entry from the (unknown-typed) nodeTimes
 *  map the API surfaces. Null when absent or malformed — the UI then keeps "—". */
export function nodeTimeOf(
  nodeTimes: Record<string, unknown> | null | undefined,
  nodeId: string,
): NodeTime | null {
  const raw = nodeTimes?.[nodeId];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const t = raw as { s?: unknown; f?: unknown; n?: unknown; totalMs?: unknown };
  if (typeof t.s !== "number" || typeof t.f !== "number") return null;
  return {
    s: t.s,
    f: t.f,
    ...(typeof t.n === "number" ? { n: t.n } : {}),
    ...(typeof t.totalMs === "number" ? { totalMs: t.totalMs } : {}),
  };
}

/** Compact real-duration text: "0ms" · "340ms" · "1.4s" · "3m 20s". Shared by the
 *  step timeline and the runs-list Duration columns (Slice 2). */
export function fmtDurMs(ms: number): string {
  const v = Math.max(0, ms);
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
  return fmtAge(v);
}

/** Duration text for a step; a multi-pass node (loop / items region) appends "×n" —
 *  the window shown is the LAST pass's. */
export function fmtStepDuration(t: NodeTime): string {
  const base = fmtDurMs(t.f - t.s);
  return t.n !== undefined && t.n > 1 ? `${base} ×${t.n}` : base;
}

/** A node output's real metered cost (agent/mcp/http/… results carry `costUsd`), or
 *  null when the node metered nothing costful — the UI then keeps "—". */
export function stepCostText(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const c = (output as { costUsd?: unknown }).costUsd;
  return typeof c === "number" && c > 0 ? `$${c.toFixed(4)}` : null;
}

/** A node output's real token count (agent results carry `totalTokens`), or null. */
export function stepTokensText(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const t = (output as { totalTokens?: unknown }).totalTokens;
  return typeof t === "number" && t > 0 ? t.toLocaleString() : null;
}

/** Compact two-unit age/duration: "2d 4h" · "4h 12m" · "3m 20s" · "12s". */
export function fmtAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
  return `${sec}s`;
}

/* ---------------- Edge branch labels ---------------- */

const OP_SYM: Partial<Record<EdgeCondition["op"], string>> = {
  eq: "=",
  neq: "≠",
  gt: ">",
  lt: "<",
  gte: "≥",
  lte: "≤",
};

/** Human chip text for a conditional edge, e.g. "amount ≥ 25000". */
export function edgeConditionLabel(c: EdgeCondition): string {
  const sym = OP_SYM[c.op] ?? c.op;
  const value = c.value === undefined ? "" : ` ${String(c.value)}`;
  // Valueless ops read better verbatim: "email exists".
  if (c.op === "exists" || c.op === "isEmpty" || c.op === "notEmpty")
    return `${c.path} ${c.op}`;
  return `${c.path} ${sym}${value}`;
}

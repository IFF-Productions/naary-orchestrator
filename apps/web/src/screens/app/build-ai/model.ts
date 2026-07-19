/**
 * Build with AI — pure view-model helpers (no React, no I/O).
 *
 * The screen streams REAL frames from the builder-session turn SSE
 * (`event: node` / `event: edge`, see lib/api/builder.ts) and lays them out on
 * the live stage. Everything here derives presentation from those frames — no
 * fabricated content.
 */
import type { EdgeCondition, EdgeDef, NodeDef, NodeType } from "@naary/dsl";
import type { IconName } from "../../../components";
import {
  NODE_KINDS,
  nodeDisplayLabel,
  nodeSubtitle,
} from "../../../lib/graph-model";

/* ---------------- Stage geometry (design "Naary AI Generate") ---------------- */

export const STAGE_W = 420;
export const NODE_W = 200;
export const NODE_H = 72;
/** Vertical rhythm between node rows. */
export const ROW_H = 118;
/** Top/bottom padding inside the stage column. */
export const STAGE_PAD = 24;

export interface StageNode {
  id: string;
  type: NodeType;
  /** Display label (provider-aware — a GitHub integration reads "GitHub"). */
  name: string;
  /** One-line config echo ("action · stripe"); node group when config says nothing. */
  sub: string;
  accent: string;
  icon: IconName;
  x: number;
  y: number;
}

export interface StageEdge {
  id: string;
  d: string;
  color: string;
  dashed: boolean;
  /** Branch label chip (a real edge condition, summarized) + its position. */
  label?: string;
  lx?: number;
  ly?: number;
}

/* ---------------- Node presentation ---------------- */

const ACCENT_BY_TYPE = new Map(NODE_KINDS.map((k) => [k.type, k.accent]));
const GROUP_BY_TYPE = new Map(NODE_KINDS.map((k) => [k.type, k.group]));

const ICON_BY_GROUP: Record<string, IconName> = {
  Triggers: "bolt",
  "AI & Tools": "agent",
  Integrations: "plug",
  "Data sources": "mcp",
  Transform: "filter",
  Flow: "router",
  Crypto: "key",
  Comms: "http",
  Terminal: "end",
};

export function nodeIcon(type: NodeType): IconName {
  if (type === "humanApproval") return "approval";
  if (type === "httpRequest" || type === "graphQL") return "http";
  return ICON_BY_GROUP[GROUP_BY_TYPE.get(type) ?? ""] ?? "workflow";
}

export function nodeAccent(type: NodeType): string {
  return ACCENT_BY_TYPE.get(type) ?? "var(--brand)";
}

/** "human · needs sign-off" style subtitle: real config echo, else the group. */
export function stageSub(
  type: NodeType,
  config?: Record<string, unknown>,
): string {
  const echo = nodeSubtitle(type, config);
  const group = (GROUP_BY_TYPE.get(type) ?? "node").toLowerCase();
  return echo ? echo : group;
}

/** Narrow an unknown SSE frame payload to a usable NodeDef (id + type minimum). */
export function asNodeDef(raw: unknown): NodeDef | null {
  const n = raw as { id?: unknown; type?: unknown } | null;
  if (!n || typeof n.id !== "string" || typeof n.type !== "string") return null;
  return n as NodeDef;
}

/** Narrow an unknown SSE frame payload to a usable EdgeDef. */
export function asEdgeDef(raw: unknown): EdgeDef | null {
  const e = raw as { from?: unknown; to?: unknown } | null;
  if (!e || typeof e.from !== "string" || typeof e.to !== "string") return null;
  return e as EdgeDef;
}

/* ---------------- Layout ---------------- */

/** Arrival-order vertical column: node i sits at row i, centered in the stage. */
export function layoutNodes(nodes: NodeDef[]): StageNode[] {
  return nodes.map((n, i) => ({
    id: n.id,
    type: n.type,
    name: nodeDisplayLabel(n.type, n.config),
    sub: stageSub(n.type, n.config),
    accent: nodeAccent(n.type),
    icon: nodeIcon(n.type),
    x: (STAGE_W - NODE_W) / 2,
    y: STAGE_PAD + i * ROW_H,
  }));
}

export function stageHeight(nodeCount: number): number {
  return Math.max(
    560,
    STAGE_PAD * 2 + Math.max(0, nodeCount - 1) * ROW_H + NODE_H,
  );
}

const OP_SYMBOL: Record<string, string> = {
  eq: "=",
  neq: "≠",
  in: "in",
  exists: "exists",
  gt: ">",
  lt: "<",
  gte: "≥",
  lte: "≤",
};

/** Summarize a REAL edge condition into a branch chip ("amount > 500"). */
export function conditionLabel(c: EdgeCondition): string {
  const op = OP_SYMBOL[c.op] ?? c.op;
  if (c.op === "exists") return `${c.path} exists`;
  const v =
    c.value === undefined
      ? ""
      : typeof c.value === "object"
        ? JSON.stringify(c.value)
        : String(c.value);
  return `${c.path} ${op} ${v}`.trim();
}

/**
 * Bezier from A's bottom port to B's top port. Adjacent rows flow straight;
 * skip edges (a branch bypassing rows) bow out to the side — alternating sides
 * per skip edge so parallel branches don't overlap.
 */
export function layoutEdges(
  edges: EdgeDef[],
  placed: StageNode[],
): StageEdge[] {
  const byId = new Map(placed.map((n) => [n.id, n]));
  const rowOf = new Map(placed.map((n, i) => [n.id, i]));
  let skipCount = 0;
  const out: StageEdge[] = [];
  for (const e of edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue; // endpoint not streamed in yet — drawn when it lands
    const down = (rowOf.get(b.id) ?? 0) >= (rowOf.get(a.id) ?? 0);
    const p0 = { x: a.x + NODE_W / 2, y: down ? a.y + NODE_H : a.y };
    const p1 = { x: b.x + NODE_W / 2, y: down ? b.y : b.y + NODE_H };
    const span = Math.abs((rowOf.get(b.id) ?? 0) - (rowOf.get(a.id) ?? 0));
    let c1: { x: number; y: number };
    let c2: { x: number; y: number };
    if (span <= 1) {
      const k = Math.max(38, Math.abs(p1.y - p0.y) / 2);
      c1 = { x: p0.x, y: p0.y + (down ? k : -k) };
      c2 = { x: p1.x, y: p1.y - (down ? k : -k) };
    } else {
      // Bow sideways around the intervening rows.
      const side = skipCount++ % 2 === 0 ? 1 : -1;
      const bow = side * (NODE_W / 2 + 46);
      c1 = { x: p0.x + bow, y: p0.y + 40 };
      c2 = { x: p1.x + bow, y: p1.y - 40 };
    }
    const mx = (c1.x + c2.x) / 2;
    const my = (c1.y + c2.y) / 2;
    const conditional = !!e.condition;
    out.push({
      id: `${e.from}→${e.to}`,
      d: `M ${p0.x} ${p0.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p1.x} ${p1.y}`,
      color: conditional ? "var(--node-router)" : "var(--brand)",
      dashed: conditional,
      ...(e.condition
        ? { label: conditionLabel(e.condition), lx: mx, ly: my }
        : {}),
    });
  }
  return out;
}

/* ---------------- Plan lines (the "Building" card) ---------------- */

export interface PlanLine {
  id: string;
  text: string;
  done: boolean;
  busy: boolean;
}

/**
 * Derive the plan-stream card from the REAL frames received so far: the meta
 * name, one line per streamed node, an edge tally, and the validation step that
 * completes when the terminal `result` frame lands. Nothing is staged or faked —
 * a line exists only because its frame arrived.
 */
export function planFromStream(
  name: string | null,
  nodes: NodeDef[],
  edgeCount: number,
  ready: boolean,
): PlanLine[] {
  const lines: Omit<PlanLine, "done" | "busy">[] = [];
  if (name) lines.push({ id: "meta", text: `Naming it “${name}”` });
  for (const n of nodes) {
    lines.push({
      id: `n-${n.id}`,
      text: `Placing ${nodeDisplayLabel(n.type, n.config)}`,
    });
  }
  if (edgeCount > 0) {
    lines.push({
      id: "edges",
      text: `Wiring ${edgeCount} connection${edgeCount === 1 ? "" : "s"}`,
    });
  }
  lines.push({
    id: "validate",
    text: ready ? "Draft validated" : "Validating the draft",
  });
  return lines.map((l, i) => ({
    ...l,
    done: ready || i < lines.length - 1,
    busy: !ready && i === lines.length - 1,
  }));
}

/* ---------------- Misc ---------------- */

/** Workflow name → workflowKey (mirrors the canvas' slugify; local to avoid
 *  pulling the react-flow chunk into this screen). */
export function slugifyName(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "ai-draft"
  );
}

/**
 * Per-run DEBUG rows for the Execution log — shown only when the run was started with `debug: true`
 * (the interpreter sets `ctx.__debug`; see run-graph.ts). One synthetic row per executed node,
 * INTERLEAVED into the curated Temporal timeline by the node's finish time, carrying SAFE metadata
 * only: an ALLOWLIST of non-content output fields (model, httpStatus, tokens, cost, …). It never
 * dumps a node's output body — no prompts, URLs, headers, bodies, or values (CLAUDE.md Tier-1 §4 /
 * privacy). All values are already in the run state the screen holds — nothing new is fetched.
 */
import { type NodeTime, nodeTimeOf } from "./run-view-model";
import type { LogEntry } from "./RunLog";
import type { TimelineStep } from "./StepTimeline";

/** Non-content output fields safe to surface. Anything not listed is NEVER shown. */
const SAFE_OUTPUT_FIELDS: {
  key: string;
  label: string;
  fmt?: (v: unknown) => string;
}[] = [
  { key: "model", label: "model" },
  { key: "httpStatus", label: "status" },
  { key: "pages", label: "pages" },
  { key: "rowCount", label: "rows" },
  { key: "exitCode", label: "exit" },
  {
    key: "totalTokens",
    label: "tokens",
    fmt: (v) => Number(v).toLocaleString(),
  },
  {
    key: "costUsd",
    label: "cost",
    fmt: (v) => (typeof v === "number" && v > 0 ? `$${v.toFixed(4)}` : ""),
  },
];

/** Extract the allowlisted, non-content fields from a node's output (or []). Exported for the test
 *  that guards the allowlist — any output key NOT in SAFE_OUTPUT_FIELDS must never appear. */
export function safeFields(output: unknown): string[] {
  if (!output || typeof output !== "object" || Array.isArray(output)) return [];
  const o = output as Record<string, unknown>;
  const out: string[] = [];
  for (const f of SAFE_OUTPUT_FIELDS) {
    const raw = o[f.key];
    if (raw === undefined || raw === null || typeof raw === "object") continue;
    const val = f.fmt ? f.fmt(raw) : String(raw);
    if (val) out.push(`${f.label}=${val}`);
  }
  return out;
}

/**
 * Build the synthetic debug log rows for a debug run: one per executed node, stamped with the node's
 * finish time so the caller can merge-sort them into the real event timeline. A node with no timing
 * yet gets `at: null` (the caller sorts those last). Nodes that didn't run are skipped.
 */
export function buildDebugEvents(
  steps: TimelineStep[],
  ctx: Record<string, unknown>,
  nodeTimes: Record<string, unknown> | null | undefined,
): LogEntry[] {
  return steps
    .filter(
      (s) => s.state === "done" || s.state === "error" || s.state === "running",
    )
    .map((s) => {
      const t: NodeTime | null = nodeTimeOf(nodeTimes, s.id);
      const parts = [
        `${s.label} (${s.id})`,
        ...(s.duration ? [s.duration] : []),
        ...safeFields(ctx[s.id]),
      ];
      return {
        id: `dbg-${s.id}`,
        at: t ? new Date(t.f).toISOString() : null,
        kind: "debug",
        label: parts.join("  ·  "),
      };
    });
}

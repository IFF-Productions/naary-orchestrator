/**
 * Per-STEP rows for the Execution log — one per executed node, interleaved into the curated
 * Temporal timeline by finish time.
 *
 * The log used to be Temporal's view of the run: `Run started`, `Activity: runNodeActivity`,
 * `Activity completed`. None of those rows names a node, so the log could tell you that something
 * ran but not what it did — the per-step data was reachable only by clicking a step in the graph.
 * These rows put it in the log itself, which is what people scroll when a run misbehaves.
 *
 * WHAT A ROW SHOWS, AND WHERE.
 *
 *   INLINE (always visible)   the step's label + id, its duration, and an ALLOWLIST of non-content
 *                             metadata — model, http status, rows, tokens, cost. Never a body.
 *   EXPANDED (on request)     that step's input and output, rendered by the same components the
 *                             step-detail card uses.
 *
 * The split is the point. A log is skimmed, so the collapsed line stays scannable and free of
 * anything that could smear a payload across the timeline; `safeFields` and its tests guard that
 * line. Bodies are one deliberate click away, showing the same data the step card already shows
 * the same authenticated user — this is a change of REACH, not of exposure.
 *
 * SECRETS. The input is the step's own config resolved with `resolveTemplates` — the very function
 * the interpreter resolved with, which leaves `{{ $secrets.NAME }}` LITERAL because the runtime
 * does (they are resolved in-memory inside the activity; CLAUDE.md Tier-1 §4). So a secret VALUE
 * cannot appear here — not because this module filters one out, but because it was never in the
 * data being resolved against. Reusing the runtime's resolver is what makes that true by
 * construction rather than by a rule someone has to keep remembering.
 */
import { resolveTemplates } from "@naary/dsl";
import { type NodeTime, nodeTimeOf, stepOutputView } from "./run-view-model";
import type { LogEntry } from "./RunLog";
import type { TimelineStep } from "./StepTimeline";

/** Non-content output fields safe to surface INLINE. Anything not listed is never in the row text. */
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
 *  that guards the allowlist — any output key NOT in SAFE_OUTPUT_FIELDS must never appear IN THE
 *  ROW TEXT. (Bodies are carried separately, as structured payload, and rendered only on expand.) */
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

/** The graph node behind a step — its config is what the input view resolves. */
export interface LogRowNode {
  id: string;
  type: string;
  config?: Record<string, unknown>;
}

/**
 * The step's input: its own configuration with `{{ … }}` resolved against the run's data.
 *
 * Derived rather than recorded. Nothing in the run stamps a node's actual inputs, and adding that
 * would be an interpreter change with a payload-size and secret-redaction design of its own — so
 * this reconstructs it from the two things we do have, the graph the run executed and the ctx it
 * built. Total: a config that fails to resolve is not worth failing a log row over.
 */
export function resolvedInput(
  node: LogRowNode | undefined,
  ctx: Record<string, unknown>,
): unknown {
  if (!node?.config || Object.keys(node.config).length === 0) return undefined;
  try {
    return resolveTemplates(node.config, ctx);
  } catch {
    return node.config; // unresolved beats nothing — the raw config is still the truth about setup
  }
}

/**
 * Build one log row per EXECUTED step, stamped with the step's finish time so the caller can
 * merge-sort them into the real event timeline. A step with no timing yet gets `at: null` (the
 * caller sorts those last). Steps that never ran are skipped — a row for them would assert an
 * execution that didn't happen.
 */
export function buildNodeLogRows({
  steps,
  ctx,
  nodeTimes,
  nodes,
  startNodeId,
}: {
  steps: TimelineStep[];
  ctx: Record<string, unknown>;
  nodeTimes: Record<string, unknown> | null | undefined;
  /** The executed graph's nodes, by id — the source of each step's configuration. */
  nodes?: Map<string, LogRowNode>;
  /** Needed so the entry step's output matches the step card's (the `__input` fallback). */
  startNodeId?: string;
}): LogEntry[] {
  return steps
    .filter(
      (s) => s.state === "done" || s.state === "error" || s.state === "running",
    )
    .map((s) => {
      const t: NodeTime | null = nodeTimeOf(nodeTimes, s.id);
      const { output, hasCtxOutput } = stepOutputView(s.id, startNodeId, ctx);
      const parts = [
        `${s.label} (${s.id})`,
        ...(s.duration ? [s.duration] : []),
        ...safeFields(ctx[s.id]),
        // #1069. Deliberately NOT an entry in SAFE_OUTPUT_FIELDS: this does not come from the
        // node's output at all — it comes from the usage ledger, joined on (executionId, nodeId)
        // — so putting it in that allowlist would widen the one list whose job is to bound what
        // OUTPUT content can reach a row, to read a key that isn't in the output. It rides the
        // step instead, and the allowlist test is untouched by this change.
        ...(s.costEstimated ? ["est. tokens"] : []),
      ];
      return {
        id: `node-${s.id}`,
        at: t ? new Date(t.f).toISOString() : null,
        kind: "node",
        label: parts.join("  ·  "),
        nodeId: s.id,
        input: resolvedInput(nodes?.get(s.id), ctx),
        output,
        // Only a node's OWN ctx entry is addressable as `<runId>/<nodeId>` — the entry step's
        // fallback to the run input is not — and that address is what a textToSpeech step's audio
        // fetch needs. Same distinction StepDetailCard draws, for the same reason.
        hasCtxOutput,
        // A step that ran more than once (a loop iteration, a retry attempt) leaves only its LAST
        // values in ctx, so that is what both panels below show. Said plainly on the row rather
        // than presented as though it were the values for this line's timestamp.
        ...(t?.n !== undefined && t.n > 1 ? { ranTimes: t.n } : {}),
      };
    });
}

/**
 * Per-run DEBUG detail, shown INSIDE the Execution log — only when the run was started with
 * `debug: true` (the interpreter sets `ctx.__debug`; see run-graph.ts). One mono line per executed
 * node with SAFE metadata only: state, duration, and an ALLOWLIST of non-content output fields
 * (model, httpStatus, tokens, cost, …). It never dumps a node's output body — no prompts, URLs,
 * bodies, or values (CLAUDE.md Tier-1 §4 / privacy: the ledger stores tokens+cost, never content).
 * All values are already present in the run state the screen holds — nothing new is fetched.
 */
import { STEP_FG, STEP_WORD, type StepState } from "./run-view-model";
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

export function DebugLogSection({
  steps,
  ctx,
}: {
  steps: TimelineStep[];
  ctx: Record<string, unknown>;
}) {
  // Only nodes that actually ran (or failed) carry useful debug detail.
  const rows = steps.filter(
    (s) => s.state === "done" || s.state === "error" || s.state === "running",
  );
  return (
    <div style={{ marginTop: 14 }}>
      <div
        className="mono"
        style={{
          fontSize: "var(--text-2xs)",
          letterSpacing: ".04em",
          textTransform: "uppercase",
          color: "var(--ink-3)",
          marginBottom: 8,
        }}
      >
        Debug · per-node detail
      </div>
      <div
        style={{
          border: "1px solid var(--line-mid)",
          background: "var(--bg)",
          borderRadius: 10,
          padding: "12px 14px",
          fontFamily: "var(--font-mono)",
          fontSize: 11.5,
          lineHeight: 1.85,
          maxHeight: 260,
          overflowY: "auto",
        }}
      >
        {rows.length === 0 ? (
          <span style={{ color: "var(--ink-3)" }}>No node detail yet.</span>
        ) : (
          rows.map((s) => {
            const fields = safeFields(ctx[s.id]);
            const parts = [
              `${s.label} (${s.id})`,
              ...(s.duration ? [s.duration] : []),
              ...fields,
            ];
            return (
              <div key={s.id} style={{ display: "flex", gap: 10 }}>
                <span
                  style={{
                    color: STEP_FG[s.state as StepState] ?? "var(--ink-3)",
                    flex: "none",
                    minWidth: 56,
                  }}
                >
                  {STEP_WORD[s.state as StepState] ?? s.state}
                </span>
                <span
                  style={{
                    color: "var(--ink-2)",
                    minWidth: 0,
                    overflowWrap: "anywhere",
                  }}
                >
                  {parts.join("  ·  ")}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

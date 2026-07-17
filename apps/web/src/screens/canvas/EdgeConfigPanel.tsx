// Edge branch-condition editor panel (extracted from CanvasPage).
import {
  CONDITION_OPS,
  type EdgeConditionDraft,
  VALUELESS_OPS,
} from "../../lib/graph-model";
import { inputStyle, Labeled } from "./fields";

/** Edit the selected edge's branch condition. A blank path = unconditional edge
 *  (the edge always fires); `exists` needs no value. Compiled by compile-graph. */
export function EdgeConfigPanel({
  condition,
  onChange,
  onClear,
}: {
  condition?: EdgeConditionDraft;
  onChange: (patch: Partial<EdgeConditionDraft>) => void;
  onClear: () => void;
}) {
  const c = condition ?? { path: "", op: "eq" as const, value: "" };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
          EDGE
        </div>
        <div style={{ fontWeight: "var(--weight-semibold)" }}>
          Branch condition
        </div>
        <div
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--ink-3)",
            marginTop: 2,
          }}
        >
          Blank path = always fires. The edge is taken when the predicate holds.
        </div>
      </div>

      <Labeled label="Path (in ctx, e.g. agent.urgency)">
        <input
          value={c.path}
          onChange={(e) => onChange({ path: e.target.value })}
          style={inputStyle}
          placeholder="agent.category"
        />
      </Labeled>

      <Labeled label="Operator">
        <select
          value={c.op}
          onChange={(e) =>
            onChange({ op: e.target.value as EdgeConditionDraft["op"] })
          }
          style={inputStyle}
        >
          {CONDITION_OPS.map((op) => (
            <option key={op} value={op}>
              {op}
            </option>
          ))}
        </select>
      </Labeled>

      {!VALUELESS_OPS.includes(c.op) && (
        <Labeled
          label={
            c.op === "in"
              ? "Values (comma-separated)"
              : c.op === "regex"
                ? "Pattern (JS regex)"
                : "Value"
          }
        >
          <input
            value={c.value}
            onChange={(e) => onChange({ value: e.target.value })}
            style={inputStyle}
            placeholder={
              c.op === "in"
                ? "billing, refunds"
                : c.op === "regex"
                  ? "^INV-\\d+$"
                  : "billing"
            }
          />
        </Labeled>
      )}

      {condition?.path?.trim() && (
        <button
          type="button"
          onClick={onClear}
          style={{
            alignSelf: "flex-start",
            padding: "6px 10px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--line-2)",
            background: "var(--card)",
            color: "var(--ink-2)",
            cursor: "pointer",
            fontSize: "var(--text-sm)",
          }}
        >
          Clear condition (make unconditional)
        </button>
      )}
    </div>
  );
}

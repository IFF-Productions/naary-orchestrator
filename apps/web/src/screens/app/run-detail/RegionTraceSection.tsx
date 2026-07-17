// Per-item trace grid section for the RunDetail screen.
import type { RegionTrace, TraceCell } from "@naary/dsl";
import { Card, type Column, StatusPill, Table } from "../../../components";
import { cellText, MAX_TABLE_ROWS } from "./NodeOutputBody";
import { SectionTitle } from "./shared";

/* ---- Per-item trace grid (items-model A5 §0.4.2) --------------------------------
 * The worker publishes `ctx.__regionTrace` keyed by splitOut: each entry is either a grid
 * ({ nodes, items, truncatedItems? }) with tri-state cells (value / dead branch / error), or an
 * `{ unavailable }` marker — "batched" for A3 node-major regions, "budget" when the aggregate trace
 * byte cap was hit first. The collected-array table above still shows those regions' results.
 * TraceCell / RegionTrace are the shared wire types from @naary/dsl (the worker writes them). */
function TraceCellView({ cell }: { cell: TraceCell | undefined }) {
  if (!cell) return <span style={{ color: "var(--ink-3)" }}>—</span>;
  if ("dead" in cell)
    return (
      <span style={{ color: "var(--ink-3)", fontStyle: "italic" }}>dead</span>
    );
  if ("err" in cell)
    return (
      <span className="mono" style={{ color: "var(--state-error)" }}>
        {cell.err}
      </span>
    );
  return (
    <span className="mono" style={{ fontSize: "var(--text-2xs)" }}>
      {cellText(cell.v)}
    </span>
  );
}

export function RegionTraceSection({ ctx }: { ctx: Record<string, unknown> }) {
  const raw = ctx.__regionTrace;
  if (raw === null || typeof raw !== "object") return null;
  const regions = Object.entries(raw as Record<string, RegionTrace>);
  if (regions.length === 0) return null;

  return (
    <Card style={{ padding: "18px 20px", marginTop: 16 }}>
      <SectionTitle>Per-item trace</SectionTitle>
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {regions.map(([splitId, trace]) => {
          if ("unavailable" in trace) {
            return (
              <div key={splitId}>
                <span
                  className="mono"
                  style={{
                    fontSize: "var(--text-sm)",
                    fontWeight: "var(--weight-semibold)",
                  }}
                >
                  {splitId}
                </span>
                <div
                  style={{
                    fontSize: "var(--text-2xs)",
                    color: "var(--ink-3)",
                    marginTop: 4,
                  }}
                >
                  {trace.unavailable === "budget"
                    ? "Per-item trace omitted — this run's trace exceeded the size budget."
                    : "Per-item trace unavailable for batched-activity regions —"}{" "}
                  see the collected array in <strong>Node outputs</strong>{" "}
                  above.
                </div>
              </div>
            );
          }
          const rows = trace.items.map((cells, i) => ({ i, cells }));
          type TraceRow = { i: number; cells: Record<string, TraceCell> };
          const columns: Column<TraceRow>[] = [
            {
              key: "__idx",
              header: "#",
              render: (r) => String(r.i + 1),
              width: 36,
            },
            ...trace.nodes.map((nid) => ({
              key: nid,
              header: nid,
              render: (r: TraceRow) => <TraceCellView cell={r.cells[nid]} />,
            })),
          ];
          return (
            <div key={splitId}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 6,
                }}
              >
                <span
                  className="mono"
                  style={{
                    fontSize: "var(--text-sm)",
                    fontWeight: "var(--weight-semibold)",
                  }}
                >
                  {splitId}
                </span>
                <StatusPill
                  state="done"
                  label={`${trace.items.length} items`}
                />
              </div>
              <div style={{ maxHeight: 360, overflow: "auto" }}>
                <Table
                  columns={columns}
                  rows={rows}
                  rowKey={(r) => String(r.i)}
                />
              </div>
              {trace.truncatedItems ? (
                <div
                  style={{
                    fontSize: "var(--text-2xs)",
                    color: "var(--ink-3)",
                    marginTop: 6,
                  }}
                >
                  trace truncated — {trace.truncatedItems} more item
                  {trace.truncatedItems === 1 ? "" : "s"} ran but were not
                  captured (cap {MAX_TABLE_ROWS}).
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

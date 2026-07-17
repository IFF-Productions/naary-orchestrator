// Node-output rendering (items table / JSON) for the RunDetail screen.
import { useState } from "react";
import { type Column, CodeBlock, StatusPill, Table } from "../../../components";

/* ---- Items table (items-model A5) ----------------------------------------------
 * A node whose output is an array of objects — e.g. a Loop End's collected per-item
 * outputs, a Split Out source, or an Aggregate — reads far better as rows than as raw
 * JSON. This is pure presentation over ctx that already exists (loopEnd writes its
 * array to ctx[loopEndId] under the coexist model); it does NOT ask the engine to
 * persist any new per-item state. Anything that isn't an array-of-objects falls back
 * to JSON unchanged. */
export const MAX_TABLE_ROWS = 50;
const MAX_TABLE_COLS = 12;

function isItemsArray(v: unknown): v is Record<string, unknown>[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((el) => el !== null && typeof el === "object" && !Array.isArray(el))
  );
}

/** Union of keys across the (capped) rows, preserving first-seen order, capped to
 *  MAX_TABLE_COLS so a wide/ragged array can't explode the header. */
function itemsColumns(rows: Record<string, unknown>[]): string[] {
  const seen: string[] = [];
  const set = new Set<string>();
  for (const row of rows.slice(0, MAX_TABLE_ROWS)) {
    for (const k of Object.keys(row)) {
      if (!set.has(k)) {
        set.add(k);
        seen.push(k);
        if (seen.length >= MAX_TABLE_COLS) return seen;
      }
    }
  }
  return seen;
}

export function cellText(v: unknown): string {
  if (v === undefined) return "";
  if (v === null) return "null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** One node's output: an items table when it's an array of objects (with a JSON
 *  toggle), otherwise raw JSON exactly as before. */
export function NodeOutputBody({ output }: { output: unknown }) {
  const [asJson, setAsJson] = useState(false);
  const tabular = isItemsArray(output);
  const rows = tabular ? (output as Record<string, unknown>[]) : [];
  const cols = tabular ? itemsColumns(rows) : [];
  const shown = rows.slice(0, MAX_TABLE_ROWS);

  const jsonBlock = (
    <CodeBlock
      style={{
        fontSize: "var(--text-2xs)",
        background: "var(--bg)",
        maxHeight: 320,
        overflow: "auto",
      }}
    >
      {JSON.stringify(output, null, 2)}
    </CodeBlock>
  );

  if (!tabular) return jsonBlock;

  // Row identity is the array index (rows can be structurally equal), so wrap each
  // row with its ordinal and key the table off that.
  const indexed = shown.map((row, i) => ({ i, row }));
  type Row = { i: number; row: Record<string, unknown> };
  const columns: Column<Row>[] = [
    { key: "__idx", header: "#", render: (r) => String(r.i + 1), width: 36 },
    ...cols.map((c) => ({
      key: c,
      header: c,
      render: (r: Row) => (
        <span className="mono" style={{ fontSize: "var(--text-2xs)" }}>
          {cellText(r.row[c])}
        </span>
      ),
    })),
  ];

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 6,
        }}
      >
        <StatusPill state="done" label={`${rows.length} items`} />
        <button
          type="button"
          onClick={() => setAsJson((v) => !v)}
          className="mono"
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--ink-3)",
            background: "none",
            border: "none",
            cursor: "pointer",
            textDecoration: "underline",
          }}
        >
          {asJson ? "view as table" : "view as JSON"}
        </button>
      </div>
      {asJson ? (
        jsonBlock
      ) : (
        <div style={{ maxHeight: 320, overflow: "auto" }}>
          <Table columns={columns} rows={indexed} rowKey={(r) => String(r.i)} />
          {rows.length > MAX_TABLE_ROWS && (
            <div
              style={{
                fontSize: "var(--text-2xs)",
                color: "var(--ink-3)",
                marginTop: 6,
              }}
            >
              +{rows.length - MAX_TABLE_ROWS} more rows — switch to JSON to see
              all.
            </div>
          )}
        </div>
      )}
    </>
  );
}

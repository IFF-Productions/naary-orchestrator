/**
 * Pure output formatting: compact tables + pretty JSON. No I/O — these return strings
 * so they are trivially testable; the commands do the actual `console.log`.
 */

export type Cell = string | number | boolean | null | undefined;

function cellToString(v: Cell): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

/**
 * Render an array of row objects as a fixed-width column table. `columns` is a list of
 * [header, key] pairs; missing keys render blank. Returns "" for an empty list.
 */
export function table<T extends Record<string, Cell>>(
  rows: T[],
  columns: Array<[header: string, key: keyof T]>,
): string {
  if (rows.length === 0) return "";
  const headers = columns.map(([h]) => h);
  const body = rows.map((r) => columns.map(([, k]) => cellToString(r[k])));

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i].length)),
  );

  const pad = (s: string, i: number) => s.padEnd(widths[i]);
  const line = (cells: string[]) =>
    cells
      .map((c, i) => pad(c, i))
      .join("  ")
      .trimEnd();

  const out = [line(headers), line(widths.map((w) => "-".repeat(w)))];
  for (const row of body) out.push(line(row));
  return out.join("\n");
}

/** Pretty-print any JSON-serializable value. `undefined` → "null". */
export function prettyJson(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

/** Format an ISO timestamp compactly (drops milliseconds), or "" if absent. */
export function shortTime(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Format a USD cost, or "" if absent. */
export function usd(cost: number | undefined | null): string {
  if (cost === undefined || cost === null) return "";
  return `$${Number(cost).toFixed(4)}`;
}

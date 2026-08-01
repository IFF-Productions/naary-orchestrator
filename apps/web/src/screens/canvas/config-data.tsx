// SQL / set / rename / text / filter / aggregate / list / compare / xml / markdown config sections of the node inspector (extracted verbatim from CanvasPage).
import type { ConfigSectionCtx } from "./ConfigPanel";
import {
  type BindingRow,
  BindingsEditor,
  ConditionEditor,
  CONNECTION_TYPES,
  ConnectionSelect,
  inputStyle,
  JsonArrayField,
  JsonField,
  Labeled,
} from "./fields";
import { RowHead } from "./PinSection";
import { SqlEditorField } from "./SqlEditorField";

export function renderDataSections(c: ConfigSectionCtx) {
  const {
    node,
    kind,
    config,
    str,
    num,
    obj,
    exprText,
    onChange,
    upstreamIds,
    edges,
    nodeKinds,
    connections,
    pins,
  } = c;
  return (
    <>
      {(kind === "sqlQuery" || kind === "sqlExec") && (
        <>
          <Labeled label="Database connection id">
            <ConnectionSelect
              connections={connections}
              types={CONNECTION_TYPES[kind] ?? []}
              value={str("connectionId")}
              onChange={(id) => onChange({ connectionId: id })}
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            A <code>postgres</code>, <code>mssql</code>, or <code>mysql</code>{" "}
            connection.{" "}
            {kind === "sqlExec"
              ? "Writes run in a transaction (commit on success, rollback on error). At-most-once — never retried."
              : "Read-only — the query runs in a transaction that's always rolled back."}
          </div>

          <div>
            <RowHead
              label="SQL"
              value={kind === "sqlExec" ? "write" : "read-only"}
            />
            <SqlEditorField
              value={str("sql")}
              onChange={(sql) => onChange({ sql })}
              connectionId={str("connectionId")}
              placeholder={
                kind === "sqlExec"
                  ? "UPDATE users SET seen = true WHERE id = $1"
                  : "SELECT id, email FROM users WHERE id = $1"
              }
            />
          </div>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            Placeholders are engine-specific: <code>$1, $2…</code> (Postgres),{" "}
            <code>@p1, @p2…</code> (MSSQL), or <code>?</code> (MySQL). Bindings
            fill the values — never build SQL from upstream output.
          </div>

          <BindingsEditor
            bindings={
              obj("paramBindings") as Record<string, BindingRow> | undefined
            }
            upstreamIds={upstreamIds}
            onChange={(v) => onChange({ paramBindings: v })}
          />

          <JsonArrayField
            label="Static params (JSON array)"
            value={config.params as unknown[] | undefined}
            placeholder={"[\n  42\n]"}
            onChange={(v) => onChange({ params: v })}
          />

          <Labeled label="Statement timeout (ms)">
            <input
              type="number"
              min={1}
              value={num("statementTimeoutMs") ?? ""}
              onChange={(e) =>
                onChange({
                  statementTimeoutMs: e.target.value
                    ? Number(e.target.value)
                    : undefined,
                })
              }
              style={inputStyle}
              placeholder="30000 (default)"
            />
          </Labeled>

          <Labeled label="Cost (USD per call)">
            <input
              type="number"
              min={0}
              step={0.001}
              value={num("costUsd") ?? ""}
              onChange={(e) =>
                onChange({
                  costUsd: e.target.value ? Number(e.target.value) : undefined,
                })
              }
              style={inputStyle}
              placeholder="0.00"
            />
          </Labeled>
        </>
      )}

      {kind === "set" && (
        <>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
            Builds a plain object passed downstream. The output <em>is</em> this
            object — bindings fill/override fields from upstream outputs. Read a
            field later as <code>{node.id}.fieldName</code>.
          </div>

          <BindingsEditor
            bindings={
              obj("fieldBindings") as Record<string, BindingRow> | undefined
            }
            upstreamIds={upstreamIds}
            onChange={(v) => onChange({ fieldBindings: v })}
          />

          <JsonField
            label="Static fields (JSON)"
            value={obj("fields")}
            placeholder={'{\n  "status": "reviewed"\n}'}
            onChange={(v) => onChange({ fields: v })}
          />
        </>
      )}

      {kind === "renameKeys" && (
        <>
          <Labeled label="Source node id">
            <input
              value={str("from")}
              onChange={(e) => onChange({ from: e.target.value })}
              style={inputStyle}
              placeholder="upstream-node-id"
            />
          </Labeled>
          <Labeled label="Source path (optional)">
            <input
              value={str("path")}
              onChange={(e) => onChange({ path: e.target.value })}
              style={inputStyle}
              placeholder="output"
            />
          </Labeled>
          <JsonField
            label="Rename (JSON: oldKey → newKey)"
            value={obj("rename")}
            placeholder={'{\n  "user_id": "userId"\n}'}
            onChange={(v) => onChange({ rename: v })}
          />
          <JsonArrayField
            label="Drop keys (JSON array)"
            value={config.drop as unknown[] | undefined}
            placeholder={'[\n  "internal"\n]'}
            onChange={(v) => onChange({ drop: v })}
          />
        </>
      )}

      {kind === "text" &&
        (() => {
          const op = str("operation") || "trim";
          return (
            <>
              <Labeled label="Operation">
                <select
                  value={op}
                  onChange={(e) => onChange({ operation: e.target.value })}
                  style={inputStyle}
                >
                  <option value="upper">Uppercase</option>
                  <option value="lower">Lowercase</option>
                  <option value="trim">Trim whitespace</option>
                  <option value="replace">Replace</option>
                  <option value="split">Split → array</option>
                  <option value="join">Join array → string</option>
                  <option value="substring">Substring</option>
                  <option value="length">Length</option>
                  <option value="regexExtract">Regex extract</option>
                </select>
              </Labeled>
              <Labeled label="Source node id">
                <input
                  value={str("from")}
                  onChange={(e) => onChange({ from: e.target.value })}
                  style={inputStyle}
                  placeholder="upstream-node-id"
                />
              </Labeled>
              <Labeled label="Path (optional)">
                <input
                  value={str("path")}
                  onChange={(e) => onChange({ path: e.target.value })}
                  style={inputStyle}
                  placeholder="output"
                />
              </Labeled>
              {op === "replace" && (
                <>
                  <Labeled label="Find">
                    <input
                      value={str("search")}
                      onChange={(e) => onChange({ search: e.target.value })}
                      style={inputStyle}
                      placeholder="text or regex source"
                    />
                  </Labeled>
                  <Labeled label="Replace with">
                    <input
                      value={str("replacement")}
                      onChange={(e) =>
                        onChange({ replacement: e.target.value })
                      }
                      style={inputStyle}
                      placeholder="replacement"
                    />
                  </Labeled>
                  <label
                    style={{
                      display: "flex",
                      gap: 6,
                      alignItems: "center",
                      fontSize: "var(--text-sm)",
                      color: "var(--ink-2)",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(config.useRegex)}
                      onChange={(e) => onChange({ useRegex: e.target.checked })}
                    />
                    Treat "find" as a regular expression (global)
                  </label>
                </>
              )}
              {(op === "split" || op === "join") && (
                <Labeled label="Separator">
                  <input
                    value={str("separator")}
                    onChange={(e) => onChange({ separator: e.target.value })}
                    style={inputStyle}
                    placeholder=","
                  />
                </Labeled>
              )}
              {op === "substring" && (
                <div style={{ display: "flex", gap: 8 }}>
                  <Labeled label="Start">
                    <input
                      type="number"
                      value={num("start") ?? ""}
                      onChange={(e) =>
                        onChange({
                          start: e.target.value
                            ? Number(e.target.value)
                            : undefined,
                        })
                      }
                      style={inputStyle}
                      placeholder="0"
                    />
                  </Labeled>
                  <Labeled label="End (optional)">
                    <input
                      type="number"
                      value={num("end") ?? ""}
                      onChange={(e) =>
                        onChange({
                          end: e.target.value
                            ? Number(e.target.value)
                            : undefined,
                        })
                      }
                      style={inputStyle}
                      placeholder="end"
                    />
                  </Labeled>
                </div>
              )}
              {op === "regexExtract" && (
                <div style={{ display: "flex", gap: 8 }}>
                  <Labeled label="Pattern">
                    <input
                      value={str("search")}
                      onChange={(e) => onChange({ search: e.target.value })}
                      style={inputStyle}
                      placeholder="(\\d+)"
                    />
                  </Labeled>
                  <Labeled label="Group">
                    <input
                      type="number"
                      value={num("group") ?? ""}
                      onChange={(e) =>
                        onChange({
                          group: e.target.value
                            ? Number(e.target.value)
                            : undefined,
                        })
                      }
                      style={inputStyle}
                      placeholder="0"
                    />
                  </Labeled>
                </div>
              )}
              <div
                style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
              >
                Result is <code>{node.id}.result</code>.
              </div>
            </>
          );
        })()}

      {kind === "filter" && (
        <>
          <Labeled label="Array source node id">
            <input
              value={str("from")}
              onChange={(e) => onChange({ from: e.target.value })}
              style={inputStyle}
              placeholder="upstream-node-id"
            />
          </Labeled>
          <Labeled label="Array path (optional)">
            <input
              value={str("path")}
              onChange={(e) => onChange({ path: e.target.value })}
              style={inputStyle}
              placeholder="rows"
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            Keeps array items matching the predicate below (paths are relative
            to each item). Output is the filtered array.
          </div>
          <ConditionEditor
            condition={
              config.condition as
                { path?: string; op?: string; value?: unknown } | undefined
            }
            onChange={(c) => onChange({ condition: c })}
          />
        </>
      )}

      {kind === "aggregate" && (
        <>
          <Labeled label="Array source node id">
            <input
              value={str("from")}
              onChange={(e) => onChange({ from: e.target.value })}
              style={inputStyle}
              placeholder="upstream-node-id"
            />
          </Labeled>
          <Labeled label="Array path (optional)">
            <input
              value={str("path")}
              onChange={(e) => onChange({ path: e.target.value })}
              style={inputStyle}
              placeholder="rows"
            />
          </Labeled>
          <Labeled label="Operation">
            <select
              value={str("operation") || "collect"}
              onChange={(e) => onChange({ operation: e.target.value })}
              style={inputStyle}
            >
              {[
                "collect",
                "count",
                "sum",
                "min",
                "max",
                "avg",
                "first",
                "last",
              ].map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </Labeled>
          <Labeled label="Field (item path, optional)">
            <input
              value={str("field")}
              onChange={(e) => onChange({ field: e.target.value })}
              style={inputStyle}
              placeholder="email"
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            Collapses the array into <code>{node.id}.result</code>. For
            collect/sum, pick a field from each item.
          </div>
        </>
      )}

      {kind === "listOps" && (
        <>
          <Labeled label="Array source node id">
            <input
              value={str("from")}
              onChange={(e) => onChange({ from: e.target.value })}
              style={inputStyle}
              placeholder="upstream-node-id"
            />
          </Labeled>
          <Labeled label="Array path (optional)">
            <input
              value={str("path")}
              onChange={(e) => onChange({ path: e.target.value })}
              style={inputStyle}
              placeholder="rows"
            />
          </Labeled>
          <Labeled label="Operation">
            <select
              value={str("operation") || "sort"}
              onChange={(e) => onChange({ operation: e.target.value })}
              style={inputStyle}
            >
              {["sort", "limit", "dedupe"].map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </Labeled>
          <Labeled label="Field (item path — sort/dedupe)">
            <input
              value={str("field")}
              onChange={(e) => onChange({ field: e.target.value })}
              style={inputStyle}
              placeholder="createdAt"
            />
          </Labeled>
          <Labeled label="Order (sort)">
            <select
              value={str("order") || "asc"}
              onChange={(e) => onChange({ order: e.target.value })}
              style={inputStyle}
            >
              <option value="asc">asc</option>
              <option value="desc">desc</option>
            </select>
          </Labeled>
          <Labeled label="Count (limit)">
            <input
              type="number"
              min={1}
              value={num("count") ?? ""}
              onChange={(e) =>
                onChange({
                  count: e.target.value ? Number(e.target.value) : undefined,
                })
              }
              style={inputStyle}
              placeholder="10"
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            Outputs the resulting array. sort/dedupe use the field (whole item
            if blank); limit takes the first N.
          </div>
        </>
      )}

      {kind === "compareDatasets" && (
        <>
          <Labeled label="A — source node id">
            <input
              value={(config.a as BindingRow | undefined)?.from ?? ""}
              onChange={(e) =>
                onChange({
                  a: {
                    ...(config.a as BindingRow | undefined),
                    from: e.target.value,
                  },
                })
              }
              style={inputStyle}
              placeholder="baseline-node"
            />
          </Labeled>
          <Labeled label="A — array path (optional)">
            <input
              value={(config.a as BindingRow | undefined)?.path ?? ""}
              onChange={(e) =>
                onChange({
                  a: {
                    ...(config.a as BindingRow | undefined),
                    path: e.target.value || undefined,
                  },
                })
              }
              style={inputStyle}
              placeholder="rows"
            />
          </Labeled>
          <Labeled label="B — source node id">
            <input
              value={(config.b as BindingRow | undefined)?.from ?? ""}
              onChange={(e) =>
                onChange({
                  b: {
                    ...(config.b as BindingRow | undefined),
                    from: e.target.value,
                  },
                })
              }
              style={inputStyle}
              placeholder="comparison-node"
            />
          </Labeled>
          <Labeled label="B — array path (optional)">
            <input
              value={(config.b as BindingRow | undefined)?.path ?? ""}
              onChange={(e) =>
                onChange({
                  b: {
                    ...(config.b as BindingRow | undefined),
                    path: e.target.value || undefined,
                  },
                })
              }
              style={inputStyle}
              placeholder="rows"
            />
          </Labeled>
          <Labeled label="Key field (identifies a row)">
            <input
              value={str("key")}
              onChange={(e) => onChange({ key: e.target.value })}
              style={inputStyle}
              placeholder="id"
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            Diffs A vs B by the key → <code>{node.id}.added</code> /{" "}
            <code>.removed</code> / <code>.changed</code> / <code>.same</code>.
          </div>
        </>
      )}

      {kind === "xml" && (
        <>
          <Labeled label="Operation">
            <select
              value={str("operation") || "parse"}
              onChange={(e) => onChange({ operation: e.target.value })}
              style={inputStyle}
            >
              <option value="parse">parse (XML → object)</option>
              <option value="build">build (object → XML)</option>
            </select>
          </Labeled>
          <Labeled label="Source node id">
            <input
              value={str("from")}
              onChange={(e) => onChange({ from: e.target.value })}
              style={inputStyle}
              placeholder="upstream-node-id"
            />
          </Labeled>
          <Labeled label="Path (optional)">
            <input
              value={str("path")}
              onChange={(e) => onChange({ path: e.target.value })}
              style={inputStyle}
              placeholder="body"
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            parse → <code>{node.id}</code> is the object; build →{" "}
            <code>{node.id}.xml</code> is the string.
          </div>
        </>
      )}

      {kind === "markdown" && (
        <>
          <Labeled label="Source node id">
            <input
              value={str("from")}
              onChange={(e) => onChange({ from: e.target.value })}
              style={inputStyle}
              placeholder="upstream-node-id"
            />
          </Labeled>
          <Labeled label="Path (optional)">
            <input
              value={str("path")}
              onChange={(e) => onChange({ path: e.target.value })}
              style={inputStyle}
              placeholder="body"
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            Converts that HTML string to Markdown →{" "}
            <code>{node.id}.markdown</code>.
          </div>
        </>
      )}
    </>
  );
}

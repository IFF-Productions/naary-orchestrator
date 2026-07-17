// Vector / split / loop / html / json / encode / number / csv / dateTime / merge config sections of the node inspector (extracted verbatim from CanvasPage).
import type { ConfigSectionCtx } from "./ConfigPanel";
import { inputStyle, Labeled } from "./fields";

export function renderTransformSections(c: ConfigSectionCtx) {
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
      {(kind === "vectorUpsert" || kind === "vectorQuery") && (
        <>
          <Labeled label="Collection">
            <input
              value={str("collection")}
              onChange={(e) => onChange({ collection: e.target.value })}
              style={inputStyle}
              placeholder="docs"
            />
          </Labeled>
          <Labeled
            label={
              kind === "vectorUpsert"
                ? "Text source node id (string or string[])"
                : "Query source node id"
            }
          >
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
              placeholder="message"
            />
          </Labeled>
          {kind === "vectorQuery" && (
            <Labeled label="Top K (default 4)">
              <input
                type="number"
                value={str("topK")}
                onChange={(e) =>
                  onChange({
                    topK: e.target.value ? Number(e.target.value) : undefined,
                  })
                }
                style={inputStyle}
                placeholder="4"
              />
            </Labeled>
          )}
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            {kind === "vectorUpsert" ? (
              <>
                Embeds + stores the chunk(s) → <code>{node.id}.upserted</code>.
                Needs an OpenAI key (Integrations).
              </>
            ) : (
              <>
                Returns the nearest chunks → <code>{node.id}.matches</code>.
                Bind an agent's context to these for RAG.
              </>
            )}
          </div>
        </>
      )}

      {kind === "splitOut" && (
        <>
          <Labeled label="Array source node id">
            <input
              value={str("from")}
              onChange={(e) => onChange({ from: e.target.value })}
              style={inputStyle}
              placeholder="upstream-node-id"
            />
          </Labeled>
          <Labeled label="Path to the array (optional)">
            <input
              value={str("path")}
              onChange={(e) => onChange({ path: e.target.value })}
              style={inputStyle}
              placeholder="items"
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            Runs the region up to <strong>Loop End</strong> once per item;
            inside it, <code>{node.id}</code> is the current item. The region
            can hold transforms, activities (Agent / HTTP / MCP), and{" "}
            <strong>IF / Switch / Merge</strong> branching that rejoins before
            Loop End — the shape is validated on save.
          </div>
        </>
      )}

      {kind === "loopEnd" && (
        <>
          <Labeled label="Collect from region node id">
            <input
              value={str("from")}
              onChange={(e) => onChange({ from: e.target.value })}
              style={inputStyle}
              placeholder="region-node-id"
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            <code>{node.id}</code> is the ARRAY of that node's per-item outputs.
            After it, the flow is a single value again.
          </div>
        </>
      )}

      {kind === "htmlExtract" &&
        (() => {
          const extractions =
            (config.extractions as
              | Array<{
                  key?: string;
                  selector?: string;
                  return?: string;
                  attribute?: string;
                  all?: boolean;
                }>
              | undefined) ?? [];
          const setEx = (next: typeof extractions) =>
            onChange({ extractions: next });
          return (
            <>
              <Labeled label="HTML source node id">
                <input
                  value={str("from")}
                  onChange={(e) => onChange({ from: e.target.value })}
                  style={inputStyle}
                  placeholder="upstream-http-node"
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
                Each row reads a CSS selector's match into{" "}
                <code>{node.id}.&lt;key&gt;</code>.
              </div>
              {extractions.map((ex, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: positional rows
                  key={i}
                  style={{
                    border: "1px solid var(--line)",
                    borderRadius: "var(--radius-md)",
                    padding: 10,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      value={ex.key ?? ""}
                      onChange={(e) =>
                        setEx(
                          extractions.map((x, j) =>
                            j === i ? { ...x, key: e.target.value } : x,
                          ),
                        )
                      }
                      style={inputStyle}
                      placeholder="key (e.g. title)"
                    />
                    <button
                      type="button"
                      aria-label="Remove extraction"
                      onClick={() =>
                        setEx(extractions.filter((_, j) => j !== i))
                      }
                      style={{
                        border: "1px solid var(--line-2)",
                        background: "var(--card)",
                        color: "var(--ink-2)",
                        borderRadius: "var(--radius-sm)",
                        cursor: "pointer",
                        padding: "6px 10px",
                        flex: "none",
                      }}
                    >
                      ×
                    </button>
                  </div>
                  <input
                    value={ex.selector ?? ""}
                    onChange={(e) =>
                      setEx(
                        extractions.map((x, j) =>
                          j === i ? { ...x, selector: e.target.value } : x,
                        ),
                      )
                    }
                    style={inputStyle}
                    placeholder="CSS selector (e.g. h1, .price, a.more)"
                  />
                  <div style={{ display: "flex", gap: 8 }}>
                    <select
                      value={ex.return ?? "text"}
                      onChange={(e) =>
                        setEx(
                          extractions.map((x, j) =>
                            j === i ? { ...x, return: e.target.value } : x,
                          ),
                        )
                      }
                      style={inputStyle}
                    >
                      <option value="text">text</option>
                      <option value="html">inner HTML</option>
                      <option value="attribute">attribute</option>
                    </select>
                    {ex.return === "attribute" && (
                      <input
                        value={ex.attribute ?? ""}
                        onChange={(e) =>
                          setEx(
                            extractions.map((x, j) =>
                              j === i ? { ...x, attribute: e.target.value } : x,
                            ),
                          )
                        }
                        style={inputStyle}
                        placeholder="attribute (e.g. href)"
                      />
                    )}
                  </div>
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
                      checked={Boolean(ex.all)}
                      onChange={(e) =>
                        setEx(
                          extractions.map((x, j) =>
                            j === i ? { ...x, all: e.target.checked } : x,
                          ),
                        )
                      }
                    />
                    Return all matches (array)
                  </label>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setEx([
                    ...extractions,
                    { key: "", selector: "", return: "text" },
                  ])
                }
                style={{
                  alignSelf: "flex-start",
                  border: "1px solid var(--line-2)",
                  background: "var(--card)",
                  color: "var(--ink-2)",
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                  padding: "6px 10px",
                  fontSize: "var(--text-sm)",
                }}
              >
                + Add extraction
              </button>
            </>
          );
        })()}

      {kind === "json" && (
        <>
          <Labeled label="Operation">
            <select
              value={str("operation") || "parse"}
              onChange={(e) => onChange({ operation: e.target.value })}
              style={inputStyle}
            >
              <option value="parse">parse (JSON text → data)</option>
              <option value="stringify">stringify (data → JSON text)</option>
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
          {str("operation") === "stringify" && (
            <Labeled label="Indent (0 = compact)">
              <input
                type="number"
                min={0}
                value={num("indent") ?? ""}
                onChange={(e) =>
                  onChange({
                    indent: e.target.value ? Number(e.target.value) : undefined,
                  })
                }
                style={inputStyle}
                placeholder="0"
              />
            </Labeled>
          )}
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
            parse → <code>{node.id}</code> is the value; stringify →{" "}
            <code>{node.id}.json</code> is the string.
          </div>
        </>
      )}

      {kind === "encode" && (
        <>
          <Labeled label="Operation">
            <select
              value={str("operation") || "base64Encode"}
              onChange={(e) => onChange({ operation: e.target.value })}
              style={inputStyle}
            >
              <option value="base64Encode">Base64 encode</option>
              <option value="base64Decode">Base64 decode</option>
              <option value="base64urlEncode">Base64url encode</option>
              <option value="base64urlDecode">Base64url decode</option>
              <option value="hexEncode">Hex encode</option>
              <option value="hexDecode">Hex decode</option>
              <option value="urlEncode">URL encode</option>
              <option value="urlDecode">URL decode</option>
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
              placeholder="result"
            />
          </Labeled>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
            Result is <code>{node.id}.result</code>.
          </div>
        </>
      )}

      {kind === "number" &&
        (() => {
          const op = str("operation") || "add";
          const binary = [
            "add",
            "subtract",
            "multiply",
            "divide",
            "modulo",
            "power",
          ].includes(op);
          const bind = (k: "aBinding" | "bBinding") =>
            (config[k] as { from?: string; path?: string } | undefined) ?? {};
          const setBind = (
            k: "aBinding" | "bBinding",
            patch: { from?: string; path?: string },
          ) => {
            const next = { ...bind(k), ...patch };
            onChange({ [k]: next.from ? next : undefined });
          };
          return (
            <>
              <Labeled label="Operation">
                <select
                  value={op}
                  onChange={(e) => onChange({ operation: e.target.value })}
                  style={inputStyle}
                >
                  <option value="add">Add (a + b)</option>
                  <option value="subtract">Subtract (a − b)</option>
                  <option value="multiply">Multiply (a × b)</option>
                  <option value="divide">Divide (a ÷ b)</option>
                  <option value="modulo">Modulo (a % b)</option>
                  <option value="power">Power (a ^ b)</option>
                  <option value="round">Round (a)</option>
                  <option value="floor">Floor (a)</option>
                  <option value="ceil">Ceil (a)</option>
                  <option value="abs">Absolute (a)</option>
                </select>
              </Labeled>
              <div style={{ display: "flex", gap: 8 }}>
                <Labeled label="a (value)">
                  <input
                    type="number"
                    value={num("a") ?? ""}
                    onChange={(e) =>
                      onChange({
                        a: e.target.value ? Number(e.target.value) : undefined,
                      })
                    }
                    style={inputStyle}
                    placeholder="0"
                  />
                </Labeled>
                <Labeled label="a from node">
                  <input
                    value={bind("aBinding").from ?? ""}
                    onChange={(e) =>
                      setBind("aBinding", { from: e.target.value })
                    }
                    style={inputStyle}
                    placeholder="node id"
                  />
                </Labeled>
                <Labeled label="a path">
                  <input
                    value={bind("aBinding").path ?? ""}
                    onChange={(e) =>
                      setBind("aBinding", { path: e.target.value })
                    }
                    style={inputStyle}
                    placeholder="x"
                  />
                </Labeled>
              </div>
              {binary && (
                <div style={{ display: "flex", gap: 8 }}>
                  <Labeled label="b (value)">
                    <input
                      type="number"
                      value={num("b") ?? ""}
                      onChange={(e) =>
                        onChange({
                          b: e.target.value
                            ? Number(e.target.value)
                            : undefined,
                        })
                      }
                      style={inputStyle}
                      placeholder="0"
                    />
                  </Labeled>
                  <Labeled label="b from node">
                    <input
                      value={bind("bBinding").from ?? ""}
                      onChange={(e) =>
                        setBind("bBinding", { from: e.target.value })
                      }
                      style={inputStyle}
                      placeholder="node id"
                    />
                  </Labeled>
                  <Labeled label="b path">
                    <input
                      value={bind("bBinding").path ?? ""}
                      onChange={(e) =>
                        setBind("bBinding", { path: e.target.value })
                      }
                      style={inputStyle}
                      placeholder="y"
                    />
                  </Labeled>
                </div>
              )}
              {op === "round" && (
                <Labeled label="Decimal places">
                  <input
                    type="number"
                    min={0}
                    value={num("precision") ?? ""}
                    onChange={(e) =>
                      onChange({
                        precision: e.target.value
                          ? Number(e.target.value)
                          : undefined,
                      })
                    }
                    style={inputStyle}
                    placeholder="0"
                  />
                </Labeled>
              )}
              <div
                style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
              >
                Result is <code>{node.id}.result</code>. A binding (from/path)
                overrides the static value.
              </div>
            </>
          );
        })()}

      {kind === "csv" && (
        <>
          <Labeled label="Operation">
            <select
              value={str("operation") || "parse"}
              onChange={(e) => onChange({ operation: e.target.value })}
              style={inputStyle}
            >
              <option value="parse">parse (CSV text → rows)</option>
              <option value="build">build (rows → CSV text)</option>
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
          <div style={{ display: "flex", gap: 8 }}>
            <Labeled label="Delimiter">
              <input
                value={str("delimiter") || ""}
                onChange={(e) =>
                  onChange({ delimiter: e.target.value || undefined })
                }
                style={inputStyle}
                placeholder=","
              />
            </Labeled>
          </div>
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
              checked={config.header !== false}
              onChange={(e) => onChange({ header: e.target.checked })}
            />
            First row is the header
          </label>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
            parse → <code>{node.id}</code> is the rows array; build →{" "}
            <code>{node.id}.csv</code> is the string.
          </div>
        </>
      )}

      {kind === "dateTime" && (
        <>
          <Labeled label="Source node id (blank = current time)">
            <input
              value={
                typeof config.source === "object" && config.source
                  ? ((config.source as { from?: string }).from ?? "")
                  : ""
              }
              onChange={(e) =>
                onChange({
                  source: e.target.value ? { from: e.target.value } : undefined,
                })
              }
              style={inputStyle}
              placeholder="(now)"
            />
          </Labeled>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
            Blank = the current time (read server-side). Otherwise bind an
            upstream epoch-ms or ISO value to do timestamp math on. Output is{" "}
            <code>{node.id}.iso</code> / <code>{node.id}.epochMs</code>.
          </div>
          <Labeled label="Add seconds (may be negative)">
            <input
              type="number"
              value={num("addSeconds") ?? ""}
              onChange={(e) =>
                onChange({
                  addSeconds: e.target.value
                    ? Number(e.target.value)
                    : undefined,
                })
              }
              style={inputStyle}
              placeholder="0"
            />
          </Labeled>
        </>
      )}

      {kind === "merge" && (
        <>
          <Labeled label="Combine mode">
            <select
              value={str("mode") || "array"}
              onChange={(e) => onChange({ mode: e.target.value })}
              style={inputStyle}
            >
              <option value="array">Array — [input1, input2, …]</option>
              <option value="object">Object — merge fields together</option>
            </select>
          </Labeled>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
            Joins parallel branches: runs once, after <em>all</em> inbound
            branches arrive, and combines their outputs into{" "}
            <code>{node.id}</code>. Inbound edges must be unconditional (no
            branch conditions into a merge).
          </div>
        </>
      )}
    </>
  );
}

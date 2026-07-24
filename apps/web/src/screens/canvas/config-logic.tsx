// if / switch / hmac / jwt / totp / hash / random config sections of the node inspector (extracted verbatim from CanvasPage).
import type { ConfigSectionCtx } from "./ConfigPanel";
import {
  type BindingRow,
  BindingsEditor,
  ConditionEditor,
  CONNECTION_TYPES,
  ConnectionSelect,
  inputStyle,
  JsonField,
  Labeled,
} from "./fields";

export function renderLogicSections(c: ConfigSectionCtx) {
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
      {kind === "if" &&
        (() => {
          const conditions =
            (config.conditions as
              | Array<{ path?: string; op?: string; value?: unknown }>
              | undefined) ?? [];
          const setConds = (next: typeof conditions) =>
            onChange({ conditions: next });
          return (
            <>
              <Labeled label="Combine">
                <select
                  value={str("combine") || "and"}
                  onChange={(e) => onChange({ combine: e.target.value })}
                  style={inputStyle}
                >
                  <option value="and">AND — all must be true</option>
                  <option value="or">OR — any can be true</option>
                </select>
              </Labeled>
              <div
                style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
              >
                Result is <code>{node.id}.result</code> (boolean). Draw a
                true-edge (<code>result eq true</code>) and a false-edge.
              </div>
              {conditions.map((c, i) => (
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
                  <ConditionEditor
                    condition={c}
                    onChange={(next) =>
                      setConds(conditions.map((x, j) => (j === i ? next : x)))
                    }
                  />
                  <button
                    type="button"
                    aria-label="Remove condition"
                    onClick={() =>
                      setConds(conditions.filter((_, j) => j !== i))
                    }
                    style={{
                      alignSelf: "flex-end",
                      border: "1px solid var(--line-2)",
                      background: "var(--card)",
                      color: "var(--ink-2)",
                      borderRadius: "var(--radius-sm)",
                      cursor: "pointer",
                      padding: "4px 10px",
                      fontSize: "var(--text-sm)",
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setConds([...conditions, { path: "", op: "eq", value: "" }])
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
                + Add condition
              </button>
            </>
          );
        })()}

      {kind === "switch" &&
        (() => {
          const rules =
            (config.rules as
              | Array<{
                  name?: string;
                  condition?: { path?: string; op?: string; value?: unknown };
                }>
              | undefined) ?? [];
          const setRules = (next: typeof rules) => onChange({ rules: next });
          return (
            <>
              <div
                style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
              >
                Rules run top-to-bottom; the first match sets{" "}
                <code>{node.id}.matched</code> to that rule's name (else the
                fallback). Draw one outgoing edge per branch with{" "}
                <code>matched eq &lt;name&gt;</code>.
              </div>
              {rules.map((rule, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: rules are positional
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
                  <div
                    style={{ display: "flex", gap: 8, alignItems: "center" }}
                  >
                    <input
                      value={rule.name ?? ""}
                      onChange={(e) =>
                        setRules(
                          rules.map((r, j) =>
                            j === i ? { ...r, name: e.target.value } : r,
                          ),
                        )
                      }
                      style={inputStyle}
                      placeholder="branch name (e.g. urgent)"
                    />
                    <button
                      type="button"
                      aria-label="Remove rule"
                      onClick={() => setRules(rules.filter((_, j) => j !== i))}
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
                  <ConditionEditor
                    condition={rule.condition}
                    onChange={(c) =>
                      setRules(
                        rules.map((r, j) =>
                          j === i ? { ...r, condition: c } : r,
                        ),
                      )
                    }
                  />
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setRules([
                    ...rules,
                    { name: "", condition: { path: "", op: "eq", value: "" } },
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
                + Add rule
              </button>
              <Labeled label="Fallback (matched when no rule fits)">
                <input
                  value={str("fallback")}
                  onChange={(e) => onChange({ fallback: e.target.value })}
                  style={inputStyle}
                  placeholder="default"
                />
              </Labeled>
            </>
          );
        })()}

      {kind === "hmac" && (
        <>
          <Labeled label="Signing connection id">
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
            A <code>signing</code> connection — its key is read server-side,
            never stored in the graph. Output is <code>{node.id}.digest</code>.
          </div>
          <Labeled label="Algorithm">
            <select
              value={str("algorithm") || "sha256"}
              onChange={(e) => onChange({ algorithm: e.target.value })}
              style={inputStyle}
            >
              <option value="sha256">sha256</option>
              {/* Weak digests are legacy-interop only (#598): not offered for new
                  configs, but a saved sha1 config keeps rendering its value. */}
              {str("algorithm") === "sha1" && (
                <option value="sha1">sha1 (legacy)</option>
              )}
            </select>
          </Labeled>
          <Labeled label="Encoding">
            <select
              value={str("encoding") || "hex"}
              onChange={(e) => onChange({ encoding: e.target.value })}
              style={inputStyle}
            >
              <option value="hex">hex</option>
              <option value="base64">base64</option>
            </select>
          </Labeled>
          <BindingsEditor
            bindings={
              config.payloadBinding
                ? { payload: config.payloadBinding as BindingRow }
                : undefined
            }
            upstreamIds={upstreamIds}
            onChange={(v) =>
              onChange({ payloadBinding: v ? Object.values(v)[0] : undefined })
            }
          />
          <JsonField
            label="Static payload (JSON, optional)"
            value={obj("payload")}
            placeholder={'{\n  "amount": 100\n}'}
            onChange={(v) => onChange({ payload: v })}
          />
        </>
      )}

      {kind === "jwt" && (
        <>
          <Labeled label="Signing connection id">
            <ConnectionSelect
              connections={connections}
              types={CONNECTION_TYPES[kind] ?? []}
              value={str("connectionId")}
              onChange={(id) => onChange({ connectionId: id })}
            />
          </Labeled>
          <Labeled label="Algorithm">
            <select
              value={str("algorithm") || "HS256"}
              onChange={(e) => onChange({ algorithm: e.target.value })}
              style={inputStyle}
            >
              <option value="HS256">HS256 (shared secret)</option>
              <option value="RS256">RS256 (RSA private key)</option>
            </select>
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            Signed by a <code>signing</code> connection's key (read server-side)
            — a shared secret for HS256, or a PEM PKCS#8 RSA private key for
            RS256. Output is <code>{node.id}.token</code>.
          </div>
          <BindingsEditor
            bindings={
              obj("claimsBindings") as Record<string, BindingRow> | undefined
            }
            upstreamIds={upstreamIds}
            onChange={(v) => onChange({ claimsBindings: v })}
          />
          <JsonField
            label="Static claims (JSON)"
            value={obj("claims")}
            placeholder={'{\n  "sub": "user-1"\n}'}
            onChange={(v) => onChange({ claims: v })}
          />
          <Labeled label="Expires in (seconds, optional)">
            <input
              type="number"
              min={1}
              value={num("expiresInSeconds") ?? ""}
              onChange={(e) =>
                onChange({
                  expiresInSeconds: e.target.value
                    ? Number(e.target.value)
                    : undefined,
                })
              }
              style={inputStyle}
              placeholder="3600"
            />
          </Labeled>
        </>
      )}

      {kind === "totp" && (
        <>
          <Labeled label="Signing connection id (base32 seed)">
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
            A <code>signing</code> connection whose secret is the base32 TOTP
            seed (read server-side). Output is <code>{node.id}.code</code>.
          </div>
          <Labeled label="Digits">
            <input
              type="number"
              min={6}
              max={8}
              value={num("digits") ?? ""}
              onChange={(e) =>
                onChange({
                  digits: e.target.value ? Number(e.target.value) : undefined,
                })
              }
              style={inputStyle}
              placeholder="6"
            />
          </Labeled>
          <Labeled label="Period (seconds)">
            <input
              type="number"
              min={1}
              value={num("period") ?? ""}
              onChange={(e) =>
                onChange({
                  period: e.target.value ? Number(e.target.value) : undefined,
                })
              }
              style={inputStyle}
              placeholder="30"
            />
          </Labeled>
        </>
      )}

      {kind === "hash" && (
        <>
          <div style={{ display: "flex", gap: 8 }}>
            <Labeled label="Algorithm">
              <select
                value={str("algorithm") || "sha256"}
                onChange={(e) => onChange({ algorithm: e.target.value })}
                style={inputStyle}
              >
                <option value="sha256">SHA-256</option>
                <option value="sha512">SHA-512</option>
                {/* md5/sha1 are legacy-interop only (#598): hidden for new configs,
                    still rendered when a saved graph already uses one. */}
                {str("algorithm") === "sha1" && (
                  <option value="sha1">SHA-1 (legacy)</option>
                )}
                {str("algorithm") === "md5" && (
                  <option value="md5">MD5 (legacy)</option>
                )}
              </select>
            </Labeled>
            <Labeled label="Encoding">
              <select
                value={str("encoding") || "hex"}
                onChange={(e) => onChange({ encoding: e.target.value })}
                style={inputStyle}
              >
                <option value="hex">hex</option>
                <option value="base64">base64</option>
              </select>
            </Labeled>
          </div>
          <Labeled label="Value to hash (static)">
            <input
              value={str("input")}
              onChange={(e) => onChange({ input: e.target.value })}
              style={inputStyle}
              placeholder="text, or bind from a node below"
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            Or bind the value from an upstream node (overrides the static
            value).
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Labeled label="From node id">
              <input
                value={
                  (config.inputBinding as { from?: string } | undefined)
                    ?.from ?? ""
                }
                onChange={(e) =>
                  onChange({
                    inputBinding: e.target.value
                      ? {
                          from: e.target.value,
                          path: (
                            config.inputBinding as { path?: string } | undefined
                          )?.path,
                        }
                      : undefined,
                  })
                }
                style={inputStyle}
                placeholder="upstream-node-id"
              />
            </Labeled>
            <Labeled label="Path (optional)">
              <input
                value={
                  (config.inputBinding as { path?: string } | undefined)
                    ?.path ?? ""
                }
                onChange={(e) =>
                  onChange({
                    inputBinding: {
                      from:
                        (config.inputBinding as { from?: string } | undefined)
                          ?.from ?? "",
                      path: e.target.value || undefined,
                    },
                  })
                }
                style={inputStyle}
                placeholder="body"
              />
            </Labeled>
          </div>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
            Output is <code>{node.id}.digest</code>.
          </div>
        </>
      )}

      {kind === "random" && (
        <>
          <Labeled label="Generate">
            <select
              value={str("operation") || "uuid"}
              onChange={(e) => onChange({ operation: e.target.value })}
              style={inputStyle}
            >
              <option value="uuid">UUID (v4)</option>
              <option value="hex">Random hex</option>
              <option value="base64">Random base64url</option>
              <option value="alphanumeric">Alphanumeric string</option>
              <option value="int">Integer in a range</option>
            </select>
          </Labeled>
          {(str("operation") === "hex" ||
            str("operation") === "base64" ||
            str("operation") === "alphanumeric") && (
            <Labeled
              label={
                str("operation") === "alphanumeric"
                  ? "Length (characters)"
                  : "Length (bytes)"
              }
            >
              <input
                type="number"
                min={1}
                value={num("length") ?? ""}
                onChange={(e) =>
                  onChange({
                    length: e.target.value ? Number(e.target.value) : undefined,
                  })
                }
                style={inputStyle}
                placeholder="16"
              />
            </Labeled>
          )}
          {str("operation") === "int" && (
            <div style={{ display: "flex", gap: 8 }}>
              <Labeled label="Min">
                <input
                  type="number"
                  value={num("min") ?? ""}
                  onChange={(e) =>
                    onChange({
                      min: e.target.value ? Number(e.target.value) : undefined,
                    })
                  }
                  style={inputStyle}
                  placeholder="0"
                />
              </Labeled>
              <Labeled label="Max">
                <input
                  type="number"
                  value={num("max") ?? ""}
                  onChange={(e) =>
                    onChange({
                      max: e.target.value ? Number(e.target.value) : undefined,
                    })
                  }
                  style={inputStyle}
                  placeholder="100"
                />
              </Labeled>
            </div>
          )}
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
            Output is <code>{node.id}.value</code>. Generated fresh each run.
          </div>
        </>
      )}
    </>
  );
}

/**
 * "Introspect" affordance for the graphQL node inspector. Runs the standard GraphQL introspection
 * query against the node's endpoint (via the API's SSRF-guarded /introspect/graphql), then lists the
 * schema's root query/mutation fields — each with an "Insert" action that scaffolds a starter query
 * into the node — plus a filterable browser of all types/fields for reference.
 *
 * AUTH: its OWN optional token field for a private endpoint, forwarded verbatim by the server (which
 * never resolves `{{ $secrets }}`). A node's stored secret header can't be used — it'd arrive literal.
 */
import { useMemo, useState } from "react";
import type { GraphQLSchemaSummary } from "@naary/dsl";
import { api } from "../lib/api";
import {
  type RootField,
  rootFields,
  scaffoldQuery,
} from "./graphql-introspect";

export function GraphQLIntrospectButton({
  url,
  onInsertQuery,
}: {
  url: string;
  onInsertQuery: (query: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [schema, setSchema] = useState<GraphQLSchemaSummary | null>(null);

  const hasUrl = url.trim().length > 0;
  const roots = useMemo(() => (schema ? rootFields(schema) : []), [schema]);

  function reset() {
    setOpen(false);
    setToken("");
    setFilter("");
    setError(undefined);
    setSchema(null);
  }

  async function introspect() {
    setLoading(true);
    setError(undefined);
    try {
      const s = await api.introspectGraphQL(url.trim(), token);
      setSchema(s);
    } catch (e) {
      setSchema(null);
      setError(
        e instanceof Error ? e.message : "Couldn't introspect that endpoint.",
      );
    } finally {
      setLoading(false);
    }
  }

  function insert(rf: RootField) {
    onInsertQuery(scaffoldQuery(rf.operation, rf.name));
    reset();
  }

  const q = filter.trim().toLowerCase();
  const types = (schema?.types ?? []).filter((t) =>
    q ? t.name.toLowerCase().includes(q) : true,
  );

  return (
    <div style={{ marginBottom: 10 }}>
      {!open ? (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            setError(undefined);
          }}
          style={{
            all: "unset",
            cursor: "pointer",
            fontSize: "var(--text-xs)",
            color: "var(--brand)",
            fontWeight: 600,
          }}
        >
          ⌕ Introspect schema
        </button>
      ) : (
        <div
          style={{
            border: "1px solid var(--line)",
            borderRadius: 8,
            padding: 8,
            background: "var(--bg-2)",
          }}
        >
          {!schema ? (
            <>
              {!hasUrl && (
                <div style={{ ...hintStyle, marginBottom: 6 }}>
                  Set the endpoint URL above first, then introspect.
                </div>
              )}
              <input
                type="password"
                aria-label="Token for a private endpoint (optional)"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Bearer token — only if the endpoint is private (optional)"
                style={fieldStyle}
              />
              {error && <div style={errStyle}>{error}</div>}
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <button
                  type="button"
                  disabled={!hasUrl || loading}
                  onClick={introspect}
                  style={primaryBtn(hasUrl && !loading)}
                >
                  {loading ? "Introspecting…" : "Introspect"}
                </button>
                <button type="button" onClick={reset} style={ghostBtn}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={{ ...hintStyle, marginBottom: 6 }}>
                {roots.length} root field{roots.length === 1 ? "" : "s"} ·{" "}
                {schema.types.length} type{schema.types.length === 1 ? "" : "s"}
              </div>
              {roots.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div style={sectionLabel}>Insert a starter query</div>
                  <ul style={listStyle}>
                    {roots.map((rf) => (
                      <li key={`${rf.operation}.${rf.name}`}>
                        <button
                          type="button"
                          onClick={() => insert(rf)}
                          style={opRowStyle}
                          title={`Insert a ${rf.operation} for ${rf.name}`}
                        >
                          <span style={{ ...methodBadge, minWidth: 62 }}>
                            {rf.operation}
                          </span>
                          <span
                            style={{
                              fontFamily: "var(--font-mono, monospace)",
                            }}
                          >
                            {rf.name}
                            {rf.args.length ? `(${rf.args.join(", ")})` : ""}
                          </span>
                          {rf.type && (
                            <span
                              style={{ color: "var(--ink-3)", marginLeft: 6 }}
                            >
                              : {rf.type}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div style={sectionLabel}>Browse types</div>
              <input
                aria-label="Filter types"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter types…"
                style={fieldStyle}
              />
              <ul style={{ ...listStyle, maxHeight: 200, overflowY: "auto" }}>
                {types.map((t) => (
                  <li key={t.name} style={{ marginTop: 6 }}>
                    <div
                      style={{
                        fontFamily: "var(--font-mono, monospace)",
                        fontSize: "var(--text-xs)",
                        color: "var(--ink)",
                        fontWeight: 600,
                      }}
                    >
                      {t.name}
                    </div>
                    <div
                      style={{
                        fontFamily: "var(--font-mono, monospace)",
                        fontSize: "var(--text-2xs, 10px)",
                        color: "var(--ink-3)",
                        paddingLeft: 10,
                      }}
                    >
                      {t.fields.map((f) => (
                        <div key={f.name}>
                          {f.name}
                          {f.args.length ? `(${f.args.join(", ")})` : ""}
                          {f.type ? `: ${f.type}` : ""}
                        </div>
                      ))}
                    </div>
                  </li>
                ))}
                {types.length === 0 && (
                  <li style={hintStyle}>No matching types.</li>
                )}
              </ul>
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <button type="button" onClick={reset} style={ghostBtn}>
                  Close
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const fieldStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  fontSize: "var(--text-xs)",
  padding: 8,
  borderRadius: 6,
  border: "1px solid var(--line-2)",
  background: "var(--card)",
  color: "var(--ink)",
};
const hintStyle: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--ink-3)",
};
const errStyle: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--state-error)",
  marginTop: 4,
};
const sectionLabel: React.CSSProperties = {
  fontSize: "var(--text-2xs, 10px)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--ink-3)",
  marginBottom: 4,
};
const listStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
};
const opRowStyle: React.CSSProperties = {
  all: "unset",
  boxSizing: "border-box",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  padding: "5px 6px",
  borderRadius: 6,
  fontSize: "var(--text-xs)",
  color: "var(--ink)",
};
const methodBadge: React.CSSProperties = {
  fontWeight: 700,
  fontSize: "var(--text-2xs, 10px)",
  color: "var(--brand)",
};
function primaryBtn(enabled: boolean): React.CSSProperties {
  return {
    all: "unset",
    cursor: enabled ? "pointer" : "default",
    padding: "5px 10px",
    borderRadius: 6,
    background: "var(--brand)",
    color: "var(--brand-ink, #fff)",
    fontSize: "var(--text-xs)",
    opacity: enabled ? 1 : 0.5,
  };
}
const ghostBtn: React.CSSProperties = {
  all: "unset",
  cursor: "pointer",
  padding: "5px 10px",
  borderRadius: 6,
  color: "var(--ink-2)",
  fontSize: "var(--text-xs)",
};

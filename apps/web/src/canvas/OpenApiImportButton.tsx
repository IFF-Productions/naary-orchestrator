/**
 * "Import from OpenAPI/Swagger spec" affordance for the httpRequest node inspector. Fetches a remote
 * spec through the API's SSRF-guarded /introspect/openapi endpoint, lists its operations, and applies
 * the picked operation's method + URL (+ its query/header param names, values left blank) to the node.
 *
 * AUTH: for a PRIVATE spec the user pastes a token here; it's forwarded VERBATIM to the spec URL by the
 * server (which never resolves `{{ $secrets }}`). This is deliberately its OWN field — a node's stored
 * `{{ $secrets.X }}` header can't be used, it'd reach the server as a literal string. The token is used
 * only for this authoring fetch; it is NOT written into the node (secrets belong on $secrets/a connection).
 */
import { useState } from "react";
import type { ApiOperation, OpenApiSummary } from "@naary/dsl";
import { api } from "../lib/api";
import { type OpenApiImportConfig, toConfig } from "./openapi-import";

export type { OpenApiImportConfig };

export function OpenApiImportButton({
  onApply,
}: {
  onApply: (config: OpenApiImportConfig) => void;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [summary, setSummary] = useState<OpenApiSummary | null>(null);

  function reset() {
    setOpen(false);
    setUrl("");
    setToken("");
    setFilter("");
    setError(undefined);
    setSummary(null);
  }

  async function fetchSpec() {
    setLoading(true);
    setError(undefined);
    try {
      const s = await api.introspectOpenApi(url.trim(), token);
      setSummary(s);
      if (s.operations.length === 0) {
        setError("No operations found in that spec.");
      }
    } catch (e) {
      setSummary(null);
      setError(e instanceof Error ? e.message : "Couldn't load that spec.");
    } finally {
      setLoading(false);
    }
  }

  function pick(op: ApiOperation) {
    if (!summary) return;
    onApply(toConfig(summary, op));
    reset();
  }

  const ops = summary?.operations ?? [];
  const q = filter.trim().toLowerCase();
  const shown = q
    ? ops.filter((o) =>
        `${o.method} ${o.path} ${o.summary ?? ""}`.toLowerCase().includes(q),
      )
    : ops;

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
          ↧ Import from OpenAPI spec
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
          {!summary ? (
            <>
              <input
                autoFocus
                aria-label="OpenAPI/Swagger spec URL"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://api.example.com/openapi.json"
                style={fieldStyle}
              />
              <input
                type="password"
                aria-label="Token for a private spec (optional)"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Bearer token — only if the spec is private (optional)"
                style={{ ...fieldStyle, marginTop: 6 }}
              />
              {error && <div style={errStyle}>{error}</div>}
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <button
                  type="button"
                  disabled={!url.trim() || loading}
                  onClick={fetchSpec}
                  style={primaryBtn(!!url.trim() && !loading)}
                >
                  {loading ? "Loading…" : "Fetch spec"}
                </button>
                <button type="button" onClick={reset} style={ghostBtn}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <div
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--ink-3)",
                  marginBottom: 6,
                }}
              >
                {summary.title ? `${summary.title} — ` : ""}
                {ops.length} operation{ops.length === 1 ? "" : "s"}
                {summary.baseUrl ? ` · ${summary.baseUrl}` : ""}
              </div>
              <input
                autoFocus
                aria-label="Filter operations"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter operations…"
                style={fieldStyle}
              />
              <ul
                style={{
                  listStyle: "none",
                  margin: "6px 0 0",
                  padding: 0,
                  maxHeight: 220,
                  overflowY: "auto",
                }}
              >
                {shown.map((op) => (
                  <li key={`${op.method} ${op.path}`}>
                    <button
                      type="button"
                      onClick={() => pick(op)}
                      style={opRowStyle}
                    >
                      <span style={methodBadge}>{op.method}</span>
                      <span
                        style={{ fontFamily: "var(--font-mono, monospace)" }}
                      >
                        {op.path}
                      </span>
                      {op.summary && (
                        <span style={{ color: "var(--ink-3)", marginLeft: 6 }}>
                          {op.summary}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
                {shown.length === 0 && (
                  <li
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--ink-3)",
                    }}
                  >
                    No matching operations.
                  </li>
                )}
              </ul>
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <button
                  type="button"
                  onClick={() => {
                    setSummary(null);
                    setFilter("");
                  }}
                  style={ghostBtn}
                >
                  ← Back
                </button>
                <button type="button" onClick={reset} style={ghostBtn}>
                  Cancel
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
const errStyle: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--state-error)",
  marginTop: 4,
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
  minWidth: 44,
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

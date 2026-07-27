// MCP registry browser (#578) — find a public MCP server and pre-fill a connection with it.
//
// SECURITY POSTURE: every row is UNTRUSTED third-party content. The api sanitizes it (https-only
// credential-free transport URLs, plain-text descriptions, http/https links only), and this
// component keeps that promise on the render side: descriptions/names/tags go through React as TEXT
// (never dangerouslySetInnerHTML), and the only href rendered is the already-scheme-checked
// `homepage`, opened with rel="noopener noreferrer". The `trust` badge tells the user which rows are
// vetted by us and which are community-authored.
import { useCallback, useEffect, useState } from "react";
import { Button } from "../../../components";
import { api, type McpRegistryServerRow } from "../../../lib/api";
import { fieldLabel, fieldStyle, introStyle } from "./shared";
// PURE mapping, in its own module so it is unit-testable in the node-environment web suite.
export { prefillFor, type McpConnectPrefill } from "./mcp-registry-prefill";

const TRUST_STYLE: Record<
  McpRegistryServerRow["trust"],
  { label: string; color: string; border: string }
> = {
  curated: {
    label: "Vetted",
    color: "var(--brand)",
    border: "var(--brand)",
  },
  community: {
    label: "Community",
    color: "var(--ink-3)",
    border: "var(--line-mid)",
  },
};

const chipStyle: React.CSSProperties = {
  fontSize: 10,
  border: "1px solid var(--line-mid)",
  background: "var(--card-2)",
  borderRadius: "var(--radius-xs)",
  padding: "2px 7px",
  color: "var(--ink-faint)",
};

export function McpRegistryBrowser({
  onPick,
}: {
  onPick: (server: McpRegistryServerRow) => void;
}) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<McpRegistryServerRow[]>([]);
  const [source, setSource] = useState<"registry" | "curated" | null>(null);
  const [degradedReason, setDegradedReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (query: string) => {
    setLoading(true);
    try {
      const page = await api.listMcpRegistry(query, 60);
      setRows(page.servers);
      setSource(page.source);
      setDegradedReason(page.degradedReason ?? null);
      setError(null);
    } catch {
      // The endpoint degrades to the curated list server-side, so reaching here means the control
      // plane itself is unreachable (or the session expired) — say that, don't blame the registry.
      setError("Could not reach the control plane to list MCP servers.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounced search: the api caches the upstream list, but there's no reason to fire a request
  // per keystroke.
  useEffect(() => {
    const t = setTimeout(() => void load(q), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, load]);

  return (
    <>
      <div style={{ ...introStyle, marginBottom: 10 }}>
        Search public MCP servers and pre-fill a connection — you only supply
        the credential. Community entries are published by third parties; review
        one before connecting it.
      </div>
      <div style={{ marginBottom: 10 }}>
        <span style={fieldLabel}>Search</span>
        <input
          style={fieldStyle}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="github, jira, docs, payments…"
        />
      </div>

      {source === "curated" && !error && (
        <div
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--ink-3)",
            marginBottom: 10,
            lineHeight: "var(--leading-snug)",
          }}
        >
          Showing the vetted built-in list
          {degradedReason ? ` — ${degradedReason}.` : "."}
        </div>
      )}
      {error && (
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--state-error)",
            marginBottom: 10,
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          maxHeight: 380,
          overflowY: "auto",
        }}
      >
        {loading && rows.length === 0 && (
          <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
            Loading servers…
          </div>
        )}
        {!loading && rows.length === 0 && !error && (
          <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
            No MCP servers matched “{q}”.
          </div>
        )}
        {rows.map((s) => {
          const trust = TRUST_STYLE[s.trust];
          return (
            <div
              key={s.id}
              style={{
                border: "1px solid var(--line-mid)",
                borderRadius: "var(--radius-md)",
                background: "var(--card-2)",
                padding: "10px 12px",
                display: "flex",
                gap: 12,
                alignItems: "flex-start",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    style={{
                      fontSize: "var(--text-sm)",
                      fontWeight: "var(--weight-semibold)",
                      color: "var(--ink)",
                    }}
                  >
                    {s.name}
                  </span>
                  <span
                    style={{
                      ...chipStyle,
                      color: trust.color,
                      borderColor: trust.border,
                    }}
                  >
                    {trust.label}
                  </span>
                  <span style={chipStyle}>
                    {s.requiresAuth ? `auth: ${s.authMode}` : "no auth needed"}
                  </span>
                </div>
                {/* TEXT, never HTML — a community description is attacker-authorable. */}
                <div
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--ink-2)",
                    marginTop: 3,
                    lineHeight: "var(--leading-snug)",
                  }}
                >
                  {s.description}
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: 10,
                    color: "var(--ink-faint)",
                    marginTop: 4,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.transportUrl}
                </div>
                {(s.tags.length > 0 || s.homepage) && (
                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      flexWrap: "wrap",
                      marginTop: 6,
                      alignItems: "center",
                    }}
                  >
                    {s.tags.map((t) => (
                      <span key={t} style={chipStyle}>
                        {t}
                      </span>
                    ))}
                    {s.homepage && (
                      // The only href we render from registry data; the api already restricted it
                      // to http/https. noopener/noreferrer so a hostile page can't touch this one.
                      <a
                        href={s.homepage}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          fontSize: 10,
                          color: "var(--brand)",
                        }}
                      >
                        Learn more
                      </a>
                    )}
                  </div>
                )}
              </div>
              <Button variant="secondary" size="sm" onClick={() => onPick(s)}>
                Use
              </Button>
            </div>
          );
        })}
      </div>
    </>
  );
}

// MCP access section (endpoint URL + API token mint/list/revoke) for the Integrations screen.
import { useCallback, useEffect, useState } from "react";
import { Button } from "../../../components";
import { api, type ApiTokenRow, type MintedToken } from "../../../lib/api";
import { monoLabel, UrlCopy } from "./shared";

const mcpUrl = (): string => `${window.location.origin}/api/mcp`;

/**
 * MCP access: the endpoint URL an external agent (Claude Desktop, Cursor, an SDK agent) connects
 * to, plus mint/list/revoke of the `nry_` API tokens that authenticate it. A minted token's
 * plaintext is shown ONCE (the server only stores its hash).
 */
export function McpAccess() {
  const [tokens, setTokens] = useState<ApiTokenRow[] | null>(null);
  const [minted, setMinted] = useState<MintedToken | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTokens(await api.listApiTokens());
    } catch {
      setTokens([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function mint() {
    setBusy(true);
    setErr(null);
    try {
      const t = await api.mintApiToken(label.trim() || undefined);
      setMinted(t);
      setLabel("");
      await load();
    } catch (e) {
      setErr(
        e instanceof Error
          ? e.message
          : "Could not create the token (owner/admin only).",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ ...monoLabel, marginBottom: 12 }}>MCP access</div>
      <div
        style={{
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-card)",
          padding: 16,
        }}
      >
        <div
          style={{
            fontSize: "var(--text-body)",
            lineHeight: "var(--leading-snug)",
            color: "var(--ink-2)",
            marginBottom: 12,
          }}
        >
          Point an MCP client (Claude Desktop, Cursor, an SDK agent) at this
          endpoint with a token below to build &amp; run your workflows as
          tools.
        </div>

        {/* endpoint URL */}
        <div style={{ ...monoLabel, marginBottom: 6 }}>Endpoint</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <span
            className="mono"
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: "var(--text-sm)",
              color: "var(--ink)",
              background: "var(--card-2)",
              border: "1px solid var(--line-2)",
              borderRadius: "var(--radius-sm)",
              padding: "7px 9px",
              wordBreak: "break-all",
            }}
          >
            {mcpUrl()}
          </span>
          <UrlCopy url={mcpUrl()} />
        </div>

        {/* just-minted token (shown once) */}
        {minted && (
          <div
            style={{
              marginBottom: 16,
              padding: 12,
              borderRadius: "var(--radius-md)",
              background: "var(--brand-soft)",
              border:
                "1px solid color-mix(in srgb, var(--brand) 45%, transparent)",
            }}
          >
            <div
              style={{
                fontSize: "var(--text-sm)",
                fontWeight: "var(--weight-semibold)",
                color: "var(--brand)",
                marginBottom: 8,
              }}
            >
              Copy this token now — it won't be shown again.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <span
                className="mono"
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: "var(--text-sm)",
                  color: "var(--ink)",
                  background: "var(--card)",
                  border: "1px solid var(--line-2)",
                  borderRadius: "var(--radius-sm)",
                  padding: "7px 9px",
                  wordBreak: "break-all",
                }}
              >
                {minted.token}
              </span>
              <UrlCopy url={minted.token} />
            </div>
          </div>
        )}

        {/* create */}
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Token label (e.g. claude-desktop)"
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) void mint();
            }}
            style={{
              flex: 1,
              padding: "7px 9px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--line-2)",
              background: "var(--card)",
              color: "var(--ink)",
              fontSize: "var(--text-body)",
            }}
          />
          <Button variant="primary" icon="plus" disabled={busy} onClick={mint}>
            {busy ? "Creating…" : "Create token"}
          </Button>
        </div>
        {err && (
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--state-error)",
              marginBottom: 12,
            }}
          >
            {err}
          </div>
        )}

        {/* list */}
        {tokens && tokens.length > 0 && (
          <div style={{ borderTop: "1px solid var(--line)", paddingTop: 4 }}>
            {tokens.map((t) => (
              <div
                key={t.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 0",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: "var(--text-body)",
                      fontWeight: "var(--weight-semibold)",
                      color: "var(--ink)",
                    }}
                  >
                    {t.label}
                  </div>
                  <div
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--ink-3)",
                      marginTop: 2,
                    }}
                  >
                    created {new Date(t.createdAt).toLocaleDateString()} ·{" "}
                    {t.lastUsedAt
                      ? `last used ${new Date(t.lastUsedAt).toLocaleDateString()}`
                      : "never used"}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={() => {
                    if (
                      !window.confirm(
                        `Revoke "${t.label}"? Clients using it stop working.`,
                      )
                    )
                      return;
                    void api
                      .revokeApiToken(t.id)
                      .then(() => load())
                      .catch(() => setErr("Could not revoke the token."));
                  }}
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

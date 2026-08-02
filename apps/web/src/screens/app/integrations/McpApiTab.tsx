// MCP & API tab — the MCP server surface (endpoint + exposed tools) and API tokens.
import { useCallback, useEffect, useState } from "react";
import { Button, Dialog, StatusPill, useConfirm } from "../../../components";
import {
  api,
  type ApiTokenRow,
  type GraphSummary,
  type MintedToken,
} from "../../../lib/api";
import { cardShell, EnvChip, IconTile, UrlCopy } from "./shared";

const mcpUrl = (): string => `${window.location.origin}/api/mcp`;

/** The server's always-registered base tools (mirrors apps/api/src/mcp/mcp.server.ts). */
const BASE_TOOLS = [
  "list_node_types",
  "list_workflows",
  "create_workflow",
  "run_workflow",
  "get_run",
  "approve",
];

/** How the server names a workflow's own tool (mirrors toolNamesFor's slugify). */
const workflowTool = (key: string): string =>
  `run_${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;

/** How many workflow tools to list before collapsing into "+N more". */
const TOOL_DISPLAY_CAP = 6;

function ToolRow({ name, dim }: { name: string; dim?: boolean }) {
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 12 }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "var(--radius-full)",
          background: dim ? "var(--ink-faint)" : "var(--state-done)",
          flex: "none",
        }}
      />
      <span
        className="mono"
        style={{
          color: dim ? "var(--ink-3)" : "var(--ink-soft)",
          fontSize: "var(--text-xs)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {name}
      </span>
    </div>
  );
}

export function McpApiTab({
  env,
  phone,
}: {
  env: string | null;
  phone: boolean;
}) {
  const confirm = useConfirm();
  const [workflows, setWorkflows] = useState<GraphSummary[] | null>(null);
  const [tokens, setTokens] = useState<ApiTokenRow[] | null>(null);
  const [minted, setMinted] = useState<MintedToken | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [toks, graphs] = await Promise.all([
      api.listApiTokens().catch(() => []),
      api.listGraphs().catch(() => []),
    ]);
    setTokens(toks);
    setWorkflows(graphs);
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

  async function revoke(t: ApiTokenRow) {
    const ok = await confirm({
      title: `Revoke "${t.label}"?`,
      body: "Any client still using this token stops working immediately.",
      confirmLabel: "Revoke token",
      danger: true,
    });
    if (!ok) return;
    void api
      .revokeApiToken(t.id)
      .then(() => load())
      .catch(() => setErr("Could not revoke the token."));
  }

  const wfTools = (workflows ?? []).map((w) => workflowTool(w.workflowKey));
  const shown = wfTools.slice(0, TOOL_DISPLAY_CAP);
  const extra = wfTools.length - shown.length;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: phone ? "1fr" : "1fr 1fr",
        gap: 16,
        alignItems: "start",
      }}
    >
      {/* ---- MCP server ---- */}
      <div style={{ ...cardShell, padding: "20px 22px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 11,
            marginBottom: 6,
          }}
        >
          <IconTile name="mcp" color="var(--node-agent)" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: "var(--text-md)",
                fontWeight: "var(--weight-bold)",
                color: "var(--ink)",
              }}
            >
              MCP server mode
            </div>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
              Expose workflows as MCP tools
            </div>
          </div>
          {/* No on/off config exists server-side — the endpoint is always
              served and gated purely by API-token auth, so no toggle here. */}
          <StatusPill state="done" label="Always on" />
        </div>
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--ink-2)",
            lineHeight: "var(--leading-snug)",
            margin: "10px 0 14px",
          }}
        >
          Point an MCP client (Claude Desktop, Cursor, an SDK agent) at this
          endpoint with an API token. The base tools are always available. A
          workflow in <EnvChip slug={env} /> also gets its own{" "}
          <code>run_*</code> tool when it OPTS IN — its start node must be an{" "}
          <b>MCP Server Trigger</b>. Add or remove that node and reconnect the
          client to pick the change up.
        </div>
        <div
          className="mono"
          style={{
            border: "1px solid var(--line-mid)",
            background: "var(--card-2)",
            borderRadius: "var(--radius-md)",
            padding: "10px 12px",
            fontSize: "var(--text-xs)",
            color: "var(--ink-2)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ color: "var(--ink-3)", flex: "none" }}>endpoint</span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--ink)",
            }}
          >
            {mcpUrl()}
          </span>
          <UrlCopy url={mcpUrl()} />
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 7,
            marginTop: 14,
          }}
        >
          {workflows === null ? (
            <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
              Loading tools…
            </div>
          ) : (
            <>
              {shown.map((t) => (
                <ToolRow key={t} name={t} />
              ))}
              {extra > 0 && (
                <div
                  style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
                >
                  +{extra} more workflow tool{extra === 1 ? "" : "s"}
                </div>
              )}
              {wfTools.length === 0 && (
                <div
                  style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
                >
                  No saved workflows in this environment yet — each saved
                  workflow becomes a callable tool.
                </div>
              )}
              {BASE_TOOLS.map((t) => (
                <ToolRow key={t} name={t} dim />
              ))}
            </>
          )}
        </div>
      </div>

      {/* ---- API tokens ---- */}
      <div style={{ ...cardShell, padding: "20px 22px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 11,
            marginBottom: 6,
          }}
        >
          <IconTile name="key" color="var(--node-mcp)" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: "var(--text-md)",
                fontWeight: "var(--weight-bold)",
                color: "var(--ink)",
              }}
            >
              API tokens
            </div>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
              REST · CLI · MCP auth
            </div>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => {
              setMinted(null);
              setErr(null);
              setDialogOpen(true);
            }}
          >
            New token
          </button>
        </div>
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--ink-2)",
            lineHeight: "var(--leading-snug)",
            margin: "10px 0 6px",
          }}
        >
          <code>nry_</code> bearer tokens for the MCP server, the public API and
          CI. Workspace-wide (not env-bound); the plaintext is shown once at
          mint — only its hash is stored.
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {tokens === null && (
            <div
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--ink-3)",
                padding: "10px 0",
              }}
            >
              Loading tokens…
            </div>
          )}
          {tokens?.length === 0 && (
            <div
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--ink-3)",
                padding: "10px 0",
              }}
            >
              No tokens yet — mint one to connect an MCP client or the CLI.
            </div>
          )}
          {(tokens ?? []).map((t) => (
            <div
              key={t.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 11,
                padding: "10px 0",
                borderBottom: "1px solid var(--line)",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: "var(--text-sm)",
                    fontWeight: "var(--weight-semibold)",
                    color: "var(--ink)",
                  }}
                >
                  {t.label}
                  {/* RBAC: the token is a grant subject — under group enforcement
                      it gets exactly its groups' grants. */}
                  {t.groupCount > 0 && (
                    <span
                      className="tag"
                      title={`This token belongs to ${t.groupCount} permission group${
                        t.groupCount === 1 ? "" : "s"
                      } — under group enforcement it only gets what those groups grant (see the Groups screen).`}
                    >
                      Restricted · {t.groupCount} group
                      {t.groupCount === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: "var(--text-2xs)",
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
                onClick={() => revoke(t)}
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
        {err && !dialogOpen && (
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--state-error)",
              marginTop: 10,
            }}
          >
            {err}
          </div>
        )}
      </div>

      {/* ---- Mint dialog (label → plaintext shown ONCE) ---- */}
      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="New API token"
        footer={
          minted ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => setDialogOpen(false)}
            >
              Done
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() => void mint()}
              >
                {busy ? "Creating…" : "Create token"}
              </Button>
            </>
          )
        }
      >
        {minted ? (
          // Form → one-time-token reveal fades in rather than snapping.
          <div style={{ animation: "naaryFadeUp .2s ease" }}>
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
                  background: "var(--card-2)",
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
        ) : (
          <div>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Token label (e.g. claude-desktop)"
              disabled={busy}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) void mint();
              }}
              style={{
                width: "100%",
                padding: "8px 10px",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--line-2)",
                background: "var(--card)",
                color: "var(--ink)",
                fontSize: "var(--text-body)",
              }}
            />
            <div
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--ink-3)",
                marginTop: 8,
              }}
            >
              Owner/admin only. The plaintext is shown once after minting.
            </div>
            {err && (
              <div
                style={{
                  fontSize: "var(--text-sm)",
                  color: "var(--state-error)",
                  marginTop: 8,
                }}
              >
                {err}
              </div>
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
}

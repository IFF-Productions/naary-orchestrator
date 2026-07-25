// Apps & agents tab — GitHub App installs, MCP/OAuth app connections, and the coding agent.
import { useState } from "react";
import { Button, Dialog, StatusPill } from "../../../components";
import {
  api,
  type ConnectionRow,
  type McpRegistryServerRow,
  type ProviderCredential,
} from "../../../lib/api";
import { APP_CONNECTION_TYPES } from "../../../lib/connection-types";
import { PHONE_QUERY, useMediaQuery } from "../../../lib/useMediaQuery";
import { CodeAgentCard } from "./CodeAgentCard";
import { CodeAgentCredentialCard } from "./CodeAgentCredentialCard";
import {
  ConnectForm,
  GithubAppForm,
  type ConnectFormPrefill,
} from "./connection-forms";
import { McpRegistryBrowser, prefillFor } from "./McpRegistryBrowser";
import { cardShell, EnvChip, IconTile, introStyle } from "./shared";

/** Connection types that are apps/servers (the rest live on the Providers tab). Defined in
 *  lib/connection-types.ts so pure modules can route a "connect this" CTA at the right tab;
 *  re-exported here because every existing import points at this screen. */
export { APP_CONNECTION_TYPES };

const TYPE_COLOR: Record<string, string> = {
  github: "var(--brand)",
  atlassian: "var(--node-mcp)",
  custom: "var(--node-agent)",
};

const STATUS_LABEL: Record<ConnectionRow["status"], string> = {
  connected: "Connected",
  needs_reauth: "Action needed",
  error: "Error",
};
const STATUS_STATE = {
  connected: "done",
  needs_reauth: "paused",
  error: "error",
} as const;

function describe(c: ConnectionRow): string {
  if (c.authMode === "github_app")
    return "GitHub App install — powers the GitHub trigger + integration nodes. No personal token stored.";
  if (c.authMode === "oauth") return `OAuth connection · ${c.serverUrl}`;
  return `${c.authMode === "connection_string" ? "connection" : c.authMode} · ${c.serverUrl}`;
}

export function AppsTab({
  tenant,
  env,
  connections,
  credentials,
  onChanged,
  onError,
}: {
  tenant: string | null;
  env: string | null;
  connections: ConnectionRow[];
  credentials: ProviderCredential[];
  onChanged: () => Promise<void> | void;
  onError: (msg: string) => void;
}) {
  const phone = useMediaQuery(PHONE_QUERY);
  const [dialog, setDialog] = useState<
    "github" | "mcp" | "mcp-registry" | null
  >(null);
  // Set when a registry row was picked (#578): the same ConnectForm, opened with the transport +
  // auth scheme filled in, so the user only supplies credentials.
  const [prefill, setPrefill] = useState<ConnectFormPrefill | undefined>();
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState<string | null>(null);

  const rows = connections.filter((c) => APP_CONNECTION_TYPES.includes(c.type));

  function disconnect(c: ConnectionRow) {
    if (!tenant || disconnecting) return;
    if (
      !window.confirm(
        `Disconnect "${c.label}"? This removes its stored secret.`,
      )
    ) {
      return;
    }
    setDisconnecting(c.id);
    void api
      .deleteConnection(tenant, c.id)
      .then(() => onChanged())
      .catch(() => onError("Could not disconnect the connection."))
      .finally(() => setDisconnecting(null));
  }

  function reconnect(c: ConnectionRow) {
    if (!tenant || reconnecting) return;
    setReconnecting(c.id);
    void api
      .startOauthConsent(tenant, c.id)
      .then(({ authorizeUrl }) => window.location.assign(authorizeUrl))
      .catch(() => {
        onError("Could not start re-authorization.");
        setReconnecting(null);
      });
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: phone ? "stretch" : "flex-end",
          flexDirection: phone ? "column" : "row",
          flexWrap: "wrap",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div>
          <div
            style={{
              fontSize: "var(--text-md)",
              fontWeight: "var(--weight-bold)",
              color: "var(--ink)",
            }}
          >
            Connected apps &amp; agents
          </div>
          <div style={{ ...introStyle, marginTop: 3 }}>
            App installs, MCP servers and autonomous agents with scoped access —
            connections are bound to the environment they were created in.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button
            variant="secondary"
            onClick={() => {
              setPrefill(undefined);
              setDialog("mcp-registry");
            }}
          >
            Browse MCP servers
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setPrefill(undefined);
              setDialog("mcp");
            }}
          >
            Connect MCP server
          </Button>
          <Button variant="primary" onClick={() => setDialog("github")}>
            Install GitHub App
          </Button>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {rows.length === 0 && (
          <div
            style={{
              ...cardShell,
              padding: "16px 18px",
              fontSize: "var(--text-sm)",
              color: "var(--ink-3)",
            }}
          >
            No apps connected in this environment — install the GitHub App, or
            browse the MCP registry above and connect a server.
          </div>
        )}
        {rows.map((c) => {
          const warn = c.status === "needs_reauth";
          return (
            <div
              key={c.id}
              style={{
                ...cardShell,
                padding: "16px 18px",
                display: "flex",
                flexDirection: phone ? "column" : "row",
                alignItems: phone ? "stretch" : "center",
                gap: 15,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 15,
                  flex: 1,
                  minWidth: 0,
                }}
              >
                <IconTile
                  name={c.authMode === "github_app" ? "workflow" : "mcp"}
                  color={TYPE_COLOR[c.type] ?? "var(--node-agent)"}
                  size={42}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "var(--text-md)",
                        fontWeight: "var(--weight-semibold)",
                        color: "var(--ink)",
                      }}
                    >
                      {c.label}
                    </span>
                    <EnvChip slug={env} />
                    <StatusPill
                      state={STATUS_STATE[c.status]}
                      label={STATUS_LABEL[c.status]}
                    />
                  </div>
                  <div
                    style={{
                      fontSize: "var(--text-sm)",
                      color: "var(--ink-2)",
                      marginTop: 3,
                      lineHeight: "var(--leading-snug)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {describe(c)}
                  </div>
                  {c.scopes.length > 0 && (
                    <div
                      style={{
                        display: "flex",
                        gap: 6,
                        flexWrap: "wrap",
                        marginTop: 9,
                      }}
                    >
                      {c.scopes.map((s) => (
                        <span
                          key={s}
                          className="mono"
                          style={{
                            fontSize: 10,
                            color: "var(--ink-faint)",
                            border: "1px solid var(--line-mid)",
                            background: "var(--card-2)",
                            borderRadius: "var(--radius-xs)",
                            padding: "2px 7px",
                          }}
                        >
                          {s}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {warn && c.authMode === "oauth" && (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={reconnecting !== null}
                    onClick={() => reconnect(c)}
                  >
                    {reconnecting === c.id ? "Redirecting…" : "Re-authorize"}
                  </Button>
                )}
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  disabled={disconnecting === c.id}
                  onClick={() => disconnect(c)}
                >
                  {disconnecting === c.id ? "Disconnecting…" : "Disconnect"}
                </button>
              </div>
            </div>
          );
        })}

        {/* ---- Coding agent (Claude Code, dedicated credential + live test) ---- */}
        <CodeAgentCard
          tenant={tenant}
          hasKey={credentials.some((c) => c.provider === "claude-code")}
          keyValid={credentials.some(
            (c) => c.provider === "claude-code" && c.isValid,
          )}
          onSaved={() => void onChanged()}
        />

        {/* ---- Other coding-agent CLIs (dedicated credential; save-only until the CLI is
               installed on the worker — no live test yet). ---- */}
        <CodeAgentCredentialCard
          tenant={tenant}
          provider="cursor"
          label="Cursor"
          badge="◆"
          placeholder="CURSOR_API_KEY"
          hint={
            <>
              The Code Agent node — runs the <code>cursor-agent</code> CLI. Uses
              a dedicated Cursor API key.
            </>
          }
          hasKey={credentials.some((c) => c.provider === "cursor")}
          keyValid={credentials.some(
            (c) => c.provider === "cursor" && c.isValid,
          )}
          onSaved={() => void onChanged()}
        />
        <CodeAgentCredentialCard
          tenant={tenant}
          provider="copilot"
          label="GitHub Copilot"
          badge="⌥"
          placeholder="github_pat_… or an OAuth token (not a classic ghp_ PAT)"
          hint={
            <>
              The Code Agent node — runs the <code>copilot</code> CLI. Uses a
              dedicated GitHub token (fine-grained PAT / OAuth).
            </>
          }
          hasKey={credentials.some((c) => c.provider === "copilot")}
          keyValid={credentials.some(
            (c) => c.provider === "copilot" && c.isValid,
          )}
          onSaved={() => void onChanged()}
        />
      </div>

      {/* ---- Connect dialogs (the existing flows, unchanged) ---- */}
      {tenant && (
        <Dialog
          open={dialog !== null}
          onClose={() => setDialog(null)}
          title={
            dialog === "github"
              ? "Install GitHub App"
              : dialog === "mcp-registry"
                ? "Browse MCP servers"
                : "Connect MCP server"
          }
        >
          {dialog === "github" && <GithubAppForm tenant={tenant} />}
          {dialog === "mcp-registry" && (
            <McpRegistryBrowser
              onPick={(server: McpRegistryServerRow) => {
                // Hand the sanitized transport + auth scheme to the SAME connect form the manual
                // path uses — one create path, one validation path.
                setPrefill(prefillFor(server));
                setDialog("mcp");
              }}
            />
          )}
          {dialog === "mcp" && (
            <ConnectForm
              // Remount on a prefill change so the form's initial state is re-read.
              key={prefill?.serverUrl ?? "manual"}
              tenant={tenant}
              onChanged={onChanged}
              prefill={prefill}
            />
          )}
        </Dialog>
      )}
    </div>
  );
}

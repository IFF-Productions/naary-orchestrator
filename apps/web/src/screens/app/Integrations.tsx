import { useCallback, useEffect, useState } from "react";
import { Button, Icon, StatusPill, type RunState } from "../../components";
import {
  api,
  type ApiTokenRow,
  type ConnectionRow,
  type MintedToken,
  type ProviderCredential,
  type RegisteredWebhook,
  type WebhookRow,
  UnauthorizedError,
} from "../../lib/api";

/** Model providers — defined locally; the DC hard-codes these three + an "add" tile.
 *  `supported` gates BYOK: only providers the backend can validate + run today
 *  accept a key. The rest render as "Coming soon" so the UI never promises a
 *  connection the agent activity can't honor. */
const providers: {
  key: string; // the backend provider id (BYOK credential slot)
  initial: string;
  name: string;
  models: string;
  color: string;
  supported: boolean;
}[] = [
  {
    key: "anthropic",
    initial: "A",
    name: "Anthropic",
    models: "Claude Opus, Sonnet, Haiku",
    color: "var(--node-agent)",
    supported: true,
  },
  {
    key: "openai",
    initial: "O",
    name: "OpenAI",
    models: "GPT-4o, GPT-4o mini, GPT-4.1",
    color: "var(--state-done)",
    supported: true,
  },
  {
    key: "google",
    initial: "G",
    name: "Google",
    models: "Gemini 2.5 Pro / Flash",
    color: "var(--node-trigger)",
    supported: true,
  },
];

/** Map a connection's status to a StatusPill run-state token. */
function connectionState(status: ConnectionRow["status"]): RunState {
  switch (status) {
    case "connected":
      return "done";
    case "needs_reauth":
      return "info";
    case "error":
      return "error";
  }
}

const CONNECTION_LABEL: Record<ConnectionRow["status"], string> = {
  connected: "Connected",
  needs_reauth: "Reauth",
  error: "Error",
};

const monoLabel: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.1em",
  color: "var(--ink-3)",
  textTransform: "uppercase",
};

/** The full, invokable webhook URL. The /hooks/:id ingress is reached through the same /api
 *  proxy the app uses (nginx rewrites /api/hooks/… → /hooks/…), so this URL is callable as-is. */
const webhookUrl = (id: string): string =>
  `${window.location.origin}/api/hooks/${id}`;

/** Small copy-to-clipboard button with brief "Copied ✓" feedback. */
function UrlCopy({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy URL"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable — the URL is still visible to copy manually */
        }
      }}
      style={{
        flex: "none",
        height: 26,
        padding: "0 10px",
        borderRadius: 6,
        border: "1px solid var(--line-2)",
        background: "var(--surface)",
        color: "var(--ink-2)",
        fontSize: 11,
        fontWeight: 600,
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      {copied ? "Copied ✓" : "Copy"}
    </button>
  );
}

const mcpUrl = (): string => `${window.location.origin}/api/mcp`;

/**
 * MCP access: the endpoint URL an external agent (Claude Desktop, Cursor, an SDK agent) connects
 * to, plus mint/list/revoke of the `nry_` API tokens that authenticate it. A minted token's
 * plaintext is shown ONCE (the server only stores its hash).
 */
function McpAccess() {
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
    <div style={{ marginBottom: 26 }}>
      <div style={{ ...monoLabel, marginBottom: 11 }}>MCP access</div>
      <div
        style={{
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: 12,
          boxShadow: "var(--shadow-card)",
          padding: 16,
        }}
      >
        <div
          style={{ fontSize: 12.5, color: "var(--ink-2)", marginBottom: 10 }}
        >
          Point an MCP client (Claude Desktop, Cursor, an SDK agent) at this
          endpoint with a token below to build &amp; run your workflows as
          tools.
        </div>

        {/* endpoint URL */}
        <div style={{ fontSize: 11, ...monoLabel, marginBottom: 5 }}>
          Endpoint
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
          <span
            className="mono"
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12,
              color: "var(--ink)",
              background: "var(--card-2)",
              border: "1px solid var(--line-2)",
              borderRadius: 6,
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
              borderRadius: 8,
              background: "var(--brand-soft)",
              border:
                "1px solid color-mix(in srgb, var(--brand) 45%, transparent)",
            }}
          >
            <div
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                color: "var(--brand)",
                marginBottom: 6,
              }}
            >
              Copy this token now — it won't be shown again.
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <span
                className="mono"
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 12,
                  color: "var(--ink)",
                  background: "var(--card)",
                  border: "1px solid var(--line-2)",
                  borderRadius: 6,
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
              borderRadius: 7,
              border: "1px solid var(--line-2)",
              background: "var(--card)",
              color: "var(--ink)",
              fontSize: 13,
            }}
          />
          <Button variant="primary" icon="plus" disabled={busy} onClick={mint}>
            {busy ? "Creating…" : "Create token"}
          </Button>
        </div>
        {err && (
          <div
            style={{
              fontSize: 12,
              color: "var(--state-error)",
              marginBottom: 10,
            }}
          >
            {err}
          </div>
        )}

        {/* list */}
        {tokens && tokens.length > 0 && (
          <div style={{ borderTop: "1px solid var(--line)", paddingTop: 6 }}>
            {tokens.map((t) => (
              <div
                key={t.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "9px 0",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 12.5,
                      fontWeight: 600,
                      color: "var(--ink)",
                    }}
                  >
                    {t.label}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
                    created {new Date(t.createdAt).toLocaleDateString()} ·{" "}
                    {t.lastUsedAt
                      ? `last used ${new Date(t.lastUsedAt).toLocaleDateString()}`
                      : "never used"}
                  </div>
                </div>
                <button
                  type="button"
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
                  style={{
                    height: 28,
                    padding: "0 12px",
                    borderRadius: 6,
                    border: "1px solid var(--line-2)",
                    background: "var(--surface)",
                    color: "var(--ink-2)",
                    fontSize: 11.5,
                    cursor: "pointer",
                    fontFamily: "inherit",
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

export function Integrations() {
  const [tenant, setTenant] = useState<string | null>(null);
  const [connections, setConnections] = useState<ConnectionRow[] | null>(null);
  const [webhooks, setWebhooks] = useState<WebhookRow[] | null>(null);
  const [credentials, setCredentials] = useState<ProviderCredential[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [deletingHook, setDeletingHook] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { tenantId } = await api.getMe();
      setTenant(tenantId);
      const [conns, hooks, creds] = await Promise.all([
        api.listConnections(tenantId),
        api.listWebhooks(tenantId),
        api.listCredentials(tenantId).catch(() => []),
      ]);
      setConnections(conns);
      setWebhooks(hooks);
      setCredentials(creds);
      setError(null);
    } catch (e) {
      setError(
        e instanceof UnauthorizedError
          ? "Sign in to view integrations"
          : "Could not reach the control plane (apps/api on :3000).",
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loading = connections === null && webhooks === null && !error;

  return (
    <div style={{ padding: "22px 28px 40px", maxWidth: 1100 }}>
      {/* heading */}
      <div style={{ marginBottom: 20 }}>
        <div
          style={{
            fontSize: 21,
            fontWeight: 700,
            color: "var(--ink)",
            letterSpacing: "-0.01em",
          }}
        >
          Integrations
        </div>
        <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 2 }}>
          MCP servers, model providers and connected apps.
        </div>
      </div>

      {error && (
        <div
          style={{
            marginBottom: 18,
            padding: "9px 12px",
            borderRadius: 8,
            background: "var(--error-soft)",
            border:
              "1px solid color-mix(in srgb, var(--state-error) 40%, transparent)",
            color: "var(--state-error)",
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}

      {/* ===== MCP access (endpoint + API tokens) ===== */}
      <McpAccess />

      {/* ===== Add integration (collapsed create forms) ===== */}
      <div id="add-integrations" style={{ marginBottom: 26 }}>
        <div style={{ ...monoLabel, marginBottom: 11 }}>Add integration</div>
        {tenant && <AddIntegrations tenant={tenant} onChanged={load} />}
      </div>

      {/* ===== Model providers ===== */}
      <div style={{ ...monoLabel, marginBottom: 11 }}>Model providers</div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
          gap: 12,
          marginBottom: 26,
        }}
      >
        {providers.map((p) => (
          <ProviderCard
            key={p.key}
            p={p}
            tenant={tenant}
            connected={credentials.some(
              (c) => c.provider === p.key && c.isValid,
            )}
            onSaved={load}
          />
        ))}
      </div>

      {/* ===== MCP servers (connections) ===== */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 11,
        }}
      >
        <span style={monoLabel}>
          Connections (MCP · database · SMTP · signing)
        </span>
        <button
          type="button"
          onClick={() =>
            document
              .getElementById("add-integrations")
              ?.scrollIntoView({ behavior: "smooth", block: "start" })
          }
          style={{
            height: 30,
            padding: "0 12px",
            borderRadius: 7,
            border:
              "1px solid color-mix(in srgb, var(--brand) 50%, transparent)",
            background: "var(--brand-soft)",
            color: "var(--brand)",
            fontSize: 11.5,
            fontWeight: 600,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontFamily: "inherit",
          }}
        >
          <Icon name="plus" size={13} strokeWidth={2} />
          Connect server
        </button>
      </div>

      <div
        style={{
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: 12,
          boxShadow: "var(--shadow-card)",
          overflow: "hidden",
          marginBottom: 26,
        }}
      >
        {loading && (
          <div style={{ padding: 18, fontSize: 12.5, color: "var(--ink-3)" }}>
            Loading…
          </div>
        )}
        {!loading && connections?.length === 0 && (
          <div style={{ padding: 18, fontSize: 12.5, color: "var(--ink-2)" }}>
            No connections yet — add one from "Add integration" above.
          </div>
        )}
        {(connections ?? []).map((c, i) => (
          <div
            key={c.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 13,
              padding: "13px 18px",
              borderBottom:
                i < (connections?.length ?? 0) - 1
                  ? "1px solid var(--line)"
                  : undefined,
            }}
          >
            <span
              style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                background:
                  "color-mix(in srgb, var(--node-mcp) 15%, transparent)",
                color: "var(--node-mcp)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flex: "none",
              }}
            >
              <Icon name="plug" size={17} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                className="mono"
                style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink)" }}
              >
                {c.label}
              </div>
              <div
                style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 1 }}
              >
                {c.type} · {c.serverUrl}
              </div>
            </div>
            <StatusPill
              state={connectionState(c.status)}
              label={CONNECTION_LABEL[c.status]}
            />
            <button
              type="button"
              disabled={disconnecting === c.id}
              onClick={() => {
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
                  .then(() => load())
                  .catch(() => setError("Could not disconnect the connection."))
                  .finally(() => setDisconnecting(null));
              }}
              style={{
                height: 28,
                padding: "0 12px",
                borderRadius: 6,
                border: "1px solid var(--line-2)",
                background: "var(--surface)",
                color: "var(--ink-2)",
                fontSize: 11.5,
                cursor: disconnecting === c.id ? "default" : "pointer",
                opacity: disconnecting === c.id ? 0.6 : 1,
                fontFamily: "inherit",
              }}
            >
              {disconnecting === c.id ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
        ))}
      </div>

      {/* ===== Webhook endpoints ===== */}
      <div style={{ ...monoLabel, marginBottom: 11 }}>Webhook endpoints</div>
      <div
        style={{
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: 12,
          boxShadow: "var(--shadow-card)",
          overflow: "hidden",
        }}
      >
        {loading && (
          <div style={{ padding: 18, fontSize: 12.5, color: "var(--ink-3)" }}>
            Loading…
          </div>
        )}
        {!loading && webhooks?.length === 0 && (
          <div style={{ padding: 18, fontSize: 12.5, color: "var(--ink-2)" }}>
            No webhook endpoints yet — register one to trigger a workflow.
          </div>
        )}
        {(webhooks ?? []).map((w, i) => (
          <div
            key={w.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 13,
              padding: "13px 18px",
              borderBottom:
                i < (webhooks?.length ?? 0) - 1
                  ? "1px solid var(--line)"
                  : undefined,
            }}
          >
            <span
              style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                background:
                  "color-mix(in srgb, var(--node-trigger) 15%, transparent)",
                color: "var(--node-trigger)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flex: "none",
              }}
            >
              <Icon name="bolt" size={17} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                className="mono"
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--ink)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                title={webhookUrl(w.id)}
              >
                {webhookUrl(w.id)}
              </div>
              <div
                style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 1 }}
              >
                POST · {w.provider} · {w.workflowId}
              </div>
            </div>
            <UrlCopy url={webhookUrl(w.id)} />
            <StatusPill state="done" label="Active" />
            <button
              type="button"
              disabled={deletingHook === w.id}
              title="Delete endpoint"
              onClick={() => {
                if (!tenant || deletingHook) return;
                if (
                  !window.confirm(
                    "Delete this webhook endpoint? Calls to its URL will stop working.",
                  )
                ) {
                  return;
                }
                setDeletingHook(w.id);
                void api
                  .deleteWebhook(tenant, w.id)
                  .then(() => load())
                  .catch(() => setError("Could not delete the webhook."))
                  .finally(() => setDeletingHook(null));
              }}
              style={{
                height: 28,
                padding: "0 12px",
                borderRadius: 6,
                border: "1px solid var(--line-2)",
                background: "var(--surface)",
                color: "var(--ink-2)",
                fontSize: 11.5,
                cursor: deletingHook === w.id ? "default" : "pointer",
                opacity: deletingHook === w.id ? 0.6 : 1,
                fontFamily: "inherit",
              }}
            >
              {deletingHook === w.id ? "Deleting…" : "Delete"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ===== Real create actions: connect a server + register a webhook ===== */

const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: "7px 9px",
  borderRadius: 7,
  border: "1px solid var(--line-2)",
  background: "var(--card)",
  color: "var(--ink)",
  fontSize: 13,
};
const fieldLabel: React.CSSProperties = {
  fontSize: 11,
  color: "var(--ink-2)",
  display: "block",
  marginBottom: 4,
};

/** A card that collapses to a single clickable header row (title + subtitle + accent bar) and
 *  expands to reveal its body. Declutters stacks of forms into a tidy, scannable list. */
function Collapsible({
  title,
  subtitle,
  accent,
  defaultOpen = false,
  children,
}: {
  title: string;
  subtitle?: string;
  accent: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      style={{
        background: "var(--card)",
        border: "1px solid var(--line)",
        borderRadius: 11,
        boxShadow: "var(--shadow-card)",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 15px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          fontFamily: "inherit",
          textAlign: "left",
        }}
      >
        <span
          style={{
            width: 4,
            height: 26,
            borderRadius: 2,
            background: accent,
            flex: "none",
          }}
        />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              display: "block",
              fontSize: 13,
              fontWeight: 600,
              color: "var(--ink)",
            }}
          >
            {title}
          </span>
          {subtitle && (
            <span
              style={{
                display: "block",
                fontSize: 11,
                color: "var(--ink-3)",
                marginTop: 1,
              }}
            >
              {subtitle}
            </span>
          )}
        </span>
        <Icon
          name={open ? "chevron-down" : "chevron-right"}
          size={16}
          style={{ color: "var(--ink-3)", flex: "none" }}
        />
      </button>
      {open && (
        <div
          style={{
            padding: "6px 16px 16px",
            borderTop: "1px solid var(--line)",
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function AddIntegrations({
  tenant,
  onChanged,
}: {
  tenant: string;
  onChanged: () => Promise<void> | void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        marginBottom: 26,
      }}
    >
      <Collapsible
        title="Connect MCP server"
        subtitle="Call remote tools from an mcpTool node"
        accent="var(--node-mcp)"
      >
        <ConnectForm tenant={tenant} onChanged={onChanged} />
      </Collapsible>
      <Collapsible
        title="Connect a database"
        subtitle="For the SQL Query / SQL Exec nodes"
        accent="var(--node-sql, var(--brand))"
      >
        <DatabaseForm tenant={tenant} onChanged={onChanged} />
      </Collapsible>
      <Collapsible
        title="Add a signing key"
        subtitle="For the hmac / jwt / totp nodes"
        accent="var(--node-hash, var(--brand))"
      >
        <SigningForm tenant={tenant} onChanged={onChanged} />
      </Collapsible>
      <Collapsible
        title="Configure SMTP (email)"
        subtitle="For the sendEmail node"
        accent="var(--node-agent, var(--brand))"
      >
        <SmtpForm tenant={tenant} onChanged={onChanged} />
      </Collapsible>
      <Collapsible
        title="Register a webhook"
        subtitle="Trigger a workflow from an inbound HTTP call"
        accent="var(--node-trigger)"
      >
        <WebhookForm tenant={tenant} onChanged={onChanged} />
      </Collapsible>
    </div>
  );
}

/** Connect a SQL database (postgres/mssql) for the SQL Query node. The connection
 *  string (DSN) is the secret → stored encrypted as the connection token; the host
 *  is a non-secret display value. The DSN is NEVER placed in serverUrl. */
function DatabaseForm({
  tenant,
  onChanged,
}: {
  tenant: string;
  onChanged: () => Promise<void> | void;
}) {
  const [label, setLabel] = useState("");
  const [engine, setEngine] = useState<"postgres" | "mssql" | "mysql">(
    "postgres",
  );
  const [host, setHost] = useState("");
  const [dsn, setDsn] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      await api.createConnection(tenant, {
        type: engine,
        label: label.trim(),
        serverUrl: host.trim(), // non-secret display host
        authMode: "connection_string",
        token: dsn.trim(), // the secret DSN (stored encrypted server-side)
      });
      setLabel("");
      setHost("");
      setDsn("");
      setMsg("Connected ✓");
      await onChanged();
    } catch (e) {
      setMsg(
        e instanceof Error && /400/.test(e.message)
          ? "Check the fields."
          : "Could not connect the database.",
      );
    } finally {
      setBusy(false);
    }
  }

  const ready = Boolean(label.trim() && host.trim() && dsn.trim());
  const dsnPlaceholder =
    engine === "postgres"
      ? "postgres://user:pass@host:5432/db"
      : engine === "mysql"
        ? "mysql://user:pass@host:3306/db"
        : "Server=host;Database=db;User Id=…;Password=…";

  return (
    <>
      <div style={{ marginBottom: 10 }}>
        <span style={fieldLabel}>Label</span>
        <input
          style={fieldStyle}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="app-db"
        />
      </div>
      <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
        <div style={{ flex: 1 }}>
          <span style={fieldLabel}>Engine</span>
          <select
            style={fieldStyle}
            value={engine}
            onChange={(e) =>
              setEngine(e.target.value as "postgres" | "mssql" | "mysql")
            }
          >
            <option value="postgres">postgres</option>
            <option value="mssql">mssql</option>
            <option value="mysql">mysql</option>
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <span style={fieldLabel}>Host (display)</span>
          <input
            style={fieldStyle}
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="localhost:5432"
          />
        </div>
      </div>
      <div style={{ marginBottom: 10 }}>
        <span style={fieldLabel}>Connection string (stored encrypted)</span>
        <input
          style={fieldStyle}
          type="password"
          value={dsn}
          onChange={(e) => setDsn(e.target.value)}
          placeholder={dsnPlaceholder}
        />
      </div>
      <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 12 }}>
        Used by the SQL Query node (read-only). The connection string is stored
        encrypted and never shown again.
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Button
          variant="primary"
          disabled={busy || !ready}
          onClick={() => void submit()}
        >
          {busy ? "Connecting…" : "Connect"}
        </Button>
        {msg && (
          <span style={{ fontSize: 12, color: "var(--ink-2)" }}>{msg}</span>
        )}
      </div>
    </>
  );
}

function SmtpForm({
  tenant,
  onChanged,
}: {
  tenant: string;
  onChanged: () => Promise<void> | void;
}) {
  const [label, setLabel] = useState("");
  const [host, setHost] = useState("");
  const [uri, setUri] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      await api.createConnection(tenant, {
        type: "smtp",
        label: label.trim(),
        serverUrl: host.trim(), // non-secret display host
        authMode: "connection_string",
        token: uri.trim(), // the secret SMTP URI (stored encrypted server-side)
      });
      setLabel("");
      setHost("");
      setUri("");
      setMsg("Connected ✓");
      await onChanged();
    } catch (e) {
      setMsg(
        e instanceof Error && /400/.test(e.message)
          ? "Check the fields."
          : "Could not connect SMTP.",
      );
    } finally {
      setBusy(false);
    }
  }

  const ready = Boolean(label.trim() && host.trim() && uri.trim());

  return (
    <>
      <div style={{ marginBottom: 10 }}>
        <span style={fieldLabel}>Label</span>
        <input
          style={fieldStyle}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="transactional-email"
        />
      </div>
      <div style={{ marginBottom: 10 }}>
        <span style={fieldLabel}>Host (display)</span>
        <input
          style={fieldStyle}
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="smtp.example.com"
        />
      </div>
      <div style={{ marginBottom: 10 }}>
        <span style={fieldLabel}>SMTP URI (stored encrypted)</span>
        <input
          style={fieldStyle}
          type="password"
          value={uri}
          onChange={(e) => setUri(e.target.value)}
          placeholder="smtps://user:pass@smtp.example.com:465"
        />
      </div>
      <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 12 }}>
        Used by the Send Email node. The URI (with credentials) is stored
        encrypted and never shown again.
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Button
          variant="primary"
          disabled={busy || !ready}
          onClick={() => void submit()}
        >
          {busy ? "Connecting…" : "Connect"}
        </Button>
        {msg && (
          <span style={{ fontSize: 12, color: "var(--ink-2)" }}>{msg}</span>
        )}
      </div>
    </>
  );
}

function SigningForm({
  tenant,
  onChanged,
}: {
  tenant: string;
  onChanged: () => Promise<void> | void;
}) {
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      await api.createConnection(tenant, {
        type: "signing",
        label: label.trim(),
        serverUrl: label.trim(), // non-secret display name (signing keys have no host)
        authMode: "api_token",
        token: key.trim(), // the secret signing key (stored encrypted server-side)
      });
      setLabel("");
      setKey("");
      setMsg("Saved ✓");
      await onChanged();
    } catch (e) {
      setMsg(
        e instanceof Error && /400/.test(e.message)
          ? "Check the fields."
          : "Could not save the signing key.",
      );
    } finally {
      setBusy(false);
    }
  }

  const ready = Boolean(label.trim() && key.trim());

  return (
    <>
      <div style={{ marginBottom: 10 }}>
        <span style={fieldLabel}>Label</span>
        <input
          style={fieldStyle}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="webhook-signing"
        />
      </div>
      <div style={{ marginBottom: 10 }}>
        <span style={fieldLabel}>Signing key (stored encrypted)</span>
        <input
          style={fieldStyle}
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="a long random secret"
        />
      </div>
      <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 12 }}>
        Used by the HMAC and JWT nodes to sign payloads. The key is stored
        encrypted and never shown again.
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Button
          variant="primary"
          disabled={busy || !ready}
          onClick={() => void submit()}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
        {msg && (
          <span style={{ fontSize: 12, color: "var(--ink-2)" }}>{msg}</span>
        )}
      </div>
    </>
  );
}

function ConnectForm({
  tenant,
  onChanged,
}: {
  tenant: string;
  onChanged: () => Promise<void> | void;
}) {
  const [label, setLabel] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [type, setType] = useState<"github" | "atlassian" | "custom">("custom");
  const [authMode, setAuthMode] = useState<"api_token" | "pat" | "oauth">(
    "api_token",
  );
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      await api.createConnection(tenant, {
        type,
        label: label.trim(),
        serverUrl: serverUrl.trim(),
        authMode,
        ...(token.trim() ? { token: token.trim() } : {}),
      });
      setLabel("");
      setServerUrl("");
      setToken("");
      setMsg("Connected ✓");
      await onChanged();
    } catch (e) {
      setMsg(
        e instanceof Error && /400/.test(e.message)
          ? "Check the fields (server URL must be https)."
          : "Could not connect the server.",
      );
    } finally {
      setBusy(false);
    }
  }

  const ready = label.trim() && /^https:\/\//.test(serverUrl.trim());

  return (
    <>
      <div style={{ marginBottom: 10 }}>
        <span style={fieldLabel}>Label</span>
        <input
          style={fieldStyle}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="GitHub (prod)"
        />
      </div>
      <div style={{ marginBottom: 10 }}>
        <span style={fieldLabel}>Server URL (https)</span>
        <input
          style={fieldStyle}
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          placeholder="https://mcp.example.com"
        />
      </div>
      <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
        <div style={{ flex: 1 }}>
          <span style={fieldLabel}>Type</span>
          <select
            style={fieldStyle}
            value={type}
            onChange={(e) =>
              setType(e.target.value as "github" | "atlassian" | "custom")
            }
          >
            <option value="custom">custom</option>
            <option value="github">github</option>
            <option value="atlassian">atlassian</option>
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <span style={fieldLabel}>Auth</span>
          <select
            style={fieldStyle}
            value={authMode}
            onChange={(e) =>
              setAuthMode(e.target.value as "api_token" | "pat" | "oauth")
            }
          >
            <option value="api_token">api_token</option>
            <option value="pat">pat</option>
            <option value="oauth">oauth</option>
          </select>
        </div>
      </div>
      {authMode !== "oauth" && (
        <div style={{ marginBottom: 12 }}>
          <span style={fieldLabel}>Token (stored encrypted)</span>
          <input
            style={fieldStyle}
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ghp_… / api token"
          />
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Button
          variant="primary"
          disabled={busy || !ready}
          onClick={() => void submit()}
        >
          {busy ? "Connecting…" : "Connect"}
        </Button>
        {msg && (
          <span style={{ fontSize: 12, color: "var(--ink-2)" }}>{msg}</span>
        )}
      </div>
    </>
  );
}

function WebhookForm({
  tenant,
  onChanged,
}: {
  tenant: string;
  onChanged: () => Promise<void> | void;
}) {
  const [workflowId, setWorkflowId] = useState("");
  const [provider, setProvider] = useState("github");
  const [busy, setBusy] = useState(false);
  const [registered, setRegistered] = useState<RegisteredWebhook | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.createWebhook(tenant, {
        workflowId: workflowId.trim(),
        provider,
      });
      setRegistered(res);
      setWorkflowId("");
      await onChanged();
    } catch {
      setMsg("Could not register the webhook.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div style={{ marginBottom: 10 }}>
        <span style={fieldLabel}>Workflow key (e.g. wf-default)</span>
        <input
          style={fieldStyle}
          value={workflowId}
          onChange={(e) => setWorkflowId(e.target.value)}
          placeholder="wf-default"
        />
      </div>
      <div style={{ marginBottom: 12 }}>
        <span style={fieldLabel}>Provider</span>
        <select
          style={fieldStyle}
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
        >
          <option value="github">github</option>
          <option value="atlassian">atlassian</option>
          <option value="generic">generic</option>
        </select>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Button
          variant="primary"
          disabled={busy || !workflowId.trim()}
          onClick={() => void submit()}
        >
          {busy ? "Registering…" : "Register"}
        </Button>
        {msg && (
          <span style={{ fontSize: 12, color: "var(--state-error)" }}>
            {msg}
          </span>
        )}
      </div>

      {registered && (
        <WebhookHowTo
          registered={registered}
          copied={copied}
          setCopied={setCopied}
        />
      )}
    </>
  );
}

/** Shown once after registering: the secret + a ready-to-run signed curl. The
 *  webhook is authenticated by an HMAC-SHA256 signature over the RAW body. */
function WebhookHowTo({
  registered,
  copied,
  setCopied,
}: {
  registered: RegisteredWebhook;
  copied: boolean;
  setCopied: (v: boolean) => void;
}) {
  const curl = [
    "# 1. your API host + a JSON body (any shape — it becomes the trigger output)",
    "API=<YOUR_API_URL>",
    `BODY='{"hello":"world"}'`,
    "",
    "# 2. sign the RAW body with the signing secret (HMAC-SHA256, hex)",
    `SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "${registered.signingSecret}" -r | cut -d' ' -f1)"`,
    "",
    "# 3. POST it",
    `curl -X POST "$API${registered.ingressPath}" \\`,
    '  -H "content-type: application/json" \\',
    '  -H "X-Hub-Signature-256: $SIG" \\',
    '  -H "x-delivery-id: $(uuidgen)" \\',
    '  --data-binary "$BODY"',
  ].join("\n");

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(curl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the command is still visible to copy manually */
    }
  }

  return (
    <div
      style={{
        marginTop: 12,
        padding: 10,
        borderRadius: 8,
        background: "var(--card-2, var(--surface))",
        border: "1px solid var(--line)",
      }}
    >
      <div style={{ fontSize: 11, color: "var(--ink-2)", marginBottom: 6 }}>
        Save this signing secret now — it is shown <strong>only once</strong>.
        The webhook is authenticated by an{" "}
        <strong>HMAC-SHA256 signature over the raw body</strong> (no bearer
        token).
      </div>
      <div className="mono" style={{ fontSize: 11, marginBottom: 4 }}>
        POST {registered.ingressPath}
      </div>
      <div
        className="mono"
        style={{ fontSize: 11, wordBreak: "break-all", color: "var(--brand)" }}
      >
        {registered.signingSecret}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          margin: "12px 0 4px",
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-2)" }}>
          Trigger it (copy &amp; run)
        </div>
        <Button variant="secondary" onClick={() => void copy()}>
          {copied ? "Copied ✓" : "Copy curl"}
        </Button>
      </div>
      <pre
        className="mono"
        style={{
          margin: 0,
          padding: 10,
          borderRadius: 6,
          background: "var(--surface)",
          border: "1px solid var(--line)",
          fontSize: 10.5,
          lineHeight: 1.5,
          overflowX: "auto",
          whiteSpace: "pre",
          color: "var(--ink)",
        }}
      >
        {curl}
      </pre>
      <div style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 6 }}>
        Replace <code>&lt;YOUR_API_URL&gt;</code> with your API host. Sign the
        exact bytes you send. A repeat with the same <code>x-delivery-id</code>{" "}
        is ignored.
      </div>
    </div>
  );
}

/** A model-provider card with REAL connected status + a BYOK key form. */
function ProviderCard({
  p,
  tenant,
  connected,
  onSaved,
}: {
  p: {
    key: string;
    initial: string;
    name: string;
    models: string;
    color: string;
    supported: boolean;
  };
  tenant: string | null;
  connected: boolean;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!tenant || !apiKey.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api.saveCredential(tenant, p.key, apiKey.trim());
      setApiKey("");
      setOpen(false);
      onSaved();
    } catch {
      setErr("Key rejected — check it's a valid key for this provider.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        background: "var(--card)",
        border: "1px solid var(--line)",
        borderRadius: 11,
        padding: 15,
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: `color-mix(in srgb, ${p.color} 16%, transparent)`,
            color: p.color,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 700,
            fontSize: 14,
          }}
        >
          {p.initial}
        </span>
        <span
          title={connected ? "Key configured" : "No key"}
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: connected ? "var(--state-done)" : "var(--line-2)",
          }}
        />
      </div>
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: "var(--ink)",
          marginTop: 11,
        }}
      >
        {p.name}
      </div>
      <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
        {p.models}
      </div>

      {!p.supported ? (
        <div
          style={{
            marginTop: 11,
            fontSize: 11.5,
            fontWeight: 600,
            color: "var(--ink-3)",
          }}
        >
          Coming soon
        </div>
      ) : open ? (
        <div style={{ marginTop: 10 }}>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={`${p.name} API key`}
            autoComplete="off"
            style={{
              width: "100%",
              padding: "6px 8px",
              borderRadius: 7,
              border: "1px solid var(--line-2)",
              background: "var(--bg)",
              color: "var(--ink)",
              fontSize: 12,
            }}
          />
          {err && (
            <div
              style={{
                fontSize: 11,
                color: "var(--state-error)",
                marginTop: 5,
              }}
            >
              {err}
            </div>
          )}
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <Button variant="primary" size="sm" onClick={save} disabled={busy}>
              {busy ? "Saving…" : "Save key"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{
            marginTop: 11,
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            fontSize: 11.5,
            fontWeight: 600,
            color: "var(--brand)",
          }}
        >
          {connected ? "Update key" : "Add key"}
        </button>
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Icon,
  LoadingBlock,
  type RunState,
  StatusPill,
} from "../../components";
import {
  api,
  type ApiTokenRow,
  type ChatRow,
  type ConnectionRow,
  type FormRow,
  type GraphSummary,
  type MintedToken,
  type ProviderCredential,
  type RegisteredChat,
  type RegisteredForm,
  type RegisteredWebhook,
  type WebhookRow,
  UnauthorizedError,
} from "../../lib/api";
import { isTerminal } from "../../lib/run-status";

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
  fontSize: "var(--text-2xs)",
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "var(--tracking-label)",
  color: "var(--ink-3)",
  textTransform: "uppercase",
};

/** The full, invokable webhook URL. The /hooks/:id ingress is reached through the same /api
 *  proxy the app uses (nginx rewrites /api/hooks/… → /hooks/…), so this URL is callable as-is. */
const webhookUrl = (id: string): string =>
  `${window.location.origin}/api/hooks/${id}`;

/** The public, shareable URL of a hosted form — the `/f/:formId` page served outside auth. */
const formUrl = (id: string): string => `${window.location.origin}/f/${id}`;

/** The public, shareable URL of a hosted chat — the `/c/:chatId` page served outside auth. */
const chatUrl = (id: string): string => `${window.location.origin}/c/${id}`;

/** Small copy-to-clipboard button with brief "Copied ✓" feedback. */
function UrlCopy({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy URL"
      className="btn btn-sm btn-secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable — the URL is still visible to copy manually */
        }
      }}
      style={{ flex: "none" }}
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

export function Integrations() {
  const [tenant, setTenant] = useState<string | null>(null);
  const [connections, setConnections] = useState<ConnectionRow[] | null>(null);
  const [webhooks, setWebhooks] = useState<WebhookRow[] | null>(null);
  const [forms, setForms] = useState<FormRow[] | null>(null);
  const [chats, setChats] = useState<ChatRow[] | null>(null);
  const [credentials, setCredentials] = useState<ProviderCredential[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [deletingForm, setDeletingForm] = useState<string | null>(null);
  const [deletingChat, setDeletingChat] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { tenantId } = await api.getMe();
      setTenant(tenantId);
      const [conns, hooks, formList, chatList, creds] = await Promise.all([
        api.listConnections(tenantId),
        api.listWebhooks(tenantId),
        api.listForms(tenantId).catch(() => []),
        api.listChats(tenantId).catch(() => []),
        api.listCredentials(tenantId).catch(() => []),
      ]);
      setConnections(conns);
      setWebhooks(hooks);
      setForms(formList);
      setChats(chatList);
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
            fontSize: "var(--text-title)",
            fontWeight: "var(--weight-bold)",
            color: "var(--ink)",
            letterSpacing: "var(--tracking-tight)",
          }}
        >
          Integrations
        </div>
        <div
          style={{
            fontSize: "var(--text-body)",
            color: "var(--ink-2)",
            marginTop: 4,
          }}
        >
          MCP servers, model providers and connected apps.
        </div>
      </div>

      {error && (
        <div
          style={{
            marginBottom: 20,
            padding: "10px 12px",
            borderRadius: "var(--radius-md)",
            background: "var(--error-soft)",
            border:
              "1px solid color-mix(in srgb, var(--state-error) 40%, transparent)",
            color: "var(--state-error)",
            fontSize: "var(--text-sm)",
          }}
        >
          {error}
        </div>
      )}

      {/* ===== MCP access (endpoint + API tokens) ===== */}
      <McpAccess />

      {/* ===== Add integration (collapsed create forms) ===== */}
      <div id="add-integrations" style={{ marginBottom: 24 }}>
        <div style={{ ...monoLabel, marginBottom: 12 }}>Add integration</div>
        {tenant && <AddIntegrations tenant={tenant} onChanged={load} />}
      </div>

      {/* ===== Model providers ===== */}
      <div style={{ ...monoLabel, marginBottom: 12 }}>Model providers</div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
          gap: 12,
          marginBottom: 24,
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

      {/* ===== Code Agent (Claude Code) ===== */}
      <div style={{ ...monoLabel, marginBottom: 12 }}>Code Agent</div>
      <div style={{ marginBottom: 24 }}>
        <CodeAgentCard
          hasKey={credentials.some(
            (c) => c.provider === "anthropic" && c.isValid,
          )}
        />
      </div>

      {/* ===== MCP servers (connections) ===== */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
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
            borderRadius: "var(--radius-sm)",
            border:
              "1px solid color-mix(in srgb, var(--brand) 50%, transparent)",
            background: "var(--brand-soft)",
            color: "var(--brand)",
            fontSize: "var(--text-sm)",
            fontWeight: "var(--weight-semibold)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontFamily: "inherit",
            transition: "background 0.14s ease, border-color 0.14s ease",
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
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-card)",
          overflow: "hidden",
          marginBottom: 24,
        }}
      >
        {loading && <LoadingBlock />}
        {!loading && connections?.length === 0 && (
          <div
            style={{
              padding: 16,
              fontSize: "var(--text-body)",
              color: "var(--ink-3)",
            }}
          >
            No connections yet — add one from "Add integration" above.
          </div>
        )}
        {(connections ?? []).map((c, i) => (
          <div
            key={c.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "14px 16px",
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
                borderRadius: "var(--radius-md)",
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
                style={{
                  fontSize: "var(--text-body)",
                  fontWeight: "var(--weight-semibold)",
                  color: "var(--ink)",
                }}
              >
                {c.label}
              </div>
              <div
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--ink-3)",
                  marginTop: 2,
                }}
              >
                {c.type} · {c.serverUrl}
              </div>
            </div>
            <StatusPill
              state={connectionState(c.status)}
              label={CONNECTION_LABEL[c.status]}
            />
            {c.status === "needs_reauth" && c.authMode === "oauth" && (
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                // Disable ALL Reconnect buttons while any reconnect is in flight — the handler
                // early-returns when `reconnecting` is set, so a per-row-only disable would make
                // the other buttons look clickable but do nothing.
                disabled={reconnecting !== null}
                onClick={() => {
                  if (!tenant || reconnecting) return;
                  setReconnecting(c.id);
                  void api
                    .startOauthConsent(tenant, c.id)
                    .then(({ authorizeUrl }) =>
                      window.location.assign(authorizeUrl),
                    )
                    .catch(() => {
                      setError("Could not start re-authorization.");
                      setReconnecting(null);
                    });
                }}
              >
                {reconnecting === c.id ? "Redirecting…" : "Reconnect"}
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm btn-secondary"
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
            >
              {disconnecting === c.id ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
        ))}
      </div>

      {/* ===== Webhook endpoints ===== */}
      <div style={{ ...monoLabel, marginBottom: 12 }}>Webhook endpoints</div>
      <div
        style={{
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-card)",
          overflow: "hidden",
        }}
      >
        {loading && <LoadingBlock />}
        {!loading && webhooks?.length === 0 && (
          <div
            style={{
              padding: 16,
              fontSize: "var(--text-body)",
              color: "var(--ink-3)",
            }}
          >
            No webhook endpoints yet — register one to trigger a workflow.
          </div>
        )}
        {(webhooks ?? []).map((w, i) => (
          <WebhookItem
            key={w.id}
            w={w}
            tenant={tenant}
            isLast={i >= (webhooks?.length ?? 0) - 1}
            webhookUrl={webhookUrl}
            onChanged={load}
            onError={setError}
          />
        ))}
      </div>

      {/* ===== Form endpoints ===== */}
      <div style={{ ...monoLabel, margin: "24px 0 12px" }}>Form endpoints</div>
      <div
        style={{
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-card)",
          overflow: "hidden",
        }}
      >
        {loading && <LoadingBlock />}
        {!loading && forms?.length === 0 && (
          <div
            style={{
              padding: 16,
              fontSize: "var(--text-body)",
              color: "var(--ink-3)",
            }}
          >
            No hosted forms yet — register one to collect submissions that start
            a workflow.
          </div>
        )}
        {(forms ?? []).map((f, i) => (
          <div
            key={f.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "14px 16px",
              borderBottom:
                i < (forms?.length ?? 0) - 1
                  ? "1px solid var(--line)"
                  : undefined,
            }}
          >
            <span
              style={{
                width: 34,
                height: 34,
                borderRadius: "var(--radius-md)",
                background:
                  "color-mix(in srgb, var(--node-trigger) 15%, transparent)",
                color: "var(--node-trigger)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flex: "none",
              }}
            >
              <Icon name="edit" size={17} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <a
                href={formUrl(f.id)}
                target="_blank"
                rel="noreferrer"
                className="mono"
                style={{
                  display: "block",
                  fontSize: "var(--text-sm)",
                  fontWeight: "var(--weight-semibold)",
                  color: "var(--ink)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  textDecoration: "none",
                }}
                title={formUrl(f.id)}
              >
                {formUrl(f.id)}
              </a>
              <div
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--ink-3)",
                  marginTop: 2,
                }}
              >
                public form · {f.workflowId}
              </div>
            </div>
            <UrlCopy url={formUrl(f.id)} />
            <StatusPill state="done" label="Active" />
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              disabled={deletingForm === f.id}
              title="Delete form"
              onClick={() => {
                if (!tenant || deletingForm) return;
                if (
                  !window.confirm(
                    "Delete this form? Its public URL will stop working.",
                  )
                ) {
                  return;
                }
                setDeletingForm(f.id);
                void api
                  .deleteForm(tenant, f.id)
                  .then(() => load())
                  .catch(() => setError("Could not delete the form."))
                  .finally(() => setDeletingForm(null));
              }}
            >
              {deletingForm === f.id ? "Deleting…" : "Delete"}
            </button>
          </div>
        ))}
      </div>

      {/* ===== Chat endpoints ===== */}
      <div style={{ ...monoLabel, margin: "24px 0 12px" }}>Chat endpoints</div>
      <div
        style={{
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-card)",
          overflow: "hidden",
        }}
      >
        {!loading && chats?.length === 0 && (
          <div
            style={{
              padding: 16,
              fontSize: "var(--text-body)",
              color: "var(--ink-3)",
            }}
          >
            No hosted chats yet — register one to serve a public chat widget
            backed by a workflow.
          </div>
        )}
        {(chats ?? []).map((c, i) => (
          <div
            key={c.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "14px 16px",
              borderBottom:
                i < (chats?.length ?? 0) - 1
                  ? "1px solid var(--line)"
                  : undefined,
            }}
          >
            <span
              style={{
                width: 34,
                height: 34,
                borderRadius: "var(--radius-md)",
                background:
                  "color-mix(in srgb, var(--node-agent) 15%, transparent)",
                color: "var(--node-agent)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flex: "none",
              }}
            >
              <Icon name="agent" size={17} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <a
                href={chatUrl(c.id)}
                target="_blank"
                rel="noreferrer"
                className="mono"
                style={{
                  display: "block",
                  fontSize: "var(--text-sm)",
                  fontWeight: "var(--weight-semibold)",
                  color: "var(--ink)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  textDecoration: "none",
                }}
                title={chatUrl(c.id)}
              >
                {chatUrl(c.id)}
              </a>
              <div
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--ink-3)",
                  marginTop: 2,
                }}
              >
                public chat · {c.workflowId}
              </div>
            </div>
            <UrlCopy url={chatUrl(c.id)} />
            <StatusPill state="done" label="Active" />
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              disabled={deletingChat === c.id}
              title="Delete chat"
              onClick={() => {
                if (!tenant || deletingChat) return;
                if (
                  !window.confirm(
                    "Delete this chat? Its public URL will stop working.",
                  )
                ) {
                  return;
                }
                setDeletingChat(c.id);
                void api
                  .deleteChat(tenant, c.id)
                  .then(() => load())
                  .catch(() => setError("Could not delete the chat."))
                  .finally(() => setDeletingChat(null));
              }}
            >
              {deletingChat === c.id ? "Deleting…" : "Delete"}
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
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line-2)",
  background: "var(--card)",
  color: "var(--ink)",
  fontSize: "var(--text-body)",
};
const fieldLabel: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--ink-2)",
  display: "block",
  marginBottom: 6,
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
        borderRadius: "var(--radius-lg)",
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
          padding: "12px 16px",
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
            borderRadius: "var(--radius-full)",
            background: accent,
            flex: "none",
          }}
        />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              display: "block",
              fontSize: "var(--text-body)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--ink)",
            }}
          >
            {title}
          </span>
          {subtitle && (
            <span
              style={{
                display: "block",
                fontSize: "var(--text-xs)",
                color: "var(--ink-3)",
                marginTop: 2,
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
        marginBottom: 24,
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
        title="Connect GitHub (App)"
        subtitle="Install the GitHub App to authorize repos — no personal token"
        accent="var(--brand)"
      >
        <GithubAppForm tenant={tenant} />
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
      <Collapsible
        title="Register a form"
        subtitle="Collect submissions on a public page that start a workflow"
        accent="var(--node-trigger)"
      >
        <FormForm tenant={tenant} onChanged={onChanged} />
      </Collapsible>
      <Collapsible
        title="Register a chat"
        subtitle="Serve a public chat widget backed by a workflow"
        accent="var(--node-agent)"
      >
        <ChatForm tenant={tenant} onChanged={onChanged} />
      </Collapsible>
    </div>
  );
}

/** Register a hosted chat for a workflow whose entry node is a chatTrigger. Mirrors FormForm; on
 *  success it surfaces the shareable /c/ URL. 400s (with a hint) if the tenant has no budget cap. */
function ChatForm({
  tenant,
  onChanged,
}: {
  tenant: string;
  onChanged: () => Promise<void> | void;
}) {
  const [workflowId, setWorkflowId] = useState("");
  const [busy, setBusy] = useState(false);
  const [registered, setRegistered] = useState<RegisteredChat | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.createChat(tenant, {
        workflowId: workflowId.trim(),
      });
      setRegistered(res);
      setWorkflowId("");
      await onChanged();
    } catch (e) {
      setMsg(
        e instanceof Error && /400/.test(e.message)
          ? "Set a monthly budget for this tenant first — a public chat needs a spend cap (Billing)."
          : "Could not register the chat.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <span style={fieldLabel}>
          Workflow key (its entry node must be a Chat)
        </span>
        <input
          style={fieldStyle}
          value={workflowId}
          onChange={(e) => setWorkflowId(e.target.value)}
          placeholder="support-chat"
        />
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
          <span
            style={{ fontSize: "var(--text-sm)", color: "var(--state-error)" }}
          >
            {msg}
          </span>
        )}
      </div>

      {registered && (
        <div
          style={{
            marginTop: 12,
            padding: 12,
            borderRadius: "var(--radius-md)",
            background: "var(--brand-soft)",
            border:
              "1px solid color-mix(in srgb, var(--brand) 45%, transparent)",
          }}
        >
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-2)",
              marginBottom: 8,
            }}
          >
            Your chat is live. Share this public URL — anyone with it can chat
            (no sign-in):
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
              {chatUrl(registered.chatId)}
            </span>
            <UrlCopy url={chatUrl(registered.chatId)} />
          </div>
        </div>
      )}
    </>
  );
}

/** Register a hosted form for a workflow whose entry node is a formTrigger. On success it surfaces
 *  the shareable public URL. Registration 400s if the tenant has no monthly budget cap — surfaced
 *  as a clear hint (the anonymous endpoint requires a spend backstop). */
function FormForm({
  tenant,
  onChanged,
}: {
  tenant: string;
  onChanged: () => Promise<void> | void;
}) {
  const [workflowId, setWorkflowId] = useState("");
  const [busy, setBusy] = useState(false);
  const [registered, setRegistered] = useState<RegisteredForm | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.createForm(tenant, {
        workflowId: workflowId.trim(),
      });
      setRegistered(res);
      setWorkflowId("");
      await onChanged();
    } catch (e) {
      setMsg(
        e instanceof Error && /400/.test(e.message)
          ? "Set a monthly budget for this tenant first — a public form needs a spend cap (Billing)."
          : "Could not register the form.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <span style={fieldLabel}>
          Workflow key (its entry node must be a Form)
        </span>
        <input
          style={fieldStyle}
          value={workflowId}
          onChange={(e) => setWorkflowId(e.target.value)}
          placeholder="contact-form"
        />
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
          <span
            style={{ fontSize: "var(--text-sm)", color: "var(--state-error)" }}
          >
            {msg}
          </span>
        )}
      </div>

      {registered && (
        <div
          style={{
            marginTop: 12,
            padding: 12,
            borderRadius: "var(--radius-md)",
            background: "var(--brand-soft)",
            border:
              "1px solid color-mix(in srgb, var(--brand) 45%, transparent)",
          }}
        >
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-2)",
              marginBottom: 8,
            }}
          >
            Your form is live. Share this public URL — anyone with it can submit
            (no sign-in):
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
              {formUrl(registered.formId)}
            </span>
            <UrlCopy url={formUrl(registered.formId)} />
          </div>
        </div>
      )}
    </>
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
      <div
        style={{
          fontSize: "var(--text-xs)",
          lineHeight: "var(--leading-snug)",
          color: "var(--ink-3)",
          marginBottom: 12,
        }}
      >
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
          <span style={{ fontSize: "var(--text-sm)", color: "var(--ink-2)" }}>
            {msg}
          </span>
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
      <div
        style={{
          fontSize: "var(--text-xs)",
          lineHeight: "var(--leading-snug)",
          color: "var(--ink-3)",
          marginBottom: 12,
        }}
      >
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
          <span style={{ fontSize: "var(--text-sm)", color: "var(--ink-2)" }}>
            {msg}
          </span>
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
      <div
        style={{
          fontSize: "var(--text-xs)",
          lineHeight: "var(--leading-snug)",
          color: "var(--ink-3)",
          marginBottom: 12,
        }}
      >
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
          <span style={{ fontSize: "var(--text-sm)", color: "var(--ink-2)" }}>
            {msg}
          </span>
        )}
      </div>
    </>
  );
}

/** Install the GitHub App for this tenant. INVERTED vs the MCP ConnectForm (which creates the
 *  connection up-front): GitHub yields no installation id until AFTER the user installs, so this
 *  only sends a label and full-page-navigates to github.com. The user picks repos; GitHub then
 *  redirects to the API's /github-app/callback, which creates the github_app connection from the
 *  returned installation_id. That callback currently returns JSON (like the OAuth callback), so the
 *  browser lands on the API response — the new connection appears on the NEXT visit to
 *  /app/integrations, not via an auto-return. (Redirecting BOTH callbacks back to the SPA is a
 *  tracked follow-up.) Hence no onChanged (we navigate away) and no token field — the app install
 *  itself IS the credential; no PAT is ever entered or stored. */
function GithubAppForm({ tenant }: { tenant: string }) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function install() {
    setBusy(true);
    setMsg(null);
    try {
      setMsg("Redirecting to GitHub…");
      const { installUrl } = await api.startGithubAppInstall(tenant, {
        label: label.trim() || "GitHub",
      });
      window.location.assign(installUrl); // navigate to github.com — leave the form as-is
    } catch {
      setMsg("Could not start the GitHub App install — try again.");
      setBusy(false);
    }
  }

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <span style={fieldLabel}>Label</span>
        <input
          style={fieldStyle}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="GitHub (prod)"
        />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => void install()}
        >
          {busy ? "Redirecting…" : "Install GitHub App"}
        </Button>
        {msg && (
          <span style={{ fontSize: "var(--text-sm)", color: "var(--ink-2)" }}>
            {msg}
          </span>
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
      const conn = await api.createConnection(tenant, {
        type,
        label: label.trim(),
        serverUrl: serverUrl.trim(),
        authMode,
        ...(token.trim() ? { token: token.trim() } : {}),
      });
      // OAuth needs an interactive consent handshake: kick off `oauth/start` and send the
      // browser to the provider's authorize URL. It redirects back to the API's
      // /oauth/callback, which persists the refresh token. (Token modes are done above.)
      // The connection already EXISTS at this point; scope consent-start errors separately so
      // a failure surfaces a specific message and refreshes the list (the created row shows up
      // and can be retried via Reconnect) — not the misleading "could not connect" that would
      // hide the created connection and invite duplicate creates on retry.
      if (authMode === "oauth") {
        try {
          setMsg("Redirecting to authorize…");
          const { authorizeUrl } = await api.startOauthConsent(tenant, conn.id);
          window.location.assign(authorizeUrl);
          return; // navigating away — leave the form as-is
        } catch {
          setMsg(
            "Connection created, but starting authorization failed — use Reconnect on it to retry.",
          );
          await onChanged();
          return;
        }
      }
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
          <span style={{ fontSize: "var(--text-sm)", color: "var(--ink-2)" }}>
            {msg}
          </span>
        )}
      </div>
    </>
  );
}

/**
 * One registered webhook row — view + INLINE EDIT. View shows the URL + "POST · provider ·
 * workflow"; Edit swaps in a workflow picker + provider select (Save updates in place, keeping
 * the id/URL/secret). Rotate mints a new signing secret (shown once). Delete removes it.
 */
function WebhookItem({
  w,
  tenant,
  isLast,
  webhookUrl,
  onChanged,
  onError,
}: {
  w: WebhookRow;
  tenant: string | null;
  isLast: boolean;
  webhookUrl: (id: string) => string;
  onChanged: () => Promise<void> | void;
  onError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [wf, setWf] = useState(w.workflowId);
  const [provider, setProvider] = useState(w.provider);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<GraphSummary[]>([]);

  // Load the saved workflows for the picker only when the user starts editing.
  useEffect(() => {
    if (!editing || workflows.length > 0) return;
    let alive = true;
    api
      .listGraphs()
      .then((gs) => alive && setWorkflows(gs))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [editing, workflows.length]);

  function startEdit() {
    setWf(w.workflowId);
    setProvider(w.provider);
    setNewSecret(null);
    setEditing(true);
  }

  async function save() {
    if (!tenant) return;
    setSaving(true);
    try {
      await api.updateWebhook(tenant, w.id, { workflowId: wf, provider });
      setEditing(false);
      await onChanged();
    } catch {
      onError("Could not update the webhook.");
    } finally {
      setSaving(false);
    }
  }

  async function rotate() {
    if (!tenant) return;
    if (
      !window.confirm(
        "Rotate the signing secret? Any provider still using the old secret will fail until you reconfigure it with the new one.",
      )
    )
      return;
    setRotating(true);
    try {
      const { signingSecret } = await api.rotateWebhookSecret(tenant, w.id);
      setNewSecret(signingSecret);
    } catch {
      onError("Could not rotate the signing secret.");
    } finally {
      setRotating(false);
    }
  }

  function remove() {
    if (!tenant || deleting) return;
    if (
      !window.confirm(
        "Delete this webhook endpoint? Calls to its URL will stop working.",
      )
    )
      return;
    setDeleting(true);
    void api
      .deleteWebhook(tenant, w.id)
      .then(() => onChanged())
      .catch(() => onError("Could not delete the webhook."))
      .finally(() => setDeleting(false));
  }

  return (
    <div
      style={{
        padding: "14px 16px",
        borderBottom: isLast ? undefined : "1px solid var(--line)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span
          style={{
            width: 34,
            height: 34,
            borderRadius: "var(--radius-md)",
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
              fontSize: "var(--text-sm)",
              fontWeight: "var(--weight-semibold)",
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
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: 2,
            }}
          >
            POST · {w.provider} · {w.workflowId}
          </div>
        </div>
        {!editing && <UrlCopy url={webhookUrl(w.id)} />}
        {!editing && <StatusPill state="done" label="Active" />}
        {!editing ? (
          <>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              title="Edit endpoint"
              onClick={startEdit}
            >
              Edit
            </button>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              disabled={deleting}
              title="Delete endpoint"
              onClick={remove}
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={saving || !wf.trim()}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              disabled={saving}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </>
        )}
      </div>

      {editing && (
        <div
          style={{
            marginTop: 12,
            paddingTop: 12,
            borderTop: "1px solid var(--line)",
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            alignItems: "flex-end",
          }}
        >
          <div style={{ flex: "1 1 220px", minWidth: 180 }}>
            <span style={fieldLabel}>Workflow to trigger</span>
            <select
              style={fieldStyle}
              value={wf}
              onChange={(e) => setWf(e.target.value)}
            >
              {/* Keep the current value selectable even if listGraphs hasn't loaded / it was deleted. */}
              {!workflows.some((g) => g.workflowKey === wf) && (
                <option value={wf}>{wf}</option>
              )}
              {workflows.map((g) => (
                <option key={g.workflowKey} value={g.workflowKey}>
                  {g.name} ({g.workflowKey})
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: "0 1 160px", minWidth: 140 }}>
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
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={rotating}
            title="Mint a new signing secret"
            onClick={() => void rotate()}
          >
            {rotating ? "Rotating…" : "Rotate secret"}
          </button>
        </div>
      )}

      {newSecret && (
        <div
          style={{
            marginTop: 12,
            padding: "10px 12px",
            borderRadius: "var(--radius-sm)",
            background: "var(--brand-soft)",
            border:
              "1px solid color-mix(in srgb, var(--brand) 30%, transparent)",
          }}
        >
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-2)",
              marginBottom: 6,
            }}
          >
            New signing secret — copy it now, it won't be shown again.
            Reconfigure the provider with it.
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <code
              className="mono"
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: "var(--text-xs)",
                color: "var(--ink)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {newSecret}
            </code>
            <UrlCopy url={newSecret} />
          </div>
        </div>
      )}
    </div>
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
  // The tenant's saved workflows, for the picker below. Typing a key by hand was the
  // #1 registration footgun ("No graph seeded for workflowKey '…'" 404s on a typo /
  // an unsaved key) — so the workflow is CHOSEN from real, saved graphs, never typed.
  const [workflows, setWorkflows] = useState<GraphSummary[]>([]);
  useEffect(() => {
    let alive = true;
    api
      .listGraphs()
      .then((gs) => {
        if (alive) setWorkflows(gs);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

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
        <span style={fieldLabel}>Workflow to trigger</span>
        {workflows.length === 0 ? (
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink-2)",
              padding: "8px 0",
            }}
          >
            No saved workflows yet — save one on the canvas first, then it'll
            appear here.
          </div>
        ) : (
          <select
            style={fieldStyle}
            value={workflowId}
            onChange={(e) => setWorkflowId(e.target.value)}
          >
            <option value="">Select a workflow…</option>
            {workflows.map((w) => (
              <option key={w.workflowKey} value={w.workflowKey}>
                {w.name} ({w.workflowKey})
              </option>
            ))}
          </select>
        )}
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
          <span
            style={{ fontSize: "var(--text-sm)", color: "var(--state-error)" }}
          >
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
        padding: 12,
        borderRadius: "var(--radius-md)",
        background: "var(--brand-soft)",
        border: "1px solid color-mix(in srgb, var(--brand) 45%, transparent)",
      }}
    >
      <div
        style={{
          fontSize: "var(--text-xs)",
          lineHeight: "var(--leading-snug)",
          color: "var(--ink-2)",
          marginBottom: 8,
        }}
      >
        Save this signing secret now — it is shown <strong>only once</strong>.
        The webhook is authenticated by an{" "}
        <strong>HMAC-SHA256 signature over the raw body</strong> (no bearer
        token).
      </div>
      <div
        className="mono"
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--ink-3)",
          marginBottom: 4,
        }}
      >
        POST {registered.ingressPath}
      </div>
      <div
        className="mono"
        style={{
          fontSize: "var(--text-xs)",
          fontWeight: "var(--weight-semibold)",
          wordBreak: "break-all",
          color: "var(--brand)",
        }}
      >
        {registered.signingSecret}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          margin: "12px 0 6px",
        }}
      >
        <div
          style={{
            fontSize: "var(--text-xs)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--ink-2)",
          }}
        >
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
          borderRadius: "var(--radius-sm)",
          background: "var(--surface)",
          border: "1px solid var(--line)",
          fontSize: "var(--text-2xs)",
          lineHeight: 1.5,
          overflowX: "auto",
          whiteSpace: "pre",
          color: "var(--ink)",
        }}
      >
        {curl}
      </pre>
      <div
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--ink-3)",
          marginTop: 6,
        }}
      >
        Replace <code>&lt;YOUR_API_URL&gt;</code> with your API host. Sign the
        exact bytes you send. A repeat with the same <code>x-delivery-id</code>{" "}
        is ignored.
      </div>
    </div>
  );
}

/**
 * Code Agent (Claude Code) card. Runs a MINIMAL read-only codeAgent run and reports whether
 * the `claude` CLI + the tenant's Anthropic key work end-to-end — a different path than the
 * agent node's API-key validation (this exercises the actual CLI subprocess in the worker).
 */
function CodeAgentCard({ hasKey }: { hasKey: boolean }) {
  const [phase, setPhase] = useState<"idle" | "running" | "ok" | "fail">(
    "idle",
  );
  const [detail, setDetail] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  async function runTest() {
    setPhase("running");
    setDetail(null);
    setRunId(null);
    try {
      const { workflowId } = await api.testCodeAgent();
      setRunId(workflowId);
      // Poll until the run reaches a terminal state (or time out).
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const s = await api.getState(workflowId).catch(() => null);
        if (!s || !isTerminal(s.status)) continue;
        if (s.status === "completed") {
          const out = (s.ctx?.codeAgent as { result?: string } | undefined)
            ?.result;
          setPhase("ok");
          setDetail(
            out ? `Claude replied: “${out.trim().slice(0, 80)}”` : "Completed.",
          );
        } else {
          setPhase("fail");
          setDetail(
            `Run ${s.status}. Common causes: the ‘claude’ CLI isn’t in the worker image, or the Anthropic key is invalid.`,
          );
        }
        return;
      }
      setPhase("fail");
      setDetail("Timed out waiting for the test run.");
    } catch {
      setPhase("fail");
      setDetail("Could not start the test run.");
    }
  }

  const resultColor =
    phase === "ok" ? "var(--state-done)" : "var(--state-error)";

  return (
    <div
      style={{
        background: "var(--card)",
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-lg)",
        boxShadow: "var(--shadow-card)",
        padding: 16,
        maxWidth: 560,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            background: "var(--node-agent)",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: "var(--weight-bold)",
            flex: "none",
          }}
        >
          ⌘
        </span>
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: "var(--text-body)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--ink)",
            }}
          >
            Claude Code
          </div>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
            The Code Agent node — runs the <code>claude</code> CLI. Uses your
            Anthropic key above.
          </div>
        </div>
        {hasKey ? (
          <StatusPill state="done" label="Key set" />
        ) : (
          <StatusPill state="idle" label="No key" />
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginTop: 14,
        }}
      >
        <Button
          variant="primary"
          icon="play"
          loading={phase === "running"}
          disabled={phase === "running" || !hasKey}
          title={hasKey ? "Run a read-only test" : "Add an Anthropic key first"}
          onClick={() => void runTest()}
        >
          {phase === "running" ? "Testing…" : "Run test"}
        </Button>
        {detail && (
          <span
            style={{
              fontSize: "var(--text-sm)",
              color: phase === "running" ? "var(--ink-3)" : resultColor,
            }}
          >
            {phase === "ok" ? "✓ " : phase === "fail" ? "✗ " : ""}
            {detail}
            {runId && phase === "fail" && (
              <>
                {" "}
                <a
                  href={`/app/runs/${runId}`}
                  style={{ color: "var(--brand)" }}
                >
                  view run
                </a>
              </>
            )}
          </span>
        )}
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
        borderRadius: "var(--radius-lg)",
        padding: 16,
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
            borderRadius: "var(--radius-md)",
            background: `color-mix(in srgb, ${p.color} 16%, transparent)`,
            color: p.color,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: "var(--weight-bold)",
            fontSize: "var(--text-md)",
          }}
        >
          {p.initial}
        </span>
        <span
          title={connected ? "Key configured" : "No key"}
          style={{
            width: 8,
            height: 8,
            borderRadius: "var(--radius-full)",
            background: connected ? "var(--state-done)" : "var(--line-2)",
          }}
        />
      </div>
      <div
        style={{
          fontSize: "var(--text-body)",
          fontWeight: "var(--weight-semibold)",
          color: "var(--ink)",
          marginTop: 12,
        }}
      >
        {p.name}
      </div>
      <div
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--ink-3)",
          marginTop: 2,
        }}
      >
        {p.models}
      </div>

      {!p.supported ? (
        <div
          style={{
            marginTop: 12,
            fontSize: "var(--text-sm)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--ink-3)",
          }}
        >
          Coming soon
        </div>
      ) : open ? (
        <div style={{ marginTop: 12 }}>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={`${p.name} API key`}
            autoComplete="off"
            style={{
              width: "100%",
              padding: "6px 8px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--line-2)",
              background: "var(--bg)",
              color: "var(--ink)",
              fontSize: "var(--text-sm)",
            }}
          />
          {err && (
            <div
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--state-error)",
                marginTop: 6,
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
            marginTop: 12,
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            fontSize: "var(--text-sm)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--brand)",
            fontFamily: "inherit",
            transition: "color 0.14s ease",
          }}
        >
          {connected ? "Update key" : "Add key"}
        </button>
      )}
    </div>
  );
}

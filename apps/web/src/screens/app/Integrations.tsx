import { useCallback, useEffect, useState } from "react";
import {
  Icon,
  LoadingBlock,
  type RunState,
  StatusPill,
} from "../../components";
import {
  api,
  type ChatRow,
  type ConnectionRow,
  type FormRow,
  type ProviderCredential,
  type WebhookRow,
  UnauthorizedError,
} from "../../lib/api";
import { PHONE_QUERY, useMediaQuery } from "../../lib/useMediaQuery";
import { AddIntegrations } from "./integrations/AddIntegrations";
import { CodeAgentCard } from "./integrations/CodeAgentCard";
import { McpAccess } from "./integrations/McpAccess";
import { ProviderCard } from "./integrations/ProviderCard";
import {
  chatUrl,
  formUrl,
  monoLabel,
  UrlCopy,
  webhookUrl,
} from "./integrations/shared";
import { WebhookItem } from "./integrations/WebhookItem";

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

export function Integrations() {
  const phone = useMediaQuery(PHONE_QUERY);
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
    <div
      style={{
        padding: phone ? "22px 14px 40px" : "22px 28px 40px",
        maxWidth: 1100,
      }}
    >
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
          tenant={tenant}
          hasKey={credentials.some((c) => c.provider === "claude-code")}
          keyValid={credentials.some(
            (c) => c.provider === "claude-code" && c.isValid,
          )}
          onSaved={load}
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

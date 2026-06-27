import { useEffect, useState } from "react";
import { Icon, StatusPill, type RunState } from "../../components";
import {
  api,
  type ConnectionRow,
  type WebhookRow,
  UnauthorizedError,
} from "../../lib/api";

/** Model providers — defined locally; the DC hard-codes these three + an "add" tile. */
const providers: {
  initial: string;
  name: string;
  models: string;
  color: string;
}[] = [
  {
    initial: "A",
    name: "Anthropic",
    models: "Claude Sonnet, Opus, Haiku",
    color: "var(--node-agent)",
  },
  {
    initial: "O",
    name: "OpenAI",
    models: "GPT-4o, GPT-4.1, o3",
    color: "var(--state-done)",
  },
  {
    initial: "G",
    name: "Google",
    models: "Gemini 2.5 Pro / Flash",
    color: "var(--node-trigger)",
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

export function Integrations() {
  const [connections, setConnections] = useState<ConnectionRow[] | null>(null);
  const [webhooks, setWebhooks] = useState<WebhookRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { tenantId } = await api.getMe();
        const [conns, hooks] = await Promise.all([
          api.listConnections(tenantId),
          api.listWebhooks(tenantId),
        ]);
        if (!alive) return;
        setConnections(conns);
        setWebhooks(hooks);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError(
          e instanceof UnauthorizedError
            ? "Sign in to view integrations"
            : "Could not reach the control plane (apps/api on :3000).",
        );
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

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

      {/* ===== Model providers ===== */}
      <div style={{ ...monoLabel, marginBottom: 11 }}>Model providers</div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4,1fr)",
          gap: 12,
          marginBottom: 26,
        }}
      >
        {providers.map((p) => (
          <div
            key={p.name}
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
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: "var(--state-done)",
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
          </div>
        ))}

        {/* add local model */}
        <button
          type="button"
          style={{
            background: "var(--card)",
            border: "1px dashed var(--line-2)",
            borderRadius: 11,
            padding: 15,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          <span
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: "var(--card-2)",
              color: "var(--ink-2)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="plus" size={16} strokeWidth={2} />
          </span>
          <span style={{ fontSize: 12, color: "var(--ink-2)" }}>
            Add local model
          </span>
        </button>
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
        <span style={monoLabel}>MCP servers</span>
        <button
          type="button"
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
            No connected servers yet — connect one to get started.
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
              Manage
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
                style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink)" }}
              >
                /hooks/{w.id}
              </div>
              <div
                style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 1 }}
              >
                {w.provider} · {w.workflowId}
              </div>
            </div>
            <StatusPill state="done" label="Active" />
          </div>
        ))}
      </div>
    </div>
  );
}

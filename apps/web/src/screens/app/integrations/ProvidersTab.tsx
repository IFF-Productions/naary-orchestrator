// Providers (BYOK) tab — one card per provider type, multiple named env-scoped
// connections per type (SQL/SMTP/signing), single key slot per env for model providers.
import { useState } from "react";
import {
  Button,
  Dialog,
  Icon,
  type IconName,
  StatusPill,
  useConfirm,
} from "../../../components";
import {
  api,
  type ConnectionRow,
  type ProviderCredential,
} from "../../../lib/api";
import { DatabaseForm, SigningForm, SmtpForm } from "./connection-forms";
import {
  cardShell,
  EnvChip,
  IconTile,
  introStyle,
  KebabMenu,
  LetterTile,
} from "./shared";

/** Model providers (BYOK key slots). One credential per provider PER ENVIRONMENT —
 *  the backend stores exactly one env-scoped key per provider (saving replaces it). */
const MODEL_PROVIDERS: {
  key: string;
  initial: string;
  name: string;
  models: string;
  color: string;
}[] = [
  {
    key: "anthropic",
    initial: "A",
    name: "Anthropic",
    models: "Claude Opus, Sonnet, Haiku",
    color: "var(--node-agent)",
  },
  {
    key: "openai",
    initial: "O",
    name: "OpenAI",
    models: "GPT-4o, GPT-4o mini, GPT-4.1",
    color: "var(--state-done)",
  },
  {
    key: "google",
    initial: "G",
    name: "Google",
    models: "Gemini 2.5 Pro / Flash",
    color: "var(--node-trigger)",
  },
];

/** Connection-backed provider groups (multiple NAMED connections per type per env). */
const CONNECTION_GROUPS: {
  id: string;
  name: string;
  kind: string;
  types: ConnectionRow["type"][];
  icon: IconName;
  color: string;
}[] = [
  {
    id: "sql",
    name: "SQL databases",
    kind: "Postgres · MySQL · SQL Server",
    types: ["postgres", "mysql", "mssql"],
    icon: "archive",
    color: "var(--node-mcp)",
  },
  {
    id: "smtp",
    name: "SMTP (email)",
    kind: "Send Email node",
    types: ["smtp"],
    icon: "card",
    color: "var(--node-http)",
  },
  {
    id: "signing",
    name: "Signing keys",
    kind: "HMAC · JWT · TOTP nodes",
    types: ["signing"],
    icon: "key",
    color: "var(--node-router)",
  },
];

const CONNECTION_LABEL: Record<ConnectionRow["status"], string> = {
  connected: "OK",
  needs_reauth: "Reauth",
  error: "Error",
};
const CONNECTION_STATE = {
  connected: "done",
  needs_reauth: "info",
  error: "error",
} as const;

/** Card frame: type tile + name/kind/count header + "Add connection" + rows. */
function ProviderTypeCard({
  tile,
  name,
  kind,
  count,
  addLabel,
  onAdd,
  children,
}: {
  tile: React.ReactNode;
  name: string;
  kind: string;
  count: number;
  addLabel: string;
  onAdd: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={cardShell}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 11,
          padding: "14px 18px",
          borderBottom: "1px solid var(--line)",
        }}
      >
        {tile}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: "var(--text-md)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--ink)",
            }}
          >
            {name}
          </div>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
            {kind} · {count} connection{count === 1 ? "" : "s"}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          onClick={onAdd}
          style={{ display: "flex", alignItems: "center", gap: 6 }}
        >
          <Icon name="plus" size={12} strokeWidth={2} />
          {addLabel}
        </button>
      </div>
      {children}
    </div>
  );
}

function EmptyRows() {
  return (
    <div
      style={{
        padding: "14px 18px",
        fontSize: "var(--text-sm)",
        color: "var(--ink-3)",
      }}
    >
      No connections in this environment.
    </div>
  );
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "12px 18px",
  borderBottom: "1px solid var(--line)",
};

export function ProvidersTab({
  tenant,
  env,
  credentials,
  connections,
  onChanged,
  onError,
}: {
  tenant: string | null;
  env: string | null;
  credentials: ProviderCredential[];
  connections: ConnectionRow[];
  onChanged: () => Promise<void> | void;
  onError: (msg: string) => void;
}) {
  const confirm = useConfirm();
  // Which model-provider key dialog is open (provider key), and which group form dialog.
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyErr, setKeyErr] = useState<string | null>(null);
  const [addGroup, setAddGroup] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const keyProvider = MODEL_PROVIDERS.find((p) => p.key === keyFor);
  const groupDef = CONNECTION_GROUPS.find((g) => g.id === addGroup);

  async function saveKey() {
    if (!tenant || !keyFor || !apiKey.trim()) return;
    setKeyBusy(true);
    setKeyErr(null);
    try {
      await api.saveCredential(tenant, keyFor, apiKey.trim());
      setApiKey("");
      setKeyFor(null);
      await onChanged();
    } catch {
      setKeyErr("Key rejected — check it's a valid key for this provider.");
    } finally {
      setKeyBusy(false);
    }
  }

  async function removeConnection(c: ConnectionRow) {
    if (!tenant || removing) return;
    const ok = await confirm({
      title: `Remove "${c.label}"?`,
      body: "This deletes its stored secret. Workflow nodes using this connection will fail until you reconnect.",
      confirmLabel: "Remove connection",
      danger: true,
    });
    if (!ok) return;
    setRemoving(c.id);
    void api
      .deleteConnection(tenant, c.id)
      .then(() => onChanged())
      .catch(() => onError("Could not remove the connection."))
      .finally(() => setRemoving(null));
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 6,
        }}
      >
        <div
          style={{
            fontSize: "var(--text-md)",
            fontWeight: "var(--weight-bold)",
            color: "var(--ink)",
          }}
        >
          Provider credentials
        </div>
        <span
          className="mono"
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--brand)",
            border: "1px solid var(--line-2)",
            borderRadius: "var(--radius-pill)",
            padding: "3px 9px",
          }}
        >
          BYOK
        </span>
      </div>
      <div style={{ ...introStyle, marginBottom: 16 }}>
        Each provider holds its credentials per environment — model providers
        keep one key per env; databases, SMTP and signing keys can hold multiple
        named connections. Values are stored encrypted and never shown again.
        Reusable named secrets (<code>{"{{ $secrets.NAME }}"}</code>) live under
        Settings → Secrets.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {/* ---- Model providers (one env-scoped key slot each) ---- */}
        {MODEL_PROVIDERS.map((p) => {
          const cred = credentials.find((c) => c.provider === p.key);
          return (
            <ProviderTypeCard
              key={p.key}
              tile={<LetterTile letter={p.initial} color={p.color} />}
              name={p.name}
              kind="LLM provider"
              count={cred ? 1 : 0}
              addLabel={cred ? "Replace key" : "Add key"}
              onAdd={() => {
                setKeyErr(null);
                setApiKey("");
                setKeyFor(p.key);
              }}
            >
              {cred ? (
                <div style={rowStyle}>
                  <EnvChip slug={env} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: "var(--text-sm)",
                        fontWeight: "var(--weight-semibold)",
                        color: "var(--ink)",
                      }}
                    >
                      API key
                    </div>
                    <div
                      className="mono"
                      style={{
                        fontSize: "var(--text-xs)",
                        color: "var(--ink-3)",
                        marginTop: 1,
                      }}
                    >
                      {p.models}
                    </div>
                  </div>
                  <StatusPill
                    state={cred.isValid ? "done" : "error"}
                    label={cred.isValid ? "Valid" : "Invalid"}
                  />
                  <KebabMenu
                    items={[
                      {
                        label: "Replace key…",
                        onClick: () => {
                          setKeyErr(null);
                          setApiKey("");
                          setKeyFor(p.key);
                        },
                      },
                    ]}
                  />
                </div>
              ) : (
                <div
                  style={{
                    padding: "14px 18px",
                    fontSize: "var(--text-sm)",
                    color: "var(--ink-3)",
                  }}
                >
                  No key in this environment — {p.models}.
                </div>
              )}
            </ProviderTypeCard>
          );
        })}

        {/* ---- Connection-backed providers (multiple named connections) ---- */}
        {CONNECTION_GROUPS.map((g) => {
          const rows = connections.filter((c) => g.types.includes(c.type));
          return (
            <ProviderTypeCard
              key={g.id}
              tile={<IconTile name={g.icon} color={g.color} />}
              name={g.name}
              kind={g.kind}
              count={rows.length}
              addLabel="Add connection"
              onAdd={() => setAddGroup(g.id)}
            >
              {rows.length === 0 && <EmptyRows />}
              {rows.map((c) => (
                <div key={c.id} style={rowStyle}>
                  <EnvChip slug={env} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: "var(--text-sm)",
                        fontWeight: "var(--weight-semibold)",
                        color: "var(--ink)",
                      }}
                    >
                      {c.label}
                    </div>
                    <div
                      className="mono"
                      style={{
                        fontSize: "var(--text-xs)",
                        color: "var(--ink-3)",
                        marginTop: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {c.type} · {c.serverUrl}
                      {c.usedByNodeCount !== undefined &&
                        ` · used by ${c.usedByNodeCount} node${
                          c.usedByNodeCount === 1 ? "" : "s"
                        }`}
                      {c.credentialLast4 && ` · ••••${c.credentialLast4}`}
                    </div>
                  </div>
                  <StatusPill
                    state={CONNECTION_STATE[c.status]}
                    label={CONNECTION_LABEL[c.status]}
                  />
                  <KebabMenu
                    items={[
                      {
                        label:
                          removing === c.id ? "Removing…" : "Remove connection",
                        danger: true,
                        disabled: removing !== null,
                        onClick: () => removeConnection(c),
                      },
                    ]}
                  />
                </div>
              ))}
            </ProviderTypeCard>
          );
        })}
      </div>

      {/* ---- Model-provider key dialog (the existing save-credential flow) ---- */}
      <Dialog
        open={keyFor !== null}
        onClose={() => setKeyFor(null)}
        title={keyProvider ? `${keyProvider.name} API key` : "API key"}
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setKeyFor(null)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={keyBusy || !apiKey.trim()}
              onClick={() => void saveKey()}
            >
              {keyBusy ? "Saving…" : "Save key"}
            </Button>
          </>
        }
      >
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={keyProvider ? `${keyProvider.name} API key` : "API key"}
          autoComplete="off"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !keyBusy) void saveKey();
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
            lineHeight: "var(--leading-snug)",
          }}
        >
          Saved into the <strong>{env ?? "default"}</strong> environment only.
          Validated on save, stored encrypted, never echoed back. Saving
          replaces this environment's existing key.
        </div>
        {keyErr && (
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--state-error)",
              marginTop: 8,
            }}
          >
            {keyErr}
          </div>
        )}
      </Dialog>

      {/* ---- Add-connection dialogs (the existing create forms, unchanged) ---- */}
      {tenant && (
        <Dialog
          open={addGroup !== null}
          onClose={() => setAddGroup(null)}
          title={
            addGroup === "sql"
              ? "Connect a database"
              : addGroup === "smtp"
                ? "Configure SMTP (email)"
                : "Add a signing key"
          }
        >
          {groupDef?.id === "sql" && (
            <DatabaseForm tenant={tenant} onChanged={onChanged} />
          )}
          {groupDef?.id === "smtp" && (
            <SmtpForm tenant={tenant} onChanged={onChanged} />
          )}
          {groupDef?.id === "signing" && (
            <SigningForm tenant={tenant} onChanged={onChanged} />
          )}
        </Dialog>
      )}
    </div>
  );
}

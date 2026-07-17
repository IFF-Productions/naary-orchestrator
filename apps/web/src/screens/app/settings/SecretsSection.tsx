// Environment Secrets ($secrets) section of the Settings screen.
import { Button, Card } from "../../../components";
import { inputStyle } from "./shared";

export function SecretsSection({
  secretNames,
  loaded,
  secretBusy,
  secretError,
  secretReplace,
  setSecretReplace,
  newSecret,
  setNewSecret,
  replaceSecret,
  removeSecret,
  addSecret,
}: {
  secretNames: string[];
  loaded: boolean;
  secretBusy: boolean;
  secretError: string | null;
  secretReplace: Record<string, string>;
  setSecretReplace: React.Dispatch<
    React.SetStateAction<Record<string, string>>
  >;
  newSecret: { name: string; value: string };
  setNewSecret: React.Dispatch<
    React.SetStateAction<{ name: string; value: string }>
  >;
  replaceSecret: (name: string) => Promise<void>;
  removeSecret: (name: string) => Promise<void>;
  addSecret: () => Promise<void>;
}) {
  return (
    <>
      <div
        className="mono"
        style={{
          fontSize: "var(--text-2xs)",
          fontWeight: "var(--weight-semibold)",
          letterSpacing: "var(--tracking-label)",
          textTransform: "uppercase",
          color: "var(--ink-3)",
          margin: "24px 0 12px",
        }}
      >
        Secrets
      </div>
      <div
        style={{
          fontSize: "var(--text-body)",
          lineHeight: "var(--leading-snug)",
          color: "var(--ink-2)",
          marginBottom: 12,
        }}
      >
        Encrypted, env-scoped secret values (API keys, tokens). Reference one as{" "}
        <code>{"{{ $secrets.NAME }}"}</code> in an{" "}
        <strong>HTTP Request node's headers or body</strong>, or in an{" "}
        <strong>MCP Tool node's arguments</strong>. Resolved only inside the
        activity that uses it, so a value never enters the flow, run data, or
        logs. Values are <strong>write-only</strong>: you can set or replace a
        secret, but its value is never shown again.
      </div>
      <Card style={{ padding: 18, marginBottom: 12 }}>
        {secretError && (
          <div
            style={{
              marginBottom: 12,
              fontSize: "var(--text-sm)",
              color: "var(--state-error)",
            }}
          >
            {secretError}
          </div>
        )}
        {secretNames.length === 0 && loaded && (
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink-3)",
              marginBottom: 12,
            }}
          >
            No secrets yet — add one below.
          </div>
        )}
        {secretNames.map((name) => (
          <div
            key={name}
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              marginBottom: 10,
            }}
          >
            <code
              style={{
                flex: "0 0 34%",
                fontSize: "var(--text-sm)",
                color: "var(--ink)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={name}
            >
              {name}
            </code>
            <input
              type="password"
              value={secretReplace[name] ?? ""}
              onChange={(e) =>
                setSecretReplace((prev) => ({
                  ...prev,
                  [name]: e.target.value,
                }))
              }
              placeholder="Set new value"
              autoComplete="new-password"
              style={{ ...inputStyle, flex: 1 }}
              disabled={!loaded || secretBusy}
            />
            <Button
              variant="secondary"
              disabled={!loaded || secretBusy || !(secretReplace[name] ?? "")}
              onClick={() => void replaceSecret(name)}
            >
              Update
            </Button>
            <Button
              variant="ghost"
              icon="trash"
              disabled={!loaded || secretBusy}
              title={`Delete ${name}`}
              onClick={() => void removeSecret(name)}
            >
              Delete
            </Button>
          </div>
        ))}
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            marginTop: secretNames.length ? 14 : 0,
            paddingTop: secretNames.length ? 14 : 0,
            borderTop: secretNames.length ? "1px solid var(--line)" : "none",
          }}
        >
          <input
            value={newSecret.name}
            onChange={(e) =>
              setNewSecret((n) => ({ ...n, name: e.target.value }))
            }
            placeholder="NAME"
            style={{ ...inputStyle, flex: "0 0 34%" }}
            disabled={!loaded || secretBusy}
          />
          <input
            type="password"
            value={newSecret.value}
            onChange={(e) =>
              setNewSecret((n) => ({ ...n, value: e.target.value }))
            }
            placeholder="value"
            autoComplete="new-password"
            style={{ ...inputStyle, flex: 1 }}
            disabled={!loaded || secretBusy}
          />
          <Button
            variant="primary"
            loading={secretBusy}
            disabled={!loaded || !newSecret.name.trim() || !newSecret.value}
            onClick={() => void addSecret()}
          >
            Add
          </Button>
        </div>
      </Card>
    </>
  );
}

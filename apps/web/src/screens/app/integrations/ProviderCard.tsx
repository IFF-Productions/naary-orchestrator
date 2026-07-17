// Model-provider BYOK key card for the Integrations screen.
import { useState } from "react";
import { Button } from "../../../components";
import { api } from "../../../lib/api";

/** A model-provider card with REAL connected status + a BYOK key form. */
export function ProviderCard({
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

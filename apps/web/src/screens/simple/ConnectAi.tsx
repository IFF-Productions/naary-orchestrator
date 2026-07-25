import { useEffect, useState } from "react";
import { Button } from "../../components";
import { api, type ProviderCredential } from "../../lib/api";
import { PHONE_QUERY, useMediaQuery } from "../../lib/useMediaQuery";

const PROVIDERS = [
  { key: "anthropic", label: "Anthropic (Claude)", hint: "sk-ant-…" },
  { key: "openai", label: "OpenAI (GPT)", hint: "sk-…" },
  { key: "google", label: "Google (Gemini)", hint: "AIza…" },
];

/**
 * Simple-mode guided BYOK (design PRODUCT-VARIANTS.md §5) — a friendly front-end to the SAME
 * credential store the Integrations screen uses. Non-devs need an AI provider key to run the AI
 * step; this asks for it without the full Integrations screen.
 */
export function ConnectAi() {
  const phone = useMediaQuery(PHONE_QUERY);
  const [tenant, setTenant] = useState<string | null>(null);
  const [creds, setCreds] = useState<ProviderCredential[]>([]);
  const [provider, setProvider] = useState("anthropic");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function load() {
    const me = await api.getMe();
    setTenant(me.tenantId);
    setCreds(await api.listCredentials(me.tenantId).catch(() => []));
  }
  useEffect(() => {
    void load();
  }, []);

  async function save() {
    if (!tenant || !key.trim()) return;
    setBusy(true);
    setStatus(null);
    try {
      await api.saveCredential(tenant, provider, key.trim());
      setKey("");
      setStatus("Connected ✓");
      await load();
    } catch {
      setStatus("That key was rejected — double-check it and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        // Phone gutters (#511) — Simple-mode screens were deferred from the wave.
        padding: phone ? "16px 14px 32px" : "22px 28px 40px",
        maxWidth: 560,
        animation: "naaryFadeUp .25s ease",
      }}
    >
      <div
        style={{
          fontSize: "var(--text-title)",
          fontWeight: "var(--weight-bold)",
          color: "var(--ink)",
          letterSpacing: "var(--tracking-tight)",
        }}
      >
        Connect your AI
      </div>
      <div
        style={{
          fontSize: "var(--text-body)",
          color: "var(--ink-2)",
          margin: "4px 0 20px",
        }}
      >
        Your automations use your own AI provider key. It's stored encrypted and
        never shown again.
      </div>

      <div
        style={{
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-card)",
          padding: 16,
        }}
      >
        <label style={{ display: "block", marginBottom: 12 }}>
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink-2)",
              marginBottom: 4,
            }}
          >
            Provider
          </div>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            style={field}
          >
            {PROVIDERS.map((p) => {
              const connected = creds.some(
                (c) => c.provider === p.key && c.isValid,
              );
              return (
                <option key={p.key} value={p.key}>
                  {p.label}
                  {connected ? " — connected" : ""}
                </option>
              );
            })}
          </select>
        </label>
        <label style={{ display: "block" }}>
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink-2)",
              marginBottom: 4,
            }}
          >
            API key
          </div>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={
              PROVIDERS.find((p) => p.key === provider)?.hint ?? "API key"
            }
            autoComplete="off"
            style={field}
          />
        </label>
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
            loading={busy}
            disabled={busy || !key.trim()}
            onClick={save}
          >
            {busy ? "Connecting…" : "Connect"}
          </Button>
          {status && (
            <span style={{ fontSize: "var(--text-sm)", color: "var(--ink-2)" }}>
              {status}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

const field: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line-2)",
  background: "var(--bg)",
  color: "var(--ink)",
  fontSize: "var(--text-body)",
};

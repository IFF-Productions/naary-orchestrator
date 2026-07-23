// Bot protection (Cloudflare Turnstile) settings — docs/design/TURNSTILE-BOT-PROTECTION.md, Slice 1.
// Per-environment config: the tenant enters their OWN Turnstile site + secret key (BYO), so their
// public form/chat pages get a bot gate (enforced at ingress in Slice 2). The secret is write-only:
// it's sent on save but never returned — a stored secret shows as a filled placeholder.
import { useCallback, useEffect, useState } from "react";
import { Button, Switch, TextInput } from "../../../components";
import type { Environment } from "../../../lib/api";
import { envScoped, type TurnstileConfig } from "./env-scoped";
import {
  EnvChip,
  ErrorLine,
  panelStyle,
  SectionHeader,
  SectionIntro,
} from "./shared";

/** Editable per-env form state (mirrors TurnstileConfig + the write-only secret draft). */
interface EnvForm {
  siteKey: string;
  secretKey: string; // draft only — never populated from the server (write-only)
  enabled: boolean;
  hasSecret: boolean;
  exists: boolean;
}

const EMPTY: EnvForm = {
  siteKey: "",
  secretKey: "",
  enabled: true,
  hasSecret: false,
  exists: false,
};

function toForm(cfg: TurnstileConfig | null): EnvForm {
  if (!cfg) return { ...EMPTY };
  return {
    siteKey: cfg.siteKey,
    secretKey: "",
    enabled: cfg.enabled,
    hasSecret: cfg.hasSecret,
    exists: true,
  };
}

export function TurnstileSection({ envs }: { envs: Environment[] }) {
  const [forms, setForms] = useState<Record<string, EnvForm>>({});
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (envs.length === 0) return;
    try {
      const cfgs = await Promise.all(
        envs.map((e) => envScoped.getTurnstile(e.id)),
      );
      const next: Record<string, EnvForm> = {};
      envs.forEach((e, i) => {
        next[e.id] = toForm(cfgs[i]);
      });
      setForms(next);
    } catch {
      setError("Couldn't load bot-protection settings.");
      setForms({});
    } finally {
      setLoaded(true);
    }
  }, [envs]);

  useEffect(() => {
    void load();
  }, [load]);

  function patch(envId: string, p: Partial<EnvForm>) {
    setForms((f) => ({ ...f, [envId]: { ...(f[envId] ?? EMPTY), ...p } }));
  }

  async function save(env: Environment) {
    const form = forms[env.id] ?? EMPTY;
    if (!form.siteKey.trim()) {
      setError(`Enter a site key for ${env.name}.`);
      return;
    }
    // A brand-new config with no secret can't gate anything — require it on first save.
    if (!form.hasSecret && !form.secretKey.trim()) {
      setError(`Enter a secret key for ${env.name}.`);
      return;
    }
    setBusy(env.id);
    setError(null);
    try {
      const saved = await envScoped.setTurnstile(env.id, {
        siteKey: form.siteKey.trim(),
        enabled: form.enabled,
        // Only send the secret when the user typed a new one (write-only).
        ...(form.secretKey.trim() ? { secretKey: form.secretKey.trim() } : {}),
      });
      patch(env.id, { ...toForm(saved) });
    } catch {
      setError(`Couldn't save ${env.name}'s settings.`);
    } finally {
      setBusy(null);
    }
  }

  async function clear(env: Environment) {
    setBusy(env.id);
    setError(null);
    try {
      await envScoped.deleteTurnstile(env.id);
      patch(env.id, { ...EMPTY });
    } catch {
      setError(`Couldn't remove ${env.name}'s settings.`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <SectionHeader title="Bot protection" />
      <SectionIntro>
        Add a Cloudflare <strong>Turnstile</strong> CAPTCHA to your public form
        and chat pages. Bring your own keys — create a Turnstile widget in your
        Cloudflare dashboard for your form/chat hostname, then paste the{" "}
        <strong>site key</strong> (public) and <strong>secret key</strong> here.
        The secret is encrypted and write-only — it's never shown again. Scoped
        per environment. Enforced at submit time once enabled (bad or missing
        challenge → the submission is rejected before any workflow runs).
      </SectionIntro>

      {error && <ErrorLine>{error}</ErrorLine>}

      {!loaded && (
        <div
          style={{ ...panelStyle, padding: "14px 18px", color: "var(--ink-3)" }}
        >
          Loading…
        </div>
      )}

      {loaded &&
        envs.map((env) => {
          const form = forms[env.id] ?? EMPTY;
          const saving = busy === env.id;
          return (
            <div
              key={env.id}
              style={{ ...panelStyle, padding: "16px 18px", marginBottom: 12 }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: 12,
                }}
              >
                <EnvChip env={env} />
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 12, color: "var(--ink-2)" }}>
                  Enabled
                </span>
                <Switch
                  checked={form.enabled}
                  onChange={(v) => patch(env.id, { enabled: v })}
                  aria-label={`Enable Turnstile for ${env.name}`}
                />
              </div>

              <label style={labelStyle}>Site key</label>
              <TextInput
                value={form.siteKey}
                onChange={(e) => patch(env.id, { siteKey: e.target.value })}
                placeholder="0x4AAAAAAA…"
                style={{ marginBottom: 10 }}
                disabled={saving}
              />

              <label style={labelStyle}>Secret key</label>
              <TextInput
                type="password"
                value={form.secretKey}
                onChange={(e) => patch(env.id, { secretKey: e.target.value })}
                placeholder={
                  form.hasSecret
                    ? "•••••••• stored — type to replace"
                    : "0x4AAAAAAA…"
                }
                autoComplete="new-password"
                disabled={saving}
              />

              <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                <Button
                  variant="primary"
                  size="sm"
                  loading={saving}
                  onClick={() => void save(env)}
                >
                  Save
                </Button>
                {form.exists && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={saving}
                    style={{ color: "var(--state-error)" }}
                    onClick={() => void clear(env)}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </div>
          );
        })}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 11.5,
  color: "var(--ink-2)",
  marginBottom: 6,
};

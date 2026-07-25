// Bot protection (Cloudflare Turnstile) + the SHARED public-pages domain allowlist —
// docs/design/TURNSTILE-BOT-PROTECTION.md and docs/design/EMBEDDED-PUBLIC-PAGES.md.
//
// Per-environment config: the tenant enters their OWN Turnstile site + secret key (BYO), so their
// public form/chat pages get a bot gate (enforced at ingress). The secret is write-only: it's sent
// on save but never returned — a stored secret shows as a filled placeholder.
//
// #617: "Allowed domains" is ONE list serving two features — Turnstile's solved-hostname check and
// the embed CORS allowlist on the anonymous /forms/:id + /chat/:id routes. Two lists would be two
// things to keep in sync for one real-world question ("which of my sites host these pages?"), so the
// list is shared and this is the single place to manage it. Consequence for the form: the Turnstile
// keys are required only when the bot gate is ENABLED — a tenant can save domains alone.
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
  /** Raw comma/newline-separated text of allowed domains (parsed to an array on save). */
  allowedHostnames: string;
  exists: boolean;
}

const EMPTY: EnvForm = {
  siteKey: "",
  secretKey: "",
  enabled: true,
  hasSecret: false,
  allowedHostnames: "",
  exists: false,
};

function toForm(cfg: TurnstileConfig | null): EnvForm {
  if (!cfg) return { ...EMPTY };
  return {
    siteKey: cfg.siteKey,
    secretKey: "",
    enabled: cfg.enabled,
    hasSecret: cfg.hasSecret,
    allowedHostnames: (cfg.allowedHostnames ?? []).join(", "),
    exists: true,
  };
}

/** Parse the raw "domains" text (comma/newline separated) into a clean host list. */
function parseHostnames(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
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
    // Keys are only needed to ENABLE the bot gate; a domains-only config (gate off) is valid (#617).
    if (form.enabled) {
      if (!form.siteKey.trim()) {
        setError(
          `Enter a site key for ${env.name}, or turn bot protection off.`,
        );
        return;
      }
      // A brand-new config with no secret can't gate anything — require it on first save.
      if (!form.hasSecret && !form.secretKey.trim()) {
        setError(
          `Enter a secret key for ${env.name}, or turn bot protection off.`,
        );
        return;
      }
    }
    setBusy(env.id);
    setError(null);
    try {
      const saved = await envScoped.setTurnstile(env.id, {
        siteKey: form.siteKey.trim(),
        enabled: form.enabled,
        allowedHostnames: parseHostnames(form.allowedHostnames),
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
      <SectionHeader title="Bot protection & embed domains" />
      <SectionIntro>
        Add a Cloudflare <strong>Turnstile</strong> CAPTCHA to your public form
        and chat pages, and list the domains you serve or embed them from. Bring
        your own keys — create a Turnstile widget in your Cloudflare dashboard
        for your form/chat hostname, then paste the <strong>site key</strong>{" "}
        (public) and <strong>secret key</strong> here. The secret is encrypted
        and write-only — it's never shown again. Scoped per environment.
        Enforced at submit time once enabled (bad or missing challenge → the
        submission is rejected before any workflow runs). Keys are only required
        to turn the gate <em>on</em> — you can save domains with it off.
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
                style={{ marginBottom: 10 }}
              />

              <label style={labelStyle}>
                Allowed domains (optional — shared)
              </label>
              <TextInput
                value={form.allowedHostnames}
                onChange={(e) =>
                  patch(env.id, { allowedHostnames: e.target.value })
                }
                placeholder="example.com, forms.example.com"
                disabled={saving}
              />
              <div
                style={{
                  fontSize: 11,
                  color: "var(--ink-3)",
                  marginTop: 4,
                }}
              >
                Comma-separated hostnames (<code>example.com</code>) — pasted
                URLs are normalised. One list, two jobs.{" "}
                <strong>Bot protection:</strong> a challenge solved on any other
                domain is rejected server-side — non-spoofable, and it kills
                site-key-lift replay. <strong>Embedding:</strong> only these
                domains may call your public form/chat endpoints from their own
                JavaScript (cross-origin); other origins are refused by the
                browser. Leave blank to allow any — that's today's behaviour, so
                existing embeds keep working.
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--ink-3)",
                  marginTop: 6,
                }}
              >
                Two things worth knowing. <strong>Which host to list:</strong>{" "}
                Turnstile matches the hostname of the page the widget actually
                rendered on — for a JavaScript embed that's your own site, but
                for the <em>iframe</em> snippet it's this Naary instance's
                hostname (the framed page). If you use the iframe snippet with
                bot protection on, list that host too, or those submissions will
                be rejected. <strong>Removing</strong> this configuration clears
                the domain list with it, so embed access reverts to allowing any
                origin. And the embed side is a browser rule, not a security
                boundary: bot protection, rate limits and your budget cap are
                what actually protect these endpoints.
              </div>

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

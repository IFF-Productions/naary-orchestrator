// Connection/credential create forms (MCP, GitHub App, database, SMTP, signing) for the Integrations screen.
import { useState } from "react";
import { Button } from "../../../components";
import { api } from "../../../lib/api";
import { ConnectionTestControl } from "./ConnectionTestControl";
import { fieldLabel, fieldStyle, introStyle } from "./shared";

/** Connect a SQL database (postgres/mssql) for the SQL Query node. The connection
 *  string (DSN) is the secret → stored encrypted as the connection token; the host
 *  is a non-secret display value. The DSN is NEVER placed in serverUrl. */
export function DatabaseForm({
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

export function SmtpForm({
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

export function SigningForm({
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
export function GithubAppForm({ tenant }: { tenant: string }) {
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

/** Values the MCP registry browser (#578) can pre-fill. Used only as the initial state — the form
 *  is mounted inside a Dialog and unmounted on close, so a remount resets it (no effect-sync). */
export interface ConnectFormPrefill {
  label?: string;
  serverUrl?: string;
  type?: "github" | "atlassian" | "custom";
  authMode?: "api_token" | "pat" | "oauth";
  /** A short, already-sanitized note shown above the fields (e.g. "needs no credential"). */
  note?: string;
}

export function ConnectForm({
  tenant,
  onChanged,
  prefill,
}: {
  tenant: string;
  onChanged: () => Promise<void> | void;
  /** Pre-filled transport/auth from a picked registry server; the user still supplies credentials. */
  prefill?: ConnectFormPrefill;
}) {
  const [label, setLabel] = useState(prefill?.label ?? "");
  const [serverUrl, setServerUrl] = useState(prefill?.serverUrl ?? "");
  const [type, setType] = useState<"github" | "atlassian" | "custom">(
    prefill?.type ?? "custom",
  );
  const [authMode, setAuthMode] = useState<"api_token" | "pat" | "oauth">(
    prefill?.authMode ?? "api_token",
  );
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  /** Id of the connection just saved, so its Test control can be offered inline (#701). */
  const [tested, setTested] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setMsg(null);
    setTested(null);
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
      // "Connected" here means STORED, not verified — nothing has asked the provider yet (#701).
      // Surface the Test control for the connection we just made so the user can find out now
      // rather than at runtime, inside a workflow, as a 401 on a node.
      setMsg("Saved — not yet verified.");
      setTested(conn.id);
      await onChanged();
    } catch (e) {
      setTested(null);
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
      {prefill?.note && (
        // Plain TEXT (React escapes it) and the string is sanitized server-side — registry
        // descriptions are attacker-authorable, so this is never rendered as HTML.
        <div style={{ ...introStyle, marginBottom: 10 }}>{prefill.note}</div>
      )}
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
      {tested && (
        // Offered right after a save so "is this token good?" is answered before the user leaves.
        <div style={{ marginTop: 12 }}>
          <ConnectionTestControl
            tenant={tenant}
            connectionId={tested}
            onTested={onChanged}
          />
        </div>
      )}
    </>
  );
}

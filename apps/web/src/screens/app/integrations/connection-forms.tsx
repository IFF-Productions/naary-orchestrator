// Connection/credential create forms (MCP, GitHub App, database, SMTP, signing) for the Integrations screen.
import { useState } from "react";
import { INTEGRATION_PROVIDERS } from "@naary/dsl";
import { Button } from "../../../components";
import { api } from "../../../lib/api";
import { ConnectionTestControl } from "./ConnectionTestControl";
import {
  catalogConnectPrefill,
  connectableProviders,
  splitInlineCode,
} from "./catalog-connect-prefill";
import type { ResolvedCredentialSetup } from "@naary/dsl";
import { fieldLabel, fieldStyle, introStyle } from "./shared";

/**
 * Providers whose API host is the CONNECTION's Server URL rather than the catalog's `baseUrl`
 * (a Jira site, a Shopify store). DERIVED from the catalog rather than typed out: a hand-written
 * list goes stale the first time a provider is added, and this sentence is the only thing between
 * a user and a connection that 404s every call.
 */
export const PER_TENANT_HOSTS = INTEGRATION_PROVIDERS.filter(
  (p) => p.baseUrlFromConnection,
)
  .map((p) => p.label)
  .join(", ");

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

export function FirestoreForm({
  tenant,
  onChanged,
}: {
  tenant: string;
  onChanged: () => Promise<void> | void;
}) {
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      await api.createConnection(tenant, {
        type: "firestore",
        label: label.trim(),
        // Non-secret display name — Firestore's host is fixed, so there is no URL to set.
        serverUrl: label.trim(),
        // The stored secret is a Google OAuth ACCESS token, sent as a bearer by the
        // activity via the shared resolveAuthHeader path (same as every api_token
        // connection). Google supports neither RFC-8414 discovery nor dynamic client
        // registration, so the interactive `oauth` consent flow cannot be used here.
        authMode: "api_token",
        token: token.trim(),
      });
      setLabel("");
      setToken("");
      setMsg("Saved ✓");
      await onChanged();
    } catch (e) {
      setMsg(
        e instanceof Error && /400/.test(e.message)
          ? "Check the fields."
          : "Could not save the Firestore connection.",
      );
    } finally {
      setBusy(false);
    }
  }

  const ready = Boolean(label.trim() && token.trim());

  return (
    <>
      <div style={{ marginBottom: 10 }}>
        <span style={fieldLabel}>Label</span>
        <input
          style={fieldStyle}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="prod-firestore"
        />
      </div>
      <div style={{ marginBottom: 10 }}>
        <span style={fieldLabel}>
          Google OAuth access token (stored encrypted)
        </span>
        <input
          style={fieldStyle}
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="ya29.…"
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
        Used by the Firestore Read and Firestore Write nodes. Needs the{" "}
        <code>https://www.googleapis.com/auth/datastore</code> scope — a Google
        API <em>key</em> will not work, because keys travel in a{" "}
        <code>?key=</code> query parameter and these nodes only send an{" "}
        <code>Authorization</code> header. The project id is set per node, so
        one connection can address several projects.
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
/**
 * Atlassian 3LO connect (#241 / APP-AUTH.md §3b) — the UI half that was never built. The API has
 * had the whole flow since the SSO work (`atlassian-oauth.controller.ts`: start → auth.atlassian.com
 * → ACS → cloudId), but nothing in the SPA called it, so the only reachable Atlassian connection
 * was the API-token kind.
 *
 * TWO STEPS, unlike the GitHub App button beside it, and the difference is the provider's:
 *  - GitHub App is INSTALL-first — GitHub yields an installation_id only after the user installs,
 *    so the callback creates the connection and we send only a label.
 *  - Atlassian 3LO is CONNECTION-first — `POST …/atlassian/oauth/start` looks the connection up by
 *    id to read the environment the consent belongs to (the callback is `@Public()` and cannot
 *    carry an X-Environment-Id header, so the env has to ride in the signed state).
 * So this creates the connection, then immediately starts consent with its id.
 *
 * If consent is abandoned, the connection remains with no grant — visible, labelled, and
 * re-connectable — rather than the flow silently leaving nothing behind. That is the better of the
 * two failure modes: a half-finished connection you can see beats one you cannot.
 */
export function AtlassianAppForm({ tenant }: { tenant: string }) {
  const [label, setLabel] = useState("");
  const [site, setSite] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function connect() {
    const siteUrl = site.trim();
    if (!siteUrl) {
      setMsg("Enter your Atlassian site URL.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const conn = await api.createConnection(tenant, {
        type: "atlassian",
        authMode: "oauth",
        label: label.trim() || "Atlassian",
        serverUrl: siteUrl,
      });
      setMsg("Redirecting to Atlassian…");
      const { authorizeUrl } = await api.startAtlassianConsent(tenant, conn.id);
      window.location.assign(authorizeUrl); // leave the form as-is; we navigate away
    } catch (e) {
      // Name the likeliest cause. Atlassian 3LO needs PLATFORM credentials
      // (ATLASSIAN_OAUTH_CLIENT_ID/_SECRET); without them the API refuses at `start`, and
      // "try again" would be advice that cannot work.
      const text = e instanceof Error ? e.message : "";
      setMsg(
        /not configured/i.test(text)
          ? "Atlassian OAuth isn't configured on this server yet — an admin must set the Atlassian app credentials."
          : "Could not start Atlassian consent — check the site URL and try again.",
      );
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
          placeholder="Atlassian (prod)"
        />
      </div>
      <div style={{ marginBottom: 12 }}>
        <span style={fieldLabel}>Site URL</span>
        <input
          style={fieldStyle}
          value={site}
          onChange={(e) => setSite(e.target.value)}
          placeholder="https://your-site.atlassian.net"
        />
      </div>
      <p style={{ fontSize: 12, color: "var(--ink-3)", margin: "0 0 12px" }}>
        You&apos;ll be sent to Atlassian to approve access. No API token is
        stored — the grant is held server-side and refreshed automatically.
      </p>
      {msg && (
        <p style={{ fontSize: 12, color: "var(--ink-2)", margin: "0 0 12px" }}>
          {msg}
        </p>
      )}
      <Button variant="primary" disabled={busy} onClick={() => void connect()}>
        {busy ? "Connecting…" : "Connect Atlassian"}
      </Button>
    </>
  );
}

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

/** Catalog prose marks literals with backticks; render those as code rather than showing them. */
function Hint({ text }: { text: string }) {
  return (
    <>
      {splitInlineCode(text).map((part, i) =>
        part.code ? (
          <code key={i} className="mono">
            {part.text}
          </code>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

/**
 * WHERE TO GET THE TOKEN, in the dialog that asks for it (#1063).
 *
 * The catalog has known this per provider for a while, but only `docs/integrations/<key>.md` ever
 * showed it — a page you have to know exists, leave the screen for, and come back from. Everything
 * here is authored per provider and rendered only when present, so a provider nobody has written
 * up yet shows nothing rather than a set of empty headings. (`tokenFormat` is the exception and is
 * deliberately NOT rendered here — it belongs beside the token input, further down the form.)
 */
function CredentialSetupHelp({ setup }: { setup: ResolvedCredentialSetup }) {
  const { tokenUrl, scopes, steps } = setup;
  if (!tokenUrl && !scopes?.length && !steps?.length) return null;

  return (
    <div
      style={{
        marginTop: 8,
        paddingTop: 8,
        borderTop: "1px solid var(--line-2)",
        color: "var(--ink-3)",
      }}
    >
      <div style={{ color: "var(--ink-2)", fontWeight: 600 }}>
        Where to get it
      </div>
      {steps && steps.length > 0 && (
        <ol style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          {steps.map((s) => (
            <li key={s} style={{ marginTop: 2 }}>
              <Hint text={s} />
            </li>
          ))}
        </ol>
      )}
      {scopes && scopes.length > 0 && (
        <div style={{ marginTop: 6 }}>
          Scopes to tick:{" "}
          {scopes.map((s, i) => (
            <span key={s}>
              {i > 0 && ", "}
              <code className="mono">{s}</code>
            </span>
          ))}
        </div>
      )}
      {tokenUrl && (
        // `noreferrer` as well as `noopener`: this leaves the app for a third-party console.
        <div style={{ marginTop: 6 }}>
          <a href={tokenUrl} target="_blank" rel="noopener noreferrer">
            Open the token page ↗
          </a>
        </div>
      )}
    </div>
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
  /**
   * The catalog provider this connection is FOR ("" = custom/manual).
   *
   * Picking one fills in the endpoint and states the exact auth header, instead of leaving the
   * author to know that PagerDuty means Type=Custom, `https://api.pagerduty.com`, and a raw token
   * sent as `Authorization: Token token=…` — three facts the catalog already holds (#815).
   */
  const [providerKey, setProviderKey] = useState("");
  const picked = providerKey ? catalogConnectPrefill(providerKey) : undefined;

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
      {/* Provider-first: pick the service and the rest fills itself in. Everything below comes
          from the integration catalog, which already knows the endpoint, the header and the
          prefix — it just was not reachable from the form where you need it (#815). */}
      <div style={{ marginBottom: 10 }}>
        <span style={fieldLabel}>Service</span>
        <select
          style={fieldStyle}
          value={providerKey}
          onChange={(e) => {
            const key = e.target.value;
            setProviderKey(key);
            const p = catalogConnectPrefill(key);
            if (!p) return;
            // Only fill an EMPTY label — never overwrite something already typed.
            setLabel((cur) => cur || p.label);
            setServerUrl(p.serverUrl);
            setType(p.type);
            setAuthMode(p.authMode);
          }}
        >
          <option value="">Custom / other…</option>
          {connectableProviders().map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      {picked && (
        <div
          style={{
            marginBottom: 10,
            padding: "8px 10px",
            border: "1px solid var(--line-2)",
            borderRadius: "var(--radius-sm)",
            background: "var(--card)",
            fontSize: "var(--text-xs)",
            color: "var(--ink-2)",
            lineHeight: 1.5,
          }}
        >
          {/* The EXACT header, not "api_token" — which is true of nearly every provider and so
              tells you nothing about whether the value you pasted is the right shape. */}
          <div>
            Sent as <code className="mono">{picked.authHeader}</code>
          </div>
          <div style={{ marginTop: 4, color: "var(--ink-3)" }}>
            {picked.authNote}
          </div>
          {/* Not on the OAuth path: there is no token to mint there, and "create a personal
              access token" is a wrong instruction, not merely a redundant one. Same reason the
              token field itself is hidden for `oauth`. */}
          {authMode !== "oauth" && (
            <CredentialSetupHelp setup={picked.credentialSetup} />
          )}
        </div>
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
          placeholder={
            picked?.hostFromConnection
              ? "https://your-site.atlassian.net"
              : "https://mcp.example.com"
          }
        />
        {picked && (
          // The distinction that breaks people: for most providers this field is cosmetic (the
          // catalog's baseUrl wins), but for a per-tenant host it IS the address every call goes
          // to. Same sentence can't serve both, so the catalog decides which one you get.
          <div
            style={{
              marginTop: 4,
              fontSize: "var(--text-xs)",
              color: picked.hostFromConnection
                ? "var(--ink-2)"
                : "var(--ink-3)",
            }}
          >
            {picked.serverUrlHint}
          </div>
        )}
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
          {/* What the pasted value should LOOK like (#1063). The panel above states the header
              and the endpoint; neither tells you what to paste, which is what the person with a
              provider console open in the next tab actually needs. Authored where the trap is
              provider-specific (Stripe's `pk_…`, Zendesk's literal `/token`), derived from the
              auth scheme otherwise — so this line is never empty. */}
          {picked && (
            <div
              style={{
                marginTop: 5,
                fontSize: "var(--text-xs)",
                color: "var(--ink-3)",
                lineHeight: 1.5,
              }}
            >
              <Hint text={picked.credentialSetup.tokenFormat} />
            </div>
          )}
          {/* #815 — two traps that produce a runtime 401 with no form error. Both are facts about
              how the code behaves, stated where the mistake is made rather than discovered on a
              run: the auth scheme's prefix is applied by `buildIntegrationRequest`, and a catalog
              provider ignores this Server URL in favour of the catalog's own baseUrl. */}
          {/* Only when NO service was picked. With one picked, the precise header + endpoint are
              already stated above (and the paste format directly above this), so repeating the
              generic "for per-tenant hosts (Mattermost, DeepL, …)" list here just makes the
              reader work out which clause applies to them. */}
          {type === "custom" && !picked && (
            <div
              style={{
                marginTop: 5,
                fontSize: "var(--text-xs)",
                color: "var(--ink-3)",
                lineHeight: 1.5,
              }}
            >
              Paste the token <strong>raw</strong> — any scheme prefix (
              <code className="mono">Bearer</code>,{" "}
              <code className="mono">Token token=</code>) is added for you, and
              including it yourself causes a 401. A <em>custom</em> connection
              is also what the catalog providers (PagerDuty, Stripe, …) use.
              Most take their API host from the catalog, so the Server URL above
              is only a label — but for per-tenant hosts ({PER_TENANT_HOSTS}) it{" "}
              <strong>is</strong> the host that gets called, so put your real
              one there.
            </div>
          )}
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

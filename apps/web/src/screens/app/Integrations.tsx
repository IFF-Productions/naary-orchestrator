// Integrations — four env-scoped tabs: Providers (BYOK) · Webhooks · MCP & API · Apps & agents.
// The app shell owns the environment switcher; every list here is already scoped to the active
// env server-side (X-Environment-Id), so row env chips echo that real binding.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { LoadingBlock, SegmentedToggle, Toast } from "../../components";
import {
  api,
  type ChatRow,
  type ConnectionRow,
  type FormRow,
  type ProviderCredential,
  type WebhookRow,
  UnauthorizedError,
} from "../../lib/api";
import { useActiveEnvironment } from "../../lib/useActiveEnvironment";
import { PHONE_QUERY, useMediaQuery } from "../../lib/useMediaQuery";
import { APP_CONNECTION_TYPES, AppsTab } from "./integrations/AppsTab";
import { McpApiTab } from "./integrations/McpApiTab";
import { ProvidersTab } from "./integrations/ProvidersTab";
import { WebhooksTab } from "./integrations/WebhooksTab";

type TabId = "providers" | "webhooks" | "mcp" | "apps";

const TABS: { value: TabId; label: string }[] = [
  { value: "providers", label: "Providers (BYOK)" },
  { value: "webhooks", label: "Webhooks" },
  { value: "mcp", label: "MCP & API" },
  { value: "apps", label: "Apps & agents" },
];

const isTab = (v: string | null): v is TabId =>
  v === "providers" || v === "webhooks" || v === "mcp" || v === "apps";

interface ToastItem {
  id: number;
  kind: "info" | "done" | "error";
  text: string;
}

// A friendly message for the `?connect_error=<code>` a connect callback bounces back with.
const CONNECT_ERROR_TEXT: Record<string, string> = {
  github_app:
    "Couldn't finish the GitHub App connection — the install link may have expired or already been used. Start again from Connect.",
  oauth:
    "Couldn't finish the connection — the authorization link may have expired or already been used. Start again from Connect.",
};

export function Integrations() {
  const phone = useMediaQuery(PHONE_QUERY);
  const env = useActiveEnvironment();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: TabId = isTab(tabParam) ? tabParam : "providers";

  const [tenant, setTenant] = useState<string | null>(null);
  const [connections, setConnections] = useState<ConnectionRow[] | null>(null);
  const [webhooks, setWebhooks] = useState<WebhookRow[] | null>(null);
  const [forms, setForms] = useState<FormRow[] | null>(null);
  const [chats, setChats] = useState<ChatRow[] | null>(null);
  const [credentials, setCredentials] = useState<ProviderCredential[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Transient toasts (used for the connect-callback outcome below).
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastId = useRef(0);
  const toastTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const dismissToast = useCallback(
    (id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)),
    [],
  );
  const toast = useCallback(
    (kind: ToastItem["kind"], text: string) => {
      const id = ++toastId.current;
      setToasts((ts) => [...ts, { id, kind, text }]);
      toastTimers.current.push(setTimeout(() => dismissToast(id), 4200));
    },
    [dismissToast],
  );
  useEffect(
    () => () => {
      for (const h of toastTimers.current) clearTimeout(h);
    },
    [],
  );

  // A connect callback (GitHub App install / OAuth consent) 302s the browser back here with
  // `?connected=1` or `?connect_error=<code>`. Surface the outcome as a toast, then strip those
  // params (keep `tab`) so a refresh doesn't re-fire it. Runs once per distinct outcome param.
  useEffect(() => {
    const connected = searchParams.get("connected");
    const connectError = searchParams.get("connect_error");
    if (!connected && !connectError) return;
    if (connected) toast("done", "Connection added.");
    else if (connectError)
      toast(
        "error",
        CONNECT_ERROR_TEXT[connectError] ??
          "Couldn't finish the connection. Start again from Connect.",
      );
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("connected");
        next.delete("connect_error");
        return next;
      },
      { replace: true },
    );
    // Depend on the raw param values so it fires once per outcome, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.get("connected"), searchParams.get("connect_error")]);

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

  // Header meta: credentials + connections in this env (webhooks counted on their tab).
  const connectedCount = useMemo(
    () => (connections?.length ?? 0) + credentials.length,
    [connections, credentials],
  );

  const setTab = (v: TabId) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("tab", v);
        return next;
      },
      { replace: true },
    );

  return (
    <div
      style={{
        padding: phone ? "22px 14px 40px" : "22px 28px 40px",
        maxWidth: 1100,
      }}
    >
      {/* heading + segmented tabs — the header wraps onto a second row before it
          overflows; the four-tab segmented control scrolls sideways inside its own
          container so it never pushes the page body wider than the viewport. */}
      <div
        style={{
          display: "flex",
          alignItems: phone ? "stretch" : "flex-end",
          flexDirection: phone ? "column" : "row",
          flexWrap: "wrap",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 22,
        }}
      >
        <div>
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
            Credentials, webhooks, MCP &amp; agents ·{" "}
            <span className="mono">{connectedCount}</span> connection
            {connectedCount === 1 ? "" : "s"} in this environment.
          </div>
        </div>
        <div
          style={{
            overflowX: "auto",
            maxWidth: "100%",
            paddingBottom: 2,
            WebkitOverflowScrolling: "touch",
          }}
        >
          <SegmentedToggle options={TABS} value={tab} onChange={setTab} />
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

      {loading ? (
        <LoadingBlock />
      ) : (
        <div key={tab} className="naary-step-enter">
          {tab === "providers" && (
            <ProvidersTab
              tenant={tenant}
              env={env}
              credentials={credentials.filter(
                // code-agent CLI slots are rendered on the Apps tab (dedicated cards), not as
                // model-provider (BYOK) keys here.
                (c) =>
                  !["claude-code", "cursor", "copilot", "gemini-cli"].includes(
                    c.provider,
                  ),
              )}
              connections={(connections ?? []).filter(
                (c) => !APP_CONNECTION_TYPES.includes(c.type),
              )}
              onChanged={load}
              onError={setError}
            />
          )}
          {tab === "webhooks" && (
            <WebhooksTab
              tenant={tenant}
              env={env}
              webhooks={webhooks ?? []}
              forms={forms ?? []}
              chats={chats ?? []}
              onChanged={load}
              onError={setError}
            />
          )}
          {tab === "mcp" && <McpApiTab env={env} phone={phone} />}
          {tab === "apps" && (
            <AppsTab
              tenant={tenant}
              env={env}
              connections={connections ?? []}
              credentials={credentials}
              onChanged={load}
              onError={setError}
            />
          )}
        </div>
      )}

      {/* connect-callback outcome toasts (bottom-right; shared Toast animates its entrance) */}
      {toasts.length > 0 && (
        <div
          style={{
            position: "fixed",
            right: 24,
            bottom: 22,
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 9,
            zIndex: 60,
          }}
        >
          {toasts.map((t) => (
            <div key={t.id}>
              <Toast kind={t.kind} onDismiss={() => dismissToast(t.id)}>
                {t.text}
              </Toast>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

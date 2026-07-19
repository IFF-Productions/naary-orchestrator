// Integrations — four env-scoped tabs: Providers (BYOK) · Webhooks · MCP & API · Apps & agents.
// The app shell owns the environment switcher; every list here is already scoped to the active
// env server-side (X-Environment-Id), so row env chips echo that real binding.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { LoadingBlock, SegmentedToggle } from "../../components";
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
      {/* heading + segmented tabs */}
      <div
        style={{
          display: "flex",
          alignItems: phone ? "stretch" : "flex-end",
          flexDirection: phone ? "column" : "row",
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
        <SegmentedToggle options={TABS} value={tab} onChange={setTab} />
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
                (c) => c.provider !== "claude-code",
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
    </div>
  );
}

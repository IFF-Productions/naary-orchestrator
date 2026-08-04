/**
 * Integration endpoints: authoring-time introspection (OpenAPI/GraphQL), BYOK
 * provider credentials, MCP/app/database connections (incl. OAuth + GitHub App
 * flows), webhooks, hosted forms, and hosted chats.
 */
import type {
  GraphQLSchemaSummary,
  McpToolSummary,
  OpenApiSummary,
  SqlSchemaSummary,
} from "@naary/dsl";
import { BASE, http, introspectFetch, introspectPost } from "./http";
import type {
  ChatDefinition,
  ChatReply,
  ChatRow,
  ConnectionInput,
  ConnectionRow,
  ConnectionTestResult,
  FormDefinition,
  FormRow,
  McpRegistryPage,
  ProviderCredential,
  RegisteredChat,
  RegisteredForm,
  RegisteredWebhook,
  WebhookRow,
} from "./types";

export const integrationsApi = {
  // --- MCP registry browser (#578) ---
  // Discovery is CONTROL-PLANE side: the api fetches the public registry (through its SSRF-guarded
  // fetch), sanitizes every field, and degrades to the curated in-repo list when the registry is
  // unavailable — so this call never fails just because the registry is down. Not tenant-scoped:
  // the catalog is global.
  listMcpRegistry(q?: string, limit?: number): Promise<McpRegistryPage> {
    const params = new URLSearchParams();
    if (q?.trim()) params.set("q", q.trim());
    if (limit !== undefined) params.set("limit", String(limit));
    const qs = params.toString();
    return http(`/mcp-registry/servers${qs ? `?${qs}` : ""}`);
  },

  // --- Authoring-time introspection (node autocomplete) ---
  // Fetch + parse a remote OpenAPI/Swagger JSON spec into an operation list, to pre-fill an
  // httpRequest node. `token` (optional) is sent as an Authorization header for a private spec,
  // forwarded VERBATIM to the spec URL (the server never resolves $secrets — see introspectFetch).
  introspectOpenApi(url: string, token?: string): Promise<OpenApiSummary> {
    // Accept a raw token OR a full pasted "Bearer …" value — never double-wrap.
    const t = token?.trim();
    return introspectFetch<OpenApiSummary>(
      "/introspect/openapi",
      url,
      t
        ? { Authorization: /^bearer\s/i.test(t) ? t : `Bearer ${t}` }
        : undefined,
    );
  },
  // Run the standard GraphQL introspection query against an endpoint → a schema summary
  // (types/fields), to help author a graphQL node's query. `token` (optional) auths a private
  // endpoint, forwarded verbatim (server never resolves $secrets).
  introspectGraphQL(
    url: string,
    token?: string,
  ): Promise<GraphQLSchemaSummary> {
    return introspectFetch<GraphQLSchemaSummary>(
      "/introspect/graphql",
      url,
      token?.trim() ? { Authorization: `Bearer ${token.trim()}` } : undefined,
    );
  },
  // Read a saved SQL connection's tables + columns, to autocomplete a sqlQuery/sqlExec node.
  // The connection (and its DSN) is resolved SERVER-SIDE from the id — unlike the two calls above
  // there is no URL and no token here, because the credential never reaches the browser.
  // `refresh` bypasses the server's TTL cache; it is the editor's Refresh button, for a schema
  // that just changed under a migration.
  introspectSqlSchema(
    connectionId: string,
    refresh?: boolean,
  ): Promise<SqlSchemaSummary> {
    return introspectPost<SqlSchemaSummary>("/introspect/sql", {
      connectionId,
      ...(refresh ? { refresh: true } : {}),
    });
  },

  // --- Integrations ---
  // Provider API keys (BYOK). The key is NEVER returned — list yields names + validity.
  listCredentials(tenantId: string): Promise<ProviderCredential[]> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/credentials`);
  },
  // Save/replace a provider key. Validated against the provider + encrypted at rest.
  saveCredential(
    tenantId: string,
    provider: string,
    apiKey: string,
  ): Promise<{ id: string; provider: string; isValid: boolean }> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/credentials`, {
      method: "POST",
      body: JSON.stringify({ provider, apiKey }),
    });
  },
  // Connected MCP servers / apps for the tenant. Tenant-scoped — pass tenantId from getMe().
  listConnections(tenantId: string): Promise<ConnectionRow[]> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/connections`);
  },
  // Registered webhook endpoints (never includes the signing secret). Tenant-scoped.
  listWebhooks(tenantId: string): Promise<WebhookRow[]> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/webhooks`);
  },
  // Connect an MCP server / app. The token (PAT/api_token) is stored encrypted
  // server-side; the returned view never echoes it.
  createConnection(
    tenantId: string,
    input: ConnectionInput,
  ): Promise<ConnectionRow> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/connections`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  // Begin interactive OAuth consent for a connection: returns the provider authorize
  // URL for the browser to redirect to. The provider then redirects to the API's
  // /oauth/callback, which exchanges the code and persists the encrypted refresh token.
  startOauthConsent(
    tenantId: string,
    connectionId: string,
  ): Promise<{ authorizeUrl: string }> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/connections/${encodeURIComponent(connectionId)}/oauth/start`,
      { method: "POST" },
    );
  },
  // Begin a GitHub App install: returns the github.com install URL for the browser to
  // redirect to. INVERTED vs OAuth — the connection does NOT exist yet: GitHub yields an
  // installation_id only AFTER the user installs, so the API's GET /github-app/callback
  // creates the github_app connection from it and redirects back. We send only a label.
  /**
   * Begin Atlassian 3LO consent for an EXISTING atlassian/oauth connection.
   *
   * Deliberately separate from `startOauthConsent`: that path does `.well-known` discovery +
   * dynamic registration against the connection's own serverUrl, which is right for an arbitrary
   * MCP server and wrong for Atlassian. Atlassian is a FIXED client — our platform app's id and
   * secret, fixed authorize/token endpoints, a required `audience`, and a cloudId resolved after
   * the exchange — so it has its own route on the API.
   */
  /**
   * The values an admin needs to register the Atlassian app: the callback URL THIS server will
   * send, and whether the platform credentials are set. Read so the UI can be the source of the
   * string rather than asking someone to retype it — the two must match exactly, and Atlassian's
   * rejection names neither side.
   */
  atlassianOauthConfig(tenantId: string): Promise<{
    redirectUri: string;
    configured: boolean;
    /** Optional: an API that predates the field answers without it (a deploy mid-rollout). */
    scopes?: string[];
  }> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/connections/atlassian/oauth/config`,
    );
  },
  startAtlassianConsent(
    tenantId: string,
    connectionId: string,
  ): Promise<{ authorizeUrl: string }> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/connections/${encodeURIComponent(connectionId)}/atlassian/oauth/start`,
      { method: "POST" },
    );
  },
  startGithubAppInstall(
    tenantId: string,
    input: { label: string },
  ): Promise<{ installUrl: string }> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/connections/github-app/install/start`,
      { method: "POST", body: JSON.stringify(input) },
    );
  },
  // Ask the provider whether this connection's credential actually works (#701). Runs the
  // provider's cheapest read-only, ZERO-ARGUMENT catalog action through the same request builder
  // the integration node uses, and updates the connection's status from the answer. Never writes:
  // a provider with no such action comes back `status: "unknown"` with the reason.
  // `provider` is required — a connection row carries no provider (a `custom` connection is
  // provider-agnostic; the provider is picked at the node), so the caller must say which API.
  testConnection(
    tenantId: string,
    connectionId: string,
    provider: string,
  ): Promise<ConnectionTestResult> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/connections/${encodeURIComponent(connectionId)}/test`,
      { method: "POST", body: JSON.stringify({ provider }) },
    );
  },
  // What tools this MCP connection's server offers (`tools/list`), so the canvas can OFFER a tool
  // name + that tool's argument names instead of asking the author to retype them. The API opens
  // ONE MCP session with the connection's stored credential (never returned) and sanitizes every
  // field — a tool name/description/schema is written by whoever runs that server.
  listMcpTools(
    tenantId: string,
    connectionId: string,
  ): Promise<McpToolSummary[]> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/connections/${encodeURIComponent(connectionId)}/mcp/tools`,
    );
  },
  // Disconnect (delete) a connection. Also removes its stored secret server-side.
  deleteConnection(tenantId: string, connectionId: string): Promise<void> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/connections/${encodeURIComponent(connectionId)}`,
      { method: "DELETE" },
    );
  },
  // Register a webhook trigger. Returns the ingress path + signing secret ONCE —
  // it is stored encrypted and never returned again, so surface it immediately.
  createWebhook(
    tenantId: string,
    input: { workflowId: string; provider: string; label?: string },
  ): Promise<RegisteredWebhook> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/webhooks`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  // Update a webhook endpoint's config (name/workflow/provider) IN PLACE — same id/URL/secret.
  // An EMPTY `label` clears the name; omitting it leaves the name unchanged.
  updateWebhook(
    tenantId: string,
    endpointId: string,
    patch: { workflowId?: string; provider?: string; label?: string },
  ): Promise<WebhookRow> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/webhooks/${encodeURIComponent(endpointId)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
  },
  // Rotate a webhook's signing secret. Returns the NEW secret ONCE (store it now).
  rotateWebhookSecret(
    tenantId: string,
    endpointId: string,
  ): Promise<{ signingSecret: string }> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/webhooks/${encodeURIComponent(endpointId)}/rotate-secret`,
      { method: "POST" },
    );
  },
  deleteWebhook(tenantId: string, endpointId: string): Promise<void> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/webhooks/${encodeURIComponent(endpointId)}`,
      { method: "DELETE" },
    );
  },
  // --- Hosted forms (public formTrigger endpoints) ---
  // Registered form endpoints for this tenant (no secret — forms are anonymous). Tenant-scoped.
  listForms(tenantId: string): Promise<FormRow[]> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/forms`);
  },
  // Register a form endpoint for a workflow. 400 if the tenant has no monthly budget cap
  // (the anonymous endpoint's required spend backstop). Returns the public path.
  createForm(
    tenantId: string,
    input: { workflowId: string },
  ): Promise<RegisteredForm> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/forms`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  // Upload a hosted-form logo. The RAW file is the body with its own content type — no multipart, and
  // no base64 (which would inflate past the JSON body limit). The server IGNORES this content type and
  // sniffs the file's magic bytes, so a mislabelled file is rejected on its contents, not its name.
  // Identical bytes return the existing asset id rather than creating a duplicate.
  uploadFormLogo(
    tenantId: string,
    file: File,
  ): Promise<{ assetId: string; contentType: string }> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/forms/assets`, {
      method: "POST",
      // Overrides http()'s default application/json (init.headers is spread last).
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    });
  },
  /** Public URL for an uploaded asset — same `/api` proxy as every other call. */
  formAssetUrl(assetId: string): string {
    return `${BASE}/forms/assets/${encodeURIComponent(assetId)}`;
  },
  deleteForm(tenantId: string, formId: string): Promise<void> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/forms/${encodeURIComponent(formId)}`,
      { method: "DELETE" },
    );
  },
  // PUBLIC (anonymous — no auth needed): the hosted form's definition + submit. Reached through
  // the same /api proxy; the endpoints are @Public() so no token is required.
  getFormDefinition(formId: string): Promise<FormDefinition> {
    return http(`/forms/${encodeURIComponent(formId)}`);
  },
  submitForm(
    formId: string,
    data: Record<string, unknown>,
    botToken?: string,
  ): Promise<{ status: string }> {
    return http(`/forms/${encodeURIComponent(formId)}`, {
      method: "POST",
      // The token rides in the body as `botToken` — provider-neutral, since it may now be a
      // Turnstile solution OR a Firebase App Check attestation. The server accepts the legacy
      // `turnstileToken` too (for cached embedded bundles), then validateSubmission strips
      // whichever arrived: neither is a declared field, so it never reaches the workflow.
      body: JSON.stringify(botToken ? { ...data, botToken } : data),
    });
  },
  // --- Hosted chats (public chatTrigger endpoints) ---
  listChats(tenantId: string): Promise<ChatRow[]> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/chats`);
  },
  createChat(
    tenantId: string,
    input: { workflowId: string },
  ): Promise<RegisteredChat> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/chats`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  deleteChat(tenantId: string, chatId: string): Promise<void> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/chats/${encodeURIComponent(chatId)}`,
      { method: "DELETE" },
    );
  },
  // PUBLIC (anonymous — no auth): the hosted chat's definition + send-a-message.
  getChatDefinition(chatId: string): Promise<ChatDefinition> {
    return http(`/chat/${encodeURIComponent(chatId)}`);
  },
  sendChatMessage(
    chatId: string,
    message: string,
    sessionId: string,
    botToken?: string,
  ): Promise<ChatReply> {
    return http(`/chat/${encodeURIComponent(chatId)}`, {
      method: "POST",
      // The server verifies `botToken` then ignores it (validateMessage only reads message +
      // sessionId). Each message needs a fresh token — single-use under both providers.
      body: JSON.stringify(
        botToken ? { message, sessionId, botToken } : { message, sessionId },
      ),
    });
  },
};

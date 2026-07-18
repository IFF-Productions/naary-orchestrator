/**
 * Integration endpoints: authoring-time introspection (OpenAPI/GraphQL), BYOK
 * provider credentials, MCP/app/database connections (incl. OAuth + GitHub App
 * flows), webhooks, hosted forms, and hosted chats.
 */
import type { GraphQLSchemaSummary, OpenApiSummary } from "@naary/dsl";
import { http, introspectFetch } from "./http";
import type {
  ChatDefinition,
  ChatRow,
  ConnectionInput,
  ConnectionRow,
  FormDefinition,
  FormRow,
  ProviderCredential,
  RegisteredChat,
  RegisteredForm,
  RegisteredWebhook,
  WebhookRow,
} from "./types";

export const integrationsApi = {
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
  startGithubAppInstall(
    tenantId: string,
    input: { label: string },
  ): Promise<{ installUrl: string }> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/connections/github-app/install/start`,
      { method: "POST", body: JSON.stringify(input) },
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
    input: { workflowId: string; provider: string },
  ): Promise<RegisteredWebhook> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/webhooks`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  // Update a webhook endpoint's config (workflow/provider) IN PLACE — same id/URL/secret.
  updateWebhook(
    tenantId: string,
    endpointId: string,
    patch: { workflowId?: string; provider?: string },
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
  ): Promise<{ status: string }> {
    return http(`/forms/${encodeURIComponent(formId)}`, {
      method: "POST",
      body: JSON.stringify(data),
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
  ): Promise<{ status: string; reply?: unknown }> {
    return http(`/chat/${encodeURIComponent(chatId)}`, {
      method: "POST",
      body: JSON.stringify({ message, sessionId }),
    });
  },
};

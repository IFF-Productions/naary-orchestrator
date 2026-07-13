/**
 * Thin client for the NestJS control plane (apps/api). Only the endpoints that
 * actually exist today are wired: start an execution, signal approval, read
 * live state. In dev, Vite proxies /api → http://localhost:3000 (see
 * vite.config.ts), so the browser avoids CORS.
 *
 * Auth: every call carries a bearer token — a fresh Firebase ID token when the
 * user is signed in, else the pasted `nry_` API token (see getBearerToken). The
 * server resolves tenantId from the token, so the client never sends it.
 */
import type { GraphDef } from "@naary/dsl";
import { getBearerToken } from "./firebase";

/** Thrown on a 401 so screens can prompt the user to set their API token. */
export class UnauthorizedError extends Error {
  constructor() {
    super("Not authenticated — set your API token on the sign-in screen.");
    this.name = "UnauthorizedError";
  }
}
export type ExecutionStatus =
  | "running"
  | "awaiting_approval"
  | "completed"
  | "rejected"
  | "budget_exceeded"
  | "circuit_open";

export interface ExecutionState {
  /** Widened: a run can be Temporal-failed/terminated/unknown, not just an
   *  ExecutionStatus. Rendered via runStatusUi (which takes any string). */
  status: string;
  currentNodeId: string;
  ctx: Record<string, unknown>;
}

/** One entry in a run's execution log (mirrors the API's RunEvent). */
export interface RunEvent {
  id: number;
  kind:
    | "started"
    | "activity"
    | "signal"
    | "timer"
    | "completed"
    | "error"
    | "continued";
  label: string;
  at: string | null;
  detail?: string;
}

const BASE = "/api";

// The active workspace, sent as `X-Workspace-Id` so the server scopes every request to the
// selected workspace (multi-workspace model). The WorkspaceProvider sets this once it has
// resolved the caller's workspaces; it's persisted so a reload keeps the selection. When
// unset (fresh signup, or an nry_ token with a single workspace) the server falls back to
// the caller's sole/claim workspace.
const WORKSPACE_KEY = "naary.workspace";
let activeWorkspaceId: string | null =
  typeof localStorage !== "undefined"
    ? localStorage.getItem(WORKSPACE_KEY)
    : null;

/** Set (or clear) the active workspace id sent on every subsequent request. */
export function setActiveWorkspace(id: string | null): void {
  activeWorkspaceId = id;
  if (typeof localStorage === "undefined") return;
  if (id) localStorage.setItem(WORKSPACE_KEY, id);
  else localStorage.removeItem(WORKSPACE_KEY);
}

/** The active workspace id, or null if none selected yet. */
export function getActiveWorkspace(): string | null {
  return activeWorkspaceId;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getBearerToken();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(activeWorkspaceId ? { "x-workspace-id": activeWorkspaceId } : {}),
      ...init?.headers,
    },
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}`);
  }
  // 204 / empty body (e.g. DELETE) — nothing to parse.
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

export interface GraphSummary {
  workflowKey: string;
  name: string;
  version: number;
  updatedAt: string;
  /** Whether the workflow's automatic triggers fire (n8n parity). Default true. */
  active: boolean;
}
export interface NamedGraph {
  workflowKey: string;
  name: string;
  version: number;
  graph: GraphDef;
}

export interface TemplateSummary {
  key: string;
  name: string;
  description: string;
  nodeCount: number;
}
export interface TemplateDetail extends TemplateSummary {
  graph: GraphDef;
}

/** A configured provider key (names + validity only — the key is never returned). */
export interface ProviderCredential {
  provider: string;
  isValid: boolean;
}

/** Result of a single-node test run. */
export type TestNodeResult =
  { pure: true; output: unknown } | { pure: false; message: string };

export const api = {
  // Built-in workflow templates (global, not tenant-scoped).
  listTemplates(): Promise<TemplateSummary[]> {
    return http("/templates");
  },
  // A template + its graph — the canvas loads this as a new draft to fork.
  getTemplate(key: string): Promise<TemplateDetail> {
    return http(`/templates/${encodeURIComponent(key)}`);
  },
  // List the tenant's workflows (latest version per key).
  listGraphs(): Promise<GraphSummary[]> {
    return http("/graphs");
  },
  // Fetch one workflow's latest graph (to open in the canvas).
  getGraph(workflowKey: string): Promise<NamedGraph> {
    return http(`/graphs/${encodeURIComponent(workflowKey)}`);
  },
  // Delete a workflow (all versions) + its triggers/schedules. Run history is kept.
  deleteGraph(workflowKey: string): Promise<{ deleted: true }> {
    return http(`/graphs/${encodeURIComponent(workflowKey)}`, {
      method: "DELETE",
    });
  },
  // --- Pinned node outputs (authoring-only samples; the interpreter never reads them) ---
  listPins(workflowKey: string): Promise<Record<string, unknown>> {
    return http(`/graphs/${encodeURIComponent(workflowKey)}/pins`);
  },
  pinNode(
    workflowKey: string,
    nodeId: string,
    output: unknown,
  ): Promise<{ pinned: true }> {
    return http(
      `/graphs/${encodeURIComponent(workflowKey)}/nodes/${encodeURIComponent(nodeId)}/pin`,
      { method: "PUT", body: JSON.stringify({ output }) },
    );
  },
  unpinNode(
    workflowKey: string,
    nodeId: string,
  ): Promise<{ cleared: boolean }> {
    return http(
      `/graphs/${encodeURIComponent(workflowKey)}/nodes/${encodeURIComponent(nodeId)}/pin`,
      { method: "DELETE" },
    );
  },
  // Single-node "Test": run one node against the workflow's pins (+ optional inputs override).
  // Pure nodes return { pure:true, output }; activity/control nodes return { pure:false, message }.
  testNode(
    workflowKey: string,
    nodeId: string,
    inputs?: Record<string, unknown>,
    autofillUpstream?: boolean,
  ): Promise<TestNodeResult> {
    return http(
      `/graphs/${encodeURIComponent(workflowKey)}/nodes/${encodeURIComponent(nodeId)}/test`,
      {
        method: "POST",
        body: JSON.stringify({
          ...(inputs ? { inputs } : {}),
          ...(autofillUpstream ? { autofillUpstream: true } : {}),
        }),
      },
    );
  },
  // AI workflow builder: describe a workflow → a validated DRAFT graph (unsaved).
  // `provider` (optional) picks the model provider; omitted ⇒ the server auto-selects
  // the tenant's first configured+valid one.
  generateGraph(
    prompt: string,
    provider?: string,
  ): Promise<{ name: string; graph: GraphDef }> {
    return http("/graphs/generate", {
      method: "POST",
      body: JSON.stringify(provider ? { prompt, provider } : { prompt }),
    });
  },
  // The workflowKey of this workflow's error handler (null if none).
  getErrorHandler(
    workflowKey: string,
  ): Promise<{ errorWorkflowKey: string | null }> {
    return http(`/graphs/${encodeURIComponent(workflowKey)}/error-handler`);
  },
  // Bind (or clear, with null) this workflow's error handler.
  setErrorHandler(
    workflowKey: string,
    errorWorkflowKey: string | null,
  ): Promise<{ errorWorkflowKey: string | null }> {
    return http(`/graphs/${encodeURIComponent(workflowKey)}/error-handler`, {
      method: "PUT",
      body: JSON.stringify({ errorWorkflowKey }),
    });
  },
  // Save a compiled graph under a workflowKey (versioned + content-hashed server-side).
  saveGraph(
    workflowKey: string,
    name: string,
    graph: GraphDef,
  ): Promise<{ workflowKey: string; version: number; contentHash: string }> {
    return http("/graphs", {
      method: "POST",
      body: JSON.stringify({ workflowKey, name, graph }),
    });
  },
  // tenantId is resolved from the token server-side — the body carries only the
  // optional run input + which stored graph (workflowKey) to run (default "default").
  // `input` overrides the Start node's sampleInput for this run; omit it to use the
  // sample (server-side precedence: body.input → Start sampleInput → fallback).
  startExecution(
    workflowKey?: string,
    input?: Record<string, unknown>,
  ): Promise<{ workflowId: string }> {
    const body: { workflowKey?: string; input?: Record<string, unknown> } = {};
    if (workflowKey) body.workflowKey = workflowKey;
    if (input !== undefined) body.input = input;
    return http("/executions", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  approve(
    id: string,
    approved: boolean,
    comment?: string,
  ): Promise<{ accepted: true }> {
    return http(`/executions/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      body: JSON.stringify({ approved, ...(comment ? { comment } : {}) }),
    });
  },
  // Decide many paused runs at once (same decision). Returns a per-run outcome so the
  // UI can show which ids slipped (already closed / no longer awaiting) without failing all.
  approveBatch(
    ids: string[],
    approved: boolean,
    comment?: string,
  ): Promise<BatchDecisionResult[]> {
    return http("/executions/approve-batch", {
      method: "POST",
      body: JSON.stringify({ ids, approved, ...(comment ? { comment } : {}) }),
    });
  },
  // Archive/restore many runs at once. Per-run outcome, like approveBatch.
  archiveBatch(
    ids: string[],
    archived: boolean,
  ): Promise<BatchDecisionResult[]> {
    return http("/executions/archive-batch", {
      method: "POST",
      body: JSON.stringify({ ids, archived }),
    });
  },
  // Cancel a running run (terminates the workflow). 409 if already finished.
  cancelRun(id: string): Promise<{ accepted: true }> {
    return http(`/executions/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    });
  },
  // Re-run a past run with its original trigger input (against the current graph).
  rerun(id: string): Promise<{ workflowId: string }> {
    return http(`/executions/${encodeURIComponent(id)}/rerun`, {
      method: "POST",
    });
  },
  // Soft-archive a run (hide it from the default Runs list). Read-model only.
  archiveRun(id: string): Promise<{ accepted: true }> {
    return http(`/executions/${encodeURIComponent(id)}/archive`, {
      method: "POST",
    });
  },
  // Restore an archived run back into the Runs list.
  unarchiveRun(id: string): Promise<{ accepted: true }> {
    return http(`/executions/${encodeURIComponent(id)}/unarchive`, {
      method: "POST",
    });
  },
  // The tenant's runs paused for approval, each with its prompt (approvals inbox).
  listAwaitingApprovals(): Promise<AwaitingApproval[]> {
    return http("/executions/awaiting");
  },
  getState(id: string): Promise<ExecutionState> {
    return http(`/executions/${encodeURIComponent(id)}`);
  },
  // The graph SNAPSHOT this run executed (accurate to what ran) — for the run-detail canvas.
  getRunGraph(id: string): Promise<{ graph: GraphDef }> {
    return http(`/executions/${encodeURIComponent(id)}/graph`);
  },
  // The signed resume-URL path for a run paused on a wait(webhook) node.
  getResumeUrl(id: string): Promise<{ path: string }> {
    return http(`/executions/${encodeURIComponent(id)}/resume-url`);
  },
  // The run's execution log (curated Temporal history).
  getRunHistory(id: string): Promise<RunEvent[]> {
    return http(`/executions/${encodeURIComponent(id)}/history`);
  },
  // Who am I — the SPA's tenantId (for tenant-scoped routes) + OIDC subject.
  getMe(): Promise<{ tenantId: string; subject?: string }> {
    return http("/me");
  },
  // The caller's workspaces + role (powers the workspace switcher).
  getMyWorkspaces(): Promise<Workspace[]> {
    return http("/me/workspaces");
  },
  // Per-user preferences (experience mode) — cross-device, keyed to the user server-side.
  // `mode` is null when the user hasn't chosen (or for API-token principals with no uid).
  getPreferences(): Promise<{ mode: string | null }> {
    return http("/me/preferences");
  },
  savePreferences(mode: string | null): Promise<{ mode: string | null }> {
    return http("/me/preferences", {
      method: "PUT",
      body: JSON.stringify({ mode }),
    });
  },
  // Create a new workspace owned by the caller. The tenantId is server-generated (never
  // sent from the client); requires a verified-email Firebase user (server-enforced).
  // `name` (optional) seeds the workspace display name.
  createWorkspace(name?: string): Promise<Workspace> {
    return http("/workspaces", {
      method: "POST",
      body: JSON.stringify(name?.trim() ? { name: name.trim() } : {}),
    });
  },
  // --- API tokens (for the MCP server + CLI/CI). Workspace-scoped via X-Workspace-Id. ---
  listApiTokens(): Promise<ApiTokenRow[]> {
    return http("/tokens");
  },
  // Returns the plaintext token ONCE — it can't be shown again.
  mintApiToken(label?: string): Promise<MintedToken> {
    return http("/tokens", {
      method: "POST",
      body: JSON.stringify(label?.trim() ? { label: label.trim() } : {}),
    });
  },
  revokeApiToken(id: string): Promise<void> {
    return http(`/tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  // Recent runs for the tenant. `archived` returns the hidden runs instead of the default list.
  listRuns(archived = false): Promise<RunSummary[]> {
    return http(archived ? "/executions?archived=true" : "/executions");
  },
  // Usage ledger (tokens + cost only). Tenant-scoped — pass the tenantId from getMe().
  getUsage(tenantId: string): Promise<UsageReport> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/usage`);
  },
  // --- Team (members) ---
  listMembers(tenantId: string): Promise<Member[]> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/members`);
  },
  addMember(tenantId: string, email: string, role?: string): Promise<Member> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/members`, {
      method: "POST",
      body: JSON.stringify({ email, ...(role ? { role } : {}) }),
    });
  },
  removeMember(tenantId: string, memberId: string): Promise<void> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/members/${encodeURIComponent(memberId)}`,
      { method: "DELETE" },
    );
  },
  // --- Settings ---
  getSettings(tenantId: string): Promise<TenantSettings> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/settings`);
  },
  saveSettings(
    tenantId: string,
    patch: TenantSettings,
  ): Promise<TenantSettings> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/settings`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  },
  // --- Audit log (activity feed) ---
  getAuditLog(tenantId: string): Promise<AuditEvent[]> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/audit`);
  },
  // --- Notifications ---
  getNotifications(tenantId: string): Promise<NotificationSettings> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/notifications`);
  },
  saveNotifications(
    tenantId: string,
    patch: Partial<NotificationSettings>,
  ): Promise<NotificationSettings> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/notifications`, {
      method: "PUT",
      body: JSON.stringify(patch),
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
  // Activate / deactivate a workflow (n8n parity): deactivating stops automatic triggers
  // (webhook/form refused, schedules paused). Manual runs still work.
  setWorkflowActive(
    tenantId: string,
    workflowKey: string,
    active: boolean,
  ): Promise<{ workflowKey: string; active: boolean }> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/workflows/${encodeURIComponent(workflowKey)}/active`,
      { method: "PUT", body: JSON.stringify({ active }) },
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
  // PUBLIC (anonymous — no auth): approve/reject a run via a signed link token.
  getApprovalPrompt(
    workflowId: string,
    token: string,
  ): Promise<{
    awaiting: boolean;
    title?: string;
    instructions?: string | null;
  }> {
    return http(
      `/approvals/${encodeURIComponent(workflowId)}?token=${encodeURIComponent(token)}`,
    );
  },
  decideApproval(
    workflowId: string,
    token: string,
    decision: "approve" | "reject",
    comment?: string,
  ): Promise<{ status: string }> {
    return http(`/approvals/${encodeURIComponent(workflowId)}/decide`, {
      method: "POST",
      body: JSON.stringify({
        token,
        decision,
        ...(comment ? { comment } : {}),
      }),
    });
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
  // --- Billing ---
  // Budget config + live month-to-date spend. Tenant-scoped. The server returns 404
  // (→ generic Error, not UnauthorizedError) when no budget is configured.
  getBudget(tenantId: string): Promise<BudgetView> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/budget`);
  },
  // --- Schedules (recurring runs, Temporal Schedules) ---
  listSchedules(tenantId: string): Promise<ScheduleRow[]> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/schedules`);
  },
  createSchedule(
    tenantId: string,
    input: { workflowKey: string; cron: string },
  ): Promise<ScheduleRow> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/schedules`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  setSchedulePaused(
    tenantId: string,
    scheduleId: string,
    paused: boolean,
  ): Promise<void> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/schedules/${encodeURIComponent(scheduleId)}/pause`,
      { method: "PUT", body: JSON.stringify({ paused }) },
    );
  },
  runScheduleNow(tenantId: string, scheduleId: string): Promise<void> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/schedules/${encodeURIComponent(scheduleId)}/trigger`,
      { method: "POST" },
    );
  },
  deleteSchedule(tenantId: string, scheduleId: string): Promise<void> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/schedules/${encodeURIComponent(scheduleId)}`,
      { method: "DELETE" },
    );
  },
};

/** A recurring schedule (mirrors the API's ScheduleView). */
export interface ScheduleRow {
  id: string;
  workflowKey: string;
  cron: string;
  paused: boolean;
  createdAt: string;
  nextRunAt: string | null;
}

/** Connection type — MCP/app servers plus SQL databases (the sqlQuery node). */
export type ConnectionType =
  | "github"
  | "atlassian"
  | "custom"
  | "postgres"
  | "mssql"
  | "mysql"
  | "signing"
  | "smtp";
export type ConnectionAuthMode =
  "api_token" | "pat" | "oauth" | "connection_string" | "github_app";

/** A connected MCP server / app / database (mirrors the API's ConnectionView; Date → string over JSON). */
export interface ConnectionRow {
  id: string;
  type: ConnectionType;
  label: string;
  serverUrl: string;
  authMode: ConnectionAuthMode;
  scopes: string[];
  status: "connected" | "needs_reauth" | "error";
  createdAt: string;
}

/** A registered webhook endpoint (no signing secret; Date → string over JSON). */
export interface WebhookRow {
  id: string;
  provider: string;
  workflowId: string;
  createdAt: string;
}

/** Input to connect a server or database (token/DSN stored encrypted server-side). */
export interface ConnectionInput {
  type: ConnectionType;
  label: string;
  /** Non-secret: an https endpoint (MCP) or a display host (DB). Never the DSN. */
  serverUrl: string;
  authMode: ConnectionAuthMode;
  scopes?: string[];
  /** The secret: a PAT/api token (MCP) or the full connection string/DSN (DB). */
  token?: string;
}

/** Returned ONCE when registering a webhook — the signing secret is not retrievable again. */
export interface RegisteredWebhook {
  endpointId: string;
  ingressPath: string;
  signingSecret: string;
}

/** A registered hosted-form endpoint (no secret — the opaque id is the only capability). */
export interface FormRow {
  id: string;
  workflowId: string;
  createdAt: string;
}

/** Returned when registering a form — the public path to host/share. */
export interface RegisteredForm {
  formId: string;
  formPath: string;
}

/** One field of a public form definition (mirrors the API's FormFieldResponse). */
export interface FormFieldView {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "email" | "select";
  required?: boolean;
  placeholder?: string;
  options?: string[];
}

/** Public form definition served to an anonymous browser — carries NO tenant/workflow ids. */
export interface FormDefinition {
  formId: string;
  title?: string;
  description?: string;
  submitLabel?: string;
  fields: FormFieldView[];
}

/** A registered hosted-chat endpoint (no secret — the opaque id is the only capability). */
export interface ChatRow {
  id: string;
  workflowId: string;
  createdAt: string;
}

/** Returned when registering a chat — the public path to host/share. */
export interface RegisteredChat {
  chatId: string;
  chatPath: string;
}

/** Public chat definition served to an anonymous browser — carries NO tenant/workflow ids. */
export interface ChatDefinition {
  chatId: string;
  title?: string;
  description?: string;
  placeholder?: string;
  greeting?: string;
}

/** A run paused at an approval, enriched with the node's prompt (approvals inbox). */
export interface AwaitingApproval {
  workflowId: string;
  workflowKey: string | null;
  nodeId: string;
  title: string;
  instructions: string | null;
  createdAt: string;
}

/** One run's outcome in a batch approve/reject — ok:false carries why it slipped. */
export interface BatchDecisionResult {
  workflowId: string;
  ok: boolean;
  error?: string;
}

export interface RunSummary {
  workflowId: string;
  workflowKey: string | null;
  /** Live status from Temporal: running | awaiting_approval | completed |
   *  rejected | budget_exceeded | circuit_open | invalid_graph | failed |
   *  timed_out | terminated | canceled | unknown. */
  status: string;
  costUsd: number | null;
  startedAt: string;
  createdAt: string;
  /** Soft-archived (hidden from the default Runs list). */
  archived: boolean;
}
export interface UsageReport {
  totalCostUsd: number;
  totalTokens: number;
  byModel: {
    provider: string;
    model: string;
    calls: number;
    totalTokens: number;
    costUsd: number;
  }[];
  events: unknown[];
}
export interface Member {
  id: string;
  email: string;
  role: string;
  createdAt: string;
}
export interface TenantSettings {
  displayName: string | null;
  defaultModel: string | null;
}

/** An API token's metadata (never the token value). */
export interface ApiTokenRow {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** A freshly minted token — `token` is the plaintext, shown once. */
export interface MintedToken {
  id: string;
  token: string;
  label: string;
  createdAt: string;
}

/** A workspace the current user belongs to, with their role (workspace switcher). */
export interface Workspace {
  tenantId: string;
  role: string;
  /** Display name (TenantSettings.displayName); may be unset for un-named workspaces. */
  name?: string;
}

/** One entry in the activity feed (who did what, when). */
export interface AuditEvent {
  id: string;
  actor: string;
  action: string;
  method: string;
  path: string;
  statusCode: number;
  createdAt: string;
}

export interface NotificationSettings {
  webhookUrl: string | null;
  onApprovalPending: boolean;
  onRunFailed: boolean;
}

/**
 * GET /tenants/:id/budget — budget config plus live month-to-date spend.
 * Mirrors the server's BudgetView (apps/api/src/budget/budget.service.ts):
 * the persisted TenantBudgetConfig fields + the two view-only spend fields.
 * Defined inline (not imported from @naary/usage) because that's a server-only
 * package with Prisma deps that must not enter the web bundle.
 */
export interface BudgetView {
  tenantId: string;
  monthlyCapUsd: number;
  perExecutionCapUsd: number;
  maxStepsPerRun: number;
  onBudgetExceeded: "reject" | "downgrade";
  fallbackModel: string | null;
  /** Spend so far this calendar month, in USD. */
  mtdSpendUsd: number;
  /** monthlyCapUsd − mtdSpendUsd (may be negative if over cap). */
  remainingUsd: number;
}

/** Map a control-plane status to a design run-state token. */
export function statusToRunState(
  s: ExecutionStatus,
): "idle" | "running" | "paused" | "done" | "error" {
  switch (s) {
    case "running":
      return "running";
    case "awaiting_approval":
      return "paused";
    case "completed":
      return "done";
    case "rejected":
    case "budget_exceeded":
    case "circuit_open":
      return "error";
  }
}

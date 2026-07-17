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
import type {
  GraphDef,
  GraphQLSchemaSummary,
  OpenApiSummary,
} from "@naary/dsl";
import { getBearerToken } from "./firebase";

/** Thrown on a 401 so screens can prompt the user to set their API token. */
export class UnauthorizedError extends Error {
  constructor() {
    super("Not authenticated — set your API token on the sign-in screen.");
    this.name = "UnauthorizedError";
  }
}

/** Thrown when the server's access allowlist rejects this (authenticated) user — the SPA
 *  shows a "not available yet" screen. Distinct from a generic 403 (membership/tenant). */
export class AccessNotAllowedError extends Error {
  constructor(message?: string) {
    super(message ?? "Your account doesn't have access yet.");
    this.name = "AccessNotAllowedError";
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
// localStorage can THROW (disabled, sandboxed iframe, private mode) — and this runs at module
// init + on every workspace/env change, so a throw would break the whole API client. Wrap it.
function lsGet(key: string): string | null {
  try {
    return typeof localStorage !== "undefined"
      ? localStorage.getItem(key)
      : null;
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable — in-memory state still works for the session */
  }
}

const WORKSPACE_KEY = "naary.workspace";
let activeWorkspaceId: string | null = lsGet(WORKSPACE_KEY);

/** Set (or clear) the active workspace id sent on every subsequent request. Switching to a
 *  DIFFERENT workspace clears the active environment (environments are per-workspace — a stale
 *  X-Environment-Id from the previous workspace must not leak into the new one). */
export function setActiveWorkspace(id: string | null): void {
  if (id !== activeWorkspaceId) setActiveEnvironment(null);
  activeWorkspaceId = id;
  lsSet(WORKSPACE_KEY, id);
}

/** The active workspace id, or null if none selected yet. */
export function getActiveWorkspace(): string | null {
  return activeWorkspaceId;
}

// The active ENVIRONMENT (sandbox/UAT/prod), sent as `X-Environment-Id` so the server scopes a
// request within the active workspace (design docs/design/ENVIRONMENTS.md). Env is per-workspace,
// so switching workspaces clears it (the provider re-resolves). Unset → the server's default env.
const ENVIRONMENT_KEY = "naary.environment";
let activeEnvironmentId: string | null = lsGet(ENVIRONMENT_KEY);

/** Set (or clear) the active environment slug/id sent on every subsequent request. */
export function setActiveEnvironment(idOrSlug: string | null): void {
  activeEnvironmentId = idOrSlug;
  lsSet(ENVIRONMENT_KEY, idOrSlug);
}

/** The active environment id/slug, or null if none selected yet. */
export function getActiveEnvironment(): string | null {
  return activeEnvironmentId;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getBearerToken();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(activeWorkspaceId ? { "x-workspace-id": activeWorkspaceId } : {}),
      ...(activeEnvironmentId
        ? { "x-environment-id": activeEnvironmentId }
        : {}),
      ...init?.headers,
    },
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    // A 403 carrying the access-allowlist marker → a specific error (the NotAvailable screen).
    // Only this exact code, so an ordinary 403 (membership/tenant) still surfaces generically.
    if (res.status === 403) {
      const body = (await res.json().catch(() => null)) as {
        code?: string;
        message?: string;
      } | null;
      if (body?.code === "access_not_allowed") {
        throw new AccessNotAllowedError(body.message);
      }
    }
    throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}`);
  }
  // 204 / empty body (e.g. DELETE) — nothing to parse.
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

/**
 * POST to an /introspect endpoint. Hand-rolled (not http()) so the server's specific 400 message
 * (bad URL, non-JSON spec, blocked host, non-2xx upstream) surfaces to the user instead of a generic
 * "→ 400". Carries the same bearer + workspace/env headers as http(). `headers` (an OPTIONAL token
 * the user pastes for a private spec) is forwarded VERBATIM by the server — it never resolves
 * `{{ $secrets }}`, so a stored-secret reference would arrive as a literal string and fail; the UI
 * offers its own token field instead.
 */
async function introspectFetch<T>(
  path: string,
  url: string,
  headers?: Record<string, string>,
): Promise<T> {
  const token = await getBearerToken();
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(activeWorkspaceId ? { "x-workspace-id": activeWorkspaceId } : {}),
      ...(activeEnvironmentId
        ? { "x-environment-id": activeEnvironmentId }
        : {}),
    },
    body: JSON.stringify({ url, ...(headers ? { headers } : {}) }),
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? `Introspection failed (${res.status}).`);
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
/** One widget's placement on the customizable Overview (order = array position). */
export interface DashboardItem {
  id: string;
  hidden: boolean;
  /** 12-col grid span: 4 (third), 6 (half), or 12 (full). */
  span: number;
}
/** One stored version of a workflow (identity only) — for the re-run-at-version picker. */
export interface GraphVersion {
  version: number;
  contentHash: string;
  createdAt: string;
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

/** A per-workspace environment (sandbox/UAT/prod). */
export interface Environment {
  id: string;
  name: string;
  slug: string;
  isDefault: boolean;
}

/** One entry in a workflow's promotion lineage. */
export interface Promotion {
  fromEnvId: string;
  toEnvId: string;
  fromVersion: number;
  toVersion: number;
  actor: string;
  createdAt: string;
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
  // Promote a workflow from the ACTIVE env (X-Environment-Id) into `toEnv` (copy-on-promote).
  promoteWorkflow(
    workflowKey: string,
    toEnv: string,
    fromVersion?: number,
  ): Promise<{ fromVersion: number; toVersion: number; contentHash: string }> {
    return http(`/graphs/${encodeURIComponent(workflowKey)}/promote`, {
      method: "POST",
      body: JSON.stringify({ toEnv, ...(fromVersion ? { fromVersion } : {}) }),
    });
  },
  listPromotions(workflowKey: string): Promise<Promotion[]> {
    return http(`/graphs/${encodeURIComponent(workflowKey)}/promotions`);
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
  // Start a minimal read-only Code Agent (Claude Code) run to verify the CLI + key work.
  // Returns the run id — poll getState until it's terminal.
  testCodeAgent(): Promise<{ workflowId: string }> {
    return http("/executions/code-agent-test", { method: "POST" });
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
  // Re-run a past run with its original trigger input. Against the current graph by
  // default; pass `graphVersion` to re-run at a specific saved version (newer or older).
  rerun(id: string, graphVersion?: number): Promise<{ workflowId: string }> {
    return http(`/executions/${encodeURIComponent(id)}/rerun`, {
      method: "POST",
      body: JSON.stringify(graphVersion !== undefined ? { graphVersion } : {}),
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
  // `version` is the executed graph version; `workflowKey` drives the re-run-at-version picker.
  getRunGraph(id: string): Promise<{
    graph: GraphDef;
    version: number | null;
    workflowKey: string | null;
  }> {
    return http(`/executions/${encodeURIComponent(id)}/graph`);
  },
  // Every stored version of a workflow (newest first) — powers the "re-run at version" picker.
  listGraphVersions(workflowKey: string): Promise<GraphVersion[]> {
    return http(`/graphs/${encodeURIComponent(workflowKey)}/versions`);
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
  // Per-user preferences (experience mode + dashboard layout) — cross-device, keyed to the
  // user server-side. Fields are null when unset (or for API-token principals with no uid).
  getPreferences(): Promise<{
    mode: string | null;
    dashboard: DashboardItem[] | null;
  }> {
    return http("/me/preferences");
  },
  // Save the experience mode only (the PUT omits `dashboard`, so it's left untouched).
  savePreferences(
    mode: string | null,
  ): Promise<{ mode: string | null; dashboard: DashboardItem[] | null }> {
    return http("/me/preferences", {
      method: "PUT",
      body: JSON.stringify({ mode }),
    });
  },
  // Save the Overview layout only (omits `mode`, so the experience mode is untouched).
  saveDashboard(
    dashboard: DashboardItem[] | null,
  ): Promise<{ mode: string | null; dashboard: DashboardItem[] | null }> {
    return http("/me/preferences", {
      method: "PUT",
      body: JSON.stringify({ dashboard }),
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
  // --- Environments (per-workspace sandbox/UAT/prod) ---
  listEnvironments(tenantId: string): Promise<Environment[]> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/environments`);
  },
  createEnvironment(
    tenantId: string,
    body: { name: string; slug: string },
  ): Promise<Environment> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/environments`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  renameEnvironment(
    tenantId: string,
    envId: string,
    name: string,
  ): Promise<Environment> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/environments/${encodeURIComponent(envId)}`,
      { method: "PATCH", body: JSON.stringify({ name }) },
    );
  },
  deleteEnvironment(
    tenantId: string,
    envId: string,
  ): Promise<{ deleted: true }> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/environments/${encodeURIComponent(envId)}`,
      { method: "DELETE" },
    );
  },

  // --- Notifications (per-channel: Slack, Teams, … each configured independently) ---
  listNotificationChannels(tenantId: string): Promise<NotificationChannel[]> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/notifications`);
  },
  // Upsert ONE channel's config (identified by type); other channels are untouched.
  saveNotificationChannel(
    tenantId: string,
    type: NotificationChannelType,
    patch: Partial<Omit<NotificationChannel, "type">>,
  ): Promise<NotificationChannel> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/notifications/${encodeURIComponent(type)}`,
      { method: "PUT", body: JSON.stringify(patch) },
    );
  },
  // Send a test message to ONE channel's webhook. Returns a result (not a throw) so the
  // UI can show the server's specific failure reason (bad URL, non-2xx, unreachable).
  async testNotificationChannel(
    tenantId: string,
    type: NotificationChannelType,
  ): Promise<{ ok: boolean; message?: string }> {
    const token = await getBearerToken();
    const res = await fetch(
      `${BASE}/tenants/${encodeURIComponent(tenantId)}/notifications/${encodeURIComponent(type)}/test`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(activeWorkspaceId ? { "x-workspace-id": activeWorkspaceId } : {}),
          ...(activeEnvironmentId
            ? { "x-environment-id": activeEnvironmentId }
            : {}),
        },
      },
    );
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => null)) as {
      message?: string;
    } | null;
    return {
      ok: false,
      message: body?.message ?? `Request failed (${res.status}).`,
    };
  },
  // --- Global Variables ($vars) ---
  // Non-secret, env-scoped workspace config referenced in expressions as `{{ $vars.KEY }}`.
  // Scoped to the ACTIVE environment via the x-environment-id header (sent by http()), so the
  // same key can hold a different value in sandbox vs prod. NOT for secrets.
  listVariables(): Promise<Variable[]> {
    return http(`/variables`);
  },
  // Set (create or overwrite) one variable in the active environment. The key must be a valid
  // identifier (server-validated) since it's read as a dot-path in `{{ $vars.KEY }}`.
  setVariable(key: string, value: string): Promise<Variable> {
    return http(`/variables/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
  },
  // Delete one variable from the active environment (204; no-op if absent).
  deleteVariable(key: string): Promise<void> {
    return http(`/variables/${encodeURIComponent(key)}`, { method: "DELETE" });
  },
  // --- Environment Secrets ($secrets) ---
  // Write-only, env-scoped named secrets referenced as `{{ $secrets.NAME }}`. Scoped to the ACTIVE
  // environment (x-environment-id). The VALUE is never returned — list yields names only; the worker
  // decrypts it in-activity (never reaches the graph/ctx/history). NOT the BYOK provider keys.
  listEnvSecrets(): Promise<{ name: string }[]> {
    return http(`/env-secrets`);
  },
  // Set (create or replace) a secret's value in the active environment (204).
  setEnvSecret(name: string, value: string): Promise<void> {
    return http(`/env-secrets/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
  },
  // Delete a secret from the active environment (204; no-op if absent).
  deleteEnvSecret(name: string): Promise<void> {
    return http(`/env-secrets/${encodeURIComponent(name)}`, {
      method: "DELETE",
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
  /** The workflow graph version this run snapshotted at start; null for older runs. */
  graphVersion: number | null;
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

/** A Global Variable — non-secret, env-scoped config referenced as `{{ $vars.KEY }}`. */
export interface Variable {
  key: string;
  value: string;
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

export type NotificationChannelType = "slack" | "teams";

/** One independently-configurable notification channel. The server returns every known
 *  channel (saved or default), so the UI renders them uniformly. */
export interface NotificationChannel {
  type: NotificationChannelType;
  /** Off = the worker skips this channel entirely, even with a URL set. */
  enabled: boolean;
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

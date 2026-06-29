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

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getBearerToken();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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
  // tenantId is resolved from the token server-side — the body carries only input
  // and which stored graph (workflowKey) to run (default "default").
  startExecution(workflowKey?: string): Promise<{ workflowId: string }> {
    return http("/executions", {
      method: "POST",
      body: JSON.stringify(workflowKey ? { workflowKey } : {}),
    });
  },
  approve(id: string, approved: boolean): Promise<{ accepted: true }> {
    return http(`/executions/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      body: JSON.stringify({ approved }),
    });
  },
  getState(id: string): Promise<ExecutionState> {
    return http(`/executions/${encodeURIComponent(id)}`);
  },
  // The run's execution log (curated Temporal history).
  getRunHistory(id: string): Promise<RunEvent[]> {
    return http(`/executions/${encodeURIComponent(id)}/history`);
  },
  // Who am I — the SPA's tenantId (for tenant-scoped routes) + OIDC subject.
  getMe(): Promise<{ tenantId: string; subject?: string }> {
    return http("/me");
  },
  // Recent runs for the tenant (identity + start time; status is on the detail view).
  listRuns(): Promise<RunSummary[]> {
    return http("/executions");
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
  // --- Integrations ---
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

/** A connected MCP server / app (mirrors the API's ConnectionView; Date → string over JSON). */
export interface ConnectionRow {
  id: string;
  type: "github" | "atlassian" | "custom";
  label: string;
  serverUrl: string;
  authMode: "api_token" | "pat" | "oauth";
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

/** Input to connect a server (token stored encrypted server-side). */
export interface ConnectionInput {
  type: "github" | "atlassian" | "custom";
  label: string;
  serverUrl: string;
  authMode: "api_token" | "pat" | "oauth";
  scopes?: string[];
  token?: string;
}

/** Returned ONCE when registering a webhook — the signing secret is not retrievable again. */
export interface RegisteredWebhook {
  endpointId: string;
  ingressPath: string;
  signingSecret: string;
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

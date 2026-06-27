/**
 * Thin client for the NestJS control plane (apps/api). Only the endpoints that
 * actually exist today are wired: start an execution, signal approval, read
 * live state. In dev, Vite proxies /api → http://localhost:3000 (see
 * vite.config.ts), so the browser avoids CORS.
 *
 * Auth: every call carries a bearer token — a fresh Keycloak (OIDC) access token
 * when the user is logged in, else the pasted `nry_` API token (see getBearerToken).
 * The server resolves tenantId from the token, so the client never sends it.
 */
import type { GraphDef } from "@naary/dsl";
import { getBearerToken } from "./keycloak";

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
  status: ExecutionStatus;
  currentNodeId: string;
  ctx: Record<string, unknown>;
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

export const api = {
  // Built-in workflow templates (global, not tenant-scoped). The canvas opens one
  // by its `key`.
  listTemplates(): Promise<TemplateSummary[]> {
    return http("/templates");
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
};

export interface RunSummary {
  workflowId: string;
  createdAt: string;
}
export interface UsageReport {
  totalCostUsd: number;
  totalTokens: number;
  byModel: { model: string; tokens: number; costUsd: number }[];
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

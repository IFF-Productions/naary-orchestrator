/**
 * Run/execution endpoints: start, approve (single/batch/public signed-link),
 * cancel/rerun, archive, state + history + snapshot graph, and schedules
 * (recurring runs via Temporal Schedules).
 */
import type { GraphDef } from "@naary/dsl";
import { http } from "./http";
import type {
  AwaitingApproval,
  BatchDecisionResult,
  ExecutionState,
  RunEvent,
  RunSummary,
  ScheduleRow,
} from "./types";

export const runsApi = {
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
  // The signed resume-URL path for a run paused on a wait(webhook) node.
  getResumeUrl(id: string): Promise<{ path: string }> {
    return http(`/executions/${encodeURIComponent(id)}/resume-url`);
  },
  // The run's execution log (curated Temporal history).
  getRunHistory(id: string): Promise<RunEvent[]> {
    return http(`/executions/${encodeURIComponent(id)}/history`);
  },
  // Recent runs for the tenant. `archived` returns the hidden runs instead of the default list.
  listRuns(archived = false): Promise<RunSummary[]> {
    return http(archived ? "/executions?archived=true" : "/executions");
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

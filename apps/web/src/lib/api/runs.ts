/**
 * Run/execution endpoints: start, approve (single/batch/public signed-link),
 * cancel/rerun, archive, state + history + snapshot graph, and schedules
 * (recurring runs via Temporal Schedules).
 *
 * MIGRATED to the openapi-fetch typed client (`./client`) — this module is the proven
 * pattern for the openapi-typescript adoption. Request bodies, path/query params, and
 * response bodies are all typed against `./schema` (generated from the API's OpenAPI
 * spec), so a DTO change on the server that this code doesn't account for is a COMPILE
 * error here + a drift-check failure (`pnpm check:api-types`). Every method returns the
 * unwrapped body and throws UnauthorizedError/AccessNotAllowedError/HttpError on failure,
 * exactly like the old `http()` path — so call sites are unchanged in behaviour.
 *
 * Other API modules still use `http()`; both clients share the same auth/workspace/env
 * state (see ./http + ./client), so this coexistence is transparent.
 */
import type { GraphDef } from "@naary/dsl";
import { client, unwrap } from "./client";
import type { components } from "./schema";

/** Response/DTO shapes inferred from the generated spec — the source of truth for these
 *  endpoints (replaces the hand-written interfaces these methods used from ./types). */
type StartExecutionResponse = components["schemas"]["StartExecutionResponse"];
type RunListItem = components["schemas"]["RunListItemResponse"];
type RunState = components["schemas"]["RunStateResponse"];
type RunEventItem = components["schemas"]["RunEventResponse"];
type AwaitingApprovalItem = components["schemas"]["AwaitingApprovalResponse"];
type BatchDecisionItem = components["schemas"]["BatchDecisionItemResponse"];
type AcceptedResponse = components["schemas"]["AcceptedResponse"];
type ResumeUrlResponse = components["schemas"]["ResumeUrlResponse"];
type ApprovalPrompt = components["schemas"]["ApprovalPromptResponse"];
type DecideResult = components["schemas"]["DecideResultResponse"];
type ScheduleItem = components["schemas"]["ScheduleResponse"];

export const runsApi = {
  // tenantId is resolved from the token server-side — the body carries only the
  // optional run input + which stored graph (workflowKey) to run (default "default").
  // `input` overrides the Start node's sampleInput for this run; omit it to use the
  // sample (server-side precedence: body.input → Start sampleInput → fallback).
  async startExecution(
    workflowKey?: string,
    input?: Record<string, unknown>,
  ): Promise<StartExecutionResponse> {
    const body: { workflowKey?: string; input?: Record<string, unknown> } = {};
    if (workflowKey) body.workflowKey = workflowKey;
    if (input !== undefined) body.input = input;
    return unwrap(await client.POST("/executions", { body }));
  },
  // Start a minimal read-only Code Agent (Claude Code) run to verify the CLI + key work.
  // Returns the run id — poll getState until it's terminal.
  async testCodeAgent(): Promise<StartExecutionResponse> {
    return unwrap(await client.POST("/executions/code-agent-test", {}));
  },
  async approve(
    id: string,
    approved: boolean,
    comment?: string,
  ): Promise<AcceptedResponse> {
    return unwrap(
      await client.POST("/executions/{id}/approve", {
        params: { path: { id } },
        body: { approved, ...(comment ? { comment } : {}) },
      }),
    );
  },
  // Decide many paused runs at once (same decision). Returns a per-run outcome so the
  // UI can show which ids slipped (already closed / no longer awaiting) without failing all.
  async approveBatch(
    ids: string[],
    approved: boolean,
    comment?: string,
  ): Promise<BatchDecisionItem[]> {
    return unwrap(
      await client.POST("/executions/approve-batch", {
        body: { ids, approved, ...(comment ? { comment } : {}) },
      }),
    );
  },
  // Archive/restore many runs at once. Per-run outcome, like approveBatch.
  async archiveBatch(
    ids: string[],
    archived: boolean,
  ): Promise<BatchDecisionItem[]> {
    return unwrap(
      await client.POST("/executions/archive-batch", {
        body: { ids, archived },
      }),
    );
  },
  // Cancel a running run (terminates the workflow). 409 if already finished.
  async cancelRun(id: string): Promise<AcceptedResponse> {
    return unwrap(
      await client.POST("/executions/{id}/cancel", {
        params: { path: { id } },
      }),
    );
  },
  // Re-run a past run with its original trigger input. Against the current graph by
  // default; pass `graphVersion` to re-run at a specific saved version (newer or older).
  async rerun(
    id: string,
    graphVersion?: number,
  ): Promise<StartExecutionResponse> {
    return unwrap(
      await client.POST("/executions/{id}/rerun", {
        params: { path: { id } },
        body: graphVersion !== undefined ? { graphVersion } : {},
      }),
    );
  },
  // Soft-archive a run (hide it from the default Runs list). Read-model only.
  async archiveRun(id: string): Promise<AcceptedResponse> {
    return unwrap(
      await client.POST("/executions/{id}/archive", {
        params: { path: { id } },
      }),
    );
  },
  // Restore an archived run back into the Runs list.
  async unarchiveRun(id: string): Promise<AcceptedResponse> {
    return unwrap(
      await client.POST("/executions/{id}/unarchive", {
        params: { path: { id } },
      }),
    );
  },
  // The tenant's runs paused for approval, each with its prompt (approvals inbox).
  async listAwaitingApprovals(): Promise<AwaitingApprovalItem[]> {
    return unwrap(await client.GET("/executions/awaiting", {}));
  },
  async getState(id: string): Promise<RunState> {
    return unwrap(
      await client.GET("/executions/{id}", { params: { path: { id } } }),
    );
  },
  // The graph SNAPSHOT this run executed (accurate to what ran) — for the run-detail canvas.
  // `version` is the executed graph version; `workflowKey` drives the re-run-at-version picker.
  // The spec types `graph` as an opaque object (the API doesn't ship the full GraphDef schema);
  // narrow it to GraphDef at this boundary — the run-detail canvas consumes it as one.
  async getRunGraph(id: string): Promise<{
    graph: GraphDef;
    version: number | null;
    workflowKey: string | null;
  }> {
    const data = unwrap<components["schemas"]["RunGraphResponse"]>(
      await client.GET("/executions/{id}/graph", {
        params: { path: { id } },
      }),
    );
    return {
      graph: data.graph as unknown as GraphDef,
      version: data.version,
      workflowKey: data.workflowKey,
    };
  },
  // The signed resume-URL path for a run paused on a wait(webhook) node.
  async getResumeUrl(id: string): Promise<ResumeUrlResponse> {
    return unwrap(
      await client.GET("/executions/{id}/resume-url", {
        params: { path: { id } },
      }),
    );
  },
  // The run's execution log (curated Temporal history).
  async getRunHistory(id: string): Promise<RunEventItem[]> {
    return unwrap(
      await client.GET("/executions/{id}/history", {
        params: { path: { id } },
      }),
    );
  },
  // Recent runs for the tenant. `archived` returns the hidden runs instead of the default list.
  // The spec requires the `archived` query param; the server treats anything but "true" as false,
  // so an explicit "false" reproduces the old (unset) default-list behaviour.
  async listRuns(archived = false): Promise<RunListItem[]> {
    return unwrap(
      await client.GET("/executions", {
        params: { query: { archived: archived ? "true" : "false" } },
      }),
    );
  },
  // PUBLIC (anonymous — no auth): approve/reject a run via a signed link token.
  async getApprovalPrompt(
    workflowId: string,
    token: string,
  ): Promise<ApprovalPrompt> {
    return unwrap(
      await client.GET("/approvals/{workflowId}", {
        params: { path: { workflowId }, query: { token } },
      }),
    );
  },
  async decideApproval(
    workflowId: string,
    token: string,
    decision: "approve" | "reject",
    comment?: string,
  ): Promise<DecideResult> {
    return unwrap(
      await client.POST("/approvals/{workflowId}/decide", {
        params: { path: { workflowId } },
        body: { token, decision, ...(comment ? { comment } : {}) },
      }),
    );
  },
  // --- Schedules (recurring runs, Temporal Schedules) ---
  async listSchedules(tenantId: string): Promise<ScheduleItem[]> {
    return unwrap(
      await client.GET("/tenants/{id}/schedules", {
        params: { path: { id: tenantId } },
      }),
    );
  },
  async createSchedule(
    tenantId: string,
    input: { workflowKey: string; cron: string },
  ): Promise<ScheduleItem> {
    return unwrap(
      await client.POST("/tenants/{id}/schedules", {
        params: { path: { id: tenantId } },
        body: input,
      }),
    );
  },
  async setSchedulePaused(
    tenantId: string,
    scheduleId: string,
    paused: boolean,
  ): Promise<void> {
    unwrap(
      await client.PUT("/tenants/{id}/schedules/{scheduleId}/pause", {
        params: { path: { id: tenantId, scheduleId } },
        body: { paused },
      }),
    );
  },
  async runScheduleNow(tenantId: string, scheduleId: string): Promise<void> {
    unwrap(
      await client.POST("/tenants/{id}/schedules/{scheduleId}/trigger", {
        params: { path: { id: tenantId, scheduleId } },
      }),
    );
  },
  async deleteSchedule(tenantId: string, scheduleId: string): Promise<void> {
    unwrap(
      await client.DELETE("/tenants/{id}/schedules/{scheduleId}", {
        params: { path: { id: tenantId, scheduleId } },
      }),
    );
  },
};

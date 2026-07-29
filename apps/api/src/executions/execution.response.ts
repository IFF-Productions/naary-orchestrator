import { ApiProperty } from "@nestjs/swagger";

/** Result of starting a run — the Temporal workflowId to poll/approve against. */
export class StartExecutionResponse {
  @ApiProperty({
    example: "run-8f3a1c2e",
    description: "Temporal workflowId of the started run.",
  })
  workflowId!: string;
}

/** One row in the recent-runs list (newest first). Mirrors the service's RunSummary — the
 *  live status/cost are projected onto the row, not just identity + time. */
export class RunListItemResponse {
  @ApiProperty({ example: "run-8f3a1c2e" }) workflowId!: string;
  @ApiProperty({ type: String, nullable: true, example: "support-triage" })
  workflowKey!: string | null;
  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    example: "Refund triage",
    description:
      "The workflow's display NAME at read time, or null when unresolvable (a pre-migration run, or " +
      "a deleted workflow). Resolved, not snapshotted — a run records the stable KEY, while the name " +
      "is editable, so snapshotting would show a stale name after a rename. Render " +
      "`workflowName ?? workflowKey`.",
  })
  workflowName?: string | null;

  @ApiProperty({
    example: "completed",
    description:
      "App status or a Temporal close reason (failed | timed_out | terminated | canceled | unknown).",
  })
  status!: string;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 0.0142,
    description: "Run cost in USD.",
  })
  costUsd!: number | null;
  @ApiProperty({ format: "date-time", example: "2026-07-04T12:00:00.000Z" })
  startedAt!: string;
  @ApiProperty({ format: "date-time", example: "2026-07-04T12:00:00.000Z" })
  createdAt!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    format: "date-time",
    description:
      "When the run reached a terminal status — stamped by the worker on a normal finish, by the API on cancel, else read from Temporal's close time (#807); null for in-flight runs and runs predating the stamp.",
  })
  finishedAt!: string | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 12840,
    description:
      "finishedAt − createdAt in ms; null whenever finishedAt is null (never derived from now).",
  })
  durationMs!: number | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "rate_limit",
    description:
      "Compact failure classification on terminal failures (timeout | upstream_5xx | rate_limit | budget | rejected | error); null → fall back to the status.",
  })
  failureKind!: string | null;
  @ApiProperty({
    example: false,
    description: "Soft-archived (hidden by default).",
  })
  archived!: boolean;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 3,
    description:
      "The workflow graph version this run snapshotted at start; null for pre-migration rows.",
  })
  graphVersion!: number | null;
}

/**
 * A cursor-paged page of runs — the Runs screen's list (`GET /executions/page`).
 *
 * Keyset-paged on (createdAt DESC, workflowId DESC), so `nextCursor` picks up exactly after the
 * last row even as new runs land at the top. An offset would drift and silently duplicate or skip
 * rows on an actively-running tenant. Mirrors the public v1 `GET /runs` envelope.
 */
export class RunPageResponse {
  @ApiProperty({ type: [RunListItemResponse] }) items!: RunListItemResponse[];
  @ApiProperty({
    type: String,
    nullable: true,
    example: "MjAyNi0wNy0wNFQxMjowMDowMC4wMDBafHJ1bi04ZjNhMWMyZQ==",
    description:
      "Opaque cursor for the next page — pass as ?cursor=. Null when this is the last page.",
  })
  nextCursor!: string | null;
}

/** One approver group on an awaiting row (display summary). */
export class ApproverGroupResponse {
  @ApiProperty({ example: "9f3a…" }) id!: string;
  @ApiProperty({ example: "finance-leads" }) name!: string;
}

/** Who may decide a routed approval gate (display summary; enforced on approve). */
export class ApproverSummaryResponse {
  @ApiProperty({ type: [String], example: ["sam@acme.io"] })
  emails!: string[];
  @ApiProperty({ type: [ApproverGroupResponse] })
  groups!: ApproverGroupResponse[];
}

/** A run paused for approval, enriched with the humanApproval node's prompt and the
 *  pause-time routing/SLA/context snapshot (null when the gate has none). */
export class AwaitingApprovalResponse {
  @ApiProperty({ example: "run-8f3a1c2e" }) workflowId!: string;
  @ApiProperty({ type: String, nullable: true, example: "support-triage" })
  workflowKey!: string | null;
  @ApiProperty({
    required: false,
    type: String,
    nullable: true,
    example: "Refund triage",
    description:
      "The workflow's display NAME at read time, or null when unresolvable (a pre-migration run, or " +
      "a deleted workflow). Resolved, not snapshotted — a run records the stable KEY, while the name " +
      "is editable, so snapshotting would show a stale name after a rename. Render " +
      "`workflowName ?? workflowKey`.",
  })
  workflowName?: string | null;
  @ApiProperty({ example: "approve-summary" }) nodeId!: string;
  @ApiProperty({ example: "Approve the drafted summary" }) title!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "Review the summary before it is emailed.",
  })
  instructions!: string | null;
  @ApiProperty({ format: "date-time", example: "2026-07-04T12:00:00.000Z" })
  createdAt!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    format: "date-time",
    description: "When the gate paused (worker clock at pause time).",
  })
  pausedAt!: string | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 48,
    description: "The gate's display-only SLA in hours.",
  })
  slaHours!: number | null;
  @ApiProperty({
    type: String,
    nullable: true,
    format: "date-time",
    description:
      "pausedAt + slaHours (server-derived); null unless both exist.",
  })
  dueAt!: string | null;
  @ApiProperty({
    type: "object",
    additionalProperties: { type: "string" },
    nullable: true,
    description:
      "Structured context card — expressions resolved at pause time (never secrets).",
  })
  contextFields!: Record<string, string> | null;
  @ApiProperty({ type: ApproverSummaryResponse, nullable: true })
  approvers!: ApproverSummaryResponse | null;
  @ApiProperty({ type: Number, nullable: true, example: 20 })
  escalateAfterHours!: number | null;
  @ApiProperty({ type: String, nullable: true, example: "@ops-oncall" })
  escalateTo!: string | null;
}

/** Outcome of a manual "Remind now" — how many channels were POSTed. */
export class RemindResponse {
  @ApiProperty({ example: true }) accepted!: boolean;
  @ApiProperty({
    example: 2,
    description:
      "How many notification channels the reminder was delivered to.",
  })
  sent!: number;
}

/** Acknowledgement that an approval decision was accepted (async, 202). */
export class AcceptedResponse {
  @ApiProperty({ example: true }) accepted!: boolean;
}

/** Per-run outcome of a batch approve/reject. `ok:false` runs were already closed or not
 *  owned by the tenant; they don't fail the batch — the caller can show which ones slipped. */
export class BatchDecisionItemResponse {
  @ApiProperty({ example: "run-8f3a1c2e" }) workflowId!: string;
  @ApiProperty({ example: true }) ok!: boolean;
  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    example:
      "Execution is not awaiting approval (already completed, rejected, or failed).",
    description: "Why this run wasn't decided (present only when ok is false).",
  })
  error?: string | null;
}

/** The resume-URL path for a run paused on a wait(webhook) node (host prepended client-side). */
export class ResumeUrlResponse {
  @ApiProperty({
    example: "/hooks/resume/run-8f3a1c2e?token=ab12…",
    description:
      "Relative path an external system POSTs to resume the run. The token is the credential.",
  })
  path!: string;
}

/** Live run detail — status, current node, and the accumulated context. */
export class RunStateResponse {
  @ApiProperty({
    example: "running",
    description:
      "App status or a Temporal close reason (failed | timed_out | terminated | canceled | unknown).",
  })
  status!: string;
  @ApiProperty({ example: "agent-1" }) currentNodeId!: string;
  @ApiProperty({
    type: "array",
    items: { type: "string" },
    example: ["trigger", "http-1"],
    description:
      "Node ids known to have run — populated for a failed run whose ctx came back empty (#525); " +
      "empty when the ctx itself carries the outputs.",
  })
  executedNodeIds!: string[];
  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description: "Accumulated workflow context.",
  })
  ctx!: Record<string, unknown>;
  @ApiProperty({
    type: "object",
    additionalProperties: true,
    nullable: true,
    description:
      "Per-node timing map (Slice 2): { [nodeId]: { s, f, n?, totalMs? } } — epoch-ms start/finish stamped with deterministic workflow time; n/totalMs aggregate repeated passes (loops). Null when the run predates the feature or its ctx is unavailable.",
  })
  nodeTimes!: Record<string, unknown> | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 0.0123,
    description:
      "Live spend-so-far of this run in USD (the interpreter's metered cost accumulator). Null when unavailable (pre-feature worker or Temporal-level failure).",
  })
  spentUsd!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 0.5,
    description:
      "The per-run budget cap this run enforces (snapshotted at start, refreshed after a budget-pause resume). Null when no cap is configured or the run is closed.",
  })
  perExecutionCapUsd!: number | null;
}

/** The graph snapshot a run executed — for the run-detail canvas (read-only). */
export class RunGraphResponse {
  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description:
      "The version-pinned GraphDef the run walked (nodes, edges, startNodeId).",
  })
  graph!: Record<string, unknown>;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 3,
    description:
      "The workflow graph version this run executed; null for pre-migration runs.",
  })
  version!: number | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "support-triage",
    description:
      "The run's workflowKey (drives the re-run-at-version picker); null for very old runs.",
  })
  workflowKey!: string | null;
}

/** A captured body — redacted and truncated by the WORKER, at the moment of failure. */
export class RunHttpBodyResponse {
  @ApiProperty({
    example: '{"message":"Not Found"}',
    description:
      "The body, secret-scrubbed and capped at ~2KB. When truncated it ends with an explicit marker.",
  })
  text!: string;
  @ApiProperty({ example: false }) truncated!: boolean;
  @ApiProperty({
    example: 23,
    description:
      "Size of the ORIGINAL body on the wire — not the length of `text`, which redaction can shrink.",
  })
  bytes!: number;
}

/** The request the failing node actually sent — resolved, not as configured. */
export class RunHttpRequestResponse {
  @ApiProperty({ example: "POST" }) method!: string;
  @ApiProperty({
    example: "https://api.github.com/repos/acme/app/issues",
    description:
      "Absolute URL including query string, with credentials redacted.",
  })
  url!: string;
  @ApiProperty({
    type: "object",
    additionalProperties: { type: "string" },
    example: {
      authorization: "[REDACTED]",
      "content-type": "application/json",
    },
    description:
      "Lowercase header names. Values survive ONLY for a small allowlist of provably non-credential headers (content-type, retry-after, x-ratelimit-*, …); everything else reads [REDACTED].",
  })
  headers!: Record<string, string>;
  @ApiProperty({ required: false, type: RunHttpBodyResponse })
  body?: RunHttpBodyResponse;
  @ApiProperty({
    required: false,
    example: "withheld — this request body carried a resolved $secret",
    description:
      "Why the body was not captured. Set when a `{{ $secrets.NAME }}` was resolved into it: the substituted value is opaque, so no scrubber can find it and Tier-1 §4 forbids it entering history.",
  })
  bodyWithheld?: string;
}

/** What came back. Absent when the call failed before any response (DNS, timeout, egress block). */
export class RunHttpResponseResponse {
  @ApiProperty({ example: 404 }) status!: number;
  @ApiProperty({ required: false, example: "Not Found" }) statusText?: string;
  @ApiProperty({
    type: "object",
    additionalProperties: { type: "string" },
    description: "Same allowlist treatment as the request headers.",
  })
  headers!: Record<string, string>;
  @ApiProperty({ required: false, type: RunHttpBodyResponse })
  body?: RunHttpBodyResponse;
}

/**
 * The redacted request/response an `integration` / `httpRequest` / `graphQL` node captured when it
 * FAILED (#916). Only ever present on a failure — a successful call captures nothing, because a
 * response body is customer data and a run's happy path must not accumulate copies of it.
 */
export class RunHttpFailureResponse {
  @ApiProperty({ type: RunHttpRequestResponse })
  request!: RunHttpRequestResponse;
  @ApiProperty({ required: false, type: RunHttpResponseResponse })
  response?: RunHttpResponseResponse;
}

/** One entry in a run's execution log (derived from Temporal history). */
export class RunEventResponse {
  @ApiProperty({ example: 12 }) id!: number;
  @ApiProperty({
    enum: [
      "started",
      "activity",
      "signal",
      "timer",
      "completed",
      "error",
      "continued",
    ],
    example: "activity",
    description: "Coarse kind for the UI icon/colour.",
  })
  kind!: string;
  @ApiProperty({ example: "Activity: callAgent" }) label!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    format: "date-time",
    example: "2026-07-04T12:00:00.000Z",
  })
  at!: string | null;
  @ApiProperty({ required: false, example: "Provider returned 429" })
  detail?: string;
  @ApiProperty({
    required: false,
    type: RunHttpFailureResponse,
    description:
      "On an error event from an HTTP-ish node: the redacted, truncated request/response it captured. Absent for every other event, and for a failure that made no HTTP call.",
  })
  http?: RunHttpFailureResponse;
}

/**
 * Whether a failed run can be resumed at the node that failed
 * (docs/design/RESUME-FROM-FAILED-NODE.md §6).
 *
 * A separate GET from the POST so the UI can disable the action and say WHY. Every `reason` is a
 * case where restarting at one node id would misrepresent the run's remaining work, so the honest
 * answer is a refusal with an explanation rather than an attempt.
 */
export class ResumeEligibilityResponse {
  @ApiProperty({ example: false }) resumable!: boolean;
  @ApiProperty({
    required: false,
    enum: [
      "not_a_failure",
      "graph_unavailable",
      "no_failed_node",
      "unknown_node",
      "snapshot_missing",
      "inside_item_region",
      "loop_or_child_node",
      "parallel_fanout",
    ],
    description: "Machine-readable refusal. Absent when `resumable` is true.",
  })
  reason?: string;
  @ApiProperty({
    required: false,
    example:
      "The failure happened inside a per-item region. Only the last item's data survives, so resuming would re-run the node against the wrong item.",
    description:
      "Human-readable expansion of `reason`, safe to show a user — never run content.",
  })
  detail?: string;
  @ApiProperty({
    type: [String],
    enum: ["at_most_once_node"],
    description:
      "Non-blocking cautions. `at_most_once_node` ⇒ the failing node may already have taken effect, so the POST requires `acknowledgeSideEffects`.",
  })
  warnings!: string[];
  @ApiProperty({
    required: false,
    example: "http-1",
    description: "The node a resume would restart at.",
  })
  failedNodeId?: string;
  @ApiProperty({
    required: false,
    description: "Ready-to-display text for the `at_most_once_node` warning.",
  })
  warningText?: string;
}

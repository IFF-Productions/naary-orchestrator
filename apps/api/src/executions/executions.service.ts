import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import {
  type Client,
  type Connection,
  defaultPayloadConverter,
  WorkflowNotFoundError,
} from "@temporalio/client";
import {
  APPROVAL_CTX_KEY,
  NODE_TIMES_CTX_KEY,
  approvalSignal,
  chatMessageSignal,
  chatReplyQuery,
  CHAT_SESSION_WORKFLOW,
  resumeSignal,
  RUN_GRAPH_WORKFLOW,
  stateQuery,
  TASK_QUEUE,
  webhookResponseQuery,
  type ApprovalAwaitingRecord,
  type ExecutionState,
  type ExecutionStatus,
  type NodeTimeEntry,
  type ResumeInput,
  type WebhookResponse,
} from "@naary/contracts";
import type { GraphDef, NodeDef } from "@naary/dsl";
import { getPrisma } from "@naary/db";
import { TracedClass } from "@naary/observability";
import { getBudget } from "@naary/usage";
import type { Principal } from "../auth/tenant.decorator";
import { assertWithinMonthlyBudget } from "../budget/budget-guard";
import {
  PermissionsService,
  buildViewTerms,
} from "../permissions/permissions.service";
import { assertWithinCompanyMonthlyBudget } from "../budget/company-budget-guard";
import { executionsStarted } from "../common/metrics";
import { EnvironmentsService } from "../environments/environments.service";
import {
  type GraphSnapshot,
  GraphsService,
  hashGraph,
} from "../graphs/graphs.service";
import { connectTemporal } from "../temporal/client";
import { resumePath } from "./resume-token";

/** Circuit breaker default when a tenant has no budget configured (safety net). */
const DEFAULT_MAX_STEPS_PER_RUN = 50;

/** workflowKey of the demo graph that POST /executions starts. */
const DEFAULT_WORKFLOW_KEY = "default";

/** A run in the list, with live status + accumulated cost from Temporal. */
export interface RunSummary {
  workflowId: string;
  workflowKey: string | null;
  /** App status (running | awaiting_approval | completed | rejected |
   *  budget_exceeded | circuit_open | invalid_graph) or a Temporal close reason
   *  (failed | timed_out | terminated | canceled) or "unknown" if unreachable. */
  status:
    | ExecutionStatus
    | "failed"
    | "timed_out"
    | "terminated"
    | "canceled"
    | "unknown";
  /** Accumulated run cost (from the workflow ctx), or null when unavailable. */
  costUsd: number | null;
  /** When the workflow started (Temporal), ISO. */
  startedAt: string;
  /** DB record time, ISO (kept for time-bucketed charts). */
  createdAt: string;
  /** When the run reached a terminal status (worker-stamped, Slice 2); null for
   *  in-flight runs AND runs predating the stamp — consumers render "—". */
  finishedAt: string | null;
  /** finishedAt − createdAt in ms; null whenever finishedAt is null (never derived
   *  from "now" — an in-flight age is not a duration). */
  durationMs: number | null;
  /** Compact failure classification (timeout | upstream_5xx | rate_limit | budget |
   *  rejected | error) on terminal failures; null → fall back to the status. */
  failureKind: string | null;
  /** Soft-archived (hidden from the default Runs list). */
  archived: boolean;
  /** The GraphDefinition version this run snapshotted at start; null for
   *  pre-migration rows (version wasn't recorded). */
  graphVersion: number | null;
}

/** One page of runs plus the opaque cursor for the next page (null = no more). */
export interface RunPage {
  items: RunSummary[];
  nextCursor: string | null;
}

/** Live run detail — like ExecutionState but with the widened status (a run can be
 *  Temporal-failed/terminated, which ExecutionStatus alone can't express). */
export interface RunStateView {
  status: RunSummary["status"];
  currentNodeId: string;
  ctx: Record<string, unknown>;
  /** Per-node timing map the interpreter stamped into ctx (Slice 2), surfaced as a
   *  first-class field so consumers don't grope the opaque ctx. Null when the run
   *  predates the feature or the ctx is unavailable (Temporal-level failure). */
  nodeTimes: Record<string, NodeTimeEntry> | null;
}

/** Pull the interpreter's per-node timing map out of a run ctx (Slice 2), or null when
 *  absent (pre-feature run / empty ctx). Shape-checked, never fabricated. */
function nodeTimesFrom(
  ctx: Record<string, unknown>,
): Record<string, NodeTimeEntry> | null {
  const raw = ctx[NODE_TIMES_CTX_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, NodeTimeEntry>;
}

/** Approver routing display summary on an awaiting row (Slice 1). */
export interface ApproverSummary {
  emails: string[];
  groups: { id: string; name: string }[];
}

/** A run paused at a humanApproval node, enriched with the node's prompt (resolved
 *  from the stored graph) so the approvals inbox can show WHAT is being approved.
 *  The Slice-1 fields (contextFields/slaHours/dueAt/approvers/…) come from the
 *  awaiting record the worker snapshotted at pause time (ctx.__approval); they are
 *  null for gates without routing/SLA config (and for pre-Slice-1 paused runs). */
export interface AwaitingApproval {
  workflowId: string;
  workflowKey: string | null;
  nodeId: string;
  title: string;
  instructions: string | null;
  createdAt: string;
  /** When the gate paused (worker clock at pause time), ISO. */
  pausedAt: string | null;
  /** The gate's display-only SLA in hours. */
  slaHours: number | null;
  /** pausedAt + slaHours, computed server-side (null unless both exist). */
  dueAt: string | null;
  /** Resolved context fields (expressions evaluated at pause time). */
  contextFields: Record<string, string> | null;
  /** Who may decide (display summary; enforcement happens on the approve path). */
  approvers: ApproverSummary | null;
  /** Escalation display info (notify-only v1). */
  escalateAfterHours: number | null;
  escalateTo: string | null;
}

/** One run's outcome in a batch approve/reject — ok:false carries why it slipped. */
export interface BatchDecisionResult {
  workflowId: string;
  ok: boolean;
  error?: string;
}

/** Temporal closed-status name → our UI status string (COMPLETED handled via result()). */
const TEMPORAL_CLOSED_STATUS: Record<string, RunSummary["status"]> = {
  FAILED: "failed",
  TIMED_OUT: "timed_out",
  TERMINATED: "terminated",
  CANCELLED: "canceled",
  CANCELED: "canceled",
  CONTINUED_AS_NEW: "running",
};

/** Temporal FAILURE states only (for reconciling a stuck-non-terminal PG row). */
const TEMPORAL_FAILED_STATUS: Record<string, RunSummary["status"]> = {
  FAILED: "failed",
  TIMED_OUT: "timed_out",
  TERMINATED: "terminated",
  CANCELLED: "canceled",
  CANCELED: "canceled",
};

/** One entry in a run's execution log (derived from a Temporal history event). */
export interface RunEvent {
  id: number;
  /** Coarse kind for the UI icon/colour. */
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

/** The subset of Temporal history-event fields we read (one attrs object is set). */
interface RawHistoryEvent {
  eventId?: number | string | { toString(): string };
  eventTime?: {
    seconds?: number | string | { toString(): string };
    nanos?: number;
  };
  workflowExecutionStartedEventAttributes?: unknown;
  activityTaskScheduledEventAttributes?: { activityType?: { name?: string } };
  activityTaskCompletedEventAttributes?: unknown;
  activityTaskFailedEventAttributes?: { failure?: { message?: string } };
  workflowExecutionSignaledEventAttributes?: { signalName?: string };
  timerStartedEventAttributes?: unknown;
  timerFiredEventAttributes?: unknown;
  workflowExecutionCompletedEventAttributes?: unknown;
  workflowExecutionFailedEventAttributes?: { failure?: { message?: string } };
  workflowExecutionContinuedAsNewEventAttributes?: unknown;
}

function mapHistoryEvent(e: RawHistoryEvent): RunEvent | null {
  const id = Number(e.eventId ?? 0);
  const at = e.eventTime?.seconds
    ? new Date(
        Number(e.eventTime.seconds) * 1000 + (e.eventTime.nanos ?? 0) / 1e6,
      ).toISOString()
    : null;
  const base = { id, at };
  if (e.workflowExecutionStartedEventAttributes)
    return { ...base, kind: "started", label: "Run started" };
  if (e.activityTaskScheduledEventAttributes)
    return {
      ...base,
      kind: "activity",
      label: `Activity: ${e.activityTaskScheduledEventAttributes.activityType?.name ?? "?"}`,
    };
  if (e.activityTaskCompletedEventAttributes)
    return { ...base, kind: "activity", label: "Activity completed" };
  if (e.activityTaskFailedEventAttributes)
    return {
      ...base,
      kind: "error",
      label: "Activity failed",
      detail: e.activityTaskFailedEventAttributes.failure?.message,
    };
  if (e.workflowExecutionSignaledEventAttributes)
    return {
      ...base,
      kind: "signal",
      label: `Signal: ${e.workflowExecutionSignaledEventAttributes.signalName ?? "?"}`,
    };
  if (e.timerStartedEventAttributes)
    return {
      ...base,
      kind: "timer",
      label: "Timer started (approval timeout)",
    };
  if (e.timerFiredEventAttributes)
    return { ...base, kind: "timer", label: "Timer fired" };
  if (e.workflowExecutionCompletedEventAttributes)
    return { ...base, kind: "completed", label: "Run completed" };
  if (e.workflowExecutionFailedEventAttributes)
    return {
      ...base,
      kind: "error",
      label: "Run failed",
      detail: e.workflowExecutionFailedEventAttributes.failure?.message,
    };
  if (e.workflowExecutionContinuedAsNewEventAttributes)
    return { ...base, kind: "continued", label: "Continued as new" };
  return null; // workflow-task / marker / version noise — skip
}

/**
 * Keyset cursor over the Runs list's (createdAt DESC, workflowId DESC) order — an opaque
 * base64url of the last row's sort key. Offset-free, so a page boundary stays stable even
 * as new runs are inserted at the top of the list.
 */
function encodeRunCursor(row: { createdAt: Date; workflowId: string }): string {
  return Buffer.from(
    JSON.stringify({ t: row.createdAt.toISOString(), id: row.workflowId }),
    "utf8",
  ).toString("base64url");
}

/** Decode + validate an opaque run cursor. A malformed/garbage cursor is a 400 (the
 *  public v1 boundary passes it through verbatim), never a Prisma error. */
function decodeRunCursor(cursor: string): {
  createdAt: Date;
  workflowId: string;
} {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { t?: unknown; id?: unknown };
    if (typeof parsed.t !== "string" || typeof parsed.id !== "string") {
      throw new Error("bad cursor");
    }
    const createdAt = new Date(parsed.t);
    if (Number.isNaN(createdAt.getTime())) throw new Error("bad cursor");
    return { createdAt, workflowId: parsed.id };
  } catch {
    throw new BadRequestException("Invalid cursor");
  }
}

/** Run statuses that won't change again — the read-model is authoritative for these. */
const TERMINAL_STATUSES = new Set([
  "completed",
  "rejected",
  "budget_exceeded",
  "circuit_open",
  "invalid_graph",
  "failed",
  "timed_out",
  "terminated",
  "canceled",
]);
function isTerminalStatus(s: string): boolean {
  return TERMINAL_STATUSES.has(s);
}

/** The awaiting-approval record the worker snapshotted at pause time (ctx.__approval),
 *  or null when the gate carries no Slice-1 fields / the run predates them. */
function awaitingRecord(s: ExecutionState): ApprovalAwaitingRecord | null {
  const rec = (s.ctx ?? {})[APPROVAL_CTX_KEY];
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
  return rec as ApprovalAwaitingRecord;
}

/** dueAt = pausedAt + slaHours (server-side derivation — display-only, no timer). */
function dueAtFrom(rec: ApprovalAwaitingRecord | null): string | null {
  if (!rec?.pausedAt || typeof rec.slaHours !== "number" || rec.slaHours <= 0) {
    return null;
  }
  const paused = Date.parse(rec.pausedAt);
  if (Number.isNaN(paused)) return null;
  return new Date(paused + rec.slaHours * 3_600_000).toISOString();
}

/** The Slice-1 display fields shared by the awaiting inbox row + the public prompt. */
function awaitingFields(rec: ApprovalAwaitingRecord | null): {
  pausedAt: string | null;
  slaHours: number | null;
  dueAt: string | null;
  contextFields: Record<string, string> | null;
  approvers: ApproverSummary | null;
  escalateAfterHours: number | null;
  escalateTo: string | null;
} {
  return {
    pausedAt: rec?.pausedAt ?? null,
    slaHours: rec?.slaHours ?? null,
    dueAt: dueAtFrom(rec),
    contextFields: rec?.contextFields ?? null,
    approvers: rec?.approvers
      ? {
          emails: rec.approvers.emails ?? [],
          groups: rec.approvers.groups ?? [],
        }
      : null,
    escalateAfterHours: rec?.escalateAfterHours ?? null,
    escalateTo: rec?.escalateTo ?? null,
  };
}

/** The Start node's configured sample input (used as the default manual-run input). */
function startSampleInput(
  graph: GraphSnapshot["graph"],
): Record<string, unknown> | undefined {
  const start = graph.nodes.find((n) => n.id === graph.startNodeId);
  const sample = (start?.config as { sampleInput?: unknown } | undefined)
    ?.sampleInput;
  return sample && typeof sample === "object" && !Array.isArray(sample)
    ? (sample as Record<string, unknown>)
    : undefined;
}

/**
 * Wraps the Temporal client: start an execution, signal approval, query state.
 * The client connects once at boot and closes on shutdown.
 *
 * Every run is recorded as an `Execution { workflowId, tenantId }` so the control
 * plane can authorize `approve`/`getState` against the caller's tenant — a raw
 * workflowId is never enough to act on a run.
 */
@Injectable()
@TracedClass()
export class ExecutionsService implements OnModuleInit, OnModuleDestroy {
  private client!: Client;
  private connection!: Connection;

  constructor(
    private readonly graphs: GraphsService,
    private readonly environments: EnvironmentsService,
    /** @Optional so the many bare test constructions still work; when an ACTOR is passed
     *  to start/rerun the service must be wired (fail CLOSED, never skip authz). */
    @Optional() private readonly permissions?: PermissionsService,
  ) {}

  /** The wired PermissionsService, or throw. Only consulted when an ACTOR is present —
   *  an actor without wired permissions must fail CLOSED, never skip authz. */
  private perms(): PermissionsService {
    if (!this.permissions) {
      throw new Error("ExecutionsService: PermissionsService is not wired");
    }
    return this.permissions;
  }

  /** In-service `run` assert (RBAC-GROUPS.md §4). Gates USER-principal-initiated starts
   *  only — trigger paths (webhook/form/chat/schedule) carry no principal by design. */
  private async assertRun(
    actor: Principal | undefined,
    workflowKey: string,
    environmentId: string,
  ): Promise<void> {
    if (!actor) return;
    await this.perms().assertCan(actor, "run", workflowKey, environmentId);
  }

  /**
   * G3 (§8.4) — gate a SINGLE run surface on the run's own workflow. `view` for the read
   * surfaces (detail/history/graph), `run` for approve/cancel (run-control actions). No
   * actor (trigger/internal caller, the company rollup path, the PUBLIC signed-link
   * approval path) = never checked. Env-EXACT: the check resolves against the RUN'S OWN
   * environment (a legacy env-less row falls back to the tenant default, the env its graph
   * lived in — the same convention as approvalPrompt/rerun). A run with NO workflowKey
   * (pre-key-tracking) can't be matched against key-scoped grants — it is visible only to
   * UNRESTRICTED subjects (owner/admin, unrestricted tokens, the zero-grant cliff).
   */
  private async assertRunAccess(
    actor: Principal | undefined,
    action: "view" | "run",
    row: {
      tenantId: string;
      workflowKey: string | null;
      environmentId: string | null;
    },
  ): Promise<void> {
    if (!actor) return;
    const perms = this.perms();
    // Bypassed subjects short-circuit here — no env resolution (no extra DB read) on the
    // common owner/admin/unrestricted path.
    const eff = await perms.getEffective(actor);
    if (!eff.restricted) return;
    if (row.workflowKey === null) {
      throw new ForbiddenException(
        `You don't have permission to ${action === "run" ? "act on" : "view"} this run. ` +
          "Ask a workspace owner or admin for access.",
      );
    }
    const envId =
      row.environmentId ?? (await this.environments.defaultEnvId(row.tenantId));
    await perms.assertCan(actor, action, row.workflowKey, envId);
  }

  /**
   * G3 (§8.4) — the Runs-list view filter for a RESTRICTED subject, as a Prisma where
   * fragment, or null when the caller is unrestricted / absent (the query stays
   * byte-identical — the common path). Pushed INTO the where clause (not post-filtered)
   * so keyset pagination stays EXACT: every fetched row is viewable, pages run full, and
   * the cursor math never sees hidden rows. Env-exact per §8.5: one OR term per tenant
   * environment from the subject's effective view there ({all} ⇒ every key in that env,
   * else the key list); rows with a NULL environmentId (pre-env rows) count as the
   * DEFAULT env's; rows with a NULL workflowKey are visible only to unrestricted
   * subjects, so a restricted subject's terms always constrain workflowKey.
   */
  private async runViewFilter(
    actor: Principal | undefined,
    tenantId: string,
  ): Promise<Record<string, unknown> | null> {
    if (!actor) return null;
    // The per-env terms come from the SHARED builder (permissions.service.ts) — the same
    // semantics filter the usage/insights ledger, so the two surfaces can't drift.
    const viewTerms = await buildViewTerms(this.perms(), actor, () =>
      this.environments.list(tenantId),
    );
    if (viewTerms === null) return null;
    const terms = viewTerms.map((t) => ({
      ...(t.view.all
        ? { workflowKey: { not: null } }
        : { workflowKey: { in: t.view.keys } }),
      ...(t.includesNullEnv
        ? { OR: [{ environmentId: t.environmentId }, { environmentId: null }] }
        : { environmentId: t.environmentId }),
    }));
    // No terms ⇒ nothing viewable anywhere: `OR: []` matches no rows (deny-by-default).
    return { OR: terms };
  }

  async onModuleInit(): Promise<void> {
    const { client, connection } = await connectTemporal();
    this.client = client;
    this.connection = connection;
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection?.close();
  }

  /** Manual start. `tenantId` comes from the authenticated principal (not the body);
   *  runs the tenant's graph for `workflowKey` (default "default"; the canvas
   *  saves + runs "canvas"). The chosen graph must already be saved. Pass
   *  `graphVersion` to run a SPECIFIC saved version (e.g. re-run at an older/newer
   *  version); omit for the latest. */
  async start(
    tenantId: string,
    environmentId: string,
    input?: Record<string, unknown>,
    workflowKey: string = DEFAULT_WORKFLOW_KEY,
    graphVersion?: number,
    /** The user-facing caller (SPA/v1/MCP manual start). Absent for internal/trigger
     *  callers — those are workspace-level automation (§0) and are never gated. */
    actor?: Principal,
  ): Promise<{ workflowId: string }> {
    await this.assertRun(actor, workflowKey, environmentId);
    const snapshot =
      graphVersion === undefined
        ? await this.graphs.getLatest(tenantId, environmentId, workflowKey)
        : await this.graphs.getVersion(
            tenantId,
            environmentId,
            workflowKey,
            graphVersion,
          );
    if (!snapshot) {
      throw new NotFoundException(
        graphVersion === undefined
          ? `No '${workflowKey}' graph for this tenant — save one first`
          : `No version ${graphVersion} of '${workflowKey}' for this tenant`,
      );
    }
    // Default input precedence: explicit body input → the Start node's configured
    // sampleInput → a generic fallback. Lets a workflow define realistic test data.
    return this.startGraph(
      `exec-${tenantId}`,
      snapshot,
      input ??
        startSampleInput(snapshot.graph) ?? {
          message: "I was charged twice this month",
        },
      tenantId,
      environmentId,
      workflowKey,
    );
  }

  /**
   * Connectivity test for the codeAgent node's Claude Code path (the Integrations "Run test"
   * button). Starts a MINIMAL read-only run — an in-memory graph {start → codeAgent → end}
   * that asks the CLI to reply "OK" — so the user can confirm end-to-end that the `claude`
   * binary is present in the worker AND their Anthropic key works through the CLI (a different
   * path than the agent node's direct API validation). Not saved as a workflow; it's a normal
   * run the UI polls via getState. maxTurns:1 keeps it cheap.
   */
  async startCodeAgentTest(
    tenantId: string,
    environmentId: string,
  ): Promise<{ workflowId: string }> {
    const graph: GraphDef = {
      startNodeId: "start",
      nodes: [
        { id: "start", type: "start" },
        {
          id: "codeAgent",
          type: "codeAgent",
          config: {
            tool: "claude",
            prompt: "Reply with the single word: OK.",
            maxTurns: 1,
          },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "codeAgent" },
        { from: "codeAgent", to: "end" },
      ],
    };
    const snapshot: GraphSnapshot = {
      graph,
      contentHash: hashGraph(graph),
      version: 0,
    };
    return this.startGraph(
      `catest-${tenantId}`,
      snapshot,
      {},
      tenantId,
      environmentId,
      "__codeagent_test",
    );
  }

  /** Start a webhook-triggered run; the verified event becomes the trigger output.
   *  The caller resolved + snapshotted the graph from the DB. Refused when the workflow is
   *  INACTIVE (n8n parity) — an automatic trigger, unlike a manual `start()`. */
  async startWebhook(
    tenantId: string,
    environmentId: string,
    snapshot: GraphSnapshot,
    event: unknown,
    workflowKey: string,
  ): Promise<{ workflowId: string }> {
    await this.assertActive(tenantId, environmentId, workflowKey);
    return this.startGraph(
      `wh-${tenantId}`,
      snapshot,
      event,
      tenantId,
      environmentId,
      workflowKey,
    );
  }

  /** Start a form-submission run; the validated+sanitized submission becomes the trigger output.
   *  The caller resolved + snapshotted the graph (and confirmed its entry is a formTrigger).
   *  Refused when the workflow is INACTIVE (n8n parity) — automatic, unlike a manual `start()`. */
  async startForm(
    tenantId: string,
    environmentId: string,
    snapshot: GraphSnapshot,
    submission: Record<string, unknown>,
    workflowKey: string,
  ): Promise<{ workflowId: string }> {
    await this.assertActive(tenantId, environmentId, workflowKey);
    return this.startGraph(
      `form-${tenantId}`,
      snapshot,
      submission,
      tenantId,
      environmentId,
      workflowKey,
    );
  }

  /**
   * Start a webhook run AND wait (bounded) for a `respondToWebhook` node to set a
   * synchronous response. Polls the response query until it's set, the run closes,
   * or the timeout elapses — then returns whatever it has. Any query hiccup or a
   * run that never responds degrades to `{ workflowId }` (no response → the ingress
   * falls back to 202). Never throws for the response path.
   */
  async startWebhookAwaitResponse(
    tenantId: string,
    environmentId: string,
    snapshot: GraphSnapshot,
    event: unknown,
    workflowKey: string,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<{ workflowId: string; response?: WebhookResponse }> {
    const { workflowId } = await this.startWebhook(
      tenantId,
      environmentId,
      snapshot,
      event,
      workflowKey,
    );
    const response = await this.pollForResponse(workflowId, opts);
    return response ? { workflowId, response } : { workflowId };
  }

  /**
   * Start a CHAT run (input `{ message, sessionId }` from the chatTrigger) AND wait (bounded) for the
   * graph's `respondToWebhook` node to set the reply — the chat's answer. Same durable-response
   * mechanism as the webhook path; a run that never replies degrades to `{ workflowId }`. (Durable
   * per-session conversation state is a later slice; this is single-turn.)
   */
  async startChatAwaitResponse(
    tenantId: string,
    environmentId: string,
    snapshot: GraphSnapshot,
    input: {
      message: string;
      sessionId: string;
      history?: { role: string; text: string }[];
    },
    workflowKey: string,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<{ workflowId: string; response?: WebhookResponse }> {
    await this.assertActive(tenantId, environmentId, workflowKey);
    const { workflowId } = await this.startGraph(
      `chat-${tenantId}`,
      snapshot,
      input,
      tenantId,
      environmentId,
      workflowKey,
    );
    const response = await this.pollForResponse(workflowId, opts);
    return response ? { workflowId, response } : { workflowId };
  }

  /**
   * Send a message to a DURABLE per-session chat (design §2.1b, option A). `signalWithStart` starts
   * the long-lived `chatSession` workflow on the first message of a session and signals it after; the
   * turn-id keyed `chatReplyQuery` is then polled for this message's answer (so concurrent messages
   * never read each other's reply). Degrades to `{ replied:false }` if the turn doesn't answer in time.
   */
  async sendChatSessionMessage(
    tenantId: string,
    environmentId: string,
    snapshot: GraphSnapshot,
    input: { message: string; sessionId: string; chatId: string },
    workflowKey: string,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<{ replied: boolean; reply?: unknown }> {
    await this.assertActive(tenantId, environmentId, workflowKey);
    // Stable, deterministic session id — the SAME id for every message of this conversation, so
    // signalWithStart routes them to one workflow. sessionId is sanitized (opaque, ≤200 chars).
    // environmentId is part of the key: the SAME tenant/workflowKey/sessionId used in two envs must
    // route to DIFFERENT durable sessions, or their conversation state would mix across envs.
    const safeSession = input.sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
    const sessionWorkflowId = `chatsession-${tenantId}-${environmentId}-${workflowKey}-${safeSession}`;
    const turnId = randomUUID(); // minted here, never in workflow code (determinism)
    const budget = await getBudget(tenantId);
    // Same fast-fail gates as startGraph — a chat turn is a run start too.
    // Tenant gate first, then the company-wide OUTER gate (both must pass).
    await assertWithinMonthlyBudget(tenantId, budget);
    await assertWithinCompanyMonthlyBudget(tenantId);

    await this.client.workflow.signalWithStart(CHAT_SESSION_WORKFLOW, {
      workflowId: sessionWorkflowId,
      taskQueue: TASK_QUEUE,
      signal: chatMessageSignal,
      signalArgs: [{ message: input.message, turnId }],
      args: [
        {
          graph: snapshot.graph,
          ctx: {
            tenantId,
            environmentId,
            workflowKey,
            perExecutionCapUsd: budget?.perExecutionCapUsd,
            maxStepsPerRun: budget?.maxStepsPerRun ?? DEFAULT_MAX_STEPS_PER_RUN,
            graphContentHash: snapshot.contentHash,
            graphVersion: snapshot.version,
          },
          chatId: input.chatId,
          sessionId: input.sessionId,
        },
      ],
    });

    return this.pollForChatReply(sessionWorkflowId, turnId, opts);
  }

  /** Poll a chat session's reply for one turn until it's replied, ages out, or times out. */
  private async pollForChatReply(
    sessionWorkflowId: string,
    turnId: string,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<{ replied: boolean; reply?: unknown }> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const pollMs = opts.pollMs ?? 150;
    const handle = this.client.workflow.getHandle(sessionWorkflowId);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const state = await handle.query(chatReplyQuery, turnId);
        if (state.status === "replied")
          return { replied: true, reply: state.reply };
        // The turn ran but the graph set no synchronous response — terminal, stop early and report
        // "started" (matches the non-durable path) rather than waiting out the full timeout.
        if (state.status === "no_reply") return { replied: false };
        // "unknown" only occurs after the reply aged out of the window (shouldn't happen inside the
        // poll deadline) — keep polling until the deadline in case of a transient ordering.
      } catch {
        // Transient query/replay hiccup — keep polling.
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return { replied: false };
  }

  /**
   * Poll a run's `respondToWebhook` response query until it's set, the run closes, or the timeout
   * elapses. Never throws (a query hiccup keeps polling); returns undefined if no response arrives.
   * Shared by the webhook + chat synchronous-reply paths.
   */
  private async pollForResponse(
    workflowId: string,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<WebhookResponse | undefined> {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const pollMs = opts.pollMs ?? 150;
    const handle = this.client.workflow.getHandle(workflowId);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const response = await handle.query(webhookResponseQuery);
        if (response) return response;
        // Not set yet — stop early if the run has already closed, but re-query ONCE first (the run
        // may have set the response AND completed between this query and the describe).
        const desc = await handle.describe();
        if (desc.status.name !== "RUNNING") {
          return await handle
            .query(webhookResponseQuery)
            .catch(() => undefined);
        }
      } catch {
        // Transient replay/worker hiccup — keep polling until the deadline.
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return undefined;
  }

  /** Throw 409 if the workflow is deactivated. The gate for AUTOMATIC triggers only (webhook/form);
   *  manual `start()` and schedule/poll (paused in Temporal when inactive) don't call this. */
  private async assertActive(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
  ): Promise<void> {
    // Activation is env-scoped: an automatic trigger fires in the endpoint's OWN environment
    // (design ENVIRONMENTS.md Slice 4), so its activation flag is checked there.
    if (!(await this.graphs.isActive(tenantId, environmentId, workflowKey))) {
      throw new ConflictException("Workflow is inactive");
    }
  }

  private async startGraph(
    prefix: string,
    snapshot: GraphSnapshot,
    input: unknown,
    tenantId: string,
    environmentId: string,
    workflowKey: string,
  ): Promise<{ workflowId: string }> {
    const workflowId = `${prefix}-${randomUUID()}`;
    const budget = await getBudget(tenantId);
    // Fast-fail if the workspace is already over its monthly cap (covers start/webhook/form,
    // which all funnel here). Optimization only — reserveBudget in the agent activity is the
    // authoritative guard; this just avoids starting a run that would die at the first agent.
    await assertWithinMonthlyBudget(tenantId, budget);
    // Company-wide OUTER gate (COMPANIES.md §8, Slice 5) — layered above the tenant gate,
    // both must pass. No-op for standalone workspaces; fails open on lookup errors.
    await assertWithinCompanyMonthlyBudget(tenantId);
    // Bind the current error handler (if any) at start — the interpreter starts it
    // detached on failure. Read now (deterministic in-workflow needs it via args).
    // Env-scoped (slice-6 cleanup): the RUN'S env's binding, so a sandbox failure
    // triggers sandbox's handler, never prod's.
    const errorWorkflowKey = await this.graphs.getErrorHandler(
      tenantId,
      environmentId,
      workflowKey,
    );

    // Pass the immutable graph SNAPSHOT (bytes that existed now); the content hash
    // + version ride in the workflow ctx (history) and a Temporal memo so the run
    // is traceable to its exact version and a later edit can't change it.
    await this.client.workflow.start(RUN_GRAPH_WORKFLOW, {
      args: [
        snapshot.graph,
        input,
        {
          tenantId,
          environmentId,
          workflowKey,
          perExecutionCapUsd: budget?.perExecutionCapUsd,
          maxStepsPerRun: budget?.maxStepsPerRun ?? DEFAULT_MAX_STEPS_PER_RUN,
          graphContentHash: snapshot.contentHash,
          graphVersion: snapshot.version,
          ...(errorWorkflowKey ? { errorWorkflowKey } : {}),
        },
      ],
      taskQueue: TASK_QUEUE,
      workflowId,
      memo: {
        graphContentHash: snapshot.contentHash,
        graphVersion: snapshot.version,
      },
    });

    // Record ownership so approve/getState can be authorized by tenant, plus the
    // snapshotted version for the Runs list / run detail (the memo/history also hold it).
    await getPrisma().execution.create({
      data: {
        workflowId,
        tenantId,
        environmentId, // tag the run with its env (Slice 6)
        workflowKey,
        graphVersion: snapshot.version,
      },
    });
    executionsStarted.inc({ workflowKey });
    return { workflowId };
  }

  /**
   * Single-node TEST (design SINGLE-NODE-EXECUTION.md slice 3): run ONE activity node against a
   * seeded ctx (its upstream outputs, from pins) and return its output. Runs the REAL interpreter
   * in test mode over a synthetic one-node graph — same activity + in-activity secret fetch +
   * billing as a real run — but records no Execution/read-model row (it's not a "run"). Awaits
   * completion (a single activity). Throws WorkflowFailedError if the node errors.
   */
  async testNode(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
    node: NodeDef,
    seededCtx: Record<string, unknown>,
  ): Promise<{
    output: unknown;
    /** Interpreter-measured duration of the tested node (Slice 2); null when the
     *  run recorded none (never a fabricated client-side guess). */
    durationMs: number | null;
    /** Real metered spend of the test run (ctx.__costUsd — same fail-safe billing
     *  as any run: missing usage ledgers the estimate, never zero). Null when the
     *  node meters no cost at all (pure/uncosted nodes). */
    costUsd: number | null;
  }> {
    const graph: GraphDef = {
      startNodeId: node.id,
      nodes: [node, { id: "__snx_end", type: "end" }],
      edges: [{ from: node.id, to: "__snx_end" }],
    };
    const budget = await getBudget(tenantId);
    const result = (await this.client.workflow.execute(RUN_GRAPH_WORKFLOW, {
      args: [
        graph,
        (seededCtx.__input as unknown) ?? {},
        {
          tenantId,
          // A single-node test runs the REAL activity + in-activity secret fetch, so it must read
          // THIS env's creds/connections (Slice 5b) — a sandbox test uses sandbox keys.
          environmentId,
          workflowKey,
          test: true,
          seededCtx,
          perExecutionCapUsd: budget?.perExecutionCapUsd,
          maxStepsPerRun: budget?.maxStepsPerRun ?? DEFAULT_MAX_STEPS_PER_RUN,
        },
      ],
      taskQueue: TASK_QUEUE,
      workflowId: `test-${tenantId}-${randomUUID()}`,
    })) as { ctx: Record<string, unknown> };
    const t = nodeTimesFrom(result.ctx)?.[node.id];
    return {
      output: result.ctx[node.id],
      durationMs: t ? Math.max(0, t.f - t.s) : null,
      costUsd:
        typeof result.ctx.__costUsd === "number" ? result.ctx.__costUsd : null,
    };
  }

  async approve(
    id: string,
    approved: boolean,
    tenantId: string,
    comment?: string,
    /** The user-facing caller (SPA/v1/MCP). G3: asserts `run` on the run's workflow —
     *  deciding an approval is a run-control action. The PUBLIC signed-link path goes
     *  through decideByToken (HMAC-authorized), NOT here, and stays ungated. */
    actor?: Principal,
  ): Promise<void> {
    const row = await this.assertOwner(id, tenantId);
    await this.assertRunAccess(actor, "run", row);
    // Slice 1: when the gate names approvers, the deciding principal must match them
    // (owner/admin user principals bypass). No-op when the gate has no routing.
    await this.assertApprover(actor, id, row.tenantId);
    try {
      await this.client.workflow
        .getHandle(id)
        .signal(approvalSignal, { approved, ...(comment ? { comment } : {}) });
    } catch (e) {
      // Signaling a CLOSED workflow (already completed / rejected / failed) returns
      // gRPC NOT_FOUND → WorkflowNotFoundError. The execution row exists (assertOwner
      // passed), so it's not a 404 — it's a 409: the run is no longer awaiting
      // approval. Mirrors getState's WorkflowNotFoundError handling, with the right
      // semantics for a write. (Previously this leaked an unhandled 500.)
      if (e instanceof WorkflowNotFoundError) {
        throw new ConflictException(
          "Execution is not awaiting approval (already completed, rejected, or failed).",
        );
      }
      throw e;
    }
  }

  /**
   * Decide-time approver enforcement (REDESIGN-FUNCTIONALITY-GAPS.md Slice 1). Reads the
   * awaiting record the worker snapshotted at pause time (ctx.__approval via stateQuery —
   * the RUN'S OWN config snapshot, immune to later graph edits). Semantics:
   *  - gate has no `approvers` (or the run predates the snapshot) → unchanged behavior;
   *  - workspace owner/admin USER principals bypass (consistent with RBAC-GROUPS §4 —
   *    PermissionsService.subjectKey gates only `member` users and tokens);
   *  - user principals match by email (case-insensitive) OR GroupMember membership (uid)
   *    in a listed group;
   *  - restricted `nry_` token principals match via GroupTokenMember (tokenId). A token
   *    WITHOUT a tokenId stamp (unenforced workspace) has no group identity and no email,
   *    so it cannot match a routed gate — fail CLOSED with the same 403;
   *  - absent actor (internal callers; the PUBLIC signed-link path uses decideByToken and
   *    stays HMAC-authorized) → never checked.
   * A closed/undecidable run skips the check — the signal path right after produces the
   * proper 409/404.
   */
  private async assertApprover(
    actor: Principal | undefined,
    workflowId: string,
    tenantId: string,
  ): Promise<void> {
    if (!actor) return;
    let state: ExecutionState;
    try {
      state = await this.client.workflow
        .getHandle(workflowId)
        .query(stateQuery);
    } catch {
      return; // closed/gone — the signal below yields the right 409/404
    }
    if (state.status !== "awaiting_approval") return;
    const approvers = awaitingRecord(state)?.approvers;
    if (!approvers) return;
    const emails = (approvers.emails ?? []).filter((e) => !!e);
    const groupIds = (approvers.groups ?? []).map((g) => g.id).filter(Boolean);
    if (emails.length === 0 && groupIds.length === 0) return;
    // Owner/admin USER principals bypass.
    if (actor.userId && (actor.role === "owner" || actor.role === "admin")) {
      return;
    }
    // Email match (user principals).
    if (
      actor.userId &&
      actor.email &&
      emails.some((e) => e.toLowerCase() === actor.email?.toLowerCase())
    ) {
      return;
    }
    // Group membership: uid via GroupMember, token via GroupTokenMember — tenant-scoped
    // through the group relation so a same-id group of another tenant can never match.
    if (groupIds.length > 0) {
      const prisma = getPrisma();
      if (actor.tokenId) {
        const m = await prisma.groupTokenMember.findFirst({
          where: {
            tokenId: actor.tokenId,
            groupId: { in: groupIds },
            group: { tenantId },
          },
          select: { groupId: true },
        });
        if (m) return;
      } else if (actor.userId) {
        const m = await prisma.groupMember.findFirst({
          where: {
            userId: actor.userId,
            groupId: { in: groupIds },
            group: { tenantId },
          },
          select: { groupId: true },
        });
        if (m) return;
      }
    }
    throw new ForbiddenException(
      "This approval is restricted to its listed approvers. " +
        "Ask one of them to decide, or a workspace owner/admin.",
    );
  }

  /**
   * Decide many paused runs at once with the SAME decision. Each run is signalled
   * independently (de-duped so a double-selected id can't double-signal) — an
   * already-closed or not-owned run must not abort the rest, so we `allSettled` and
   * return a per-run outcome. The caller surfaces which ids slipped (ok:false).
   */
  async approveBatch(
    ids: string[],
    approved: boolean,
    tenantId: string,
    comment?: string,
    actor?: Principal,
  ): Promise<BatchDecisionResult[]> {
    const unique = [...new Set(ids)];
    const settled = await Promise.allSettled(
      unique.map((id) => this.approve(id, approved, tenantId, comment, actor)),
    );
    return settled.map((r, i) =>
      r.status === "fulfilled"
        ? { workflowId: unique[i], ok: true }
        : {
            workflowId: unique[i],
            ok: false,
            error:
              r.reason instanceof Error ? r.reason.message : String(r.reason),
          },
    );
  }

  /**
   * Resolve everything a manual "Remind now" needs (Slice 1): asserts tenant ownership +
   * the `run` verb on the run's workflow, confirms the run is STILL awaiting approval
   * (409 otherwise — nothing to remind about), and returns the run's env + prompt title.
   * The controller then fans the reminder out via NotificationsService.sendApprovalReminder
   * (API-side send — see that method for why not a worker Signal round-trip).
   */
  async remindContext(
    id: string,
    tenantId: string,
    actor?: Principal,
  ): Promise<{
    environmentId: string;
    workflowId: string;
    workflowKey: string | null;
    title: string;
  }> {
    const row = await this.assertOwner(id, tenantId);
    await this.assertRunAccess(actor, "run", row);
    let state: ExecutionState;
    try {
      state = await this.client.workflow.getHandle(id).query(stateQuery);
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) {
        throw new ConflictException(
          "Run is not awaiting approval (already decided, completed, or timed out).",
        );
      }
      throw e;
    }
    if (state.status !== "awaiting_approval") {
      throw new ConflictException(
        "Run is not awaiting approval (already decided, completed, or timed out).",
      );
    }
    const prompt = await this.approvalPrompt(
      tenantId,
      row.environmentId,
      row.workflowKey,
      state.currentNodeId,
    );
    const environmentId =
      row.environmentId ?? (await this.environments.defaultEnvId(tenantId));
    return {
      environmentId,
      workflowId: id,
      workflowKey: row.workflowKey,
      title: prompt.title,
    };
  }

  /**
   * Resume a run paused on a wait(webhook) node by signalling `resumeSignal` with the caller's
   * payload. PUBLIC path: authorization is the HMAC resume token (verified in the controller), so
   * there is NO tenant/owner check here — the token is the credential. A run that isn't paused
   * (already resumed, completed, or timed out) is a closed workflow → NOT_FOUND → 409, mirroring
   * `approve`.
   */
  async resumeByToken(workflowId: string, payload: unknown): Promise<void> {
    try {
      await this.client.workflow
        .getHandle(workflowId)
        .signal(resumeSignal, { payload } satisfies ResumeInput);
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) {
        throw new ConflictException(
          "Run is not awaiting a webhook resume (already resumed, completed, or timed out).",
        );
      }
      throw e;
    }
  }

  /** Approve/reject a paused run authorized by a signed link token (not a bearer) — the public
   *  approval-decision path. No tenant assertion (the HMAC token IS the authorization; the caller
   *  verified it). Mirrors resumeByToken's closed-run handling. */
  async decideByToken(
    workflowId: string,
    approved: boolean,
    comment?: string,
  ): Promise<void> {
    const handle = this.client.workflow.getHandle(workflowId);
    // GUARD (public signed link): only decide a run that is CURRENTLY awaiting approval. Temporal
    // buffers a signal sent to a running-but-not-yet-paused run, so without this a stale link
    // clicked later could be "saved up" and auto-satisfy a FUTURE humanApproval pause (a graph that
    // loops or has multiple approvals). Query the live state first; anything but awaiting → 409.
    let status: string;
    try {
      status = (await handle.query(stateQuery)).status;
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) {
        throw new ConflictException("Run not found or already closed.");
      }
      throw e;
    }
    if (status !== "awaiting_approval") {
      throw new ConflictException(
        "Run is not awaiting approval (already decided, completed, or timed out).",
      );
    }
    try {
      await handle.signal(approvalSignal, {
        approved,
        ...(comment ? { comment } : {}),
      });
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) {
        throw new ConflictException(
          "Run is not awaiting approval (already completed, rejected, or timed out).",
        );
      }
      throw e;
    }
  }

  /** The relative resume-URL path for a run, for the owner's UI to display/copy. Tenant-scoped. */
  async getResumePath(workflowId: string, tenantId: string): Promise<string> {
    await this.assertOwner(workflowId, tenantId);
    return resumePath(workflowId);
  }

  /**
   * Cancel a running (or paused) run — terminates the workflow immediately (status → terminated).
   * Terminate rather than a graceful cancel: the generic interpreter doesn't handle a
   * CancelledFailure, so terminate gives a definitive stop. Tenant-scoped via assertOwner. A run
   * that's already closed returns NOT_FOUND → 409 (nothing to cancel).
   */
  async cancel(id: string, tenantId: string, actor?: Principal): Promise<void> {
    const row = await this.assertOwner(id, tenantId);
    // G3: cancelling is a run-control action — `run` on the run's workflow (§8.4).
    await this.assertRunAccess(actor, "run", row);
    try {
      await this.client.workflow.getHandle(id).terminate("Canceled by user");
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) {
        throw new ConflictException(
          "Execution is already finished — nothing to cancel.",
        );
      }
      throw e;
    }
  }

  /**
   * Soft-archive (hide from the default Runs list) or restore a run. Read-model-only:
   * flips `archivedAt` on the PG row and never touches Temporal — a running run can be
   * archived and keeps executing; unarchiving is just clearing the flag. Owner-scoped.
   */
  async setArchived(
    id: string,
    tenantId: string,
    archived: boolean,
  ): Promise<void> {
    await this.assertOwner(id, tenantId);
    await getPrisma().execution.update({
      where: { workflowId: id },
      data: { archivedAt: archived ? new Date() : null },
    });
  }

  /**
   * Archive (or restore) many runs at once. Each is settled independently (mirrors
   * approveBatch): one not-owned/unknown id doesn't fail the whole batch — the caller gets a
   * per-run outcome so it can drop the successes and surface the rest.
   */
  async archiveBatch(
    ids: string[],
    tenantId: string,
    archived: boolean,
  ): Promise<BatchDecisionResult[]> {
    const unique = [...new Set(ids)];
    const settled = await Promise.allSettled(
      unique.map((id) => this.setArchived(id, tenantId, archived)),
    );
    return settled.map((r, i) =>
      r.status === "fulfilled"
        ? { workflowId: unique[i], ok: true }
        : {
            workflowId: unique[i],
            ok: false,
            error:
              r.reason instanceof Error ? r.reason.message : String(r.reason),
          },
    );
  }

  /**
   * The tenant's runs currently paused for human approval, each enriched with the
   * approval node's prompt (title/instructions) resolved from the stored graph — so
   * the inbox shows WHAT is being approved, not just that something is waiting.
   *
   * Starts from the read-model (status = awaiting_approval), then confirms each is
   * STILL awaiting via a live query (a run may have been decided since the row was
   * written) and reads its current node. Bounded by the number of paused runs.
   */
  async listAwaiting(
    tenantId: string,
    actor?: Principal,
  ): Promise<AwaitingApproval[]> {
    let rows = await getPrisma().execution.findMany({
      where: { tenantId, status: "awaiting_approval" },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    // G3 (§8.4): a RESTRICTED subject's inbox is view-filtered to its workflows —
    // BEFORE the per-run Temporal queries, so invisible runs cost nothing. Key-less
    // legacy rows are visible only to unrestricted subjects (same rule as the list).
    if (actor) {
      const perms = this.perms();
      const eff = await perms.getEffective(actor);
      if (eff.restricted) {
        const visible = await Promise.all(
          rows.map(async (r) => {
            if (r.workflowKey === null) return false;
            const envId =
              r.environmentId ??
              (await this.environments.defaultEnvId(tenantId));
            return perms.can(actor, "view", r.workflowKey, envId);
          }),
        );
        rows = rows.filter((_, i) => visible[i]);
      }
    }
    const items = await Promise.all(
      rows.map(async (r): Promise<AwaitingApproval | null> => {
        let currentNodeId = "";
        let rec: ApprovalAwaitingRecord | null = null;
        try {
          const s = await this.client.workflow
            .getHandle(r.workflowId)
            .query(stateQuery);
          // Decided/advanced since the read-model write, or closed → not awaiting.
          if (s.status !== "awaiting_approval") return null;
          currentNodeId = s.currentNodeId;
          // Slice 1: the pause-time snapshot (contextFields/SLA/approvers) rides the ctx.
          rec = awaitingRecord(s);
        } catch {
          return null; // closed/gone
        }
        const prompt = await this.approvalPrompt(
          tenantId,
          r.environmentId,
          r.workflowKey,
          currentNodeId,
        );
        return {
          workflowId: r.workflowId,
          workflowKey: r.workflowKey,
          nodeId: currentNodeId,
          title: prompt.title,
          instructions: prompt.instructions,
          createdAt: r.createdAt.toISOString(),
          ...awaitingFields(rec),
        };
      }),
    );
    return items.filter((x): x is AwaitingApproval => x !== null);
  }

  /** Public (token-authed) approval prompt lookup by workflowId — for the signed-link decision page.
   *  Resolves tenant/workflowKey from the Execution row (no bearer), confirms the run is still
   *  awaiting, and returns the node's prompt plus (Slice 1) the workspace display name and the
   *  pause-time context fields — the public page's trust line + fields card. Degrades to
   *  `{ awaiting: false }` on any miss. */
  async promptByWorkflowId(workflowId: string): Promise<{
    awaiting: boolean;
    title?: string;
    instructions?: string | null;
    /** Workspace display name (TenantSettings.displayName) — "on behalf of …". Null if unset. */
    workspaceName?: string | null;
    /** Resolved pause-time context fields (never secrets — see prepareApproval). */
    contextFields?: Record<string, string> | null;
    slaHours?: number | null;
    dueAt?: string | null;
  }> {
    const row = await getPrisma().execution.findUnique({
      where: { workflowId },
    });
    if (!row) return { awaiting: false };
    try {
      const s = await this.client.workflow
        .getHandle(workflowId)
        .query(stateQuery);
      if (s.status !== "awaiting_approval") return { awaiting: false };
      const prompt = await this.approvalPrompt(
        row.tenantId,
        row.environmentId,
        row.workflowKey,
        s.currentNodeId,
      );
      const rec = awaitingRecord(s);
      // Best-effort workspace display name — the public trust line ("on behalf of Acme").
      const settings = await getPrisma()
        .tenantSettings.findUnique({
          where: { tenantId: row.tenantId },
          select: { displayName: true },
        })
        .catch(() => null);
      return {
        awaiting: true,
        title: prompt.title,
        instructions: prompt.instructions,
        workspaceName: settings?.displayName ?? null,
        contextFields: rec?.contextFields ?? null,
        slaHours: rec?.slaHours ?? null,
        dueAt: dueAtFrom(rec),
      };
    } catch {
      return { awaiting: false };
    }
  }

  /** Resolve a humanApproval node's title/instructions from the tenant's stored graph. */
  private async approvalPrompt(
    tenantId: string,
    environmentId: string | null,
    workflowKey: string | null,
    nodeId: string,
  ): Promise<{ title: string; instructions: string | null }> {
    if (!workflowKey) return { title: "Approval required", instructions: null };
    // Best-effort read of the graph for the node's title, IN THE RUN'S OWN ENV (Slice 6) — the run
    // is env-tagged now, so a sandbox run's prompt reads the sandbox graph. A pre-Slice-6 run has no
    // env tag → fall back to the tenant default (where its graph lived).
    const envId =
      environmentId ?? (await this.environments.defaultEnvId(tenantId));
    const snap = await this.graphs
      .getLatest(tenantId, envId, workflowKey)
      .catch(() => null);
    const node = snap?.graph.nodes.find((n) => n.id === nodeId);
    const cfg = (node?.config ?? {}) as {
      title?: string;
      instructions?: string;
    };
    return {
      title: cfg.title?.trim() || "Approval required",
      instructions: cfg.instructions?.trim() || null,
    };
  }

  /**
   * Recent runs for the tenant (newest first). Reads the Execution READ-MODEL: the
   * interpreter pushes status + accumulated cost to the row as a run progresses
   * (see setExecutionStatus), so a terminal run needs ZERO Temporal calls — the
   * key scaling win over the old per-run describe()+result() (which replayed each
   * closed run's history).
   *
   * One reconcile: a run still marked non-terminal in PG that FAILED at the
   * Temporal level (the workflow THREW, so it couldn't push a terminal status) is
   * caught with a cheap describe() ONLY (no history replay). Genuinely
   * running/awaiting runs keep their pushed status.
   */
  async list(
    tenantId: string,
    limit = 50,
    archived = false,
    actor?: Principal,
  ): Promise<RunSummary[]> {
    const { items } = await this.listPage(tenantId, { limit, archived }, actor);
    return items;
  }

  /**
   * Cursor-paged variant of {@link list} (the public v1 GET /runs seam). Keyset
   * pagination on (createdAt DESC, workflowId DESC): the returned `nextCursor`
   * encodes the last row's sort key, so the next page picks up exactly after it
   * even as new runs land at the top (an offset would drift). `nextCursor` is null
   * when there is no further page. Same read-model + reconcile path as list().
   */
  async listPage(
    tenantId: string,
    opts: { limit?: number; cursor?: string; archived?: boolean } = {},
    /** The user-facing caller (SPA Runs screen / v1 GET /runs). G3 (§8.4): a RESTRICTED
     *  subject's rows are view-filtered IN the where clause, so pagination stays exact.
     *  Absent for internal callers + the company rollup path (workspace-level reads). */
    actor?: Principal,
  ): Promise<RunPage> {
    const take = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    // Default view hides archived runs; `archived: true` shows only the archived ones.
    const base = { tenantId, archivedAt: opts.archived ? { not: null } : null };
    // Keyset filter: rows strictly AFTER the cursor row in the (DESC, DESC) order.
    const keyset = opts.cursor
      ? {
          ...base,
          OR: (({ createdAt, workflowId }) => [
            { createdAt: { lt: createdAt } },
            { createdAt, workflowId: { lt: workflowId } },
          ])(decodeRunCursor(opts.cursor)),
        }
      : base;
    // View scoping composes via AND so it can't collide with the keyset's own OR. Null
    // for unrestricted callers — their query is byte-identical to before G3.
    const viewFilter = await this.runViewFilter(actor, tenantId);
    const where = viewFilter ? { ...keyset, AND: [viewFilter] } : keyset;
    const rows = await getPrisma().execution.findMany({
      where,
      // The workflowId tiebreak makes the order TOTAL, so a page boundary can't
      // skip/duplicate rows that share a createdAt.
      orderBy: [{ createdAt: "desc" }, { workflowId: "desc" }],
      take: take + 1, // one extra row probes "is there a next page?"
    });
    const page = rows.slice(0, take);
    const nextCursor =
      rows.length > take ? encodeRunCursor(page[page.length - 1]) : null;
    const items = await Promise.all(page.map((r) => this.toRunSummary(r)));
    return { items, nextCursor };
  }

  /** Map one Execution read-model row to a RunSummary (with the non-terminal
   *  Temporal-failure reconcile described on {@link list}). */
  private async toRunSummary(r: {
    workflowId: string;
    workflowKey: string | null;
    status: string;
    costUsd: unknown;
    createdAt: Date;
    finishedAt: Date | null;
    failureKind: string | null;
    archivedAt: Date | null;
    graphVersion: number | null;
  }): Promise<RunSummary> {
    const createdAt = r.createdAt.toISOString();
    const base = {
      workflowId: r.workflowId,
      workflowKey: r.workflowKey,
      costUsd: r.costUsd !== null ? Number(r.costUsd) : null,
      // startedAt currently mirrors the DB row time; createdAt reads the DB field
      // directly (per its docstring) rather than aliasing startedAt, so a future
      // real Temporal start time can diverge without silently moving createdAt.
      startedAt: createdAt,
      createdAt,
      // Slice 2: worker-stamped terminal time → durationMs. Both null for runs that
      // predate the stamp / closed only at the Temporal level — the UI keeps "—".
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      durationMs: r.finishedAt
        ? Math.max(0, r.finishedAt.getTime() - r.createdAt.getTime())
        : null,
      failureKind: r.failureKind,
      archived: r.archivedAt !== null,
      graphVersion: r.graphVersion,
    };
    if (isTerminalStatus(r.status)) {
      return { ...base, status: r.status as RunSummary["status"] };
    }
    // Non-terminal in PG → reconcile against Temporal (cheap describe only) so
    // a workflow that threw (Temporal-FAILED) isn't shown as forever-running.
    try {
      const desc = await this.client.workflow
        .getHandle(r.workflowId)
        .describe();
      const failed = TEMPORAL_FAILED_STATUS[desc.status.name];
      return {
        ...base,
        status: failed ?? (r.status as RunSummary["status"]),
      };
    } catch {
      return { ...base, status: r.status as RunSummary["status"] };
    }
  }

  /**
   * Live detail for a run. Mirrors list()'s truthful, never-500 status handling:
   * describe() to learn the Temporal state, then a RUNNING run is queried, a
   * COMPLETED run's terminal status + ctx come from result(), and a Temporal
   * failure (FAILED/TIMED_OUT/TERMINATED/CANCELED) maps to a real status instead
   * of throwing a 500. Only a truly-gone run is a 404.
   */
  async getState(
    id: string,
    tenantId: string,
    actor?: Principal,
  ): Promise<RunStateView> {
    const row = await this.assertOwner(id, tenantId);
    // G3 (§8.4): the run detail (incl. its ctx/output) is view-gated on its workflow.
    await this.assertRunAccess(actor, "view", row);
    const handle = this.client.workflow.getHandle(id);
    try {
      const desc = await handle.describe();
      if (desc.status.name === "RUNNING") {
        // Wrap the query (mirrors list()): a transient replay/worker hiccup must
        // degrade to "running", never 500.
        try {
          const s = await handle.query(stateQuery);
          return {
            status: s.status,
            currentNodeId: s.currentNodeId,
            ctx: s.ctx,
            nodeTimes: nodeTimesFrom(s.ctx),
          };
        } catch {
          return {
            status: "running",
            currentNodeId: "",
            ctx: {},
            nodeTimes: null,
          };
        }
      }
      if (desc.status.name === "COMPLETED") {
        try {
          const r = (await handle.result()) as {
            status: ExecutionStatus;
            ctx: Record<string, unknown>;
          };
          return {
            status: r.status,
            currentNodeId: "",
            ctx: r.ctx,
            nodeTimes: nodeTimesFrom(r.ctx),
          };
        } catch {
          return {
            status: "completed",
            currentNodeId: "",
            ctx: {},
            nodeTimes: null,
          };
        }
      }
      // Temporal-level failure (the workflow threw, was terminated, etc.) — there's
      // no returned {status,ctx} to recover, so report the mapped close reason.
      return {
        status: TEMPORAL_CLOSED_STATUS[desc.status.name] ?? "unknown",
        currentNodeId: "",
        ctx: {},
        nodeTimes: null,
      };
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) {
        throw new NotFoundException("Execution not found");
      }
      throw e;
    }
  }

  /**
   * The run's execution log — a curated timeline from the workflow's Temporal
   * history (the durable record of what happened). We map by event TYPE (which
   * `*EventAttributes` is present) + read only plain fields (activity name, signal
   * name, failure message — already sanitized at the activity) — no payload
   * decoding, so nothing secret-bearing is surfaced.
   */
  async history(
    id: string,
    tenantId: string,
    actor?: Principal,
  ): Promise<RunEvent[]> {
    const row = await this.assertOwner(id, tenantId);
    await this.assertRunAccess(actor, "view", row);
    let h: { events?: unknown[] | null };
    try {
      h = await this.client.workflow.getHandle(id).fetchHistory();
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) {
        throw new NotFoundException("Execution not found");
      }
      throw e;
    }
    const out: RunEvent[] = [];
    for (const raw of h.events ?? []) {
      const ev = mapHistoryEvent(raw as RawHistoryEvent);
      if (ev) out.push(ev);
    }
    return out;
  }

  /**
   * The trigger input a past run was STARTED with, read back from Temporal history
   * (the durable source of truth). We decode the WorkflowExecutionStarted event's
   * SECOND arg — `startGraph` starts the workflow with `[graph, input, runCtx]`, so
   * `payloads[1]` is the input — using the default payload converter (this deployment
   * configures no custom one). Works for ANY terminal state, including a FAILED run
   * whose ctx `getState` can't return — which is exactly what a re-run needs. Returns
   * undefined if the event/payload is missing or undecodable (caller falls back to the
   * graph's default input). Nothing is surfaced to the user: the value is fed straight
   * back into a new run, so no new payload exposure.
   */
  private async originalTriggerInput(
    id: string,
  ): Promise<Record<string, unknown> | undefined> {
    let h: { events?: unknown[] | null };
    try {
      h = await this.client.workflow.getHandle(id).fetchHistory();
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) {
        throw new NotFoundException("Execution not found");
      }
      throw e;
    }
    const started = (h.events ?? []).find(
      (ev) =>
        (ev as { workflowExecutionStartedEventAttributes?: unknown })
          .workflowExecutionStartedEventAttributes,
    ) as
      | {
          workflowExecutionStartedEventAttributes?: {
            input?: { payloads?: unknown[] };
          };
        }
      | undefined;
    const payloads =
      started?.workflowExecutionStartedEventAttributes?.input?.payloads;
    if (!payloads || payloads.length < 2) return undefined;
    try {
      const decoded = defaultPayloadConverter.fromPayload(payloads[1] as never);
      return decoded == null ? undefined : (decoded as Record<string, unknown>);
    } catch {
      return undefined;
    }
  }

  /**
   * The graph a past run EXECUTED, read back from Temporal history (the durable source of
   * truth). `startGraph` starts the workflow with `[graph, input, runCtx]`, so `payloads[0]`
   * is the version-pinned snapshot the run actually walked — accurate even if the saved
   * workflow was edited since (unlike fetching the latest by key). Owner-scoped; used by the
   * run-detail canvas to draw the executed path. 404 if the run or its snapshot is gone.
   * Read-only projection — the graph is definition data (no secrets), safe to return.
   */
  async runGraph(
    id: string,
    tenantId: string,
    actor?: Principal,
  ): Promise<{
    graph: Record<string, unknown>;
    version: number | null;
    workflowKey: string | null;
  }> {
    const owned = await this.assertOwner(id, tenantId);
    await this.assertRunAccess(actor, "view", owned);
    let h: { events?: unknown[] | null };
    try {
      h = await this.client.workflow.getHandle(id).fetchHistory();
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) {
        throw new NotFoundException("Execution not found");
      }
      throw e;
    }
    const started = (h.events ?? []).find(
      (ev) =>
        (ev as { workflowExecutionStartedEventAttributes?: unknown })
          .workflowExecutionStartedEventAttributes,
    ) as
      | {
          workflowExecutionStartedEventAttributes?: {
            input?: { payloads?: unknown[] };
          };
        }
      | undefined;
    const payloads =
      started?.workflowExecutionStartedEventAttributes?.input?.payloads;
    if (!payloads || payloads.length < 1) {
      throw new NotFoundException("This run has no stored graph snapshot.");
    }
    let graph: unknown;
    try {
      // fromPayload can throw on a malformed/unknown payload — treat that as "no usable
      // snapshot" (404), not an unhandled 500 (mirrors originalTriggerInput's guard).
      graph = defaultPayloadConverter.fromPayload(payloads[0] as never);
    } catch {
      graph = undefined;
    }
    // Require a GraphDef-SHAPED object (nodes[] + edges[] + startNodeId), not just any object
    // — an array or arbitrary payload would decode fine here but then throw in the web
    // decompiler, which iterates graph.nodes AND graph.edges.
    const g = graph as {
      nodes?: unknown;
      edges?: unknown;
      startNodeId?: unknown;
    } | null;
    if (
      g == null ||
      typeof g !== "object" ||
      Array.isArray(g) ||
      !Array.isArray(g.nodes) ||
      !Array.isArray(g.edges) ||
      typeof g.startNodeId !== "string"
    ) {
      throw new NotFoundException("This run's graph snapshot is unavailable.");
    }
    // Version + workflowKey come from the Execution read-model row (the same source the
    // Runs list uses, so the detail label matches the list) — not re-decoded from history.
    // These let the detail view label the executed graph and drive the re-run-at-version
    // picker. version is null for pre-migration runs; workflowKey null for very old rows.
    const row = await getPrisma().execution.findUnique({
      where: { workflowId: id },
      select: { graphVersion: true, workflowKey: true },
    });
    return {
      graph: g as Record<string, unknown>,
      version: row?.graphVersion ?? null,
      workflowKey: row?.workflowKey ?? null,
    };
  }

  /**
   * Re-run a past execution: start a NEW run of the same saved workflow with the same
   * trigger input the original was started with (n8n's "Retry"). By default it runs
   * against the CURRENT graph (start snapshots the latest) — so re-running picks up any
   * fix. Pass `graphVersion` to re-run at a SPECIFIC saved version (newer or older) of
   * the run's OWN workflowKey — the version is resolved against that key only, never an
   * arbitrary (key, version) from the caller. The run is durable and metered exactly
   * like any other start. Returns the new run id.
   */
  async rerun(
    id: string,
    tenantId: string,
    graphVersion?: number,
    actor?: Principal,
  ): Promise<{ workflowId: string }> {
    await this.assertOwner(id, tenantId);
    const row = await getPrisma().execution.findUnique({
      where: { workflowId: id },
    });
    if (!row?.workflowKey) {
      throw new BadRequestException(
        "This run predates workflow-key tracking and can't be re-run.",
      );
    }
    // Re-run in the ORIGINAL run's env (Slice 6) — a sandbox run re-runs against the sandbox graph.
    // A pre-Slice-6 run has no env tag → the tenant default (where its graph lived).
    const envId =
      row.environmentId ?? (await this.environments.defaultEnvId(tenantId));
    // `run` gate (§4) against the run's own key + env, BEFORE reading the original input.
    await this.assertRun(actor, row.workflowKey, envId);
    const input = await this.originalTriggerInput(id);
    // workflowKey is the run's OWN key; graphVersion (if given) is resolved against
    // that key inside start() — the caller can't target another workflow's version.
    // No actor forwarded: the gate already ran just above (same key + env).
    return this.start(tenantId, envId, input, row.workflowKey, graphVersion);
  }

  /** 404 if the execution is unknown, 403 if it belongs to another tenant. Returns the
   *  row so callers can gate on its workflowKey/environmentId without a second read. */
  private async assertOwner(
    workflowId: string,
    tenantId: string,
  ): Promise<{
    tenantId: string;
    workflowKey: string | null;
    environmentId: string | null;
  }> {
    const row = await getPrisma().execution.findUnique({
      where: { workflowId },
    });
    if (!row) throw new NotFoundException("Execution not found");
    if (row.tenantId !== tenantId) {
      throw new ForbiddenException("Execution belongs to another tenant");
    }
    return row;
  }
}

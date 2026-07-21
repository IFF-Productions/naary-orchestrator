import { BadRequestException } from "@nestjs/common";
import {
  APPROVAL_CTX_KEY,
  NODE_TIMES_CTX_KEY,
  type ApprovalAwaitingRecord,
  type ExecutionState,
  type NodeTimeEntry,
} from "@naary/contracts";
import type { GraphSnapshot } from "../graphs/graphs.service";
import {
  type ApproverSummary,
  type RawHistoryEvent,
  type RunEvent,
  TERMINAL_STATUSES,
} from "./executions.types";

/** Pull the interpreter's per-node timing map out of a run ctx (Slice 2), or null when
 *  absent (pre-feature run / empty ctx). Shape-checked, never fabricated. */
export function nodeTimesFrom(
  ctx: Record<string, unknown>,
): Record<string, NodeTimeEntry> | null {
  const raw = ctx[NODE_TIMES_CTX_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, NodeTimeEntry>;
}

/** The run's accumulated spend mirrored into ctx (__costUsd), or null when the run
 *  metered nothing / predates the mirror. Shape-checked, never fabricated (Slice 3). */
export function costUsdFrom(ctx: Record<string, unknown>): number | null {
  const c = ctx.__costUsd;
  return typeof c === "number" && Number.isFinite(c) ? c : null;
}

export function mapHistoryEvent(e: RawHistoryEvent): RunEvent | null {
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
export function encodeRunCursor(row: {
  createdAt: Date;
  workflowId: string;
}): string {
  return Buffer.from(
    JSON.stringify({ t: row.createdAt.toISOString(), id: row.workflowId }),
    "utf8",
  ).toString("base64url");
}

/** Decode + validate an opaque run cursor. A malformed/garbage cursor is a 400 (the
 *  public v1 boundary passes it through verbatim), never a Prisma error. */
export function decodeRunCursor(cursor: string): {
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

export function isTerminalStatus(s: string): boolean {
  return TERMINAL_STATUSES.has(s);
}

/** The awaiting-approval record the worker snapshotted at pause time (ctx.__approval),
 *  or null when the gate carries no Slice-1 fields / the run predates them. */
export function awaitingRecord(
  s: ExecutionState,
): ApprovalAwaitingRecord | null {
  const rec = (s.ctx ?? {})[APPROVAL_CTX_KEY];
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
  return rec as ApprovalAwaitingRecord;
}

/** dueAt = pausedAt + slaHours (server-side derivation — display-only, no timer). */
export function dueAtFrom(rec: ApprovalAwaitingRecord | null): string | null {
  if (!rec?.pausedAt || typeof rec.slaHours !== "number" || rec.slaHours <= 0) {
    return null;
  }
  const paused = Date.parse(rec.pausedAt);
  if (Number.isNaN(paused)) return null;
  return new Date(paused + rec.slaHours * 3_600_000).toISOString();
}

/** The Slice-1 display fields shared by the awaiting inbox row + the public prompt. */
export function awaitingFields(rec: ApprovalAwaitingRecord | null): {
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
export function startSampleInput(
  graph: GraphSnapshot["graph"],
): Record<string, unknown> | undefined {
  const start = graph.nodes.find((n) => n.id === graph.startNodeId);
  const sample = (start?.config as { sampleInput?: unknown } | undefined)
    ?.sampleInput;
  return sample && typeof sample === "object" && !Array.isArray(sample)
    ? (sample as Record<string, unknown>)
    : undefined;
}

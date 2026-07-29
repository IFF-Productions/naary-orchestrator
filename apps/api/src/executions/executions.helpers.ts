import { BadRequestException } from "@nestjs/common";
import { defaultPayloadConverter } from "@temporalio/client";
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
  type HttpFailureBodyView,
  type HttpFailureView,
  type RawFailure,
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

// --- The failing node's redacted request/response (#916) -------------------------------------
//
// `queryHistory` otherwise reads PLAIN history fields only, on the stated grounds that no payload
// decoding means nothing secret can leak. The decode below is a DELIBERATE exception, and narrow:
// the only thing read is the `http` key the worker's `captureHttpFailure` writes, which is already
// failures-only, header-allowlisted, secret-scrubbed and truncated AT THE SOURCE — before it ever
// reached history. Nothing else in `details` is looked at, and the decoded value is rebuilt field
// by field rather than spread, so an unexpected shape can't ride into the response.
//
// Total by construction: this runs while rendering an already-FAILED run, so a throw here would
// replace a diagnosable error with a 500.

/** Hard caps applied to the DECODED value. The worker's caps are the real ones; these exist so a
 *  payload written by an older/other worker still can't bloat the run-detail response. */
const MAX_URL_CHARS = 1000;
const MAX_HEADERS = 60;
const MAX_HEADER_CHARS = 300;
const MAX_BODY_CHARS = 4096;
const MAX_CAPTURE_BYTES = 16_384;
/** Matches `failureChain`'s bound — a cyclic or absurdly deep chain can't spin here. */
const MAX_CAUSE_DEPTH = 12;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined;
}

/** Flat string→string only. A nested/array value is dropped, never stringified. */
function headerMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(v)) return out;
  for (const [k, val] of Object.entries(v).slice(0, MAX_HEADERS)) {
    if (typeof val === "string")
      out[k.slice(0, MAX_HEADER_CHARS)] = val.slice(0, MAX_HEADER_CHARS);
  }
  return out;
}

function bodyView(v: unknown): HttpFailureBodyView | undefined {
  if (!isObj(v)) return undefined;
  const text = str(v.text, MAX_BODY_CHARS);
  if (text === undefined) return undefined;
  return {
    text,
    // The WORKER is the authority on whether it cut anything. Re-deriving this from
    // `text.length < bytes` reads as truncated on every body that merely had a credential
    // scrubbed out of it — redaction shrinks the text while `bytes` stays the wire length.
    truncated: v.truncated === true,
    bytes: typeof v.bytes === "number" && v.bytes >= 0 ? v.bytes : text.length,
  };
}

/** Rebuild the capture field by field, dropping anything that isn't the shape we expect. */
export function sanitizeHttpFailure(v: unknown): HttpFailureView | undefined {
  if (!isObj(v) || !isObj(v.request)) return undefined;
  const r = v.request;
  const method = str(r.method, 16);
  const url = str(r.url, MAX_URL_CHARS);
  if (!method || !url) return undefined;

  const out: HttpFailureView = {
    request: { method, url, headers: headerMap(r.headers) },
  };
  const nodeId = str(v.nodeId, 200);
  if (nodeId) out.nodeId = nodeId;
  const reqBody = bodyView(r.body);
  if (reqBody) out.request.body = reqBody;
  const withheld = str(r.bodyWithheld, 200);
  if (withheld) out.request.bodyWithheld = withheld;

  const res = v.response;
  if (isObj(res) && typeof res.status === "number") {
    const response: NonNullable<HttpFailureView["response"]> = {
      status: res.status,
      headers: headerMap(res.headers),
    };
    const statusText = str(res.statusText, 200);
    if (statusText) response.statusText = statusText;
    const resBody = bodyView(res.body);
    if (resBody) response.body = resBody;
    out.response = response;
  }

  // Last guard: a capture that somehow got large is dropped WHOLE rather than half-shown —
  // a run's execution log must stay a small response.
  return JSON.stringify(out).length > MAX_CAPTURE_BYTES ? undefined : out;
}

/**
 * Walk a Temporal failure's cause chain for the first `ApplicationFailure` whose details carry an
 * `http` capture.
 *
 * The chain rather than a fixed level, because Temporal wraps: `WorkflowExecutionFailed` →
 * `ActivityTaskFailed` → the `ApplicationFailure` the activity actually threw. And the FIRST node
 * with details is not necessarily the right one — `toSanitizedRetryable` attaches `{statusCode}` —
 * so the walk stops on the presence of `http`, not on the presence of details.
 */
export function httpFailureFrom(
  failure: RawFailure | undefined,
): HttpFailureView | undefined {
  let node = failure;
  for (let depth = 0; node && depth < MAX_CAUSE_DEPTH; depth++) {
    const payload = node.applicationFailureInfo?.details?.payloads?.[0];
    if (payload) {
      try {
        const decoded = defaultPayloadConverter.fromPayload(payload as never);
        if (isObj(decoded) && decoded.http !== undefined) {
          const view = sanitizeHttpFailure(decoded.http);
          if (view) return view;
        }
      } catch {
        // A payload we can't decode is not a reason to fail the history read.
      }
    }
    node = node.cause;
  }
  return undefined;
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
  if (e.activityTaskFailedEventAttributes) {
    const failure = e.activityTaskFailedEventAttributes.failure;
    const http = httpFailureFrom(failure);
    return {
      ...base,
      kind: "error",
      label: "Activity failed",
      detail: failure?.message,
      // The message alone left the step card saying "No output was recorded for this step"
      // (#916) — attach the redacted request/response the activity captured, when it did.
      ...(http ? { http } : {}),
    };
  }
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
  if (e.workflowExecutionFailedEventAttributes) {
    const failure = e.workflowExecutionFailedEventAttributes.failure;
    const http = httpFailureFrom(failure);
    return {
      ...base,
      kind: "error",
      label: "Run failed",
      detail: failure?.message,
      ...(http ? { http } : {}),
    };
  }
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

/** Max length of the searchable trigger-input projection stored on the Execution row (#463) — caps
 *  the pg_trgm index size and honors the payload rule (long inputs truncate, never reject). */
const SEARCH_TEXT_MAX = 8_192;

/**
 * Build the searchable projection of a run's TRIGGER INPUT (issue #463 "search executions by
 * contained data"). The input is the user-supplied structured data a run was started with — NOT LLM
 * prompt/completion text and NOT node outputs — so it is safe to index (privacy rule / usage-ledger
 * invariant). We serialize it to plain text and length-cap it; the `?q=` substring search runs
 * against this string. Returns undefined for empty/undecodable input so the column stays NULL (a
 * NULL never matches a search — no false hits, and it's the honest "nothing to index" signal).
 */
export function projectSearchText(input: unknown): string | undefined {
  if (input == null) return undefined;
  let text: string;
  try {
    text = typeof input === "string" ? input : JSON.stringify(input);
  } catch {
    return undefined; // circular / non-serializable — skip rather than fail the run start
  }
  if (!text || text === "{}" || text === "[]") return undefined;
  return text.length > SEARCH_TEXT_MAX ? text.slice(0, SEARCH_TEXT_MAX) : text;
}

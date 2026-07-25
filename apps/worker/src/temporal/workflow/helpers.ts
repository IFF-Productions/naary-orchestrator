// Pure interpreter constants + helpers (split out of workflows.ts — moved
// verbatim, zero behavior change). Everything here is deterministic and
// command-neutral: safe in the Temporal workflow sandbox.
import { ApplicationFailure, TimeoutFailure } from "@temporalio/workflow";
import type { FailureKind } from "@naary/contracts";
import type { TraceCell } from "@naary/dsl";

/** Max sub-workflow nesting depth (a run at this depth refuses to spawn children).
 *  Bounds accidental/infinite recursion — a saved graph that calls itself. */
export const MAX_SUBWORKFLOW_DEPTH = 5;

/** Max items a single forEach will fan out to (child run per item). An array larger
 *  than this trips the circuit breaker — filter/limit upstream first. */
export const MAX_FOREACH_ITEMS = 100;

/**
 * Claim-check reference shape (@naary/storage's `ClaimCheck`), DUPLICATED here on purpose: workflow
 * code must not import @naary/storage — that would pull the AWS S3 SDK and `node:crypto` into the
 * deterministic Temporal sandbox. The shape is one field and has not changed since Arch§4.6;
 * packages/dsl/src/node-output.ts inlines it for the same reason. Keep in sync with claim-check.ts.
 */
function isClaimCheckRef(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { __claimCheck?: unknown }).__claimCheck === "string"
  );
}

/**
 * True when `value` holds a claim-check reference ANYWHERE in its tree — the signal that an items
 * source cannot be read in workflow code and must go through the `expandItems` activity (#479).
 *
 * PURE: no I/O, no clock, no randomness; issues no Temporal command. Bounded (the value already fit
 * Temporal's payload cap to get here) and cycle-safe.
 *
 * Deliberately NOT path-aware. A reference may sit AT the source path (the whole `body` was
 * offloaded) or ABOVE it (`body.items`, where `body` is the reference and getByPath silently yields
 * `undefined`). Any reference in the tree routes us to the activity, which applies the REAL
 * @naary/dsl getByPath after rehydrating — so there is no second path parser here to drift out of
 * sync. The cost is a rare wasted activity when a reference sits off-path; the benefit is that a
 * whole class of silent-wrong-answer bugs cannot exist.
 */
export function containsClaimCheckRef(
  value: unknown,
  seen = new WeakSet<object>(),
): boolean {
  if (isClaimCheckRef(value)) return true;
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((v) => containsClaimCheckRef(v, seen));
  }
  return Object.values(value).some((v) => containsClaimCheckRef(v, seen));
}

/**
 * continueAsNew snapshot budget (#681). Above this many serialized `ctx` bytes the interpreter
 * claim-checks the LARGEST node outputs before continuing, so the carried snapshot stays under
 * Temporal's ~2MB payload cap instead of hard-failing an otherwise-healthy long run. Deliberately
 * well below 2MB: the continueAsNew payload also carries the graph snapshot, the trigger input and
 * runCtx, and Temporal's cap applies to the whole thing.
 */
export const CAN_CTX_BUDGET_BYTES = 1_200_000;

/**
 * Per-entry floor for that offload. Only sizeable entries are worth a reference, and every
 * reference costs workflow-side readability: an edge condition or `{{ }}` expression reading INTO an
 * offloaded output resolves to `undefined` in workflow code (only activities rehydrate). Keeping the
 * floor high means the trade is made for a handful of blobs, never for the small outputs conditions
 * actually branch on. (This residual is documented in docs/DURABILITY-PROOF.md.)
 */
export const CAN_CTX_ENTRY_FLOOR_BYTES = 64_000;

/**
 * A single entry above this size cannot be offloaded at all — it would blow the ~2MB payload cap as
 * the offload ACTIVITY's own argument. Such an entry can only come from a PURE workflow-side node
 * (merge/aggregate/listOps of several already-large parents), since every activity output is already
 * claim-checked at 1MB. It is skipped and the continueAsNew fails loudly on the payload cap — the
 * same fail-closed posture as MAX_EXPANDED_ITEMS_BYTES' "many small items".
 */
export const CAN_CTX_MAX_OFFLOADABLE_ENTRY_BYTES = 1_000_000;

/** Approximate serialized size of a claim-check reference (`{"__claimCheck":"…","bytes":N}`). Used
 *  only to estimate how much a planned offload saves, so a rough over-estimate is the safe side. */
const CLAIM_CHECK_REF_BYTES = 160;

/**
 * Decide WHICH `ctx` entries to claim-check before a continueAsNew (#681) — PURE: JSON sizing only,
 * no I/O, no clock, no randomness, no Temporal command. The caller performs the actual offload via
 * the `offloadCtxEntry` activity, once per returned key, in the returned order.
 *
 * DETERMINISM: the plan is a function of the ctx contents alone. Candidates are sorted by size
 * DESCENDING with the node id as tie-break (never insertion order, which is only incidentally
 * stable), so a replay of the same ctx produces the same plan and therefore the same activity
 * sequence.
 *
 * Strategy: largest-first until the snapshot fits the budget — the minimum number of entries loses
 * workflow-side readability. Reserved `__*`/`$*` keys are never offloaded: they are the interpreter's
 * own bookkeeping (`__input`, `__costUsd`, `__approval`, `__regionTrace`, `$vars`), are individually
 * capped already, and expressions read them constantly.
 */
export function planCtxOffload(
  ctx: Record<string, unknown>,
  budgetBytes: number = CAN_CTX_BUDGET_BYTES,
): string[] {
  let total = 2; // the enclosing "{}"
  const candidates: { key: string; bytes: number }[] = [];
  for (const key of Object.keys(ctx)) {
    let bytes: number;
    try {
      bytes = JSON.stringify(ctx[key] ?? null).length + key.length + 4;
    } catch {
      continue; // unserializable: continueAsNew would fail on it regardless
    }
    total += bytes;
    if (
      !key.startsWith("__") &&
      !key.startsWith("$") &&
      bytes >= CAN_CTX_ENTRY_FLOOR_BYTES &&
      bytes <= CAN_CTX_MAX_OFFLOADABLE_ENTRY_BYTES
    ) {
      candidates.push({ key, bytes });
    }
  }
  if (total <= budgetBytes) return [];
  candidates.sort((a, b) => b.bytes - a.bytes || (a.key < b.key ? -1 : 1));
  const plan: string[] = [];
  for (const c of candidates) {
    if (total <= budgetBytes) break;
    total -= c.bytes - CLAIM_CHECK_REF_BYTES;
    plan.push(c.key);
  }
  return plan;
}

/** Items model A3: max items a single splitOut region batches through ONE mapNode activity. The N
 *  resolved configs (in) + N outputs (out) ride in Temporal history verbatim (no global codec), so
 *  a very large N would cross the ~2MB payload cap and hard-fail the history write. Fail closed
 *  BELOW the cap with a clear message; larger fan-out belongs in `forEach` (child runs, own history)
 *  or an upstream chunk.
 *
 *  #479 does NOT lift this cap, and can't: the mapNode ARGUMENT is built here, in workflow code, so
 *  offloading it would require I/O on the deterministic side (Tier-1 rules 2/3) — and an activity
 *  that offloaded it for us would receive the same oversized payload as its own argument. What #479
 *  does fix is the SOURCE side: a claim-checked items array is now expanded per element by the
 *  expandItems activity, so a few enormous items no longer blow the payload; MANY items still hit
 *  this count cap. Lifting it properly means moving per-item config resolution into the activity. */
export const MAX_MAP_BATCH_ITEMS = 100;

/** Items model A4: max ACTIVITY executions across a per-item sub-DAG region in one run (design
 *  §0.4.1). A4 regions run item-major and can't batch (branching), so each live activity occurrence is
 *  its own Temporal command → history grows O(live activity executions). Fail closed here — a region
 *  that needs more per-item activity fan-out with branching belongs in `forEach` (child run per item).
 *  Distinct from MAX_MAP_BATCH_ITEMS, which caps a single A3 mapNode's batch, not a running total. */
export const MAX_A4_REGION_ACTIVITY_EXECUTIONS = 100;

/** Per-item INTERMEDIATE trace grid (items-model §0.4.2). Capture is PURE STATE — it writes a
 *  `__regionTrace` key into `ctx` and issues NO Temporal command and NO `stepCount` change, so it is
 *  replay-safe by construction (needs no `patched()`) and rides the CAN snapshot (:1647) + return
 *  (:1786) verbatim like the rest of `ctx`. The caps below are what keep that carried payload bounded
 *  (CLAUDE.md ~2MB): first K items captured (excess → `truncatedItems`, never silent), each cell's
 *  value JSON-capped. A cell is tri-state — value / dead (A4 dead branch) / error. */
export const MAX_TRACE_ITEMS = 50;
export const MAX_TRACE_CELL_BYTES = 1000;
/** Aggregate cap across ALL regions in one run segment. Per-region worst case is ~650KB (50 rows ×
 *  ~13 cols × 1KB), so several full wide regions could otherwise push the CAN snapshot (:1647) + return
 *  (:1786) past Temporal's ~2MB and FAIL AN OTHERWISE-HEALTHY RUN. A diagnostic must never do that:
 *  once this budget is hit, later regions emit `{ unavailable: "budget" }` instead of a grid.
 *  TraceCell / RegionTrace wire types are shared from @naary/dsl (worker writes, web renders). */
export const MAX_TRACE_TOTAL_BYTES = 512_000;

/** One tri-state cell from a node's per-item output. `live=false` ⇒ dead branch (A4). An
 *  `onError:"continue"` result is `{ error }` ⇒ shown as `err`. Otherwise the value, JSON-capped so a
 *  large output can't blow the carried payload (over the cap → a visible truncation marker). PURE. */
export function traceCell(value: unknown, live: boolean): TraceCell {
  if (!live) return { dead: true };
  if (
    value !== null &&
    typeof value === "object" &&
    "error" in (value as object)
  ) {
    return { err: String((value as { error: unknown }).error) };
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return { v: "<unserializable>" };
  }
  if (json !== undefined && json.length > MAX_TRACE_CELL_BYTES) {
    return { v: `<truncated ${json.length} bytes>` };
  }
  return { v: value };
}

/**
 * Sanitized, bounded failure message for a node's error output (onError: "continue").
 * Temporal wraps an activity failure in ActivityFailure whose `cause` carries the real
 * message; unwrap to the innermost cause, then cap length so a huge error can't bloat the
 * ctx/history. Activity errors are already sanitized upstream (toSanitizedRetryable), so
 * this never surfaces secrets.
 */
export function nodeErrorMessage(err: unknown): string {
  let e: unknown = err;
  // Drill through wrapped failures (ActivityFailure → cause → …) to the root message.
  for (let i = 0; i < 5 && e && typeof e === "object" && "cause" in e; i++) {
    const cause = (e as { cause?: unknown }).cause;
    if (!cause) break;
    e = cause;
  }
  const msg = e instanceof Error ? e.message : String(e);
  return msg.length > 500 ? `${msg.slice(0, 500)}…` : msg;
}

/**
 * Classify a THROWN run failure into the compact {@link FailureKind} persisted on the
 * Execution read-model row (Slice 2 — per-node timing + cost). PURE + DETERMINISTIC:
 * it only inspects the error object Temporal already recorded in history (failure chain
 * types + the activity-sanitized messages), so calling it in workflow code issues no
 * command and replays identically. Mapping is derived from the failure the activity
 * actually observed — never re-guessed later from logs:
 *  - TimeoutFailure in the chain (activity start-to-close elapsed) or the activities'
 *    own *_TIMEOUT types → "timeout"
 *  - QUOTA (provider 429) → "rate_limit"
 *  - BUDGET (monthly cap reservation refused) → "budget"
 *  - HTTP_ERROR_STATUS with a 5xx status in the sanitized message → "upstream_5xx"
 *  - anything else (STOP_AND_ERROR, AUTH, code errors, …) → "error"
 * "rejected"/"budget" for RETURNED terminal statuses are mapped in the
 * setExecutionStatus activity from the status itself, not here.
 */
/**
 * True when a thrown failure chain carries the activity's BUDGET_PAUSE marker (Slice 3
 * — pause-not-fail). PURE + DETERMINISTIC (same argument as {@link classifyFailure}):
 * only inspects the error Temporal recorded, issues no command. The marker is thrown
 * EXCLUSIVELY when the tenant's live-read policy is "pause" — a value no pre-existing
 * run ever observed — so old histories can never contain it.
 */
export function isBudgetPauseFailure(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 6 && e; i++) {
    if (e instanceof ApplicationFailure && e.type === "BUDGET_PAUSE") {
      return true;
    }
    if (
      typeof e === "object" &&
      "cause" in e &&
      (e as { cause?: unknown }).cause
    ) {
      e = (e as { cause: unknown }).cause;
      continue;
    }
    break;
  }
  return false;
}

export function classifyFailure(err: unknown): FailureKind {
  // Walk the wrapped chain (ActivityFailure → cause → …) collecting evidence.
  let e: unknown = err;
  for (let i = 0; i < 6 && e; i++) {
    if (e instanceof TimeoutFailure) return "timeout";
    if (e instanceof ApplicationFailure) {
      const type = e.type ?? "";
      if (type === "QUOTA" || type === "RATE_LIMIT") return "rate_limit";
      // BUDGET_PAUSE normally parks the run (Slice 3); it only reaches a THROWN
      // terminal when the patched pause path was unavailable — still a budget stop.
      if (type === "BUDGET" || type === "BUDGET_PAUSE") return "budget";
      if (type.endsWith("_TIMEOUT") || type === "TIMEOUT") return "timeout";
      if (type === "HTTP_ERROR_STATUS" || type === "HTTP_5XX") {
        // http.ts throws "HTTP request returned status <n>" — a 5xx is an upstream
        // failure; a 4xx stays a plain error (the caller's request/config).
        return /\b5\d\d\b/.test(e.message ?? "") ? "upstream_5xx" : "error";
      }
    }
    if (
      typeof e === "object" &&
      "cause" in e &&
      (e as { cause?: unknown }).cause
    ) {
      e = (e as { cause: unknown }).cause;
      continue;
    }
    break;
  }
  return "error";
}

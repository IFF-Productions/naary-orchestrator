/**
 * The shell's "N approvals waiting" count, as a tiny framework-free store.
 *
 * WHY THIS EXISTS: the count is rendered in two places away from the screen that
 * decides an approval — the nav-rail badges (Overview + Approvals) and the
 * context-bar pill — and it was previously a 45s poll held in shell-local state.
 * Deciding an approval on ANY screen therefore left those numbers stale for up to
 * 45 seconds. This store is the shared seam every decision path notifies, so the
 * badges update right after a decision.
 *
 * Pattern note: a plain `Set` of listeners + a snapshot getter, exactly like the
 * active-environment store in ./http (React subscribes via useSyncExternalStore).
 * No new state library.
 *
 * CORRECTNESS — why the optimism is id-scoped and reconciled, not a decrement:
 *   - Deciding an approval is a fire-and-forget Temporal *signal* (the API's
 *     opApprove in apps/api/src/executions/executions.approvals-ops.ts), and the
 *     awaiting list confirms each row with a live workflow query (listAwaiting →
 *     queryAwaiting). So an immediate refetch can legitimately STILL return the
 *     run we just decided — a pure refetch would sometimes not move the badge.
 *   - A batch decision is per-run: some ids can slip (already decided/closed), so
 *     a numeric `count -= selected.length` would show a WRONG number.
 * Hence: mask the ids the server confirmed decided (instant, exact), and keep the
 * authoritative awaiting list as the source of truth. A masked id is forgotten as
 * soon as the server stops listing it, so the mask can never permanently hide a
 * run that is genuinely still waiting.
 */

/** The authoritative awaiting workflowIds from the last successful fetch. */
let serverIds: string[] = [];
/** Runs decided locally that the server may not have caught up on yet. */
const decided = new Set<string>();

/** Notified whenever the derived count may have changed (re-render). */
const countListeners = new Set<() => void>();
/** Notified when a decision happened and the awaiting list should be refetched. */
const revalidateListeners = new Set<() => void>();

let lastCount = 0;

/** The count the UI should show: the server's awaiting list minus locally-decided runs. */
export function approvalsCountSnapshot(): number {
  return lastCount;
}

function recompute(): void {
  const next =
    decided.size === 0
      ? serverIds.length
      : serverIds.filter((id) => !decided.has(id)).length;
  if (next === lastCount) return;
  lastCount = next;
  for (const l of countListeners) l();
}

/** Subscribe to count changes (useSyncExternalStore). Returns an unsubscribe fn. */
export function subscribeApprovalsCount(onChange: () => void): () => void {
  countListeners.add(onChange);
  return () => countListeners.delete(onChange);
}

/** Subscribe to "a decision was made — refetch the awaiting list". Returns an unsubscribe fn. */
export function subscribeApprovalsRevalidate(onChange: () => void): () => void {
  revalidateListeners.add(onChange);
  return () => revalidateListeners.delete(onChange);
}

/**
 * Fold in a freshly fetched awaiting list (the authoritative truth).
 *
 * Also PRUNES the optimistic mask: a decided id the server no longer lists has
 * been observed, so drop it. An id the server still lists is kept masked — that's
 * the signal-not-yet-processed race, not a reason to un-decide it. Never called on
 * a failed fetch, so a transient network error keeps the last good count.
 */
export function reconcileAwaitingApprovals(ids: readonly string[]): void {
  serverIds = [...ids];
  if (decided.size > 0) {
    const live = new Set(ids);
    for (const id of [...decided]) if (!live.has(id)) decided.delete(id);
  }
  recompute();
}

/**
 * Record runs the server CONFIRMED as decided (single decide, or the `ok: true`
 * rows of a batch) and ask every subscriber to revalidate.
 *
 * Pass an empty array for a decision that FAILED (409 "no longer awaiting", a
 * network error, or a batch where every id slipped): nothing is masked — the
 * count must not move on a decision that didn't happen — but the revalidate still
 * fires, because a 409 usually means our list is stale.
 */
export function markApprovalsDecided(ids: readonly string[]): void {
  for (const id of ids) decided.add(id);
  recompute();
  for (const l of revalidateListeners) l();
}

/**
 * Drop all state. Called when the active workspace/environment changes — awaiting
 * ids belong to one workspace+env scope, and a mask must never leak across scopes.
 */
export function resetApprovalsCount(): void {
  serverIds = [];
  decided.clear();
  recompute();
}

/** Test-only view of the optimistic mask. */
export function decidedApprovalIdsForTest(): string[] {
  return [...decided];
}

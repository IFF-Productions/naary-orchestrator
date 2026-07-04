// Pure forEach fan-out policy — no Temporal imports, so the interpreter can use it
// in deterministic workflow code AND unit tests can exercise it directly (audit
// Q-3/A-3). Keep this module free of side effects and wall-clock/random reads.

/** Max child runs a single forEach keeps in flight at once. Items beyond this wait
 *  for a slot, so a 100-item array can't spawn 100 concurrent child workflows and
 *  swamp worker capacity (audit A-3). The cost-cap divisor rides on the same window
 *  (see {@link perChildCap}). */
export const FOREACH_CONCURRENCY = 10;

/**
 * Per-child cost cap for the concurrent children of ONE forEach window (audit Q-3).
 *
 * The children in a window run at the same time and would otherwise each be granted
 * the FULL remaining parent cap — so N of them could collectively spend N× the cap
 * before any of their costs is metered back. Splitting the remaining cap across the
 * window bounds the aggregate concurrent spend to the remaining cap (≤1× overshoot).
 *
 * `capRemaining` is `perExecutionCapUsd - costUsdSoFar`; a negative value (already
 * over budget) floors to 0 so no further child gets a budget. Returns `undefined`
 * only when the caller has no cap at all (handled there, not here).
 */
export function perChildCap(capRemaining: number, windowLen: number): number {
  return Math.max(0, capRemaining) / Math.max(1, windowLen);
}

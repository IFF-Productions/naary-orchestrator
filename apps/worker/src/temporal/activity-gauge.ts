/**
 * Live activity-slot gauge (Queue-mode Slice 2). `countActivities` wraps every activity so a
 * module-level counter tracks how many are executing RIGHT NOW on this replica; the heartbeat reports
 * `activeActivities()` as the numerator of live slot usage (denominator = the configured max).
 *
 * Observe-only: the wrapper never alters the return value or the error — it increments before the
 * activity runs and decrements in a `finally`, on both the sync and async paths (identical to
 * log-activities' passthrough contract, so Temporal's dispatch-by-name is unchanged).
 */

let active = 0;

/** Activities executing right now on this replica. */
export function activeActivities(): number {
  return active;
}

/** Test-only reset. */
export function __resetActivityGauge(): void {
  active = 0;
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    v != null &&
    (typeof v === "object" || typeof v === "function") &&
    typeof (v as { then?: unknown }).then === "function"
  );
}

export function countActivities<T extends Record<string, unknown>>(
  activities: T,
): T {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(activities)) {
    if (typeof value !== "function") {
      out[name] = value;
      continue;
    }
    const fn = value as (...a: unknown[]) => unknown;
    out[name] = (...args: unknown[]): unknown => {
      active++;
      let result: unknown;
      try {
        result = fn(...args);
      } catch (err) {
        active--; // synchronous throw — release the slot now
        throw err;
      }
      if (isThenable(result)) {
        return Promise.resolve(result).finally(() => {
          active--;
        });
      }
      active--; // synchronous return
      return result;
    };
  }
  return out as T;
}

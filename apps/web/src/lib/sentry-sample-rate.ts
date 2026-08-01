/**
 * Parse a build-time (`VITE_`-inlined) Sentry sample rate.
 *
 * Lives in its own module — not inline in instrument.ts — so it can be tested WITHOUT
 * importing instrument.ts, which calls `Sentry.init` at module scope.
 *
 * Why the empty-string case is the whole point (#1034): an UNSET GitHub Actions secret
 * interpolates to the empty string, so `.github/workflows/deploy.yml` passes
 * `VITE_SENTRY_TRACES_SAMPLE_RATE=` as a build arg that is *present and empty*, and Vite
 * inlines `""`. `Number("") === 0` and `0` is finite, so a naive parse silently returned 0
 * and every documented default became unreachable — replays were never kept even on an
 * error, and no transaction was ever sampled, while errors kept reporting so Sentry looked
 * healthy. Empty / whitespace / absent therefore means "no override" → use the fallback.
 *
 * Out-of-range values are CLAMPED into [0,1], not sent to the fallback: Sentry expects a
 * rate, and a typo'd `10` should mean "always" rather than silently reverting to the default.
 * A non-numeric (`"abc"`) or non-finite (`"Infinity"`) value is a typo with no defensible
 * reading, so that DOES take the fallback.
 *
 * The backend has the same shape in `packages/observability/src/config.ts` — kept separate on
 * purpose: that package imports `@sentry/node` and must not enter the browser bundle.
 */
export function sampleRate(raw: unknown, fallback: number): number {
  const value = typeof raw === "string" ? raw.trim() : raw;
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  // Finite check BEFORE the clamp — Math.min(1, Math.max(0, NaN)) is NaN, so clamping first
  // would let "abc" through as NaN instead of falling back.
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

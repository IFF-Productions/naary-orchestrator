/**
 * Configuration for `@naary/observability`. See docs/design/CONFIG-CENTRALIZATION.md (slice 3).
 *
 * Everything here defaults to OFF or to zero. Observability must never break the product: an
 * unconfigured deployment reports nothing rather than failing to boot, and every sample rate
 * starts at 0 so turning a component on is always an explicit act.
 */

/** The applications that report to Sentry. Each may have its OWN Sentry project. */
export type SentryComponent = "api" | "worker" | "sandbox-runner";

/** The per-component DSN variable name, e.g. "api" → SENTRY_DSN_API. */
export function componentDsnVar(component: SentryComponent): string {
  return `SENTRY_DSN_${component.toUpperCase().replace(/-/g, "_")}`;
}

/**
 * Which DSN this component reports to: its own if configured, else the shared `SENTRY_DSN`.
 *
 * TRIMMED and empty-checked because docker-compose passes an unset variable through as the empty
 * string (`${SENTRY_DSN_WORKER:-}`) — treating "" as configured would hand Sentry.init an invalid
 * DSN and disable reporting for that component entirely.
 */
export function sentryDsn(
  component: SentryComponent,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const own = env[componentDsnVar(component)]?.trim();
  if (own) return own;
  return env.SENTRY_DSN?.trim() || undefined;
}

/**
 * Deployment environment tag. An explicit `SENTRY_ENVIRONMENT` (the deploy sets "production")
 * wins, then NODE_ENV, then "development" — the fallback chain exists because prod containers
 * don't set NODE_ENV, and without it every prod event filed under "development".
 */
export function sentryEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.SENTRY_ENVIRONMENT ?? env.NODE_ENV ?? "development";
}

/** Release tag, stamped by the deploy. Undefined ⇒ Sentry groups everything under one release. */
export function sentryRelease(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.SENTRY_RELEASE;
}

/**
 * Parse a sample rate from the environment.
 *
 * Empty / whitespace / absent means "not configured" → the fallback, because docker-compose
 * renders an unset variable as the empty string (`${SENTRY_TRACES_SAMPLE_RATE:-0}` only
 * defaults when the var is *absent*, and CI passes unset secrets through as `""`). A
 * non-numeric or non-finite value is a typo → the fallback as well; a bare `Number()` would
 * have produced `NaN`, and `NaN > 0` is false, so `initSentry` silently dropped the profiling
 * integration for a value the operator believed was set.
 *
 * In-range-but-wrong values are CLAMPED into [0,1] rather than falling back: Sentry expects a
 * rate, so a typo'd `10` means "always" instead of sailing through as 1000%.
 *
 * The browser has the same shape in `apps/web/src/lib/sentry-sample-rate.ts` (kept separate:
 * this package imports `@sentry/node` and must not enter the browser bundle). See #1034 — the
 * browser copy is where an equivalent gap actually disabled replays and tracing in production.
 */
function sampleRate(raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  if (!value) return fallback;
  const n = Number(value);
  // Finite check BEFORE the clamp — Math.min(1, Math.max(0, NaN)) is NaN.
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/** Performance tracing sample rate. 0 (off) unless explicitly configured. */
export function sentryTracesSampleRate(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return sampleRate(env.SENTRY_TRACES_SAMPLE_RATE, 0);
}

/** CPU profiling sample rate. 0 (off) unless explicitly configured; requires tracing on. */
export function sentryProfilesSampleRate(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return sampleRate(env.SENTRY_PROFILES_SAMPLE_RATE, 0);
}

/**
 * Whether an OTLP metrics endpoint is configured. Only the PRESENCE is read here — the exporter
 * reads the endpoint, headers and protocol itself from the standard `OTEL_EXPORTER_OTLP_*`
 * variables, and re-reading them would create a second source of truth that could disagree.
 */
export function otlpConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT);
}

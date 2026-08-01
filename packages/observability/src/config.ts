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
 * Empty / whitespace / absent means "not configured" → the fallback. Note this is NOT how the
 * deployed backend receives an unset value, and the difference is the whole point of #1034:
 * `docker-compose.yml` writes `${SENTRY_TRACES_SAMPLE_RATE:-0}`, and `:-` substitutes the
 * default when the variable is **unset OR empty** — only the colon-less `${VAR-0}` is the
 * unset-only form. So an unset repo secret, which CI does render as `""`, still reaches the
 * container as `"0"` (verified with `docker compose config`), and `deploy.yml` additionally
 * `unset`s the empty ones before compose runs. The empty case here is therefore defense in
 * depth for the paths that bypass compose — `docker run -e SENTRY_TRACES_SAMPLE_RATE=`, or an
 * exported-but-empty var when running the worker directly — not a live production failure.
 *
 * The browser has no such substitution layer: Vite inlines the build arg VERBATIM, so an unset
 * secret arrives as a literal `""`. That is why the same parsing gap silently disabled replays
 * and tracing in the SPA (#1034) and not here. The browser copy of this helper lives in
 * `apps/web/src/lib/sentry-sample-rate.ts`, kept separate because this package imports
 * `@sentry/node` and must not enter the browser bundle.
 *
 * What this package DID share is the missing guards, which is why it changed at all: a
 * non-numeric or non-finite value produced `NaN` from a bare `Number()`, and `NaN > 0` is
 * false, so `initSentry` silently dropped the profiling integration for a value the operator
 * believed was set. Those now take the fallback.
 *
 * In-range-but-wrong values are CLAMPED into [0,1] rather than falling back: Sentry expects a
 * rate, so a typo'd `10` means "always" instead of sailing through as 1000%.
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

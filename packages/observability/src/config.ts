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
export function sentryEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  return env.SENTRY_ENVIRONMENT ?? env.NODE_ENV ?? "development";
}

/** Release tag, stamped by the deploy. Undefined ⇒ Sentry groups everything under one release. */
export function sentryRelease(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.SENTRY_RELEASE;
}

/** Performance tracing sample rate. 0 (off) unless explicitly configured. */
export function sentryTracesSampleRate(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.SENTRY_TRACES_SAMPLE_RATE ?? "0");
}

/** CPU profiling sample rate. 0 (off) unless explicitly configured; requires tracing on. */
export function sentryProfilesSampleRate(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.SENTRY_PROFILES_SAMPLE_RATE ?? "0");
}

/**
 * Whether an OTLP metrics endpoint is configured. Only the PRESENCE is read here — the exporter
 * reads the endpoint, headers and protocol itself from the standard `OTEL_EXPORTER_OTLP_*`
 * variables, and re-reading them would create a second source of truth that could disagree.
 */
export function otlpConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT);
}

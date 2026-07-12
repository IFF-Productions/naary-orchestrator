/**
 * Sentry for the browser SPA. Sidecar so init runs BEFORE any app code (imported
 * first in main.tsx). Mirrors the backend philosophy (@naary/observability):
 *   - OFF unless VITE_SENTRY_DSN is set at build time, so existing builds are unchanged.
 *   - Never send PII; scrub secret-shaped values from every outgoing event so a bearer
 *     token / API key can't leak into telemetry (CLAUDE.md: secrets never reach telemetry).
 *
 * The DSN is a *publishable* value (safe in the client bundle) — it is NOT one of the
 * secrets guarded elsewhere. Tracing is on (the SDK's recommended default); Session
 * Replay is intentionally NOT enabled here (it records user sessions — opt in separately).
 */
import * as Sentry from "@sentry/react";
import {
  createRoutesFromChildren,
  matchRoutes,
  useLocation,
  useNavigationType,
} from "react-router-dom";
import { useEffect } from "react";
import { redactSecrets } from "./lib/sentry-scrub";

const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;

/** Scrub, but NEVER throw from a Sentry hook — a scrub failure must not break the app or
 *  block telemetry. On failure DROP the payload (return null) rather than ship it unscrubbed. */
function safeScrub<T>(value: T): T | null {
  try {
    return redactSecrets(value) as T;
  } catch {
    return null;
  }
}

if (dsn) {
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_APP_VERSION as string | undefined,
    // Never attach IPs / cookies / user PII automatically (matches the backend).
    sendDefaultPii: false,
    // Forward the SPA's logs to Sentry Logs (mirrors the backend). enableLogs + the console
    // integration send console.{log,info,warn,error,…} as searchable logs, correlated to the
    // active trace. Scrubbed via beforeSendLog below (a console line could echo a token).
    enableLogs: true,
    integrations: [
      // react-router-dom v7 (data router) — page-load + navigation transactions.
      Sentry.reactRouterV7BrowserTracingIntegration({
        useEffect,
        useLocation,
        useNavigationType,
        createRoutesFromChildren,
        matchRoutes,
      }),
      // Capture console calls as Sentry logs.
      Sentry.consoleLoggingIntegration(),
    ],
    // Opt-in sample rate; default 0.1 so production isn't fully traced. Override with
    // VITE_SENTRY_TRACES_SAMPLE_RATE at build time.
    tracesSampleRate: Number(
      (import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE as string | undefined) ??
        "0.1",
    ),
    // Only propagate the trace header to our own API (avoid leaking it cross-origin).
    tracePropagationTargets: [/^\/(api)\//, /naar-y\.com/],
    // Security-critical: scrub secret-shaped data from every event + breadcrumb + log.
    // safeScrub never throws (console can capture circular/huge objects) — drops on failure.
    beforeSend: (event) => safeScrub(event),
    beforeSendLog: (log) => safeScrub(log),
    beforeBreadcrumb: (crumb) => safeScrub(crumb),
  });
}

/** Whether Sentry actually initialized (a DSN was configured at build time). */
export const sentryEnabled = Boolean(dsn);

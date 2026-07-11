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

const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;

/** Redact secret-shaped strings (bearer tokens, our `nry_` API tokens, provider keys). */
const SECRET_RE =
  /\b(?:Bearer\s+[\w.\-]+|nry_[A-Za-z0-9]+|sk-[A-Za-z0-9]+|gh[pousr]_[A-Za-z0-9]+)/g;
function redact(value: unknown): unknown {
  if (typeof value === "string") return value.replace(SECRET_RE, "[redacted]");
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Drop auth headers / token fields outright, redact everything else in place.
      out[k] = /authorization|token|secret|api[_-]?key|password/i.test(k)
        ? "[redacted]"
        : redact(v);
    }
    return out;
  }
  return value;
}

if (dsn) {
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_APP_VERSION as string | undefined,
    // Never attach IPs / cookies / user PII automatically (matches the backend).
    sendDefaultPii: false,
    integrations: [
      // react-router-dom v7 (data router) — page-load + navigation transactions.
      Sentry.reactRouterV7BrowserTracingIntegration({
        useEffect,
        useLocation,
        useNavigationType,
        createRoutesFromChildren,
        matchRoutes,
      }),
    ],
    // Opt-in sample rate; default 0.1 so production isn't fully traced. Override with
    // VITE_SENTRY_TRACES_SAMPLE_RATE at build time.
    tracesSampleRate: Number(
      (import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE as string | undefined) ??
        "0.1",
    ),
    // Only propagate the trace header to our own API (avoid leaking it cross-origin).
    tracePropagationTargets: [/^\/(api)\//, /naar-y\.com/],
    // Security-critical: scrub secret-shaped data from every event + breadcrumb.
    beforeSend: (event) => redact(event) as typeof event,
    beforeBreadcrumb: (crumb) => redact(crumb) as typeof crumb,
  });
}

/** Whether Sentry actually initialized (a DSN was configured at build time). */
export const sentryEnabled = Boolean(dsn);

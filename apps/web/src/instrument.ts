/**
 * Sentry for the browser SPA. Sidecar so init runs BEFORE any app code (imported
 * first in main.tsx). Mirrors the backend philosophy (@naary/observability):
 *   - OFF unless VITE_SENTRY_DSN is set at build time, so existing builds are unchanged.
 *   - Never send PII; scrub secret-shaped values from every outgoing event so a bearer
 *     token / API key can't leak into telemetry (CLAUDE.md: secrets never reach telemetry).
 *
 * The DSN is a *publishable* value (safe in the client bundle) — it is NOT one of the
 * secrets guarded elsewhere. Tracing is on (the SDK's recommended default). Session
 * Replay is on in MASKED mode (all text/inputs masked, media blocked — the recording
 * carries DOM *structure*, not readable user content): by default it records only
 * sessions where an error happened. Browser profiling is opt-in via
 * VITE_SENTRY_PROFILES_SAMPLE_RATE (> 0) and additionally requires the
 * `Document-Policy: js-profiling` response header (set in apps/web/nginx.conf) —
 * without it the integration is inert (dev serves without the header, so no profiles
 * from `vite dev`). Chromium-only; other browsers just don't profile.
 */
import * as Sentry from "@sentry/react";
import {
  createRoutesFromChildren,
  matchRoutes,
  useLocation,
  useNavigationType,
} from "react-router-dom";
import { useEffect } from "react";
import { nameEventRejection } from "./lib/sentry-rejections";
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

/** A VITE_-inlined sample rate with a default; NaN (a typo'd value) falls back too. */
function sampleRate(raw: unknown, fallback: number): number {
  const n = Number((raw as string | undefined) ?? "");
  return Number.isFinite(n) ? n : fallback;
}

const profilesSampleRate = sampleRate(
  import.meta.env.VITE_SENTRY_PROFILES_SAMPLE_RATE,
  0,
);

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
      // Session Replay, PRIVACY-FIRST: mask all text + inputs, block media — the recording
      // is DOM structure and interaction timing, never readable user content. NOTE: do NOT
      // route recording events through redactSecrets — it is depth-bounded (deep trees →
      // "[Truncated]") and would destroy the rrweb DOM snapshot; masking IS the privacy
      // layer here. Network capture stays at the SDK default (URLs only, no bodies/headers),
      // and those URLs flow through the scrubbed breadcrumb path.
      Sentry.replayIntegration({
        maskAllText: true,
        maskAllInputs: true,
        blockAllMedia: true,
      }),
      // Browser profiling — only bundled into the running config when opted in.
      ...(profilesSampleRate > 0 ? [Sentry.browserProfilingIntegration()] : []),
      // User Feedback: NO floating auto-widget (autoInject:false) — a "Send feedback" button in the
      // nav drawer opens it (see lib/feedback + NavRail). Theme-following; no Sentry branding. The
      // message a user types is their own report, so it is intentionally NOT run through the secret
      // scrubber (that path is beforeSend* for events — feedback rides its own envelope).
      Sentry.feedbackIntegration({
        autoInject: false,
        colorScheme: "system",
        showBranding: false,
        // Frame it as feedback (not the default "Report a Bug"), matching the drawer button.
        formTitle: "Send feedback",
        submitButtonLabel: "Send feedback",
        messagePlaceholder:
          "What's working well, what's confusing, or what's broken?",
        successMessageText: "Thanks — your feedback was sent.",
      }),
    ],
    // Opt-in sample rate; default 0.1 so production isn't fully traced. Override with
    // VITE_SENTRY_TRACES_SAMPLE_RATE at build time.
    tracesSampleRate: sampleRate(
      import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE,
      0.1,
    ),
    // Profiles are taken INSIDE sampled transactions (effective rate = this × traces rate).
    profilesSampleRate,
    // Replay defaults: don't record ordinary sessions (0), DO keep the replay when an
    // error happens (1) — the debugging payoff without recording everyone all the time.
    replaysSessionSampleRate: sampleRate(
      import.meta.env.VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE,
      0,
    ),
    replaysOnErrorSampleRate: sampleRate(
      import.meta.env.VITE_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE,
      1,
    ),
    // Only propagate the trace header to our own API (avoid leaking it cross-origin).
    tracePropagationTargets: [/^\/(api)\//, /naar-y\.com/],
    // Security-critical: scrub secret-shaped data from every event + breadcrumb + log.
    // safeScrub never throws (console can capture circular/huge objects) — drops on failure.
    // Enrich BEFORE scrubbing, so the scrubber also covers anything nameEventRejection adds.
    // A DOM-Event rejection reaches Sentry with no message, stack or target (#793) — the target is
    // only still reachable here, via hint.originalException.
    beforeSend: (event, hint) =>
      safeScrub(nameEventRejection(event, hint?.originalException)),
    beforeSendLog: (log) => safeScrub(log),
    beforeBreadcrumb: (crumb) => safeScrub(crumb),
  });
}

/** Whether Sentry actually initialized (a DSN was configured at build time). */
export const sentryEnabled = Boolean(dsn);

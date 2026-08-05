/**
 * The `naary auth login` browser handshake — the client half of #1078 §2 shape B.
 *
 * The flow: `POST /auth/cli/start` returns a device code (ours, secret) and a short user code (the
 * human's). We show the human where to go, open a browser if we can, then poll
 * `POST /auth/cli/exchange` until someone approves, denies, or the ten-minute window closes.
 *
 * WHY THE POLLING IS THE DELICATE PART. `/auth/cli/exchange` is `@Public` and therefore rate
 * limited (60/min, sized for the advertised 5s interval); a client that busy-loops gets 429s and
 * turns its own login into a failure. So the loop is driven entirely by what the SERVER said —
 * `interval` for the cadence, `expiresIn` for the deadline — and never by a constant of ours.
 *
 * The signals here are this server's, not RFC 8628's — there is no `slow_down` or
 * `authorization_pending` error code to look for:
 *   - 200 `{status:"pending"}`  → keep waiting.
 *   - 200 `{status:"denied"}`   → a human said "that wasn't me". Stop.
 *   - 200 `{status:"authorized"}` → the tokens, exactly once.
 *   - 400 `invalid_grant`       → TERMINAL. Unknown, expired and already-redeemed are one opaque
 *                                 answer by design, so there is nothing to retry into.
 *   - 429                       → the only back-off signal available. Treated as `slow_down`:
 *                                 additive, capped, and never a reason to give up.
 *
 * Everything impure — the clock, the sleep, the browser, fetch — is injected, so the specs drive
 * the loop with a fake clock and assert the waits without spending real seconds or opening a
 * browser on a CI runner.
 */

import { toApiError, buildRootUrl, type FetchLike } from "./client";
import type { CliSession } from "./session";
import { sessionFromResponse } from "./session";

/** Fallbacks used ONLY if the server omits the field. Never a preference over what it sent. */
const FALLBACK_INTERVAL_SECONDS = 5;
const FALLBACK_EXPIRES_IN_SECONDS = 600;

/** Sanity bounds on the server's numbers. A malformed/hostile `interval` of 0 would busy-loop
 *  straight into the rate limit; one of 86400 would hang the terminal until the user gave up. */
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 60_000;
const MAX_WINDOW_MS = 60 * 60_000;

/** Ceiling for the back-off. The window is ten minutes; a wait longer than this would spend the
 *  whole of it asleep and miss an approval that already happened. */
const MAX_BACKOFF_MS = 30_000;

/** What the human needs on screen while we poll. */
export interface DeviceLoginPrompt {
  /** Absolute URL of the approval page. */
  verificationUri: string;
  /** The code they type there, in its hyphenated display form. */
  userCode: string;
  /** Seconds until the request expires (the server's number). */
  expiresIn: number;
  /** True if we managed to launch a browser. */
  browserOpened: boolean;
}

export type DeviceLoginResult =
  | { ok: true; session: CliSession }
  | { ok: false; reason: "denied" | "expired" | "invalid"; message: string };

export interface DeviceLoginDeps {
  apiUrl: string;
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Device name, shown in Settings as `naary CLI — <hostname>`. */
  hostname: string;
  /** Best-effort browser launch. Omit (or pass `--no-browser`) to skip. Must not throw. */
  openBrowser?: (url: string) => boolean;
  /** Called ONCE, before the first poll, so the code is on screen while we wait. */
  onPrompt: (prompt: DeviceLoginPrompt) => void;
}

/** Run the whole handshake. Resolves with a session or a reason the user can act on; throws only
 *  for a transport/`/start` failure, which the router renders as an ApiError. */
export async function deviceLogin(
  deps: DeviceLoginDeps,
): Promise<DeviceLoginResult> {
  const started = await start(deps);

  const intervalMs = clamp(
    Math.round((started.interval ?? FALLBACK_INTERVAL_SECONDS) * 1000),
    MIN_INTERVAL_MS,
    MAX_INTERVAL_MS,
  );
  const expiresIn = clamp(
    Math.round((started.expiresIn ?? FALLBACK_EXPIRES_IN_SECONDS) * 1000),
    MIN_INTERVAL_MS,
    MAX_WINDOW_MS,
  );
  const deadline = deps.now() + expiresIn;
  const verificationUri = absoluteUri(deps.apiUrl, started.verificationUri);

  const browserOpened = deps.openBrowser
    ? safeOpen(deps.openBrowser, verificationUri)
    : false;
  deps.onPrompt({
    verificationUri,
    userCode: started.userCode,
    expiresIn: Math.round(expiresIn / 1000),
    browserOpened,
  });

  // Monotonic: back-off only ever grows within one login. Decaying it back to the base interval
  // after a 429 would walk straight back into the same 60-second throttle window that produced it.
  let waitMs = intervalMs;

  for (;;) {
    // Wait BEFORE the first poll, RFC 8628-style: the approval cannot possibly have happened in
    // the microseconds since `/start`, and the first poll is the one most likely to be wasted.
    await deps.sleep(waitMs);
    if (deps.now() >= deadline) {
      return {
        ok: false,
        reason: "expired",
        message:
          "That login request expired before it was approved. Run `naary auth login` again.",
      };
    }

    const res = await deps.fetch(
      buildRootUrl(deps.apiUrl, "/auth/cli/exchange"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ deviceCode: started.deviceCode }),
      },
    );
    const raw = await res.text();

    // The throttler, or a server having a bad minute. Both mean "ask again, less often" — never
    // "give up", because the human may well be mid-approval on the other side.
    if (res.status === 429 || res.status >= 500) {
      waitMs = Math.min(waitMs + intervalMs, MAX_BACKOFF_MS);
      continue;
    }

    if (!res.ok) {
      // 400 `invalid_grant` and anything else non-2xx: terminal. The device code cannot become
      // valid again, so retrying only feeds the rate limiter.
      const err = toApiError(res.status, res.statusText, raw);
      return {
        ok: false,
        reason: "invalid",
        message: `${err.message}\nRun \`naary auth login\` to start a new login.`,
      };
    }

    const body = parseJson(raw);
    const status = (body as { status?: unknown } | undefined)?.status;
    if (status === "denied") {
      return {
        ok: false,
        reason: "denied",
        message:
          "That login was refused in the browser. Run `naary auth login` if it was you.",
      };
    }
    if (status === "authorized") {
      const session = sessionFromResponse(body);
      if (session) return { ok: true, session };
      return {
        ok: false,
        reason: "invalid",
        message:
          "The server approved the login but returned no access token. Run `naary auth login` again.",
      };
    }
    // `pending` (or anything unrecognized): keep the current cadence and poll again.
  }
}

/** The response shape of `/auth/cli/start`. Every field is treated as optional on the wire —
 *  a missing `interval` must degrade to a safe default, not to `NaN` milliseconds of sleep. */
interface StartedLogin {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn?: number;
  interval?: number;
}

async function start(deps: DeviceLoginDeps): Promise<StartedLogin> {
  const res = await deps.fetch(buildRootUrl(deps.apiUrl, "/auth/cli/start"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ hostname: deps.hostname }),
  });
  const raw = await res.text();
  if (!res.ok) throw toApiError(res.status, res.statusText, raw);

  const body = parseJson(raw) as Partial<StartedLogin> | undefined;
  if (!body?.deviceCode || !body.userCode) {
    throw toApiError(
      res.status,
      res.statusText,
      JSON.stringify({
        message:
          "The server did not return a login code. Is this a naary API URL?",
      }),
    );
  }
  return {
    deviceCode: body.deviceCode,
    userCode: body.userCode,
    verificationUri: body.verificationUri ?? "/app/cli-login",
    expiresIn: numberOrUndefined(body.expiresIn),
    interval: numberOrUndefined(body.interval),
  };
}

/**
 * The server returns a RELATIVE `verificationUri` when it has no public base URL configured
 * (`appBaseUrl()` degrades to a path). A path is useless in a terminal, so resolve it against the
 * configured origin — that origin is where the SPA lives whenever the CLI's default holds.
 */
export function absoluteUri(apiUrl: string, uri: string): string {
  if (/^https?:\/\//i.test(uri)) return uri;
  return `${apiUrl.replace(/\/+$/, "")}${uri.startsWith("/") ? "" : "/"}${uri}`;
}

/** `openBrowser` is a spawn; a headless box or a missing `xdg-open` must not fail a login. */
function safeOpen(open: (url: string) => boolean, url: string): boolean {
  try {
    return open(url);
  } catch {
    return false;
  }
}

function parseJson(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(Math.max(v, lo), hi);
}

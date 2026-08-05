/**
 * The stored CLI session: the `nry_` access token, the `nryr_` refresh token that renews it, and
 * the two expiries the server told us about.
 *
 * This file owns the half of `naary auth` that is NOT the login handshake — persisting a session,
 * rotating it when the access token dies, and ending it. It is deliberately separate from
 * `device-login.ts` so the refresh path can be exercised on its own: refresh is what makes a
 * 12-hour access token survivable, and it runs on a code path no login test ever visits.
 *
 * Everything impure is injected (`fetch`, the config file path), so the specs drive it against a
 * real HTTP fixture and a temp file rather than the user's `~/.naary`.
 */

import { AuthError, buildRootUrl, type FetchLike } from "./client";
import {
  readConfigFile,
  updateConfigFile,
  configPath,
  SESSION_FIELDS,
} from "./config";

/** What `/auth/cli/{exchange,refresh}` hands back on success. */
export interface CliSession {
  accessToken: string;
  accessTokenExpiresAt?: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
  tenantId?: string;
}

/**
 * What the user must be told when their session cannot be renewed.
 *
 * #1078 §4's reuse detection revokes an entire family, so a user whose refresh token leaked (or who
 * simply hit the 30-day idle / 90-day absolute cap) sees a working CLI stop working from one
 * command to the next. The server deliberately gives ONE opaque reason for all of those, so the
 * client cannot explain *why* — but it can say exactly what to do about it, which is the part that
 * matters. A stack trace here would be the worst possible answer.
 */
export const SESSION_ENDED_MESSAGE =
  "Your naary CLI session has ended (it expired, or it was revoked). Run `naary auth login` to sign in again.";

/** Read the persisted session, if there is one. */
export function readSession(
  file: string = configPath(),
): CliSession | undefined {
  const cfg = readConfigFile(file);
  if (!cfg.token) return undefined;
  return {
    accessToken: cfg.token,
    accessTokenExpiresAt: cfg.tokenExpiresAt,
    refreshToken: cfg.refreshToken,
    refreshTokenExpiresAt: cfg.refreshTokenExpiresAt,
    tenantId: cfg.tenantId,
  };
}

/** Persist a session, merging onto whatever else is in the file (apiUrl, env). */
export function saveSession(
  session: CliSession,
  file: string = configPath(),
): void {
  updateConfigFile(
    {
      token: session.accessToken,
      refreshToken: session.refreshToken,
      tokenExpiresAt: session.accessTokenExpiresAt,
      refreshTokenExpiresAt: session.refreshTokenExpiresAt,
      tenantId: session.tenantId,
    },
    file,
  );
}

/** Remove every session field, leaving `apiUrl`/`env` alone — those are preferences, not credentials. */
export function clearSession(file: string = configPath()): void {
  const patch: Record<string, undefined> = {};
  for (const field of SESSION_FIELDS) patch[field] = undefined;
  updateConfigFile(patch, file);
}

/** Coerce an exchange/refresh response body into a session, or undefined if it isn't one. */
export function sessionFromResponse(body: unknown): CliSession | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b.accessToken !== "string" || !b.accessToken) return undefined;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v ? v : undefined;
  return {
    accessToken: b.accessToken,
    accessTokenExpiresAt: str(b.accessTokenExpiresAt),
    refreshToken: str(b.refreshToken),
    refreshTokenExpiresAt: str(b.refreshTokenExpiresAt),
    tenantId: str(b.tenantId),
  };
}

export interface SessionDeps {
  apiUrl: string;
  fetch: FetchLike;
  /** Config file to read/write. Defaults to ~/.naary/config.json. */
  file?: string;
}

/**
 * Trade the stored refresh token for a new access token, persist the rotated pair, and return the
 * new access token. `undefined` means "there was nothing to refresh" (no stored refresh token) —
 * the caller should surface the original 401.
 *
 * Two details are load-bearing:
 *
 *  - The refresh token is read from the file HERE, not from a snapshot taken at process start.
 *    Slice 2 rotates on every use with a 60-second grace window, so a token that was current when
 *    the process booted may already have been superseded by a sibling `naary` invocation. Reading
 *    late means we present the newest one we have, and only fall into the grace window when we
 *    genuinely raced.
 *  - The successor is written back BEFORE this returns. Dropping it (a crash, an unwritten file)
 *    leaves the CLI holding a token the server has already retired; the next refresh presents it
 *    outside the grace window, which slice 2 reads as a LEAK and answers by revoking the whole
 *    family. Failing to persist a rotation is therefore not a lost optimisation, it is a
 *    self-inflicted logout.
 */
export async function refreshSession(
  deps: SessionDeps,
): Promise<string | undefined> {
  const file = deps.file ?? configPath();
  const stored = readConfigFile(file).refreshToken;
  if (!stored) return undefined;

  const res = await deps.fetch(buildRootUrl(deps.apiUrl, "/auth/cli/refresh"), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ refreshToken: stored }),
  });
  const raw = await res.text();

  if (res.status === 401 || res.status === 400) {
    // The family is gone: expired, idle-expired, or revoked by reuse detection. Clear the dead
    // credentials so the next command fails with "not logged in" instead of another futile round
    // trip, and tell the user the one thing they can act on.
    clearSession(file);
    throw new AuthError(SESSION_ENDED_MESSAGE);
  }
  if (!res.ok) {
    // A 429 or a 5xx is the SERVER having a bad moment, not a dead session. Leave the stored
    // token alone — clearing it here would log the user out over a transient blip.
    return undefined;
  }

  const session = sessionFromResponse(safeJson(raw));
  if (!session) return undefined;
  saveSession(session, file);
  return session.accessToken;
}

/**
 * End the session server-side: revoke the refresh family and delete the access token.
 * Returns false if the call could not be made (offline, server down) — the caller still clears the
 * local file, because a `logout` that refuses to forget the credentials on this laptop because the
 * network is down is the wrong failure.
 */
export async function revokeSession(deps: SessionDeps): Promise<boolean> {
  const file = deps.file ?? configPath();
  const cfg = readConfigFile(file);
  if (!cfg.refreshToken && !cfg.token) return true;
  try {
    const res = await deps.fetch(
      buildRootUrl(deps.apiUrl, "/auth/cli/logout"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          refreshToken: cfg.refreshToken,
          accessToken: cfg.token,
        }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

function safeJson(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

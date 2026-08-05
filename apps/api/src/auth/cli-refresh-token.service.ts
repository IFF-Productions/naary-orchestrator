import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { getPrisma } from "@naary/db";

/** sha256 hex — the only form of the token persisted, exactly as ApiTokenService does it.
 *  The plaintext is returned to the CLI once and never written anywhere. */
const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

const DAY = 24 * 60 * 60 * 1000;

/** Absolute cap (#1078 §4). Set once when the family is created and INHERITED unchanged by every
 *  successor — re-deriving it per rotation would make "90-day absolute" mean "forever". */
export const REFRESH_ABSOLUTE_TTL_MS = 90 * DAY;

/** Idle expiry (#1078 §4): a token unused for 30 days is dead even inside the absolute cap.
 *  Weekly use never re-authenticates for a quarter; a laptop that goes quiet for a month does. */
export const REFRESH_IDLE_TTL_MS = 30 * DAY;

/** #1078 §4: "The 60-second grace window is load-bearing, not a nicety." Two `naary` processes
 *  running concurrently both refresh; with strict single-use one invalidates the other and the
 *  user sees a spurious auth failure. Accepting the previous token for 60s after rotation fixes
 *  the common race without meaningfully widening the replay window. */
export const REFRESH_ROTATION_GRACE_MS = 60_000;

/**
 * Bearer prefix for a CLI refresh token.
 *
 * Load-bearing that it is NOT `nry_`: `AuthGuard` routes any `nry_`-prefixed bearer into the API
 * token branch, and `nrys_` into the SSO branch. `nryr_` matches neither (`"nryr_x".startsWith(
 * "nry_") === false`), so a refresh token presented as an `Authorization` header authenticates
 * nothing at all. That is the whole point of keeping this in its own table: it is a credential for
 * exactly one endpoint (slice 3's `/auth/cli/refresh`), never for a request.
 */
export const CLI_REFRESH_TOKEN_PREFIX = "nryr_";

/** Why a refresh was refused. The caller (slice 3) reports ONE opaque failure to the client
 *  regardless — these exist so the server can log/alert, especially on `reused`. */
export type RefreshFailureReason =
  /** No row for this hash: never issued, or issued by another deployment. */
  | "unknown"
  /** Explicitly revoked — by logout, or by reuse detection killing this token's family. */
  | "revoked"
  /** Past the 90-day absolute cap. */
  | "expired"
  /** Unused for longer than the 30-day idle window. */
  | "idle_expired"
  /** Presented after it was rotated AND after the grace window ⇒ treated as a leak. The whole
   *  family has been revoked by the time this is returned. */
  | "reused"
  /** Lost the compare-and-set race and the re-read did not show a coherent rotated state.
   *  Fails closed: we never mint a successor for a row we did not observe ourselves claim. */
  | "conflict";

/** A session identity plus the NEXT refresh token. `refreshToken` is plaintext and is the only
 *  time it exists outside the client — the caller must hand it straight to the CLI. */
export interface RotatedRefreshToken {
  tenantId: string;
  userId: string;
  familyId: string;
  refreshToken: string;
  /** The family's absolute cap. Unchanged by this rotation. */
  expiresAt: Date;
}

export type RefreshResult =
  | ({ ok: true } & RotatedRefreshToken)
  | { ok: false; reason: RefreshFailureReason };

const fail = (reason: RefreshFailureReason): RefreshResult => ({
  ok: false,
  reason,
});

/**
 * Rotating refresh tokens for `naary auth` (design #1078 §4, slice 2).
 *
 * The state machine, which is the whole slice:
 *
 *   issue()  → a new family: one row, `familyId` of its own, `expiresAt = now + 90d`.
 *   rotate() → validate, then atomically stamp `rotatedAt` on the presented row and create a
 *              successor in the same family. The presented token is DEAD from that moment: the
 *              next presentation takes the already-rotated path below.
 *
 * Already-rotated token presented:
 *   - within `REFRESH_ROTATION_GRACE_MS` of `rotatedAt` → accepted (the concurrent-CLI race),
 *     a sibling successor is minted and the family is left alone. `rotatedAt` is NOT slid
 *     forward, so replaying the same token cannot keep renewing its own window.
 *   - after it → this is a replay or a stolen copy, and declining only this token would leave
 *     the thief's other copies working. §4 mandates the standard response: revoke the entire
 *     `familyId`. The legitimate holder's live token dies too and the human re-authenticates —
 *     that is the intended cost, because we cannot tell which of the two callers is the thief.
 *
 * NOTHING here is wired to an HTTP route: `/auth/cli/{start,exchange,refresh}` is slice 3.
 */
@Injectable()
export class CliRefreshTokenService {
  private readonly logger = new Logger(CliRefreshTokenService.name);

  /** Mint the FIRST token of a new rotation family (i.e. a fresh CLI login).
   *  Returns the plaintext once — only the sha256 is stored. */
  async issue(
    tenantId: string,
    userId: string,
    now: Date = new Date(),
  ): Promise<RotatedRefreshToken> {
    const token = newToken();
    const familyId = randomUUID();
    const expiresAt = new Date(now.getTime() + REFRESH_ABSOLUTE_TTL_MS);
    await getPrisma().cliRefreshToken.create({
      data: {
        tenantId,
        userId,
        tokenHash: hashToken(token),
        familyId,
        // createdAt is written explicitly (rather than left to @default(now())) so it is the SAME
        // instant `expiresAt` was derived from, and so the idle window it anchors is exact.
        createdAt: now,
        expiresAt,
      },
    });
    return { tenantId, userId, familyId, refreshToken: token, expiresAt };
  }

  /**
   * Exchange a refresh token for its successor. On success the PRESENTED token is invalid from
   * here on — that is what "rotation" buys, and it is what makes the reuse branch meaningful.
   */
  async rotate(
    presented: string,
    now: Date = new Date(),
  ): Promise<RefreshResult> {
    const db = getPrisma();
    const row = await db.cliRefreshToken.findUnique({
      where: { tokenHash: hashToken(presented) },
    });
    if (!row) return fail("unknown");

    // Revocation wins over everything: a family already killed by reuse detection must not be
    // reported as merely "expired", and must never mint anything.
    if (row.revokedAt) return fail("revoked");
    if (row.expiresAt.getTime() <= now.getTime()) return fail("expired");

    // "Was this already superseded?" is asked BEFORE "is this row still fresh?", and the order is
    // load-bearing. Rotation stamps `lastUsedAt` on the row it retires, so a retired row's idle
    // clock starts at its rotation instant — checking idle first would answer `idle_expired` to
    // every replay older than 30 days and never reach reuse detection, leaving the family alive
    // and refreshing. That is the likeliest leak of all (a month-old laptop backup or shell
    // history), so it is precisely the one that must not slip through.
    //
    // It sits BELOW the absolute cap on purpose: successors inherit `expiresAt` unchanged, so a
    // family past its cap is already dead in every row and revoking it would be a no-op. Only the
    // idle window is per-row, and therefore only the idle window could hide a live family.
    if (row.rotatedAt) return this.afterRotation(row, now);

    const idleSince = (row.lastUsedAt ?? row.createdAt).getTime();
    if (now.getTime() - idleSince > REFRESH_IDLE_TTL_MS)
      return fail("idle_expired");

    // Compare-and-set: `rotatedAt: null` in the WHERE is the guard that makes rotation single-use
    // under concurrency. Without it, two simultaneous callers both "rotate" the same row and the
    // lineage forks silently. Exactly one caller can flip null → now, and only that caller mints.
    const claimed = await db.cliRefreshToken.updateMany({
      where: { id: row.id, rotatedAt: null, revokedAt: null },
      data: { rotatedAt: now, lastUsedAt: now },
    });
    if (claimed.count === 1) return this.mintSuccessor(row, now);

    // We lost the race (or the row was revoked underneath us). Re-read and decide from FRESH
    // state; never fall through to minting on the strength of the stale read.
    const fresh = await db.cliRefreshToken.findUnique({
      where: { id: row.id },
    });
    if (!fresh || fresh.revokedAt || !fresh.rotatedAt) return fail("conflict");
    return this.afterRotation(fresh, now);
  }

  /** Revoke every live token in a rotation family. Used by reuse detection (and, in slice 4, by
   *  `naary logout`). Idempotent: already-revoked rows are left with their original timestamp. */
  async revokeFamily(
    familyId: string,
    now: Date = new Date(),
  ): Promise<number> {
    const res = await getPrisma().cliRefreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now },
    });
    return res.count;
  }

  /** The already-rotated branch: grace-window sibling, or reuse ⇒ kill the family. */
  private async afterRotation(
    row: RefreshRow,
    now: Date,
  ): Promise<RefreshResult> {
    const rotatedAt = row.rotatedAt;
    /* c8 ignore next */
    if (!rotatedAt) return fail("conflict"); // unreachable; both callers checked
    if (now.getTime() - rotatedAt.getTime() > REFRESH_ROTATION_GRACE_MS) {
      const killed = await this.revokeFamily(row.familyId, now);
      // No token material in the log, ever — the family id is a random opaque handle.
      this.logger.warn(
        `CLI refresh token reuse detected: revoked family ${row.familyId} (${killed} live token(s))`,
      );
      return fail("reused");
    }
    // Inside the grace window. Deliberately does NOT touch `rotatedAt` on this row: sliding it
    // would turn a 60s window into an indefinitely renewable one for whoever holds the old value.
    return this.mintSuccessor(row, now);
  }

  /** Create the next token in `row`'s family. `expiresAt` is INHERITED — never extended. */
  private async mintSuccessor(
    row: RefreshRow,
    now: Date,
  ): Promise<RefreshResult> {
    const token = newToken();
    await getPrisma().cliRefreshToken.create({
      data: {
        tenantId: row.tenantId,
        userId: row.userId,
        tokenHash: hashToken(token),
        familyId: row.familyId,
        expiresAt: row.expiresAt,
        createdAt: now,
      },
    });
    return {
      ok: true,
      tenantId: row.tenantId,
      userId: row.userId,
      familyId: row.familyId,
      refreshToken: token,
      expiresAt: row.expiresAt,
    };
  }
}

/** 32 random bytes — a refresh token is a bearer credential with a 90-day ceiling, so it is
 *  deliberately longer than the 24-byte `nry_` access token. */
function newToken(): string {
  return `${CLI_REFRESH_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** The columns this service reads. Structural, so the tests' in-memory table satisfies it
 *  without importing the generated Prisma types. */
interface RefreshRow {
  id: string;
  tenantId: string;
  userId: string;
  familyId: string;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  rotatedAt: Date | null;
  revokedAt: Date | null;
}

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
  /** The family's device hint, inherited unchanged. Null for a family minted before #1078 §5. */
  label: string | null;
}

/**
 * ONE CLI session as a human recognises it — a rotation FAMILY, not a token (#1078 §5).
 *
 * Rotation mints a row on every refresh, so a laptop that has been signed in for a month is
 * ~60 rows of the same session. Listing tokens would show that; listing families shows the laptop.
 */
export interface CliSessionSummary {
  /** The family id — the handle the revoke route takes. Opaque; it is not a credential. */
  familyId: string;
  /** `naary CLI — <hostname>` from the login handshake, or null for a pre-#1078-§5 session. */
  label: string | null;
  /** When the human signed in: the FIRST token of the family, not the newest one. */
  createdAt: Date;
  /** Newest activity across the family — i.e. the last refresh. See {@link listUserSessions}. */
  lastUsedAt: Date;
  /** The family's 90-day absolute cap (uniform across its rows). */
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
   *  Returns the plaintext once — only the sha256 is stored.
   *
   *  `label` is the handshake's `naary CLI — <hostname>` device hint (#1078 §5) and is optional
   *  ONLY so it can sit after `now` — moving it earlier would silently retarget every existing
   *  caller that passes a clock positionally. It is display text, never a credential. */
  async issue(
    tenantId: string,
    userId: string,
    now: Date = new Date(),
    label?: string | null,
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
        label: label ?? null,
        // createdAt is written explicitly (rather than left to @default(now())) so it is the SAME
        // instant `expiresAt` was derived from, and so the idle window it anchors is exact.
        createdAt: now,
        expiresAt,
      },
    });
    return {
      tenantId,
      userId,
      familyId,
      refreshToken: token,
      expiresAt,
      label: label ?? null,
    };
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

  /**
   * `naary auth logout`: end the session a presented token belongs to (#1078 slice 4).
   *
   * Deliberately NOT expressed as `rotate()`-then-revoke. Rotation is a state machine with reuse
   * detection in it; a logout that went through it would, for a token already rotated by a
   * concurrent process, look exactly like a leak and log a false incident. Logout asks a much
   * smaller question — "which family is this?" — and answers it with the same sha256 lookup
   * `rotate()` opens with, then revokes the family and nothing else.
   *
   * Every state is accepted, because every state means the same thing to a human who typed
   * `logout`: an already-rotated token still names its family (so the successor its sibling holds
   * dies too), and an already-revoked family is a no-op via `revokeFamily`'s `revokedAt: null`
   * filter. An unknown token returns 0. The caller renders ALL of these identically — a distinct
   * answer would turn this into an oracle for whether a token is real.
   */
  async revokeByToken(
    presented: string,
    now: Date = new Date(),
  ): Promise<number> {
    const row = await getPrisma().cliRefreshToken.findUnique({
      where: { tokenHash: hashToken(presented) },
    });
    if (!row) return 0;
    return this.revokeFamily(row.familyId, now);
  }

  /** Revoke every live token in a rotation family. Used by reuse detection, by offboarding via
   *  {@link revokeUserSessions} (#1117), by the Settings list (#1078 §5), and by `naary auth
   *  logout` through {@link revokeByToken}. Idempotent: already-revoked rows keep their original
   *  timestamp. */
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

  /**
   * Revoke EVERY live family this user holds in ONE workspace — the offboarding surface (#1117).
   *
   * A `CliRefreshToken` is keyed to a `userId` and carries a 90-day absolute cap, so it outlives
   * the `Membership` it was minted from: without this, removing a member (or demoting them out of
   * the roles that may hold a CLI session) left them rotating a fresh 12h `nry_` token every day
   * for up to a quarter, which is not what `members.service.ts` promises.
   *
   * TENANT-SCOPED, and that is the whole reason this exists rather than callers passing a bare
   * `userId`: the same human can hold a CLI session in several workspaces, and being removed from
   * one must not sign them out of the others. The `(tenantId, userId)` index is exactly this read.
   *
   * It resolves families and delegates to {@link revokeFamily} rather than issuing its own
   * `updateMany`, so there stays ONE way a family dies — reuse detection, logout and offboarding
   * all leave the same state, and a future change to what revocation means (an audit row, a
   * metric) has one place to land. A family never spans users or tenants — successors copy
   * `tenantId`/`userId` unchanged from the row they supersede — so revoking by id inside a
   * tenant-scoped read cannot reach outside it.
   *
   * Idempotent, and a no-op (zero queries past the read) for the overwhelmingly common case of a
   * user who never used the CLI.
   */
  async revokeUserSessions(
    tenantId: string,
    userId: string,
    now: Date = new Date(),
  ): Promise<{ families: number; tokens: number }> {
    const live = await getPrisma().cliRefreshToken.findMany({
      where: { tenantId, userId, revokedAt: null },
      select: { familyId: true },
    });
    const familyIds = [...new Set(live.map((r) => r.familyId))];
    let tokens = 0;
    for (const familyId of familyIds) {
      tokens += await this.revokeFamily(familyId, now);
    }
    return { families: familyIds.length, tokens };
  }

  /**
   * The Settings surface (#1078 §5): ONE entry per rotation family this user holds in THIS
   * workspace, newest activity first.
   *
   * Grouping by `familyId` is the whole point. A refresh mints a row every 12 hours, so a session
   * that has been alive a month is ~60 rows; a per-TOKEN list would show a person dozens of
   * identical entries for one laptop and the screen would stop being read. It also handles the 60s
   * grace window for free — two live siblings are still one session.
   *
   * WHAT COUNTS AS ACTIVE is defined as "a family `rotate()` would still accept", and is derived
   * from the same constants rather than a second opinion: not revoked, inside the 90-day absolute
   * cap, and inside the 30-day idle window. A row shown here that could not actually refresh would
   * be worse than no screen at all — a user would revoke a dead session and believe they had done
   * something.
   *
   * `lastUsedAt` is the max of `lastUsedAt ?? createdAt` over the family, which in practice is the
   * last REFRESH: `rotate()` is the only writer of `lastUsedAt`, and a successor's `createdAt` is
   * the same instant. So its granularity is the 12h access-token TTL, not per-request — still the
   * column that lets someone recognise a session they don't remember starting.
   *
   * Scoped by `(tenantId, userId)` — both from the authenticated principal, never a parameter the
   * caller chose — which is exactly the index this table already carries.
   */
  async listUserSessions(
    tenantId: string,
    userId: string,
    now: Date = new Date(),
  ): Promise<CliSessionSummary[]> {
    const rows = await getPrisma().cliRefreshToken.findMany({
      where: { tenantId, userId, revokedAt: null, expiresAt: { gt: now } },
      select: {
        familyId: true,
        label: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
      },
    });

    const byFamily = new Map<string, CliSessionSummary>();
    for (const row of rows) {
      const used = row.lastUsedAt ?? row.createdAt;
      const seen = byFamily.get(row.familyId);
      if (!seen) {
        byFamily.set(row.familyId, {
          familyId: row.familyId,
          label: row.label ?? null,
          createdAt: row.createdAt,
          lastUsedAt: used,
          expiresAt: row.expiresAt,
        });
        continue;
      }
      // `createdAt` is the family's OLDEST row (when the human signed in) and `lastUsedAt` its
      // newest activity — so the two fold in opposite directions over the same set.
      if (row.createdAt < seen.createdAt) seen.createdAt = row.createdAt;
      if (used > seen.lastUsedAt) seen.lastUsedAt = used;
      if (seen.label === null && row.label) seen.label = row.label;
    }

    return [...byFamily.values()]
      .filter(
        (s) => now.getTime() - s.lastUsedAt.getTime() <= REFRESH_IDLE_TTL_MS,
      )
      .sort((a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime());
  }

  /**
   * Revoke ONE family, but only if it belongs to this user in this workspace (#1078 §5).
   *
   * The ownership read is the entire security of the Settings revoke button. `revokeFamily` takes a
   * bare `familyId` — a global handle — so a route that passed the client's parameter straight to
   * it would let any signed-in user sign out any other user's laptop by guessing (or, worse,
   * observing) a family id. The `(tenantId, userId)` filter here is what makes that a 404.
   *
   * Returns false when the family does not exist, is already fully revoked, or is somebody else's —
   * ONE answer for all three, so this cannot be used to probe whether a family id is real.
   */
  async revokeUserFamily(
    tenantId: string,
    userId: string,
    familyId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const owned = await getPrisma().cliRefreshToken.findFirst({
      where: { tenantId, userId, familyId, revokedAt: null },
      select: { id: true },
    });
    if (!owned) return false;
    await this.revokeFamily(familyId, now);
    return true;
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
        // INHERITED, like `expiresAt`: the device hint identifies the family, so a session must not
        // lose its name the first time it refreshes.
        label: row.label,
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
      label: row.label,
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
  label: string | null;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  rotatedAt: Date | null;
  revokedAt: Date | null;
}

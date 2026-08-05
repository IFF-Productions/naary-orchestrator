import { createHash, randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { getPrisma } from "@naary/db";

/** Shared stem of every CLI-minted access-token label (#1078 §5 — "a token indistinguishable from
 *  four others is a token nobody revokes"). Declared HERE, next to the sweep that matches on it and
 *  not in the slice-3 handshake file, so this service — the one path REST, /api/v1 and MCP all
 *  authenticate through — depends on nothing above it. Every CLI token label must start with it. */
export const CLI_TOKEN_LABEL_STEM = "naary CLI";

/** sha256 hex — the only form of the token persisted; the plaintext is shown once. */
const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

/**
 * Per-tenant API tokens authenticate the control plane. Tokens are stored hashed
 * (never plaintext); the bearer presented on a request is hashed and looked up.
 */
@Injectable()
export class ApiTokenService {
  /** Mint a token for a tenant. Returns the id + PLAINTEXT once — only the sha256 is stored,
   *  so the plaintext can never be shown again. */
  async mint(
    tenantId: string,
    label: string,
    /** Absolute expiry (#1078 §3). Omitted/undefined ⇒ stored as NULL ⇒ non-expiring, which is
     *  what every Settings- and CI-minted token stays. Short-lived CLI tokens pass a value. */
    expiresAt?: Date,
    /** The Firebase uid this token belongs to — passed ONLY by the CLI handshake
     *  (`/auth/cli/exchange` and `/auth/cli/refresh`). Omitted ⇒ NULL ⇒ an UNOWNED workspace
     *  capability, which is what every Settings- and CI-minted token stays: stamping the creator
     *  on those would silently change what member removal means for a token the workspace, not the
     *  person, depends on. See {@link revokeUserCliTokens}. */
    ownerUserId?: string,
  ): Promise<{ id: string; token: string; label: string; createdAt: Date }> {
    const token = `nry_${randomBytes(24).toString("base64url")}`;
    const row = await getPrisma().apiToken.create({
      data: {
        tenantId,
        label,
        tokenHash: hashToken(token),
        expiresAt: expiresAt ?? null,
        userId: ownerUserId ?? null,
      },
      select: { id: true, label: true, createdAt: true },
    });
    return { id: row.id, token, label: row.label, createdAt: row.createdAt };
  }

  /** A tenant's tokens — metadata only, never the token/hash (write-once).
   *  `groupCount` (additive, RBAC-GROUPS.md §4a slice G2): how many permission groups the
   *  token belongs to — the SPA's "Restricted" badge. One batched query (a relation
   *  `_count` in the same findMany), no per-row lookups. */
  async list(tenantId: string): Promise<
    {
      id: string;
      label: string;
      createdAt: Date;
      lastUsedAt: Date | null;
      groupCount: number;
    }[]
  > {
    const rows = await getPrisma().apiToken.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        label: true,
        createdAt: true,
        lastUsedAt: true,
        _count: { select: { groupMemberships: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      groupCount: r._count.groupMemberships,
    }));
  }

  /**
   * Delete this tenant's ALREADY-EXPIRED CLI-minted tokens (#1078 slice 3).
   *
   * A CLI session mints a 12-hour access token and refreshes it, so without a sweep a 90-day
   * refresh family leaves ~180 dead rows in the workspace's token list — and §5's "a token
   * indistinguishable from four others is a token nobody revokes" stops holding.
   *
   * Safe by construction, and narrowly scoped on purpose:
   *  - only rows PAST `expiresAt`, which `verify()` already refuses, so nothing loses a capability;
   *  - only rows whose label starts with the CLI stem, so a hand-made token is never touched;
   *  - `expiresAt: null` (every Settings- and CI-minted token) can't match `lt`, so non-expiring
   *    tokens are outside this query entirely.
   */
  async pruneExpiredCliTokens(
    tenantId: string,
    now: Date = new Date(),
  ): Promise<number> {
    const res = await getPrisma().apiToken.deleteMany({
      where: {
        tenantId,
        label: { startsWith: CLI_TOKEN_LABEL_STEM },
        expiresAt: { lt: now },
      },
    });
    return res.count;
  }

  /**
   * Delete the LIVE CLI access tokens one user holds in ONE workspace — the offboarding surface
   * that closes the residual #1118 left open (`CliAuthController.refresh`, "TWO RESIDUALS").
   *
   * #1118 killed a removed member's refresh FAMILIES, so they can mint nothing new. Their current
   * `nry_` access token still authenticated for up to 12 hours, because there was no way to say
   * WHOSE it was: `ApiToken` had no owner, and deleting by the `naary CLI` label would have signed
   * out every other CLI session in the workspace. `userId` is that missing attribution, and this is
   * the only method that reads it.
   *
   * THREE PREDICATES, and each excludes a token that must survive:
   *  - `tenantId` — a consultant removed from one workspace keeps their CLI session in the others;
   *  - `userId` — a non-null match, so it can never reach another member's token and can never
   *    reach an UNOWNED one. Prisma renders `userId: "u-1"` as `= 'u-1'`, and SQL `NULL = 'u-1'`
   *    is not true, so every Settings/CI token and every token minted before this column existed
   *    is outside the query by construction — not by luck, and not by the label filter below;
   *  - the CLI label stem — defence in depth. Only the CLI writes `userId` today, so this is
   *    redundant; it is here so that if some future caller ever stamps an owner on a token that is
   *    NOT a CLI session, offboarding does not start deleting it as a side effect.
   *
   * DELETE, not a revoked-flag: it is the same disposal `revoke()` and `pruneExpiredCliTokens()`
   * already use, and `verify()` has exactly one lookup — no row, no auth.
   *
   * ROLLING-DEPLOY WINDOW (see the migration's note): a CLI login served by an OLD image mid-
   * rollout mints an access token with `userId = NULL`, which this cannot match. That token is
   * unrevocable for the rest of its ≤12h life — bounded, self-healing (its family is already dead,
   * so it cannot refresh), and exactly the pre-migration behaviour rather than a regression.
   *
   * Idempotent, and cheap: a no-op for the overwhelmingly common member who never used the CLI.
   */
  async revokeUserCliTokens(tenantId: string, userId: string): Promise<number> {
    const res = await getPrisma().apiToken.deleteMany({
      where: {
        tenantId,
        userId,
        label: { startsWith: CLI_TOKEN_LABEL_STEM },
      },
    });
    return res.count;
  }

  /** Revoke a tenant's token by id (tenant-scoped). Returns true if a row was removed. */
  async revoke(tenantId: string, id: string): Promise<boolean> {
    const res = await getPrisma().apiToken.deleteMany({
      where: { id, tenantId },
    });
    return res.count > 0;
  }

  /** Resolve a bearer token to its tenant + optional env binding, or null if unknown. The env id
   *  is free (same row we already read for the tenant) — the token's bound env is authoritative for
   *  runs it starts (design ENVIRONMENTS.md §3, Slice 4). Null environmentId = unbound.
   *  Additionally returns the token ROW id (RBAC-GROUPS.md §4a, slice G1): the identity a
   *  WorkflowGrant hangs on when the workspace opts into group enforcement. Additive — the id
   *  is not the secret (the hash stays write-once) and callers that ignore it are unchanged.
   *
   *  DOES NOT RETURN `userId`, and must not start to. `AuthGuard`'s `nry_` branch builds
   *  `req.principal` from exactly this shape, and a principal with a `userId` passes
   *  `CliAuthController.assertMayApprove` — so surfacing the owner here would let a CLI access
   *  token approve a CLI login and mint another CLI token, i.e. self-replication off a leaked
   *  bearer. The column is a REVOCATION key for {@link revokeUserCliTokens}, never an identity;
   *  a CLI token's authority stays exactly what it was before it had an owner. */
  async verify(token: string): Promise<{
    id: string;
    tenantId: string;
    environmentId: string | null;
  } | null> {
    const row = await getPrisma().apiToken.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (!row) return null;
    // Expiry (#1078 §3). This is the ONLY place it is enforced, deliberately: REST, /api/v1 and
    // MCP all resolve their bearer through this method, so every surface inherits the check and
    // none of them can drift. NULL = non-expiring (existing tokens). Evaluated against the
    // SERVER's clock — a client's clock is never consulted. An expired token is indistinguishable
    // from an unknown one to the caller (both → null → 401), which is also the right disclosure.
    // Checked BEFORE the lastUsedAt stamp below so a dead token can't keep reporting itself as
    // recently active in Settings.
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
    // Best-effort last-used stamp; never block or fail auth on it.
    void getPrisma()
      .apiToken.update({
        where: { id: row.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => undefined);
    return {
      id: row.id,
      tenantId: row.tenantId,
      environmentId: row.environmentId,
    };
  }
}

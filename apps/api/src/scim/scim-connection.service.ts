import { BadRequestException, Injectable } from "@nestjs/common";
import { getPrisma } from "@naary/db";
import { hashScimToken, isScimToken, newScimToken } from "./scim-token";

/** What a verified SCIM bearer resolves to. Note what is ABSENT: no role, no userId, no
 *  environment — a SCIM connection is not a principal and must never become one. */
export interface VerifiedScimConnection {
  connectionId: string;
  tenantId: string;
  /** Slice-1 dead weight, carried so slice 2's write path cannot forget it exists. */
  allowedEmailDomains: string[];
}

/**
 * Issues and verifies the per-connection SCIM bearer (#1075, design LDAP-DIRECTORY.md §3.1).
 *
 * The shape is `ApiTokenService`'s — sha256 at rest, plaintext shown once — but deliberately
 * NOT its table. See scim-token.ts for why reusing `nry_` would be a privilege escalation.
 */
@Injectable()
export class ScimConnectionService {
  /**
   * Register a connection and return the PLAINTEXT bearer once.
   *
   * Called from the operator CLI (`register-scim-connection.ts`), not from an HTTP route:
   * registering a connection declares "this IdP may read — and later write — this
   * workspace's directory", and nothing in an HTTP request proves the registrant owns the
   * domains they name. Exactly the SAML posture (`register-sso-connection.ts`, and
   * `SSO_SELF_SERVICE` defaulting off).
   */
  async mint(
    tenantId: string,
    label: string,
    allowedEmailDomains: string[],
  ): Promise<{ id: string; token: string; tenantId: string; label: string }> {
    const domains = allowedEmailDomains
      .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
      .filter((d) => d.length > 0);
    if (domains.length === 0) {
      // The §5 invariant is not enforced by slice 1 (nothing writes), but an empty allowlist
      // must never be PERSISTED — slice 2 would inherit a connection that permits any domain.
      // A Nest exception rather than a bare Error: this is CLI-only today (which just prints
      // `.message`), but `mint` is exported from ScimModule, and the first HTTP caller should
      // get a 400 for bad input rather than a 500.
      throw new BadRequestException(
        "At least one allowed email domain is required.",
      );
    }
    const token = newScimToken();
    const row = await getPrisma().scimConnection.create({
      data: {
        tenantId,
        label,
        allowedEmailDomains: domains,
        tokenHash: hashScimToken(token),
      },
      select: { id: true, tenantId: true, label: true },
    });
    return { id: row.id, token, tenantId: row.tenantId, label: row.label };
  }

  /** A tenant's connections — metadata only. `tokenHash` is never selected, so it cannot
   *  reach a DTO by accident (the write-once property is enforced here, not by discipline). */
  async list(tenantId: string): Promise<
    {
      id: string;
      label: string;
      allowedEmailDomains: string[];
      enabled: boolean;
      createdAt: Date;
      lastUsedAt: Date | null;
    }[]
  > {
    return getPrisma().scimConnection.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        label: true,
        allowedEmailDomains: true,
        enabled: true,
        createdAt: true,
        lastUsedAt: true,
      },
    });
  }

  /**
   * Resolve a bearer to its connection + tenant, or null.
   *
   * REVOCATION LAG — a decision, not an oversight (#1075 decision 1). Revoking or disabling a
   * connection takes effect on the next request against THIS row, so the SCIM surface itself
   * is immediate; what is bounded is everything downstream that reads a cache — the
   * PermissionsCache (30 s) and MembershipCache (60 s), which on a multi-instance deployment
   * have no cross-instance invalidation channel (permissions-cache.ts). That lag is the same
   * one every other credential in this system already carries, and provisioning is not the
   * path where 60 seconds of staleness is the risk that matters. The `enabled` kill switch is
   * subject to exactly the same lag for the same reason, and no more.
   */
  async verify(token: string): Promise<VerifiedScimConnection | null> {
    // Prefix-check BEFORE any DB work: a Firebase or `nry_` bearer aimed at /scim/v2 must
    // never become a lookup in this table, whatever its bytes are.
    if (!isScimToken(token)) return null;
    const row = await getPrisma().scimConnection.findUnique({
      where: { tokenHash: hashScimToken(token) },
    });
    if (!row) return null;
    if (!row.enabled) return null; // kill switch
    // Best-effort last-used stamp; never block or fail auth on it (ApiTokenService's rule).
    void getPrisma()
      .scimConnection.update({
        where: { id: row.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => undefined);
    return {
      connectionId: row.id,
      tenantId: row.tenantId,
      allowedEmailDomains: row.allowedEmailDomains,
    };
  }
}

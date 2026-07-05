import { createHash, randomBytes } from "node:crypto";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { getPrisma } from "@naary/db";
import { MembershipService } from "../membership/membership.service";
import { type Role, ROLE_RANK } from "../auth/roles.decorator";

/** Invitation as shown to an admin — NEVER includes `tokenHash`. */
export interface InvitationView {
  id: string;
  email: string;
  role: string;
  invitedBy: string;
  expiresAt: string;
  createdAt: string;
}

/** Create result: the raw token is returned exactly ONCE (only its hash is stored). */
export interface CreatedInvitation extends InvitationView {
  token: string;
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** sha256(token) hex — what we store and look up by; the raw token is never persisted. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Canonical form for recipient matching — case/space-insensitive. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Workspace invitations (design Path B). Creating an invite is admin+ (RolesGuard on the
 * controller); a granted role must be strictly BELOW the inviter's (attack #4) and never
 * `owner`. Accepting requires the accepter's VERIFIED email to equal the invite email — the
 * token alone is not enough (attack #3) — and is single-use + expiring.
 */
@Injectable()
export class InvitationsService {
  constructor(private readonly memberships: MembershipService) {}

  async create(
    tenantId: string,
    email: string,
    role: string,
    inviterRole: string | undefined,
    invitedBy: string,
  ): Promise<CreatedInvitation> {
    const grant = (role || "member") as Role;
    if (grant === "owner" || ROLE_RANK[grant] === undefined) {
      throw new BadRequestException("Role must be 'admin' or 'member'.");
    }
    // Can't grant a role >= your own (attack #4). `nry_` tokens are owner, so they may grant
    // admin/member; an admin may grant only member.
    const inviter = (inviterRole ?? "") as Role;
    if (
      ROLE_RANK[inviter] === undefined ||
      ROLE_RANK[grant] >= ROLE_RANK[inviter]
    ) {
      throw new ForbiddenException("Cannot grant a role at or above your own.");
    }

    // High-entropy, single-use token; store only its hash.
    const token = randomBytes(32).toString("base64url");
    const row = await getPrisma().invitation.create({
      data: {
        tenantId,
        email: normalizeEmail(email),
        role: grant,
        tokenHash: hashToken(token),
        invitedBy,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    });
    return { ...toView(row), token };
  }

  /** Pending (unaccepted, unexpired) invitations for a tenant — never exposes the hash. */
  async list(tenantId: string): Promise<InvitationView[]> {
    const rows = await getPrisma().invitation.findMany({
      where: { tenantId, acceptedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toView);
  }

  /** Revoke a pending invite. Scoped by tenantId so an id from another tenant is a no-op. */
  async revoke(tenantId: string, id: string): Promise<void> {
    await getPrisma().invitation.deleteMany({ where: { tenantId, id } });
  }

  /**
   * Accept an invite: verify the token, gate on the accepter's verified email matching the
   * invite, then create the Membership (busts the cache) and mark the invite consumed.
   * Returns the joined workspace + role. Token problems (unknown / expired / already used)
   * surface as an opaque 400 so a probe can't distinguish them; email problems (unverified /
   * wrong recipient) return a 403 with an actionable message — only the token holder can
   * reach that branch, and a legit invitee who signed in with the wrong account needs to know.
   */
  async accept(
    rawToken: string,
    userId: string,
    userEmail: string | undefined,
    emailVerified: boolean,
  ): Promise<{ tenantId: string; role: string }> {
    const invite = await getPrisma().invitation.findUnique({
      where: { tokenHash: hashToken(rawToken) },
    });
    const invalid = (): never => {
      throw new BadRequestException("Invalid or expired invitation.");
    };
    if (!invite || invite.acceptedAt || invite.expiresAt <= new Date()) {
      invalid();
      return { tenantId: "", role: "" }; // unreachable — for the type checker
    }
    if (!emailVerified) {
      throw new ForbiddenException("Verify your email before accepting.");
    }
    if (!userEmail || normalizeEmail(userEmail) !== invite.email) {
      // You must be the intended recipient — the token alone is not enough (attack #3).
      throw new ForbiddenException(
        "This invitation was issued to a different email address.",
      );
    }

    // Single-use: only consume it if it's still pending (guards a concurrent double-accept).
    const consumed = await getPrisma().invitation.updateMany({
      where: { id: invite.id, acceptedAt: null },
      data: { acceptedAt: new Date() },
    });
    if (consumed.count === 0) invalid();

    // Create the membership + bust the cache (immediate access).
    await this.memberships.ensureMembership(
      userId,
      invite.tenantId,
      invite.role,
      userEmail,
    );
    return { tenantId: invite.tenantId, role: invite.role };
  }
}

function toView(r: {
  id: string;
  email: string;
  role: string;
  invitedBy: string;
  expiresAt: Date;
  createdAt: Date;
}): InvitationView {
  return {
    id: r.id,
    email: r.email,
    role: r.role,
    invitedBy: r.invitedBy,
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
  };
}

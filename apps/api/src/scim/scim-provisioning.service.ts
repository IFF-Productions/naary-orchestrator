import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { getPrisma } from "@naary/db";
import { AuditService } from "../audit/audit.service";
import type { Principal } from "../auth/tenant.decorator";
import { MembersService } from "../members/members.service";
import { canonical, ScimUsersService } from "./scim-users.service";
import type { ScimUser } from "./scim-user.response";
import type { ScimWriteContext } from "./scim.guard";
import { ScimError } from "./scim.errors";

/**
 * The role a SCIM-provisioned subject is invited with. NEVER read from the payload:
 * `Membership.role` is locally administered (#1075 scope, LDAP-DIRECTORY.md §12) — the
 * directory is an authorization/lifecycle source, not a role source. A payload carrying
 * `roles: [{value: "owner"}]` is silently ignored rather than rejected, because rejecting it
 * would break every IdP that sends a default profile it cannot be told to omit.
 */
const PROVISIONED_ROLE = "member";

/**
 * The authority a SCIM connection acts with. THIS IS A DELIBERATE CEILING.
 *
 * `MembersService` gates on a Principal, and the two plausible stampings differ in what a
 * misconfigured or stolen connection can destroy:
 *
 *  - `owner` — the IdP can de-provision anyone but the last owner. One bad mapping in Okta
 *    ("everyone not in this group is deactivated") deletes the workspace's own admins, their
 *    permission groups with them, and takes away the accounts that could have stopped it.
 *  - `admin` (chosen) — the IdP can de-provision plain MEMBERS. Removing someone who holds an
 *    elevated role stays a local decision, exactly as GRANTING that role already is. The blast
 *    radius of a de-provisioning storm is then bounded by the same line the product already
 *    draws around roles, and the people who can fix it are always still there.
 *
 * The cost is real and is why {@link ScimProvisioningService.deprovision} audits a refusal
 * loudly: a departing admin's SCIM de-provision FAILS (403), and if that only ever showed up
 * in the IdP's log, a terminated admin would keep access with nobody in the workspace aware.
 * The AuditEvent is what makes the refusal visible on the Activity screen.
 *
 * `subject` (not `userId`) is what the audit trail records, so every SCIM-initiated write is
 * attributable to a connection rather than to a person who did not make it.
 */
function scimPrincipal(ctx: ScimWriteContext): Principal {
  return {
    tenantId: ctx.tenantId,
    role: "admin",
    subject: `scim:${ctx.connectionId}`,
  };
}

/** Bare `local@domain`, no display names, no angle brackets — an IdP asserting a userName we
 *  cannot key on is a bad payload, not a subject we should guess at. */
const EMAIL_RE = /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/;

/**
 * Enforce the LDAP-DIRECTORY.md §5 invariant: *"every ingested email's domain must be in that
 * connection's non-empty `allowedEmailDomains`"*.
 *
 * Stored but unenforced until now — slice 1 said so explicitly, having nothing to enforce it
 * against. This is the check that makes registering a connection mean "this IdP may create
 * memberships in this workspace **for these domains**" rather than "…for anyone".
 *
 * FAILS CLOSED on an empty allowlist. `mint` refuses to persist one, so reaching this needs a
 * row written before that check existed — and treating an empty list as "no restriction" would
 * turn exactly that row into a connection that can provision any address on the internet.
 *
 * Exact match only: no wildcards and no subdomain widening. `acme.example` does NOT admit
 * `eu.acme.example`, because a subdomain is a different administrative boundary and the
 * operator registering the connection can list both in one second.
 */
export function assertAllowedDomain(email: string, allowed: string[]): void {
  const domain = email.slice(email.lastIndexOf("@") + 1);
  const ok =
    allowed.length > 0 &&
    domain.length > 0 &&
    allowed.some((d) => d.toLowerCase() === domain);
  if (!ok) {
    throw ScimError.invalidValue(
      `The domain "${domain}" is not one this SCIM connection may provision.`,
    );
  }
}

/**
 * Read the two fields we accept from a SCIM User payload, and nothing else.
 *
 * Hand-parsed rather than spread into Prisma `data`: named-key reads cannot carry
 * `__proto__`/`constructor` through (the prototype-pollution posture from the 2026-07 audit),
 * and a SCIM payload is a large, IdP-specific document of which we can answer truthfully for
 * exactly `userName` and `externalId` (see ScimUser's docstring on why we emit no profile
 * attributes we do not store).
 */
function parseUserPayload(body: unknown): {
  email: string;
  externalId?: string;
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw ScimError.invalidValue(
      "A SCIM User payload is required. (Is the request body JSON, with Content-Type application/scim+json or application/json?)",
    );
  }
  const b = body as Record<string, unknown>;

  /**
   * `active: false` ON A CREATE IS REFUSED — see the deprovision docstring. Slice 2 has no
   * deactivated state to create a subject INTO, and inventing one silently (provisioning them
   * fully active) would be the worst possible reading of an explicit instruction.
   */
  if (b.active === false) {
    throw ScimError.invalidValue(
      "Creating a deactivated user is not supported: this connection has no deactivated state. De-provision with DELETE instead.",
    );
  }

  const userName = typeof b.userName === "string" ? canonical(b.userName) : "";
  if (!userName || !EMAIL_RE.test(userName)) {
    throw ScimError.invalidValue(
      "userName must be the subject's email address.",
    );
  }
  const rawExternal =
    typeof b.externalId === "string" ? b.externalId.trim() : "";
  return {
    email: userName,
    ...(rawExternal ? { externalId: rawExternal.slice(0, 255) } : {}),
  };
}

/**
 * The SCIM WRITE surface (#1075 slice 2) — provisioning and de-provisioning.
 *
 * Slice 1 was read-only on purpose: a misconfigured IdP pointed at it could do nothing. This
 * is the destructive half, and every method here is written on the assumption that the caller
 * is a machine that may repeat itself, may be pointed at the wrong workspace, and may have
 * been told to de-provision everyone.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────────────────
 * `PATCH /Users/{id}` with `active: false` — the standard SOFT de-provision, and the signal
 * Okta and Entra send most often. It is unbuilt and `ServiceProviderConfig` still advertises
 * `patch: { supported: false }`, so an IdP will not send it. The reason is that `Membership`
 * has no `active` column, which leaves two answers with materially different recovery:
 *   (a) map it onto removal — real revocation today, but `GroupMember` rows go with it
 *       (`removeMember`'s cascade), so re-activation restores the person, NOT their grants;
 *   (b) add `Membership.active` and teach the AuthGuard to honour it — reversible, but it puts
 *       a new condition on the hot authorization path, where missing one read means a
 *       "de-provisioned" user still has access.
 * That is a product decision about a destructive default, not an implementation detail, and
 * #1075 does not settle it. Advertising `patch: false` is the honest interim: an IdP
 * configured to DELETE on de-provision is fully served, and one configured to deactivate is
 * told we cannot, instead of being 400'd into a retry loop.
 * ────────────────────────────────────────────────────────────────────────────────────────
 */
@Injectable()
export class ScimProvisioningService {
  constructor(
    /** The mandated removal path — see {@link deprovision}. Never `membership.deleteMany`. */
    private readonly members: MembersService,
    private readonly users: ScimUsersService,
    private readonly audit: AuditService,
  ) {}

  /**
   * `POST /scim/v2/Users` — provision a subject.
   *
   * Creates a pending **Invitation**, never a Membership, and that is forced rather than
   * chosen: `Membership.userId` is a Firebase uid, which does not exist until the person
   * actually signs in. So a provisioned subject is `active: false` until their first verified
   * login converts the invitation (`MembershipService.acceptPendingInvitations`) — the same
   * lifecycle a human-issued invite follows, which is why this routes through
   * `MembersService.invite` rather than writing an Invitation row itself: the conflict
   * semantics, the re-open-a-consumed-invitation branch and the invite email all live there.
   *
   * 409 on an existing subject (RFC 7644 §3.3 `uniqueness`) rather than a silent upsert: an
   * IdP that gets a 409 reconciles by filter, which slice 1 serves, whereas a silent success
   * would let a POST quietly re-open an invitation for someone a workspace admin had just
   * removed.
   */
  async provision(ctx: ScimWriteContext, body: unknown): Promise<ScimUser> {
    const { email, externalId } = parseUserPayload(body);
    assertAllowedDomain(email, ctx.allowedEmailDomains);

    try {
      await this.members.invite(
        ctx.tenantId,
        scimPrincipal(ctx),
        email,
        PROVISIONED_ROLE,
      );
    } catch (err) {
      if (err instanceof ConflictException) {
        throw ScimError.conflict(
          "That user already exists in this workspace. Reconcile with a userName filter instead.",
        );
      }
      throw err;
    }
    this.record(
      ctx,
      `SCIM provisioned ${email} as an invited member`,
      "POST",
      201,
    );
    return this.users.renderByEmail(ctx.tenantId, email, externalId);
  }

  /**
   * `DELETE /scim/v2/Users/{id}` — de-provision a subject. THE DESTRUCTIVE PATH.
   *
   * Routes through `MembersService.removeMember`, which is the only removal that also deletes
   * the `GroupMember` rows, invalidates the membership AND permission caches, reports
   * `strandedApprovals` and writes the AuditEvent its own docstring calls "the SCIM/no-human
   * surface" (#1041, #1053). A `membership.deleteMany` here would silently lose all four.
   *
   * TWO TARGETS, NOT ONE. `removeMember` keys on `(userId, tenantId)`, and a subject who was
   * provisioned but has never signed in HAS NO MEMBERSHIP — they are a pending Invitation. So
   * this deletes both, unconditionally and in that order:
   *
   *  1. the Membership (the live access), via `removeMember`;
   *  2. any PENDING Invitation, via `revokeInvitation`.
   *
   * Step 2 is not tidying — it is a re-entry hole. `acceptPendingInvitations` converts any
   * `acceptedAt: null` invitation matching a verified email into a Membership at the next
   * sign-in, so a de-provisioned user who kept a pending invitation would silently
   * re-provision THEMSELVES by logging in. (The manual removal path is safe from this only
   * because it leaves `acceptedAt` set on the consumed row, which that filter excludes.)
   *
   * THE uid IS RESOLVED FRESH, from `Membership` by `(tenantId, email)` — never from
   * `ScimIdentity.userId`, which is a denormalised copy refreshed opportunistically on read
   * and can therefore be stale or null. Passing a stale uid to `removeMember` yields
   * `removed: false`, which would 204 a de-provision that removed NOTHING while the IdP
   * recorded success. The post-condition below asserts that state is unreachable rather than
   * trusting the return value.
   */
  async deprovision(ctx: ScimWriteContext, id: string): Promise<void> {
    const prisma = getPrisma();
    // Tenant-scoped findFirst, never findUnique({ id }) — slice 1's whole lesson, and here a
    // cross-tenant hit would DELETE another workspace's member rather than merely show them.
    const identity = await prisma.scimIdentity.findFirst({
      where: { id, tenantId: ctx.tenantId },
    });
    if (!identity) throw ScimError.notFound();
    const email = canonical(identity.email);
    const caller = scimPrincipal(ctx);

    const membership = await this.membershipFor(ctx.tenantId, email);
    const invitation = await prisma.invitation.findFirst({
      where: {
        tenantId: ctx.tenantId,
        acceptedAt: null,
        email: { equals: email, mode: "insensitive" },
      },
      // `role` is read for the refusal message, not for a decision — see `refused`.
      select: { id: true, role: true },
    });

    if (!membership && !invitation) {
      // The identity row outlived its subject (a workspace admin removed them by hand). GET
      // 404s in this state, so DELETE must too — but drop the stale row on the way out so the
      // two surfaces cannot drift.
      await prisma.scimIdentity.deleteMany({
        where: { id, tenantId: ctx.tenantId },
      });
      throw ScimError.notFound();
    }

    if (membership) {
      try {
        await this.members.removeMember(
          ctx.tenantId,
          caller,
          membership.userId,
        );
      } catch (err) {
        throw this.refused(ctx, err, email, {
          kind: "member",
          role: membership.role,
        });
      }
      // POST-CONDITION, not a log line. If the membership survives, the de-provision did not
      // happen, and answering 204 would tell the IdP a terminated user lost access when they
      // did not. Fail loudly instead — a 500 is retried; a false success is never revisited.
      if (await this.membershipFor(ctx.tenantId, email)) {
        this.record(
          ctx,
          `SCIM de-provision of ${email} FAILED: the membership still exists`,
          "DELETE",
          500,
        );
        throw new ScimError(
          500,
          "De-provisioning did not remove the membership.",
        );
      }
    }

    if (invitation) {
      try {
        await this.members.revokeInvitation(
          ctx.tenantId,
          caller,
          invitation.id,
        );
      } catch (err) {
        // The membership (if any) is already gone, so access IS revoked; what remains is a
        // pending invitation for an elevated role that this connection may not revoke. Not a
        // 204: the resource is not fully de-provisioned and the IdP must see that.
        throw this.refused(ctx, err, email, {
          kind: "invitation",
          role: invitation.role,
        });
      }
      // The same post-condition, for the same reason: a surviving `acceptedAt: null` row is a
      // re-entry hole, and a 204 over one would report a de-provision that the user's next
      // sign-in quietly undoes.
      const stillPending = await prisma.invitation.findFirst({
        where: {
          tenantId: ctx.tenantId,
          acceptedAt: null,
          email: { equals: email, mode: "insensitive" },
        },
        select: { id: true },
      });
      if (stillPending) {
        this.record(
          ctx,
          `SCIM de-provision of ${email} FAILED: a pending invitation survives`,
          "DELETE",
          500,
        );
        throw new ScimError(
          500,
          "De-provisioning did not revoke the pending invitation.",
        );
      }
    }

    // The resource is gone, so its id must stop resolving (RFC 7644 §3.6). Tenant-scoped
    // deleteMany, so a leaked id can never delete another workspace's identity row.
    await prisma.scimIdentity.deleteMany({
      where: { id, tenantId: ctx.tenantId },
    });
    this.record(ctx, `SCIM de-provisioned ${email}`, "DELETE", 204);
  }

  /** The uid to de-provision, resolved from the ONE table that carries live access, scoped to
   *  the connection's tenant. A missing `tenantId` here is the write-path version of slice 1's
   *  cross-tenant read — it would resolve another workspace's uid. */
  private async membershipFor(
    tenantId: string,
    email: string,
  ): Promise<{ userId: string; role: string } | null> {
    return getPrisma().membership.findFirst({
      where: { tenantId, email: { equals: email, mode: "insensitive" } },
      select: { userId: true, role: true },
    });
  }

  /**
   * Turn a `MembersService` refusal into a SCIM error AND an AuditEvent.
   *
   * The audit row is the point, and it is READ BY A HUMAN on the Activity screen: it is the
   * only place a workspace learns that a terminated admin was NOT removed. A 403 that reaches
   * nothing but the IdP's sync log is what would make the `admin` ceiling in
   * {@link scimPrincipal} dangerous instead of merely conservative, so the sentence has to say
   * exactly which person, which role, and what the reader must do.
   */
  private refused(
    ctx: ScimWriteContext,
    err: unknown,
    email: string,
    target: { kind: "member" | "invitation"; role: string },
  ): unknown {
    if (err instanceof ForbiddenException) {
      this.record(
        ctx,
        target.kind === "member"
          ? `SCIM de-provision of ${email} REFUSED: they hold the elevated role "${target.role}" here — remove them in this workspace`
          : `SCIM de-provision of ${email} REFUSED: their pending invitation is for the elevated role "${target.role}" — revoke it in this workspace`,
        "DELETE",
        403,
      );
      return ScimError.forbidden(
        "This user holds an elevated role in the workspace and must be removed there. A SCIM connection cannot de-provision an owner or admin.",
      );
    }
    if (err instanceof ConflictException) {
      // The last-owner guard. Unreachable while scimPrincipal is `admin` (an owner target is
      // refused above first), and kept so that loosening that ceiling cannot turn a 409 into
      // an unhandled 500.
      this.record(
        ctx,
        `SCIM de-provision of ${email} REFUSED: last owner`,
        "DELETE",
        409,
      );
      return new ScimError(
        409,
        "The last owner of a workspace cannot be removed.",
      );
    }
    return err;
  }

  /** Fire-and-forget, like every other audit write: an audit failure must never be the reason
   *  a completed de-provision reports an error. */
  private record(
    ctx: ScimWriteContext,
    action: string,
    method: string,
    statusCode: number,
  ): void {
    void this.audit
      .record({
        tenantId: ctx.tenantId,
        actor: `scim:${ctx.connectionId}`,
        action,
        method,
        path: "/scim/v2/Users",
        statusCode,
      })
      .catch(() => undefined);
  }
}

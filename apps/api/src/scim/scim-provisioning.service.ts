import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { getPrisma } from "@naary/db";
import { AuditService } from "../audit/audit.service";
import type { Principal } from "../auth/tenant.decorator";
import { MembersService } from "../members/members.service";
import { SCIM_BASE_PATH } from "./scim-body-parser";
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

/** The route an audited event actually happened on — `/scim/v2/Users/{the id the IdP called}`. */
const resourcePath = (id: string): string => `${SCIM_BASE_PATH}/Users/${id}`;

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
  if (!isAllowedDomain(email, allowed)) {
    throw ScimError.invalidValue(
      `The domain "${domainOf(email)}" is not one this SCIM connection may provision.`,
    );
  }
}

/** The domain half of an address, lowercased by the caller's `canonical`. */
const domainOf = (email: string): string =>
  email.slice(email.lastIndexOf("@") + 1);

/** The predicate behind {@link assertAllowedDomain}, extracted so the de-provision paths can
 *  refuse with a DIFFERENT status and an audit row (see `assertWritableDomain`) while sharing
 *  one definition of "allowed" — two spellings of this rule would eventually disagree. */
export function isAllowedDomain(email: string, allowed: string[]): boolean {
  const domain = domainOf(email);
  return (
    allowed.length > 0 &&
    domain.length > 0 &&
    allowed.some((d) => d.toLowerCase() === domain)
  );
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
   * `active: false` ON A CREATE IS STILL REFUSED, and #1115 does not change that — it only
   * changes the reason, so the refusal is re-argued here rather than left standing on a
   * sentence that is no longer true.
   *
   * `Membership.active` now exists, but a CREATE cannot reach it: `provision` writes an
   * Invitation, because `Membership.userId` is a Firebase uid that does not exist until the
   * person signs in. So there is still no row to create a subject INTO in a deactivated state,
   * and the two silent readings are both wrong — provisioning them fully active ignores an
   * explicit instruction, and provisioning nothing at all reports a create that did not happen.
   * The honest answer is the 400, and it now names the operation that DOES work.
   */
  if (b.active === false) {
    throw ScimError.invalidValue(
      "Creating a deactivated user is not supported: a subject who has never signed in has no membership to deactivate. Create them, then PATCH active:false.",
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

/** RFC 7644 §3.5.2 — the envelope schema every PatchOp body declares. */
const PATCH_OP_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

/**
 * Read `active` out of a SCIM PatchOp, and REFUSE everything else (#1115).
 *
 * This parser is deliberately narrow: `PATCH` is now advertised as supported, and an IdP that
 * believes it can PATCH will send whatever its admin mapped — display names, department,
 * manager, `userName` changes. We store none of those (see ScimUser's docstring on why we emit
 * no profile attribute we do not hold), so silently accepting an operation and applying nothing
 * would let an IdP believe it had renamed someone. Every operation we do not implement is a
 * 400, not a shrug.
 *
 * THREE DIALECTS, ALL REAL, and this is where interop actually lives:
 *   1. `{ op: "replace", path: "active", value: false }`      — the RFC's own example, Okta;
 *   2. `{ op: "Replace", value: { "active": false } }`        — path-less, Entra/Azure AD, and
 *      note the capitalised `op`: §3.5.2 says the operation name is case-insensitive;
 *   3. `value: "False"` / `"True"` as a STRING                — Azure AD does this, and a
 *      JSON-strict reading (`value === false`) treats `"False"` as truthy, i.e. it ACTIVATES
 *      the user the directory just asked us to switch off. That is the one misreading here
 *      that fails open, so it is handled explicitly rather than left to `Boolean(value)`.
 *
 * Values are read by NAMED KEY throughout, never spread — the prototype-pollution posture the
 * 2026-07 audit set, and the same reason `parseUserPayload` is hand-written.
 *
 * The last `active` operation in the list wins, which is what "apply the operations in order"
 * means; in practice an IdP sends exactly one.
 */
export function parsePatchPayload(body: unknown): { active: boolean } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw ScimError.invalidValue(
      "A SCIM PatchOp payload is required. (Is the request body JSON, with Content-Type application/scim+json or application/json?)",
    );
  }
  const b = body as Record<string, unknown>;
  // The schema declaration is checked when present but not required: some IdPs omit it, and
  // 400ing a body we otherwise understand perfectly would fail a sync over a formality.
  const schemas = Array.isArray(b.schemas) ? b.schemas : [];
  if (schemas.length > 0 && !schemas.includes(PATCH_OP_SCHEMA)) {
    throw ScimError.invalidValue(
      `A PATCH body must declare the "${PATCH_OP_SCHEMA}" schema.`,
    );
  }
  const ops = Array.isArray(b.Operations)
    ? b.Operations
    : Array.isArray(b.operations)
      ? b.operations
      : null;
  if (!ops || ops.length === 0) {
    throw ScimError.invalidValue("A PATCH body must carry Operations.");
  }

  let active: boolean | undefined;
  for (const raw of ops) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw ScimError.invalidValue("Each PATCH operation must be an object.");
    }
    const op = raw as Record<string, unknown>;
    const verb = typeof op.op === "string" ? op.op.toLowerCase() : "";
    // `add` is accepted alongside `replace` because §3.5.2.1 says adding an existing
    // single-valued attribute replaces it — and Entra does send `add` for `active`.
    if (verb !== "replace" && verb !== "add") {
      throw ScimError.invalidValue(
        `This connection supports only "replace" of the "active" attribute; "${
          typeof op.op === "string" ? op.op : "?"
        }" is not implemented.`,
      );
    }
    const path = typeof op.path === "string" ? op.path.trim() : "";
    if (path && path.toLowerCase() !== "active") {
      throw ScimError.invalidValue(
        `This connection supports only the "active" attribute; "${path}" is not implemented. Roles and profile attributes are administered in the workspace.`,
      );
    }
    // Dialect 1/3 (path: "active") reads `value` directly; dialect 2 (no path) reads it from
    // the object the IdP put in `value`.
    const raw2 = path
      ? op.value
      : op.value && typeof op.value === "object" && !Array.isArray(op.value)
        ? (op.value as Record<string, unknown>).active
        : undefined;
    const parsed = booleanish(raw2);
    if (parsed === undefined) {
      throw ScimError.invalidValue(
        'This connection supports only the "active" attribute, with a boolean value.',
      );
    }
    active = parsed;
  }
  if (active === undefined) {
    throw ScimError.invalidValue(
      'No supported operation in this PATCH — this connection implements "active" only.',
    );
  }
  return { active };
}

/** `true`/`false`, or the strings Azure AD sends for them. Anything else ⇒ undefined (⇒ 400),
 *  never a coerced guess: `Boolean("False")` is `true`, which would activate a leaver. */
function booleanish(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
  }
  return undefined;
}

/**
 * The SCIM WRITE surface (#1075 slice 2) — provisioning and de-provisioning.
 *
 * Slice 1 was read-only on purpose: a misconfigured IdP pointed at it could do nothing. This
 * is the destructive half, and every method here is written on the assumption that the caller
 * is a machine that may repeat itself, may be pointed at the wrong workspace, and may have
 * been told to de-provision everyone.
 *
 * ── #1115 — THE TWO DECISIONS, AND WHAT THEY COST ───────────────────────────────────────
 * Both were open questions recorded here in slice 2; the owner has now answered both, and the
 * answers live next to the reasoning as that note asked.
 *
 * DECISION 1 — `PATCH /Users/{id}` with `active: false` maps to **(b)**: a new
 * `Membership.active` column that the authorization path honours. Not (a) — mapping the soft
 * de-provision onto removal — because `removeMember` cascades the `GroupMember` rows away, so
 * an `active: true` a week later would restore the PERSON AND NOT THEIR GRANTS, and an IdP
 * admin running a deactivate/reactivate cycle would get a silently wrong answer. `ServiceProvider
 * Config` now advertises `patch: { supported: true }`, which is a contract: an IdP that reads it
 * WILL send PATCH.
 *
 * The cost is the one the issue named verbatim — *"every place that treats 'a Membership row
 * exists' as authority would have to also check `active`; missing one read means a user we told
 * the IdP was de-provisioned still has access."* The enumeration is in the PR for this change.
 * The load-bearing sites, and what each does now:
 *   · `MembershipService.listForUser` — THE chokepoint: returns live rows only, so the AuthGuard
 *     (and everything downstream of the principal it builds) denies a deactivated member;
 *   · the AuthGuard's legacy `tenant` claim — a deactivated row now BEATS the claim, which
 *     otherwise re-granted owner with no row at all;
 *   · `SsoService.resolveUser` — refuses the login, because a deactivated row that merely
 *     "wasn't found" would fall through to auto-provisioning a NEW active membership;
 *   · `MembersService` — `assertNotLastOwner` counts live owners, `invite` says why it 409s,
 *     the Team screen reports `active`;
 *   · `resolveRemaining` (stranded approvals) — a deactivated member is not their own remaining
 *     approver, in either the email or the group half;
 *   · `CompanyService.addMember`/`isWorkspaceOwner` — a deactivated row is not an account;
 *   · this file's read surface (`ScimUsersService`) — reports `active: false` rather than
 *     hiding the subject, or the IdP reads them as deleted and re-creates them.
 * DECIDED NOT TO GATE, so a reader walking the same grep finds no unclassified hit:
 * `GroupsService.addMember` and `MembersService.changeRole` still administer a deactivated
 * member (preserving their role and grants IS the feature; neither grants access), and
 * `AuditService.actorEmails` is presentation — filtering it would blank the email on historical
 * audit lines.
 * AND THE PART A COLUMN CANNOT DO: `AuthGuard`'s `nry_` branch authenticates from the TOKEN row
 * with no Membership read at all, so {@link MembersService.setMemberActive} revokes the user's
 * CLI rotation families and their live CLI access token, exactly as `removeMember` does.
 *
 * DECISION 2 — `allowedEmailDomains` is enforced on the DE-PROVISION verbs too, not only on
 * ingest. A connection registered for `@contractor.example` can no longer remove or deactivate
 * anyone at `@acme.example`. Two things come with it, because the owner attached them:
 *   · THE REFUSAL IS AUDITED AND SAYS WHY. A domain-refused de-provision is a 403 with an
 *     AuditEvent naming the domain and the connection — see {@link assertWritableDomain}. The
 *     failure mode this closes is an IdP that silently stops de-provisioning after someone
 *     narrows an allowlist: without the row, the workspace's only evidence is in the IdP's log,
 *     which nobody here reads.
 *   · THE ESCAPE HATCH IS REAL AND STAYS OPEN. Narrowing an allowlist CAN strand people the
 *     connection provisioned earlier — that is accepted deliberately — so "stranded" must never
 *     mean "unrevocable": `MembersService.removeMember` (the Team screen's Remove member, and
 *     any other caller) is completely unaffected by this gate, which is asserted by a test
 *     rather than promised by this sentence.
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
    // Recorded AFTER the resource renders, so the 201 in the row is the status the caller
    // actually received. Auditing "201" before the response can still fail would be the same
    // class of lie the de-provision post-condition exists to prevent.
    const user = await this.users.renderByEmail(
      ctx.tenantId,
      email,
      externalId,
    );
    this.record(ctx, {
      action: `SCIM provisioned ${email} as an invited member (role "${PROVISIONED_ROLE}")`,
      method: "POST",
      path: `${SCIM_BASE_PATH}/Users`,
      statusCode: 201,
    });
    return user;
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
   *
   * DOMAIN-GATED SINCE #1115 (decision 2). Slice 2 enforced `allowedEmailDomains` on ingest
   * only; a connection registered for one domain could still DELETE anyone in the workspace,
   * which made a hostile or misconfigured connection a broader denial-of-service than its
   * registration described. See {@link assertWritableDomain} for the refusal's shape and for
   * the escape hatch that keeps a domain-stranded member revocable.
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
    // BEFORE any read of the subject's membership, so a refused connection learns nothing about
    // who is in the workspace beyond the id it already held.
    this.assertWritableDomain(ctx, email, id, "DELETE");
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
        throw this.refused(ctx, err, email, id, "DELETE", {
          kind: "member",
          role: membership.role,
        });
      }
      // POST-CONDITION, not a log line. If the membership survives, the de-provision did not
      // happen, and answering 204 would tell the IdP a terminated user lost access when they
      // did not. Fail loudly instead — a 500 is retried; a false success is never revisited.
      if (await this.membershipFor(ctx.tenantId, email)) {
        this.record(ctx, {
          action: `SCIM de-provision of ${email} FAILED: the membership still exists`,
          method: "DELETE",
          path: resourcePath(id),
          statusCode: 500,
        });
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
        throw this.refused(ctx, err, email, id, "DELETE", {
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
        this.record(ctx, {
          action: `SCIM de-provision of ${email} FAILED: a pending invitation survives`,
          method: "DELETE",
          path: resourcePath(id),
          statusCode: 500,
        });
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
    // WHAT WAS ACTUALLY REMOVED, not just "de-provisioned". "Removed the member" and "revoked
    // a pending invitation nobody had accepted" are different facts about a person's access,
    // and this row is the workspace's only view of a removal no human performed.
    const removed = [
      membership
        ? `removed their membership (role "${membership.role}")`
        : null,
      invitation ? "revoked their pending invitation" : null,
    ]
      .filter(Boolean)
      .join(" and ");
    this.record(ctx, {
      action: `SCIM de-provisioned ${email}: ${removed}`,
      method: "DELETE",
      path: resourcePath(id),
      statusCode: 204,
    });
  }

  /**
   * `PATCH /scim/v2/Users/{id}` — the SOFT de-provision (`active: false`) and its inverse
   * (`active: true`). #1115 decision (b).
   *
   * THE SIGNAL OKTA AND ENTRA ACTUALLY SEND on a leaver, which is why slice 2 refused to guess
   * at it. It lands on `Membership.active` via {@link MembersService.setMemberActive}, and it
   * is that method — not this one — that holds the four things a bare column update would lose
   * (both caches, the CLI credential the column cannot reach, the stranded-approval report).
   * The same rule the DELETE path follows: nothing in this file writes a `Membership`.
   *
   * TWO TARGETS AGAIN, exactly as `deprovision` has two, and for the same reason: a subject
   * who was provisioned but never signed in has NO Membership, only a pending Invitation.
   *  · WITH a membership — `active: false` deactivates it (the row, the role and the
   *    `GroupMember` rows all survive), and any PENDING invitation for the same address is
   *    revoked alongside it. That second half is the re-entry hole `deprovision` documents:
   *    `acceptPendingInvitations` would otherwise convert it at the next sign-in. (The upsert
   *    there leaves `active` alone, so it could not actually restore access — but a de-provision
   *    that leaves a live invitation lying around is a state nobody should have to reason about.)
   *  · WITHOUT one — `active: false` behaves EXACTLY LIKE DELETE: the invitation is revoked and
   *    the `ScimIdentity` row is dropped, so the id stops resolving. There is no third state to
   *    put a never-signed-in subject into, and inventing `Invitation.active` would be a second
   *    column and a second enforcement surface for one case. Absence is a contract this endpoint
   *    already has, and re-provisioning is the POST the IdP already knows how to send.
   *
   * `active: true` IS A PURE FLIP — it restores the person AND their permission groups, because
   * nothing ever deleted them. That is the whole argument for (b) over (a), and the one
   * behaviour a reviewer should check has a test.
   *
   * 204 NO CONTENT, ALWAYS (RFC 7644 §3.5.2 permits it explicitly). Uniform rather than
   * "200 with the resource, except 204 when the resource no longer exists" — a status code that
   * varies with the outcome is exactly what an IdP's error handling gets wrong, and the
   * reconcile GET is right there for a caller that wants the resulting state.
   */
  async setActive(
    ctx: ScimWriteContext,
    id: string,
    body: unknown,
  ): Promise<void> {
    const { active } = parsePatchPayload(body);
    const prisma = getPrisma();
    // Tenant-scoped findFirst, never findUnique({ id }) — see `deprovision`.
    const identity = await prisma.scimIdentity.findFirst({
      where: { id, tenantId: ctx.tenantId },
    });
    if (!identity) throw ScimError.notFound();
    const email = canonical(identity.email);
    this.assertWritableDomain(ctx, email, id, "PATCH");
    const caller = scimPrincipal(ctx);

    const membership = await this.membershipFor(ctx.tenantId, email);
    const invitation = await prisma.invitation.findFirst({
      where: {
        tenantId: ctx.tenantId,
        acceptedAt: null,
        email: { equals: email, mode: "insensitive" },
      },
      select: { id: true, role: true },
    });

    if (!membership && !invitation) {
      // The identity row outlived its subject (removed by hand in the workspace). Same answer
      // as GET and DELETE give in this state, and drop the stale row so they cannot drift.
      await prisma.scimIdentity.deleteMany({
        where: { id, tenantId: ctx.tenantId },
      });
      throw ScimError.notFound();
    }

    if (active) {
      // REACTIVATION. Only a membership can be reactivated; a subject sitting on a pending
      // invitation is already in the only pre-access state there is, so this is a no-op for
      // them rather than an error — an IdP re-asserting `active: true` on everyone it knows
      // about (which they do, every sync) must not get a 400 per pending invite.
      if (membership) {
        await this.applyActive(ctx, caller, id, email, membership, true);
      }
      this.record(ctx, {
        action: membership
          ? `SCIM reactivated ${email}: their membership (role "${membership.role}") and its permission groups are live again`
          : `SCIM reactivated ${email}: no change — their invitation is still pending`,
        method: "PATCH",
        path: resourcePath(id),
        statusCode: 204,
      });
      return;
    }

    // DEACTIVATION.
    if (membership) {
      await this.applyActive(ctx, caller, id, email, membership, false);
      // POST-CONDITION, not a log line — the same one `deprovision` asserts, for the same
      // reason: answering 204 over a membership that is still live would tell the IdP a
      // terminated user lost access when they did not.
      const after = await this.membershipFor(ctx.tenantId, email);
      if (after && after.active) {
        this.record(ctx, {
          action: `SCIM deactivation of ${email} FAILED: their membership is still active`,
          method: "PATCH",
          path: resourcePath(id),
          statusCode: 500,
        });
        throw new ScimError(500, "Deactivation did not take effect.");
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
        throw this.refused(ctx, err, email, id, "PATCH", {
          kind: "invitation",
          role: invitation.role,
        });
      }
      // THE SAME POST-CONDITION `deprovision` ASSERTS, and "behaves exactly like DELETE" is only
      // true because it is here. A surviving `acceptedAt: null` row is a re-entry hole:
      // `acceptPendingInvitations` converts it at the subject's next sign-in. For a subject who
      // HAS a membership that conversion could not restore access anyway (the upsert leaves
      // `active` alone), but for an invitation-only one the invitation is the only thing between
      // them and a fresh ACTIVE membership — and this is the branch that then deletes the
      // identity row and audits success. A 500 is retried; a false 204 is never revisited.
      const stillPending = await prisma.invitation.findFirst({
        where: {
          tenantId: ctx.tenantId,
          acceptedAt: null,
          email: { equals: email, mode: "insensitive" },
        },
        select: { id: true },
      });
      if (stillPending) {
        this.record(ctx, {
          action: `SCIM deactivation of ${email} FAILED: a pending invitation survives`,
          method: "PATCH",
          path: resourcePath(id),
          statusCode: 500,
        });
        throw new ScimError(
          500,
          "Deactivation did not revoke the pending invitation.",
        );
      }
    }

    // A subject who never signed in has nothing left to represent, so the id stops resolving —
    // see the docstring. One who HAS a membership keeps their id: the resource still exists and
    // must keep reporting `active: false` to the IdP's next reconcile GET.
    if (!membership) {
      await prisma.scimIdentity.deleteMany({
        where: { id, tenantId: ctx.tenantId },
      });
    }

    const did = [
      membership
        ? `deactivated their membership (role "${membership.role}"; role and permission groups kept for reactivation)`
        : null,
      invitation ? "revoked their pending invitation" : null,
    ]
      .filter(Boolean)
      .join(" and ");
    this.record(ctx, {
      action: `SCIM deactivated ${email}: ${did}`,
      method: "PATCH",
      path: resourcePath(id),
      statusCode: 204,
    });
  }

  /** The `setMemberActive` call plus the refusal mapping both PATCH branches share. Separate
   *  only so the elevated-role ceiling is applied identically in each. */
  private async applyActive(
    ctx: ScimWriteContext,
    caller: Principal,
    id: string,
    email: string,
    membership: { userId: string; role: string },
    active: boolean,
  ): Promise<void> {
    try {
      await this.members.setMemberActive(
        ctx.tenantId,
        caller,
        membership.userId,
        active,
      );
    } catch (err) {
      throw this.refused(ctx, err, email, id, "PATCH", {
        kind: "member",
        role: membership.role,
      });
    }
  }

  /**
   * #1115 DECISION 2 — this connection may only WRITE subjects inside its own
   * `allowedEmailDomains`, on every verb rather than on ingest alone.
   *
   * Slice 2 enforced the LDAP-DIRECTORY.md §5 invariant on POST only, which is what §5 literally
   * says ("every INGESTED email's domain…"). The gap that leaves is that a connection registered
   * for `@contractor.example` could de-provision the whole of `@acme.example` — a blast radius
   * far wider than its registration described, and the concrete denial-of-service §5 warns a
   * directory connection is.
   *
   * 403, NOT 400. `assertAllowedDomain` answers a bad *payload* with `invalidValue`; this
   * answers a permitted-looking request about a real resource with "not yours to touch", which
   * is an authorization fact. An IdP admin reading a sync log can act on the difference, and
   * `mutability` is the `scimType` this surface already uses for "you may see it and may not
   * change it" (the owner/admin ceiling).
   *
   * THE AUDIT ROW IS HALF THE FEATURE, per the owner's first condition. The accepted cost of
   * enforcing this is that narrowing an allowlist later strands people the connection created:
   * the IdP keeps trying to de-provision them and keeps being refused. Without a workspace-side
   * record, the only evidence is in the IdP's own log, and an admin would see a sync that
   * "stopped working" with no way to learn why. The row names the DOMAIN and the CONNECTION,
   * which is exactly what the operator has to change.
   *
   * THE ESCAPE HATCH, per the owner's second condition — "stranded" must never mean
   * "unrevocable". This gate lives ONLY on the SCIM surface. `MembersService.removeMember` and
   * `revokeInvitation` know nothing about `allowedEmailDomains`, so Team → Remove member, the
   * `/tenants/:id/members/:userId` DELETE behind it, and every other caller keep working on a
   * domain-refused subject. There is a test for that, because a documented escape hatch that
   * nobody exercises is a comment.
   */
  private assertWritableDomain(
    ctx: ScimWriteContext,
    email: string,
    id: string,
    method: "DELETE" | "PATCH",
  ): void {
    if (isAllowedDomain(email, ctx.allowedEmailDomains)) return;
    const domain = domainOf(email);
    const verb = method === "DELETE" ? "de-provision" : "deactivation";
    this.record(ctx, {
      action: `SCIM ${verb} of ${email} REFUSED: the domain "${domain}" is not in this connection's allowed domains — widen the connection's allowlist, or remove them in this workspace`,
      method,
      path: resourcePath(id),
      statusCode: 403,
    });
    throw ScimError.forbidden(
      `The domain "${domain}" is not one this SCIM connection may modify. Widen the connection's allowed domains, or remove this member in the workspace.`,
    );
  }

  /** The uid to de-provision, resolved from the ONE table that carries live access, scoped to
   *  the connection's tenant. A missing `tenantId` here is the write-path version of slice 1's
   *  cross-tenant read — it would resolve another workspace's uid.
   *
   *  `active` comes back too (#1115): the PATCH post-condition has to be able to tell "the row
   *  is gone" from "the row is still switched on", and those are different failures. */
  private async membershipFor(
    tenantId: string,
    email: string,
  ): Promise<{ userId: string; role: string; active: boolean } | null> {
    return getPrisma().membership.findFirst({
      where: { tenantId, email: { equals: email, mode: "insensitive" } },
      select: { userId: true, role: true, active: true },
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
   *
   * `method` since #1115: the same refusal now reaches this from DELETE and from PATCH, and the
   * audit row has to say which one an admin's IdP is actually stuck on. The `verb` in the
   * sentence moves with it for the same reason.
   */
  private refused(
    ctx: ScimWriteContext,
    err: unknown,
    email: string,
    id: string,
    method: "DELETE" | "PATCH",
    target: { kind: "member" | "invitation"; role: string },
  ): unknown {
    const verb = method === "DELETE" ? "de-provision" : "deactivation";
    if (err instanceof ForbiddenException) {
      this.record(ctx, {
        action:
          target.kind === "member"
            ? `SCIM ${verb} of ${email} REFUSED: they hold the elevated role "${target.role}" here — remove them in this workspace`
            : `SCIM ${verb} of ${email} REFUSED: their pending invitation is for the elevated role "${target.role}" — revoke it in this workspace`,
        method,
        path: resourcePath(id),
        statusCode: 403,
      });
      return ScimError.forbidden(
        "This user holds an elevated role in the workspace and must be removed there. A SCIM connection cannot de-provision an owner or admin.",
      );
    }
    if (err instanceof ConflictException) {
      // The last-owner guard. Unreachable while scimPrincipal is `admin` (an owner target is
      // refused above first), and kept so that loosening that ceiling cannot turn a 409 into
      // an unhandled 500.
      this.record(ctx, {
        action: `SCIM ${verb} of ${email} REFUSED: they are this workspace's last owner`,
        method,
        path: resourcePath(id),
        statusCode: 409,
      });
      return new ScimError(
        409,
        "The last owner of a workspace cannot be removed.",
      );
    }
    return err;
  }

  /**
   * Fire-and-forget, like every other audit write: an audit failure must never be the reason a
   * completed de-provision reports an error.
   *
   * EVERY FIELD IS PASSED BY THE CALLER, none defaulted here. `path` used to be the constant
   * `/scim/v2/Users` for all of them, so the Activity screen could not tell a provision from a
   * de-provision by route — a log where every entry claims the same path looks specific and
   * is not, which is exactly the failure this feature's audit trail cannot afford (the whole
   * argument for auditing a refused de-provision is that the row is what a workspace reads).
   * The concrete resource id is recorded, not the `:id` route shape, matching what
   * `MembersService.recordStranded` does with `/tenants/{id}/members/{userId}` — a person
   * reconciling an IdP's sync log against ours needs the id the IdP actually called.
   */
  private record(
    ctx: ScimWriteContext,
    event: {
      action: string;
      method: string;
      path: string;
      statusCode: number;
    },
  ): void {
    void this.audit
      .record({
        tenantId: ctx.tenantId,
        actor: `scim:${ctx.connectionId}`,
        ...event,
      })
      .catch(() => undefined);
  }
}

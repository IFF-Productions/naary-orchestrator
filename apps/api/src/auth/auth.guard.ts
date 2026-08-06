import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { MembershipService } from "../membership/membership.service";
import { PermissionsService } from "../permissions/permissions.service";
import { SsoSessionService } from "../sso/sso-session.service";
import { ApiTokenService } from "./api-token.service";
import { FirebaseVerifier, type FirebaseUser } from "./firebase-verifier";
import { IS_PUBLIC_KEY } from "./public.decorator";
import type { Principal, RequestWithPrincipal } from "./tenant.decorator";
import { IS_USER_SCOPED_KEY } from "./user-scoped.decorator";
import { accessAllowedEmails, requireMfa } from "../config";

interface GuardRequest extends RequestWithPrincipal {
  headers: Record<string, string | undefined>;
  params?: Record<string, string>;
  path?: string;
}

/** SPA sends the selected workspace here; the guard membership-checks it. */
const WORKSPACE_HEADER = "x-workspace-id";
/** SPA sends the selected environment here. The guard only STASHES it (no DB work — design
 *  ENVIRONMENTS.md §4); env-scoped controllers resolve it via EnvironmentsService.resolveEnvId. */
const ENVIRONMENT_HEADER = "x-environment-id";

/**
 * Optional single-/few-user allowlist (early-access lockdown). `ACCESS_ALLOWED_EMAILS` is a
 * comma-separated list; when set, ONLY those (verified) Firebase emails may sign in — every
 * other user gets 403 `access_not_allowed` and the SPA shows a "not available yet" screen.
 * UNSET/empty ⇒ open (unchanged behaviour). Returns null when open, else a lowercased Set.
 *
 * Note: this gates Firebase USER sign-ins only. `nry_` API tokens are explicit owner-created
 * capabilities and pass regardless (they back the CLI/MCP) — see the caller.
 */
export function parseAllowedEmails(
  raw: string | undefined,
): Set<string> | null {
  return accessAllowedEmails({ ACCESS_ALLOWED_EMAILS: raw });
}

/** Response body for a blocked user — the SPA keys its NotAvailable screen on `code`. */
const ACCESS_NOT_ALLOWED = {
  statusCode: 403,
  error: "Forbidden",
  code: "access_not_allowed",
  message: "Naary isn't open to your account yet.",
} as const;

/**
 * Response body for an authenticated user whose membership in the targeted workspace has been
 * DEACTIVATED (#1115 — SCIM `PATCH active: false`).
 *
 * A distinct `code` for the same reason `mfa_required` has one: "Not a workspace member" is
 * true but misleading for someone who IS in the workspace's member list and was switched off by
 * their company's IdP, and it would send them to a workspace admin who can see them on the Team
 * screen and cannot work out why they are locked out. The message names the actual state and
 * the actual remedy (their directory), so the support conversation starts in the right place.
 *
 * 403, not 401: the credentials are valid and re-authenticating changes nothing.
 */
const MEMBERSHIP_DEACTIVATED = {
  statusCode: 403,
  error: "Forbidden",
  code: "membership_deactivated",
  message:
    "Your access to this workspace has been deactivated. Ask your identity provider's administrator to reactivate you, or a workspace owner or admin for help.",
} as const;

/**
 * Instance-wide "require two-factor authentication" policy (#457). `REQUIRE_MFA` is an
 * operator env toggle — the same shape as `ACCESS_ALLOWED_EMAILS` above, which is the
 * existing precedent for an instance-wide auth policy (there is no instance-settings table;
 * every DB settings row is tenant- or env-scoped, and this policy is explicitly NOT
 * per-tenant). Accepts `1`/`true`/`yes`/`on` (case-insensitive); anything else — including
 * unset — is OFF.
 *
 * DEFAULT OFF, on purpose: turning this on before anyone has enrolled would lock every
 * human out of the instance, so it must be an explicit, deliberate operator action.
 */
export function parseRequireMfa(raw: string | undefined): boolean {
  return requireMfa({ REQUIRE_MFA: raw });
}

/**
 * Response body for an authenticated user whose SESSION has no second factor while the
 * instance requires one (#457). A DISTINCT `code` (not a bare 403) is the contract with the
 * SPA: it routes to the "enrol to continue" screen instead of showing a confusing
 * "forbidden". 403 (not 401) deliberately — the credentials ARE valid, so a 401 would make
 * the SPA sign the user out and loop them back through the same single-factor login.
 */
const MFA_REQUIRED = {
  statusCode: 403,
  error: "Forbidden",
  code: "mfa_required",
  message:
    "This instance requires two-factor authentication. Enrol a second factor, then sign in again.",
} as const;

/**
 * Global multi-source auth guard.
 *
 * Authenticates `Authorization: Bearer <token>` as ONE of: a per-tenant `nry_` API token
 * (services/CLI/CI — full access to its single tenant), an `nrys_` SAML SSO session (#455 —
 * authenticates the USER, minted by the ACS after a verified assertion), or a Firebase ID
 * token (humans, the default — authenticates the USER). It then resolves the ACTIVE workspace
 * and attaches `req.principal`.
 *
 * Branch order is load-bearing and must not change: `@Public()` first, then `nry_`, then the
 * user branches. The two instance-wide policies below (allowlist, MFA) apply to every USER
 * source but never to `@Public()` routes or `nry_` tokens, because those return first.
 *
 * The trust model (design PROVISIONING-MULTIUSER §3): the Firebase token no longer names
 * a tenant — a `Membership(userId, tenantId, role)` row is the authority. The active
 * workspace is the `/tenants/:id` path segment or the `X-Workspace-Id` header; the guard
 * verifies the user has a Membership there (403 if not — the core cross-tenant check,
 * attack #1) and loads their role from the MembershipCache. A legacy `tenant` claim is a
 * transitional owner grant, lazily migrated to a Membership.
 *
 * Fails CLOSED: a workspace-scoped route with no resolvable membership → 403. Only routes
 * marked `@UserScoped()` (identity/onboarding) run tenant-less. `@Public()` routes
 * (webhook HMAC ingress, connections OAuth redirect) skip auth entirely.
 *
 * Two instance-wide policies layer on top of the Firebase branch only (never on `nry_`
 * tokens, never on `@Public()`): the `ACCESS_ALLOWED_EMAILS` early-access allowlist and the
 * `REQUIRE_MFA` two-factor requirement (#457) — both default OFF.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);
  /** Early-access allowlist (see parseAllowedEmails). null = open. Computed once at boot. */
  private readonly allowedEmails = accessAllowedEmails();
  /** Instance-wide MFA enforcement (#457). false = off (default). Read once at boot. */
  private readonly requireMfa = requireMfa();

  constructor(
    private readonly tokens: ApiTokenService,
    private readonly firebase: FirebaseVerifier,
    private readonly reflector: Reflector,
    private readonly memberships: MembershipService,
    private readonly permissions: PermissionsService,
    /** SAML SSO session verifier (#455). Appended LAST so every existing positional
     *  construction in the tests keeps working. Inert unless SSO is configured. */
    private readonly sso: SsoSessionService,
  ) {
    // Log the lock state at boot (COUNT only, never the emails) so a misspelled env var —
    // which silently means "wide open" — is easy to catch after deploy.
    this.logger.log(
      this.allowedEmails
        ? `access allowlist: ${this.allowedEmails.size} email(s)`
        : "access allowlist: disabled (open)",
    );
    // Same reasoning as above: a misspelled REQUIRE_MFA silently means "not enforced", and
    // a correct one can lock out humans — so make the state visible at boot.
    this.logger.log(
      this.requireMfa
        ? "MFA enforcement: REQUIRED for all Firebase user sessions"
        : "MFA enforcement: disabled (default)",
    );
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<GuardRequest>();
    const header = req.headers?.authorization;
    const token =
      header && header.startsWith("Bearer ")
        ? header.slice(7).trim()
        : undefined;
    if (!token) throw new UnauthorizedException("Missing bearer token");

    // The workspace being targeted: a /tenants/:id path segment (extracted by PATTERN so a
    // global prefix can't silently disable the check — see AUTH-PROVISIONING-AUDIT P-1) or
    // the X-Workspace-Id header. If both are present they must agree.
    const pathTenant = /(?:^|\/)tenants\/([^/]+)/.exec(req.path ?? "")?.[1];
    const headerTenant = req.headers?.[WORKSPACE_HEADER]?.trim() || undefined;
    // The selected environment — STASHED only (no membership/DB check here; a controller resolves +
    // tenant-validates it via resolveEnvId). A header can be a string[] if duplicated; take the first.
    const envHeader = req.headers?.[ENVIRONMENT_HEADER];
    const environmentSel =
      (Array.isArray(envHeader) ? envHeader[0] : envHeader)?.trim() ||
      undefined;
    if (pathTenant && headerTenant && pathTenant !== headerTenant) {
      throw new ForbiddenException("Workspace mismatch");
    }
    const target = pathTenant ?? headerTenant;

    // `nry_…` → API token, scoped to its ONE tenant. Cross-tenant isolation is unchanged
    // from the claim era — this keeps the isolation tests green.
    if (token.startsWith("nry_")) {
      const verified = await this.tokens.verify(token);
      if (!verified) throw new UnauthorizedException("Invalid credentials");
      const { id: tokenRowId, tenantId, environmentId: tokenEnvId } = verified;
      if (target && target !== tenantId) {
        throw new ForbiddenException("Tenant mismatch");
      }
      // Token env precedence (design ENVIRONMENTS.md §3, Slice 4): an env-BOUND token's env is
      // authoritative — its runs can't cross to another env. A bound token combined with an
      // explicit X-Environment-Id is a conflict (the two disagree on intent) → reject. An UNBOUND
      // token uses the header (or the default) like any caller.
      if (tokenEnvId && environmentSel) {
        throw new ForbiddenException(
          "This API token is scoped to a fixed environment; do not send X-Environment-Id.",
        );
      }
      // Tokens fall under the SAME first-grant cliff as members (RBAC-GROUPS.md §4a/§8.6):
      // zero grants in the workspace ⇒ today's full-access `owner` stamp (migration-neutral);
      // ≥1 grant ⇒ the token is a RESTRICTED subject — stamped `member` + its row id, and
      // PermissionsService resolves the union of its groups' grants by that tokenId. The
      // check is cached (short TTL + invalidation on grant writes) so the hot path stays
      // free of an extra per-request query in steady state.
      const restricted = tokenRowId
        ? await this.permissions.isTenantEnforced(tenantId)
        : false;
      req.principal = restricted
        ? {
            tenantId,
            role: "member",
            tokenId: tokenRowId,
            environmentSel: tokenEnvId ?? environmentSel,
          }
        : {
            tenantId,
            role: "owner",
            environmentSel: tokenEnvId ?? environmentSel,
          };
      return true;
    }

    // Otherwise the bearer authenticates a USER, from EITHER identity source (#455):
    //  - `nrys_…` → a Naary SSO session, minted by the SAML ACS after a verified assertion;
    //  - anything else → a Firebase ID token (the default, unchanged).
    //
    // The PREFIX is what makes this additive: the two branches above (`@Public()` and `nry_`)
    // still return first, so webhook ingress, hosted forms/chat, OAuth callbacks and signed
    // approve/reject links are untouched. And the SSO branch joins here — BEFORE the
    // early-access allowlist, the MFA gate and the membership resolution below — so a
    // federated session is subject to exactly the same instance-wide policies as a Firebase
    // one. It is an extra identity source, not a policy bypass.
    let user: FirebaseUser | null;
    /**
     * The ONE workspace an SSO session may act in — undefined for Firebase/`nry_`.
     *
     * A SAML identity is asserted by a single tenant's IdP, so it is CONFINED to that
     * tenant: memberships in other workspaces are filtered out below and invitation
     * acceptance is scoped to it. Without this, a workspace's own IdP could mint an
     * `email_verified` principal for any address and every email-keyed path in the instance
     * (invitation accept-on-login, company member resolution) would honour it — a
     * cross-tenant escalation. A Firebase identity proves mailbox ownership instance-wide
     * and is therefore NOT confined; a SAML one proves only "this IdP says so".
     */
    let ssoTenant: string | undefined;
    // Optional-chained so a hand-built guard in an older unit test (5 positional deps, no SSO
    // service) still takes the Firebase path instead of throwing. Nest always injects it —
    // SsoModule is @Global and apps/api/test/auth-guard-di.spec.ts is the boot gate for that.
    if (this.sso?.isSessionToken(token)) {
      const session = await this.sso.verify(token);
      user = session?.user ?? null;
      ssoTenant = session?.tenantId;
    } else {
      if (!this.firebase.enabled) {
        throw new UnauthorizedException("Invalid credentials");
      }
      user = await this.firebase.verify(token);
    }
    if (!user) throw new UnauthorizedException("Invalid credentials");

    // Early-access allowlist: only listed, EMAIL-VERIFIED users may sign in. Verified matters —
    // an unverified account could otherwise claim an allowed address. Checked BEFORE any
    // membership backfill so a blocked user never gets a workspace provisioned. `nry_` tokens
    // (handled above) intentionally bypass this — they're owner-created capabilities.
    if (this.allowedEmails) {
      const email = user.email?.trim().toLowerCase();
      if (!email || !user.emailVerified || !this.allowedEmails.has(email)) {
        throw new ForbiddenException(ACCESS_NOT_ALLOWED);
      }
    }

    // Instance-wide MFA enforcement (#457). The ID token itself says whether the session
    // completed a second factor (`firebase.sign_in_second_factor` — see
    // secondFactorFromClaims), so this is a claim check, not a DB lookup.
    //
    // EXEMPT BY CONSTRUCTION (all of them return above, before this line):
    //  - `@Public()` routes — webhook ingress, hosted forms/chat, OAuth callbacks, signed
    //    approve/reject links, /healthz + /metrics. They have no user to enrol.
    //  - `nry_` API tokens (CLI/MCP/CI) — owner-created capabilities with no interactive
    //    login and therefore no possible second factor; gating them would break automation
    //    without adding security (the token IS the secret). Same posture as the email
    //    allowlist above.
    //
    // Runs BEFORE the invitation-acceptance and claim→Membership backfills below so a gated
    // user causes no membership writes — same ordering rationale as the allowlist.
    if (this.requireMfa && user.secondFactor === undefined) {
      throw new ForbiddenException(MFA_REQUIRED);
    }

    // Accept-on-login (RBAC-GROUPS.md §5, slice U1): convert pending Invitations matching
    // the user's VERIFIED email into Memberships BEFORE the membership read below, so an
    // invited user's first request already sees the workspace. Strictly gated on
    // `emailVerified === true` — an unverified account must never claim an invited address.
    // NON-authorizing (it only converts invitations; access still resolves from the
    // Membership table) and fail-quiet, same posture as the claim backfill below: a DB
    // error here must not 500 an authenticated user. Runs AFTER authentication (and the
    // allowlist) — it never widens who may sign in.
    // For an SSO session it is SCOPED to the session's workspace (`ssoTenant`): the email was
    // asserted by that workspace's IdP, so it may only satisfy that workspace's invitations.
    // Instance-wide conversion here would be the cross-tenant escalation described above.
    if (user.emailVerified === true && user.email) {
      await this.memberships
        .acceptPendingInvitations(
          user.userId,
          user.email,
          user.emailVerified,
          ssoTenant,
        )
        .catch((err) =>
          this.logger.warn(
            `invitation accept-on-login failed for user=${user.userId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
    }

    // Tenants this user may reach = their memberships ∪ {legacy claim tenant}. The claim is
    // a TRANSITIONAL owner grant (existing single-tenant users); migrate it to a Membership
    // on first sight so enforcement moves fully onto the table. (Slice 3's member-removal
    // must never target claim-holders — they own their own workspace.)
    // CONFINEMENT (see `ssoTenant` above): an SSO session sees ONLY its own workspace's
    // membership, even if the linked user really is a member of others. So a workspace's IdP
    // can never mint a session that reaches a workspace it does not speak for — including via
    // a linked pre-existing Firebase userId.
    // `listForUser` returns LIVE memberships only — a row with `active: false` (#1115, the
    // SCIM soft de-provision) is not in this list and therefore authorizes nothing.
    const allMemberships = await this.memberships.listForUser(user.userId);
    const memberships = ssoTenant
      ? allMemberships.filter((m) => m.tenantId === ssoTenant)
      : allMemberships;
    /**
     * Workspaces where this user holds a DEACTIVATED membership (#1115).
     *
     * Needed because the legacy `tenant` claim below grants owner WITHOUT a Membership row, so
     * dropping the deactivated row from `memberships` is not enough on its own: the claim would
     * quietly re-grant exactly the access a de-provision took away, and we would have told the
     * IdP the user was deactivated while they kept owner. An explicit deactivated row BEATS the
     * claim — the fail-closed reading. Answered from the same cached entry as `listForUser`,
     * so this adds no query.
     *
     * CONFINED TO `ssoTenant` FOR THE SAME REASON `memberships` IS. It is read twice — to defuse
     * the claim (which an SSO session never has) and to pick the 403's body below (which an SSO
     * session CAN reach). Unconfined, the second read would answer `membership_deactivated` for
     * a workspace the session may not speak for and `"Not a workspace member"` otherwise — a
     * distinguisher across exactly the boundary this guard's docstring calls a confinement. It
     * grants nothing either way, but a one-line filter is cheaper than the exception.
     */
    const allDeactivated = await this.memberships.deactivatedTenantIds(
      user.userId,
    );
    const deactivated = ssoTenant
      ? new Set([...allDeactivated].filter((t) => t === ssoTenant))
      : allDeactivated;
    const claim =
      user.claimTenant && !deactivated.has(user.claimTenant)
        ? user.claimTenant
        : undefined;
    if (claim && !memberships.some((m) => m.tenantId === claim)) {
      // Best-effort, NON-authorizing: access is granted via the claim union below, not by
      // this write succeeding. Awaiting-and-throwing would 500 an already-authorized user
      // on a transient DB error or a P2002 race (the SPA fires several first-login requests
      // at once, all missing the cache). Swallow + log; a later request retries the upsert.
      await this.memberships
        .ensureMembership(user.userId, claim, "owner", user.email)
        .catch((err) =>
          this.logger.warn(
            `claim→Membership backfill failed for user=${user.userId} tenant=${claim}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
    }
    const roleOf = (tenantId: string): string | undefined =>
      memberships.find((m) => m.tenantId === tenantId)?.role ??
      (tenantId === claim ? "owner" : undefined);

    // User-scoped routes (/me, the switcher, create-workspace) are about the USER, not a
    // workspace — they never scope data by the active tenant. So they IGNORE the header for
    // enforcement: a stale/foreign X-Workspace-Id (e.g. a previous user on a shared browser)
    // must not 403 the very call that lists/creates workspaces. Workspace-scoped routes
    // enforce membership on an explicit target (attack #1) and fail closed otherwise.
    const isUserScoped = this.reflector.getAllAndOverride<boolean>(
      IS_USER_SCOPED_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );

    // Resolve the ACTIVE workspace. An explicit target must be one the user belongs to; with
    // no (valid) target, default to the user's own workspace (their claim, or their sole
    // membership) so existing single-workspace callers keep working before the SPA sends the
    // header.
    const targetAllowed =
      !!target &&
      (memberships.some((m) => m.tenantId === target) || target === claim);
    let active: string | undefined;
    if (targetAllowed) {
      active = target;
    } else if (target && !isUserScoped) {
      // A workspace-scoped route explicitly targeting a workspace the user isn't in — or, since
      // #1115, one where their membership has been switched off. Same 403 either way; only the
      // body differs, so a de-provisioned person is told what actually happened.
      if (deactivated.has(target)) {
        throw new ForbiddenException(MEMBERSHIP_DEACTIVATED);
      }
      throw new ForbiddenException("Not a workspace member");
    } else {
      active =
        claim ??
        (memberships.length === 1 ? memberships[0].tenantId : undefined);
    }

    if (!active) {
      // No resolvable workspace. User-scoped routes need only the authenticated user; every
      // other route is workspace-scoped and FAILS CLOSED — a tenant-less principal must
      // never fall through to a shared empty-tenant query.
      if (!isUserScoped) throw new ForbiddenException("No workspace selected");
      req.principal = {
        tenantId: "",
        userId: user.userId,
        subject: user.userId,
        email: user.email,
        name: user.name,
        emailVerified: user.emailVerified,
      };
      return true;
    }

    req.principal = {
      tenantId: active,
      userId: user.userId,
      subject: user.userId,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerified,
      role: roleOf(active),
      environmentSel,
    };

    // Record last-active for the Team screen (#489). Fire-and-forget + NON-authorizing: it must
    // add no latency and never 500 an authed request, so we do NOT await it (unlike the
    // best-effort backfills above, which the membership read depends on). DB-side throttled, so
    // this is a cheap no-op write in steady state. `nry_` tokens (services) never reach here.
    void this.memberships
      .touchLastActive(user.userId, active)
      .catch((err) =>
        this.logger.warn(
          `last-active stamp failed for user=${user.userId} tenant=${active}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
    return true;
  }
}

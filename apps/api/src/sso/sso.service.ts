import { createHash } from "node:crypto";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { getDefaultEnvironmentId, getPrisma } from "@naary/db";
import { SecretStore } from "@naary/secrets";
import { parseAllowedEmails, parseRequireMfa } from "../auth/auth.guard";
import { MembershipService } from "../membership/membership.service";
import {
  SamlError,
  type SamlRejection,
  decodeSamlResponse,
  peekIssuer,
  verifySamlResponse,
} from "./saml";
import { SsoSessionService } from "./sso-session.service";

/**
 * SAML ACS orchestration (design SAML-SSO.md, #455): match the tenant, verify the assertion,
 * enforce the instance policies the `@Public()` route would otherwise skip, provision-or-link
 * a Membership, mint a session.
 *
 * THE SECURITY INVARIANT (SAML-SSO.md): every lookup, provision and link is scoped to
 * `connection.tenantId` — the tenant of the SsoConnection matched by the assertion's Issuer —
 * and the asserted email's domain must be in that connection's `allowedEmailDomains`. Tenant
 * A's IdP must never be able to assert `alice@tenant-b.com` and link into tenant B.
 */

/** DI token for the replay-cache SecretStore (see the constructor). */
export const SSO_SECRET_STORE = Symbol("SSO_SECRET_STORE");

/** Everything that can go wrong, as a stable coarse code for the SPA (detail stays in logs). */
export type SsoFailure =
  | SamlRejection
  | "not_configured"
  | "unknown_idp"
  | "connection_disabled"
  | "email_domain_not_allowed"
  | "replay"
  | "access_not_allowed"
  | "mfa_required"
  | "no_membership";

export class SsoLoginError extends Error {
  constructor(
    readonly code: SsoFailure,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "SsoLoginError";
  }
}

export interface SsoConfig {
  /** Our SP entity id, as configured in the IdP. */
  spEntityId: string;
  /** Our ACS URL, as configured in the IdP (must be the absolute public URL). */
  acsUrl: string;
}

/** SP-side config. Both values must match what the IdP admin entered, so they are EXPLICIT
 *  env — never guessed from a request header (a spoofable Host would let an attacker change
 *  the audience we accept). Missing either ⇒ SAML is off. */
export function ssoConfig(
  env: Record<string, string | undefined> = process.env,
): SsoConfig | null {
  const spEntityId = (env.SSO_SP_ENTITY_ID ?? "").trim();
  const acsUrl = (env.SSO_ACS_URL ?? "").trim();
  if (!spEntityId || !acsUrl) return null;
  return { spEntityId, acsUrl };
}

/** How long a consumed assertion id is remembered. Assertions are short-lived (the time-window
 *  check rejects them long before this), so this only needs to cover the validity window plus
 *  skew — it is a replay cache, not an audit log. */
const REPLAY_TTL_MS = 30 * 60_000;
const REPLAY_PREFIX = "saml:";

export interface SsoLoginResult {
  /** `nrys_…` bearer for the SPA. */
  token: string;
  tenantId: string;
  /** How the user got in — for the server log only. */
  outcome: "linked" | "provisioned" | "invited";
}

@Injectable()
export class SsoService {
  private readonly logger = new Logger(SsoService.name);
  private readonly allowedEmails = parseAllowedEmails(
    process.env.ACCESS_ALLOWED_EMAILS,
  );
  private readonly requireMfa = parseRequireMfa(process.env.REQUIRE_MFA);

  /** Built LAZILY (see the getter): a `SecretStore` reads ENCRYPTION_KEY when constructed, and
   *  merely compiling this module — e.g. in the AuthGuard DI boot test — must not require it. */
  private secretStore?: SecretStore;

  constructor(
    private readonly sessions: SsoSessionService,
    private readonly memberships: MembershipService,
    /** Replay-cache store. `@Optional()` + a symbol token so Nest doesn't try to resolve the
     *  class itself and tests can inject an in-memory double. */
    @Optional() @Inject(SSO_SECRET_STORE) private readonly injectedStore?: SecretStore,
  ) {}

  private get secrets(): SecretStore {
    this.secretStore ??= this.injectedStore ?? new SecretStore();
    return this.secretStore;
  }

  /** Whether a SAML login can complete at all (session signing + SP config present). */
  get enabled(): boolean {
    return this.sessions.enabled && ssoConfig() !== null;
  }

  /** The IdP's SSO URL for an IdP-initiated entry link (`GET /sso/:slug`). */
  async ssoUrlForSlug(slug: string): Promise<string> {
    const conn = await getPrisma().ssoConnection.findUnique({
      where: { slug },
    });
    if (!conn) throw new SsoLoginError("unknown_idp");
    if (!conn.enabled) throw new SsoLoginError("connection_disabled");
    return conn.idpSsoUrl;
  }

  /**
   * Consume a `SAMLResponse` form field. Throws `SsoLoginError` for every rejection; the
   * caller turns that into a coarse redirect.
   */
  async consumeAssertion(samlResponseB64: string): Promise<SsoLoginResult> {
    const config = ssoConfig();
    if (!config || !this.sessions.enabled) {
      throw new SsoLoginError("not_configured");
    }

    let xml: string;
    let verified: ReturnType<typeof verifySamlResponse>;
    let conn: Awaited<ReturnType<typeof this.findConnection>>;
    try {
      xml = decodeSamlResponse(samlResponseB64);
      // The Issuer is read BEFORE verification purely as a LOOKUP KEY — it is not trusted for
      // anything. Verification then re-checks it against the connection it selected, so a
      // forged Issuer can only ever select a connection whose cert will not validate it.
      const issuer = peekIssuer(xml);
      if (!issuer) throw new SamlError("malformed", "no issuer");
      conn = await this.findConnection(issuer);
      verified = verifySamlResponse(xml, {
        idpEntityId: conn.idpEntityId,
        idpCertPem: conn.idpCertPem,
        spEntityId: config.spEntityId,
        acsUrl: config.acsUrl,
      });
    } catch (err) {
      if (err instanceof SsoLoginError) throw err;
      if (err instanceof SamlError)
        throw new SsoLoginError(err.code, err.message);
      throw err;
    }

    // --- The invariant: this IdP may only speak for domains its connection allows. ---------
    const domain = verified.email.split("@")[1] ?? "";
    const allowed = conn.allowedEmailDomains.map((d) => d.trim().toLowerCase());
    if (allowed.length === 0 || !allowed.includes(domain)) {
      throw new SsoLoginError(
        "email_domain_not_allowed",
        `domain '${domain}' not allowed for connection ${conn.id}`,
      );
    }

    // --- Replay: an assertion id is single-use. --------------------------------------------
    await this.consumeAssertionId(conn.tenantId, verified.assertionId);

    // --- Instance-wide policies. The ACS is @Public(), so the guard has NOT applied these; a
    // SAML login must not be a way around early-access lockdown or REQUIRE_MFA. Checked
    // BEFORE any membership write, same ordering rationale as the guard. ---------------------
    if (this.allowedEmails && !this.allowedEmails.has(verified.email)) {
      throw new SsoLoginError("access_not_allowed");
    }
    if (this.requireMfa && !verified.mfa) {
      // Fail closed: we do not assume the IdP did MFA — it has to say so in the
      // AuthnContextClassRef (SAML-SSO.md).
      throw new SsoLoginError("mfa_required");
    }

    // --- Link or provision, always scoped to conn.tenantId. --------------------------------
    const { userId, outcome } = await this.resolveUser(conn, verified.email);

    const token = await this.sessions.mint({
      userId,
      email: verified.email,
      tenantId: conn.tenantId,
      name: verified.name,
      mfa: verified.mfa,
    });
    // Log the OUTCOME, never the assertion, the token, or the NameID.
    this.logger.log(
      `sso login ${outcome} tenant=${conn.tenantId} connection=${conn.id} mfa=${verified.mfa}`,
    );
    return { token, tenantId: conn.tenantId, outcome };
  }

  private async findConnection(issuer: string) {
    const conn = await getPrisma().ssoConnection.findUnique({
      where: { idpEntityId: issuer },
    });
    if (!conn) throw new SsoLoginError("unknown_idp");
    if (!conn.enabled) throw new SsoLoginError("connection_disabled");
    return conn;
  }

  /**
   * Single-use assertion ids, reusing the existing encrypted `SecretStore` (same
   * persist → consume-before-use → TTL shape as the GitHub App install `state`), so this needs
   * no new table. Opportunistically prunes expired entries.
   */
  private async consumeAssertionId(
    tenantId: string,
    assertionId: string,
  ): Promise<void> {
    const envId = await getDefaultEnvironmentId(tenantId);
    const key = `${REPLAY_PREFIX}${createHash("sha256").update(assertionId).digest("hex")}`;
    const seen = await this.secrets.get(tenantId, envId, key);
    if (seen !== null) throw new SsoLoginError("replay");
    await this.secrets.put(tenantId, envId, key, new Date().toISOString());
    // Best-effort hygiene; never fails a login.
    await this.secrets
      .prunePrefixOlderThan(tenantId, envId, REPLAY_PREFIX, REPLAY_TTL_MS)
      .catch(() => 0);
  }

  /**
   * Resolve the Membership identity for this login, in order (SAML-SSO.md):
   *  1. LINK — an existing Membership for this email IN THIS TENANT ⇒ reuse its userId, so a
   *     user who signed up with Firebase and is later federated keeps one identity and role.
   *  2. INVITED — a pending Invitation for this email in this tenant ⇒ allow; the guard's
   *     existing accept-on-login converts it on the first request (the SSO session is
   *     email_verified).
   *  3. PROVISION — `autoProvision` ⇒ a Membership with the CONNECTION's defaultRole.
   *  4. else refuse.
   */
  private async resolveUser(
    conn: {
      id: string;
      tenantId: string;
      defaultRole: string;
      autoProvision: boolean;
    },
    email: string,
  ): Promise<{ userId: string; outcome: SsoLoginResult["outcome"] }> {
    const existing = await this.memberships.findByEmail(conn.tenantId, email);
    if (existing) return { userId: existing.userId, outcome: "linked" };

    // Deterministic synthetic id: stable across logins, impossible to collide with a Firebase
    // uid, and it does not reveal the email/NameID.
    const userId = `sso:${conn.id}:${createHash("sha256").update(email).digest("hex").slice(0, 32)}`;

    const invitation = await getPrisma().invitation.findFirst({
      where: { tenantId: conn.tenantId, email, acceptedAt: null },
      select: { id: true },
    });
    if (invitation) return { userId, outcome: "invited" };

    if (!conn.autoProvision) throw new SsoLoginError("no_membership");
    // Role comes from the CONNECTION, never from an assertion attribute — the IdP is an
    // identity source, not an authorization source (JIT role mapping is deferred).
    const role = ["owner", "admin", "member"].includes(conn.defaultRole)
      ? conn.defaultRole
      : "member";
    await this.memberships.ensureMembership(userId, conn.tenantId, role, email);
    return { userId, outcome: "provisioned" };
  }
}

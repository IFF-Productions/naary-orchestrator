import "reflect-metadata";
import { generateKeyPairSync } from "node:crypto";
import { SignedXml } from "xml-crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory Prisma: the SsoConnection map + Invitation + Membership (via the service double).
const connections = new Map<string, Record<string, unknown>>();
const invitations: {
  tenantId: string;
  email: string;
  acceptedAt: Date | null;
}[] = [];

vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    ssoConnection: {
      findUnique: async ({ where }: any) => {
        for (const c of connections.values()) {
          if (where.idpEntityId && c.idpEntityId === where.idpEntityId)
            return c;
          if (where.slug && c.slug === where.slug) return c;
        }
        return null;
      },
    },
    invitation: {
      findFirst: async ({ where }: any) =>
        invitations.find(
          (i) =>
            i.tenantId === where.tenantId &&
            i.email === where.email &&
            i.acceptedAt === null,
        ) ?? null,
    },
  }),
  getDefaultEnvironmentId: async (tenantId: string) => `env-of-${tenantId}`,
}));

import type { MembershipService } from "../src/membership/membership.service";
import { SsoSessionService } from "../src/sso/sso-session.service";
import { SsoLoginError, SsoService } from "../src/sso/sso.service";

const IDP_A = "https://idp-a.example.com/entity";
const IDP_B = "https://idp-b.example.com/entity";
const SP_ENTITY = "https://naary.test/sso/metadata";
const ACS_URL = "https://naary.test/sso/saml/acs";
const SECRET = "s".repeat(48);

const keysA = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const keysB = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

/** Locally minted + REALLY SIGNED assertion. No live IdP is involved anywhere here. */
function signedResponse(opts: {
  issuer: string;
  email: string;
  privateKey: string;
  assertionId?: string;
  mfa?: boolean;
  /** A NameID that differs from the email — what a `persistent`-format IdP sends. The email
   *  then has to arrive as an attribute, which is the fallback saml.ts already implements. */
  nameId?: string;
}): string {
  const iso = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
  const ctx = opts.mfa
    ? "urn:oasis:names:tc:SAML:2.0:ac:classes:MultiFactorAuthentication"
    : "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport";
  const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_r1" Version="2.0" IssueInstant="${iso(
    -1,
  )}">
  <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
  <saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${
    opts.assertionId ?? "_a1"
  }" IssueInstant="${iso(-1)}" Version="2.0">
    <saml:Issuer>${opts.issuer}</saml:Issuer>
    <saml:Subject>
      <saml:NameID>${opts.nameId ?? opts.email}</saml:NameID>
      <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
        <saml:SubjectConfirmationData Recipient="${ACS_URL}" NotOnOrAfter="${iso(5)}"/>
      </saml:SubjectConfirmation>
    </saml:Subject>
    <saml:Conditions NotBefore="${iso(-5)}" NotOnOrAfter="${iso(5)}">
      <saml:AudienceRestriction><saml:Audience>${SP_ENTITY}</saml:Audience></saml:AudienceRestriction>
    </saml:Conditions>
    <saml:AuthnStatement AuthnInstant="${iso(-1)}"><saml:AuthnContext><saml:AuthnContextClassRef>${ctx}</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>${
    opts.nameId
      ? `
    <saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${opts.email}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>`
      : ""
  }
  </saml:Assertion>
</samlp:Response>`;
  const sig = new SignedXml({
    privateKey: opts.privateKey,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  sig.addReference({
    xpath: "//*[local-name()='Assertion']",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  sig.computeSignature(xml, {
    location: { reference: "//*[local-name()='Assertion']", action: "append" },
  });
  return Buffer.from(sig.getSignedXml()).toString("base64");
}

/** In-memory SecretStore double (the replay cache). */
function fakeStore() {
  const kv = new Map<string, string>();
  return {
    kv,
    get: async (t: string, e: string, k: string) =>
      kv.get(`${t}/${e}/${k}`) ?? null,
    put: async (t: string, e: string, k: string, v: string) => {
      kv.set(`${t}/${e}/${k}`, v);
    },
    /** Mirrors the real unique-constrained insert: only the FIRST caller wins. */
    putIfAbsent: async (t: string, e: string, k: string, v: string) => {
      const key = `${t}/${e}/${k}`;
      if (kv.has(key)) return false;
      kv.set(key, v);
      return true;
    },
    prunePrefixOlderThan: async () => 0,
  };
}

const ensureMembership = vi.fn();
const findByEmail = vi.fn();

function makeService(env: Record<string, string | undefined> = {}) {
  const sessions = new SsoSessionService({
    SSO_SESSION_SECRET: SECRET,
    ...env,
  });
  const memberships = {
    ensureMembership,
    findByEmail,
  } as unknown as MembershipService;
  return new SsoService(sessions, memberships, fakeStore() as never);
}

beforeEach(() => {
  connections.clear();
  invitations.length = 0;
  ensureMembership.mockReset();
  findByEmail.mockReset().mockResolvedValue(null);
  process.env.SSO_SP_ENTITY_ID = SP_ENTITY;
  process.env.SSO_ACS_URL = ACS_URL;
  delete process.env.ACCESS_ALLOWED_EMAILS;
  delete process.env.REQUIRE_MFA;
  // tenant-a's IdP, allowed to speak for tenant-a.com only
  connections.set("conn-a", {
    id: "conn-a",
    tenantId: "ws-a",
    slug: "acme",
    idpEntityId: IDP_A,
    idpSsoUrl: "https://idp-a.example.com/sso",
    idpCertPem: keysA.publicKey,
    allowedEmailDomains: ["tenant-a.com"],
    defaultRole: "member",
    autoProvision: true,
    enabled: true,
  });
  connections.set("conn-b", {
    id: "conn-b",
    tenantId: "ws-b",
    slug: "beta",
    idpEntityId: IDP_B,
    idpSsoUrl: "https://idp-b.example.com/sso",
    idpCertPem: keysB.publicKey,
    allowedEmailDomains: ["tenant-b.com"],
    defaultRole: "member",
    autoProvision: true,
    enabled: true,
  });
});

const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
    return "NO_ERROR";
  } catch (err) {
    return err instanceof SsoLoginError ? err.code : `OTHER:${String(err)}`;
  }
};

describe("SsoService — provisioning and linking", () => {
  it("auto-provisions a Membership with the CONNECTION's role and mints a session", async () => {
    const svc = makeService();
    const res = await svc.consumeAssertion(
      signedResponse({
        issuer: IDP_A,
        email: "alice@tenant-a.com",
        privateKey: keysA.privateKey,
      }),
    );
    expect(res.outcome).toBe("provisioned");
    expect(res.tenantId).toBe("ws-a");
    expect(res.token.startsWith("nrys_")).toBe(true);
    expect(ensureMembership).toHaveBeenCalledTimes(1);
    const [userId, tenantId, role, email] = ensureMembership.mock.calls[0];
    expect(tenantId).toBe("ws-a");
    expect(role).toBe("member");
    expect(email).toBe("alice@tenant-a.com");
    // Synthetic id: stable, namespaced, and it does not contain the email/NameID.
    expect(userId).toMatch(/^sso:conn-a:[0-9a-f]{32}$/);
    expect(userId).not.toContain("alice");
  });

  /**
   * The synthetic id is keyed on the NAME ID, not the email (SAML-SSO.md). This is the
   * property that matters: someone's address changes (marriage, domain migration) and they
   * must still be the SAME user. Hashing the email would mint a new synthetic id on that
   * first post-change login and silently orphan their membership and role.
   */
  it("keys the synthetic id on the NameID, so an email change keeps one identity", async () => {
    const svc = makeService();
    const idFor = async (email: string) => {
      ensureMembership.mockClear();
      await svc.consumeAssertion(
        signedResponse({
          issuer: IDP_A,
          email,
          nameId: "persistent-subject-42",
          privateKey: keysA.privateKey,
          // A fresh assertion id each time — replay protection consumes them.
          assertionId: `_a-${email}`,
        }),
      );
      return ensureMembership.mock.calls[0][0] as string;
    };

    const before = await idFor("alice@tenant-a.com");
    const after = await idFor("alice.smith@tenant-a.com");
    expect(after).toBe(before);
    // …and the id leaks neither the email nor the NameID.
    expect(before).toMatch(/^sso:conn-a:[0-9a-f]{32}$/);
    expect(before).not.toContain("alice");
    expect(before).not.toContain("persistent-subject-42");
  });

  it("gives two different NameIDs different synthetic ids", async () => {
    const svc = makeService();
    const idFor = async (nameId: string) => {
      ensureMembership.mockClear();
      await svc.consumeAssertion(
        signedResponse({
          issuer: IDP_A,
          email: "shared@tenant-a.com",
          nameId,
          privateKey: keysA.privateKey,
          assertionId: `_a-${nameId}`,
        }),
      );
      return ensureMembership.mock.calls[0][0] as string;
    };
    expect(await idFor("subject-1")).not.toBe(await idFor("subject-2"));
  });

  it("LINKS to an existing membership for that email, reusing its userId", async () => {
    findByEmail.mockResolvedValue({ userId: "firebase-uid-7", role: "admin" });
    const svc = makeService();
    const res = await svc.consumeAssertion(
      signedResponse({
        issuer: IDP_A,
        email: "alice@tenant-a.com",
        privateKey: keysA.privateKey,
      }),
    );
    expect(res.outcome).toBe("linked");
    expect(ensureMembership).not.toHaveBeenCalled(); // role/identity preserved, not overwritten
    expect(findByEmail).toHaveBeenCalledWith("ws-a", "alice@tenant-a.com");
  });

  it("allows a pending invitation through even when autoProvision is off", async () => {
    connections.get("conn-a")!.autoProvision = false;
    invitations.push({
      tenantId: "ws-a",
      email: "alice@tenant-a.com",
      acceptedAt: null,
    });
    const res = await makeService().consumeAssertion(
      signedResponse({
        issuer: IDP_A,
        email: "alice@tenant-a.com",
        privateKey: keysA.privateKey,
      }),
    );
    expect(res.outcome).toBe("invited");
    expect(ensureMembership).not.toHaveBeenCalled(); // the guard's accept-on-login does it
  });

  it("refuses an unknown user when autoProvision is off and there is no invitation", async () => {
    connections.get("conn-a")!.autoProvision = false;
    expect(
      await codeOf(() =>
        makeService().consumeAssertion(
          signedResponse({
            issuer: IDP_A,
            email: "alice@tenant-a.com",
            privateKey: keysA.privateKey,
          }),
        ),
      ),
    ).toBe("no_membership");
    expect(ensureMembership).not.toHaveBeenCalled();
  });
});

describe("SsoService — THE SECURITY INVARIANT: an IdP may only speak for its own tenant", () => {
  it("refuses tenant A's IdP asserting a tenant-B address (cross-tenant linking)", async () => {
    // Validly signed by A's real key — the ONLY thing stopping it is the domain allowlist.
    const code = await codeOf(() =>
      makeService().consumeAssertion(
        signedResponse({
          issuer: IDP_A,
          email: "victim@tenant-b.com",
          privateKey: keysA.privateKey,
        }),
      ),
    );
    expect(code).toBe("email_domain_not_allowed");
    expect(ensureMembership).not.toHaveBeenCalled();
    expect(findByEmail).not.toHaveBeenCalled(); // no cross-tenant lookup even happens
  });

  it("never links a tenant-B membership from tenant A's IdP even when the email matches", async () => {
    // A membership DOES exist for this address — in the other workspace. The domain gate fires
    // first, and the lookup that follows would be scoped to ws-a anyway.
    findByEmail.mockResolvedValue({ userId: "uid-in-ws-b", role: "owner" });
    expect(
      await codeOf(() =>
        makeService().consumeAssertion(
          signedResponse({
            issuer: IDP_A,
            email: "victim@tenant-b.com",
            privateKey: keysA.privateKey,
          }),
        ),
      ),
    ).toBe("email_domain_not_allowed");
  });

  it("refuses an assertion signed by the WRONG IdP's key for a claimed issuer", async () => {
    // Attacker owns IdP B's key but claims to be IdP A. The connection selected by the Issuer
    // brings A's cert, so verification fails.
    expect(
      await codeOf(() =>
        makeService().consumeAssertion(
          signedResponse({
            issuer: IDP_A,
            email: "alice@tenant-a.com",
            privateKey: keysB.privateKey,
          }),
        ),
      ),
    ).toBe("signature_invalid");
  });

  it("refuses an unregistered issuer", async () => {
    expect(
      await codeOf(() =>
        makeService().consumeAssertion(
          signedResponse({
            issuer: "https://who.example/entity",
            email: "alice@tenant-a.com",
            privateKey: keysA.privateKey,
          }),
        ),
      ),
    ).toBe("unknown_idp");
  });

  it("refuses a disabled connection (the kill switch)", async () => {
    connections.get("conn-a")!.enabled = false;
    expect(
      await codeOf(() =>
        makeService().consumeAssertion(
          signedResponse({
            issuer: IDP_A,
            email: "alice@tenant-a.com",
            privateKey: keysA.privateKey,
          }),
        ),
      ),
    ).toBe("connection_disabled");
  });

  it("refuses a connection with an empty domain allowlist", async () => {
    connections.get("conn-a")!.allowedEmailDomains = [];
    expect(
      await codeOf(() =>
        makeService().consumeAssertion(
          signedResponse({
            issuer: IDP_A,
            email: "alice@tenant-a.com",
            privateKey: keysA.privateKey,
          }),
        ),
      ),
    ).toBe("email_domain_not_allowed");
  });
});

describe("SsoService — replay", () => {
  it("consumes an assertion id single-use: the same assertion twice is refused", async () => {
    const svc = makeService();
    const assertion = signedResponse({
      issuer: IDP_A,
      email: "alice@tenant-a.com",
      privateKey: keysA.privateKey,
    });
    expect((await svc.consumeAssertion(assertion)).outcome).toBe("provisioned");
    expect(await codeOf(() => svc.consumeAssertion(assertion))).toBe("replay");
  });

  it("a different assertion id from the same IdP still works", async () => {
    const svc = makeService();
    await svc.consumeAssertion(
      signedResponse({
        issuer: IDP_A,
        email: "alice@tenant-a.com",
        privateKey: keysA.privateKey,
        assertionId: "_a1",
      }),
    );
    const second = await svc.consumeAssertion(
      signedResponse({
        issuer: IDP_A,
        email: "alice@tenant-a.com",
        privateKey: keysA.privateKey,
        assertionId: "_a2",
      }),
    );
    expect(second.outcome).toBe("provisioned");
  });
});

describe("SsoService — the instance policies the @Public() ACS would otherwise skip", () => {
  it("enforces ACCESS_ALLOWED_EMAILS before any membership write", async () => {
    process.env.ACCESS_ALLOWED_EMAILS = "someone-else@tenant-a.com";
    expect(
      await codeOf(() =>
        makeService().consumeAssertion(
          signedResponse({
            issuer: IDP_A,
            email: "alice@tenant-a.com",
            privateKey: keysA.privateKey,
          }),
        ),
      ),
    ).toBe("access_not_allowed");
    expect(ensureMembership).not.toHaveBeenCalled();
  });

  it("lets a listed email through", async () => {
    process.env.ACCESS_ALLOWED_EMAILS = "alice@tenant-a.com";
    const res = await makeService().consumeAssertion(
      signedResponse({
        issuer: IDP_A,
        email: "alice@tenant-a.com",
        privateKey: keysA.privateKey,
      }),
    );
    expect(res.outcome).toBe("provisioned");
  });

  it("REQUIRE_MFA refuses a single-factor assertion (fails closed) and no membership is written", async () => {
    process.env.REQUIRE_MFA = "true";
    expect(
      await codeOf(() =>
        makeService().consumeAssertion(
          signedResponse({
            issuer: IDP_A,
            email: "alice@tenant-a.com",
            privateKey: keysA.privateKey,
            mfa: false,
          }),
        ),
      ),
    ).toBe("mfa_required");
    expect(ensureMembership).not.toHaveBeenCalled();
  });

  it("REQUIRE_MFA accepts an IdP-asserted multi-factor context", async () => {
    process.env.REQUIRE_MFA = "1";
    const res = await makeService().consumeAssertion(
      signedResponse({
        issuer: IDP_A,
        email: "alice@tenant-a.com",
        privateKey: keysA.privateKey,
        mfa: true,
      }),
    );
    expect(res.outcome).toBe("provisioned");
    // …and the minted session carries the second factor, so the GUARD also lets it through.
    const sessions = new SsoSessionService({ SSO_SESSION_SECRET: SECRET });
    expect((await sessions.verify(res.token))?.user.secondFactor).toBe("mfa");
  });
});

describe("SsoService — configuration", () => {
  it("refuses to complete a login when SP config is missing", async () => {
    delete process.env.SSO_SP_ENTITY_ID;
    expect(
      await codeOf(() =>
        makeService().consumeAssertion(
          signedResponse({
            issuer: IDP_A,
            email: "alice@tenant-a.com",
            privateKey: keysA.privateKey,
          }),
        ),
      ),
    ).toBe("not_configured");
  });

  it("refuses when there is no session secret to sign with", async () => {
    const svc = new SsoService(
      new SsoSessionService({}),
      { ensureMembership, findByEmail } as unknown as MembershipService,
      fakeStore() as never,
    );
    expect(svc.enabled).toBe(false);
    expect(
      await codeOf(() =>
        svc.consumeAssertion(
          signedResponse({
            issuer: IDP_A,
            email: "alice@tenant-a.com",
            privateKey: keysA.privateKey,
          }),
        ),
      ),
    ).toBe("not_configured");
  });

  it("resolves an IdP SSO URL by slug, and refuses a disabled/unknown one", async () => {
    const svc = makeService();
    expect(await svc.ssoUrlForSlug("acme")).toBe(
      "https://idp-a.example.com/sso",
    );
    expect(await codeOf(() => svc.ssoUrlForSlug("nope"))).toBe("unknown_idp");
    connections.get("conn-a")!.enabled = false;
    expect(await codeOf(() => svc.ssoUrlForSlug("acme"))).toBe(
      "connection_disabled",
    );
  });
});

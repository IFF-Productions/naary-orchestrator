import { generateKeyPairSync } from "node:crypto";
import { SignedXml } from "xml-crypto";
import { describe, expect, it } from "vitest";
import {
  MFA_AUTHN_CONTEXTS,
  SamlError,
  decodeSamlResponse,
  normalizeIdpCert,
  spMetadataXml,
  verifySamlResponse,
} from "../src/sso/saml";

/**
 * These assertions are generated and REALLY SIGNED locally (RSA-2048 minted per run, signed
 * with xml-crypto's exclusive-c14n + rsa-sha256). NO LIVE IdP WAS CONTACTED — no Okta, Entra,
 * Google Workspace or ADFS instance is involved anywhere in this suite. What this proves is
 * our verification logic against a genuine XML-DSIG signature.
 */

const IDP_ENTITY = "https://idp.example.com/entity";
const SP_ENTITY = "https://naary.test/sso/metadata";
const ACS_URL = "https://naary.test/sso/saml/acs";

const keys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const otherKeys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const ASSERTION_XPATH = "//*[local-name()='Assertion']";

interface Opts {
  assertionId?: string;
  issuer?: string;
  audience?: string;
  recipient?: string | null;
  notBefore?: string;
  notOnOrAfter?: string;
  status?: string;
  nameId?: string;
  emailAttr?: string | null;
  authnContext?: string | null;
  extraAssertion?: boolean;
  privateKey?: string;
  sign?: boolean;
  signResponseInstead?: boolean;
}

/** Build an (optionally signed) SAML Response. `iso(+/-minutes)` keeps the window realistic. */
function iso(minutesFromNow: number): string {
  return new Date(Date.now() + minutesFromNow * 60_000).toISOString();
}

function buildResponse(o: Opts = {}): string {
  const assertionId = o.assertionId ?? "_assertion-id-1";
  const recipientAttr =
    o.recipient === null ? "" : ` Recipient="${o.recipient ?? ACS_URL}"`;
  const authn =
    o.authnContext === null
      ? ""
      : `<saml:AuthnStatement AuthnInstant="${iso(-1)}"><saml:AuthnContext><saml:AuthnContextClassRef>${
          o.authnContext ??
          "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport"
        }</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`;
  const emailAttr =
    o.emailAttr === null
      ? ""
      : `<saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${
          o.emailAttr ?? "alice@corp.example.com"
        }</saml:AttributeValue></saml:Attribute><saml:Attribute Name="displayName"><saml:AttributeValue>Alice Example</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>`;

  const assertion = (
    id: string,
  ) => `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" IssueInstant="${iso(
    -1,
  )}" Version="2.0">
      <saml:Issuer>${o.issuer ?? IDP_ENTITY}</saml:Issuer>
      <saml:Subject>
        <saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${
          o.nameId ?? "alice-nameid-42"
        }</saml:NameID>
        <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
          <saml:SubjectConfirmationData${recipientAttr} NotOnOrAfter="${
            o.notOnOrAfter ?? iso(5)
          }"/>
        </saml:SubjectConfirmation>
      </saml:Subject>
      <saml:Conditions NotBefore="${o.notBefore ?? iso(-5)}" NotOnOrAfter="${
        o.notOnOrAfter ?? iso(5)
      }">
        <saml:AudienceRestriction><saml:Audience>${
          o.audience ?? SP_ENTITY
        }</saml:Audience></saml:AudienceRestriction>
      </saml:Conditions>
      ${authn}
      ${emailAttr}
    </saml:Assertion>`;

  const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_response-1" Version="2.0" IssueInstant="${iso(
    -1,
  )}" Destination="${ACS_URL}">
    <samlp:Status><samlp:StatusCode Value="${
      o.status ?? "urn:oasis:names:tc:SAML:2.0:status:Success"
    }"/></samlp:Status>
    ${assertion(assertionId)}${o.extraAssertion ? assertion("_assertion-id-evil") : ""}
  </samlp:Response>`;

  if (o.sign === false) return xml;

  const sig = new SignedXml({
    privateKey: o.privateKey ?? keys.privateKey,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  const target = o.signResponseInstead
    ? "//*[local-name()='Response']"
    : ASSERTION_XPATH;
  sig.addReference({
    xpath: target,
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  sig.computeSignature(xml, {
    location: { reference: target, action: "append" },
  });
  return sig.getSignedXml();
}

const verify = (
  xml: string,
  over: Partial<Parameters<typeof verifySamlResponse>[1]> = {},
) =>
  verifySamlResponse(xml, {
    idpEntityId: IDP_ENTITY,
    idpCertPem: keys.publicKey,
    spEntityId: SP_ENTITY,
    acsUrl: ACS_URL,
    ...over,
  });

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
    return "NO_ERROR";
  } catch (err) {
    return err instanceof SamlError ? err.code : `OTHER:${String(err)}`;
  }
};

describe("verifySamlResponse — happy path", () => {
  it("accepts a properly signed assertion and extracts the identity", () => {
    const out = verify(buildResponse());
    expect(out.assertionId).toBe("_assertion-id-1");
    expect(out.issuer).toBe(IDP_ENTITY);
    expect(out.nameId).toBe("alice-nameid-42");
    expect(out.email).toBe("alice@corp.example.com");
    expect(out.name).toBe("Alice Example");
    expect(out.mfa).toBe(false);
  });

  it("prefers an email-shaped NameID and lowercases the email", () => {
    const out = verify(
      buildResponse({
        nameId: "Alice.Example@CORP.example.com",
        emailAttr: null,
      }),
    );
    expect(out.email).toBe("alice.example@corp.example.com");
  });

  it("rejects an assertion with no email anywhere", () => {
    expect(codeOf(() => verify(buildResponse({ emailAttr: null })))).toBe(
      "no_email",
    );
  });
});

describe("verifySamlResponse — signature + XML-signature-wrapping (XSW)", () => {
  it("rejects an unsigned assertion", () => {
    expect(codeOf(() => verify(buildResponse({ sign: false })))).toBe(
      "assertion_not_signed",
    );
  });

  it("rejects a signature made with a different key", () => {
    expect(
      codeOf(() => verify(buildResponse({ privateKey: otherKeys.privateKey }))),
    ).toBe("signature_invalid");
  });

  it("rejects a tampered assertion (email swapped after signing)", () => {
    const signed = buildResponse();
    const tampered = signed.replace(
      "alice@corp.example.com",
      "attacker@corp.example.com",
    );
    expect(codeOf(() => verify(tampered))).toBe("signature_invalid");
  });

  it("rejects an XSW document: a second, unsigned assertion wrapped in", () => {
    // The classic attack shape — one validly signed assertion plus an injected one. We refuse
    // the document rather than trying to work out which one to read.
    expect(codeOf(() => verify(buildResponse({ extraAssertion: true })))).toBe(
      "multiple_assertions",
    );
  });

  it("rejects an XSW document assembled by splicing a signed assertion into a new Response", () => {
    const signed = buildResponse();
    const assertionStart = signed.indexOf("<saml:Assertion");
    const assertionEnd =
      signed.indexOf("</saml:Assertion>") + "</saml:Assertion>".length;
    const signedAssertion = signed.slice(assertionStart, assertionEnd);
    // Attacker's own Response, carrying the victim's signed assertion PLUS an unsigned one
    // that names a different subject. Two assertions ⇒ refused.
    const spliced = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_evil" Version="2.0" IssueInstant="${iso(
      -1,
    )}"><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${signedAssertion}${signedAssertion.replace(
      "alice@corp.example.com",
      "attacker@corp.example.com",
    )}</samlp:Response>`;
    expect(codeOf(() => verify(spliced))).toBe("multiple_assertions");
  });

  it("rejects a document with more than one Signature", () => {
    const signed = buildResponse();
    const sigStart = signed.indexOf("<Signature");
    const sigEnd = signed.indexOf("</Signature>") + "</Signature>".length;
    const dup =
      signed.slice(0, sigEnd) +
      signed.slice(sigStart, sigEnd) +
      signed.slice(sigEnd);
    expect(codeOf(() => verify(dup))).toBe("multiple_signatures");
  });

  it("rejects a response-level-only signature (the assertion itself must be signed)", () => {
    // Explicit deferral, asserted so it can't silently become a half-validated accept.
    expect(
      codeOf(() => verify(buildResponse({ signResponseInstead: true }))),
    ).toBe("assertion_not_signed");
  });

  it("rejects an EncryptedAssertion with a distinct code", () => {
    const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"><saml:EncryptedAssertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"/></samlp:Response>`;
    expect(codeOf(() => verify(xml))).toBe("encrypted_not_supported");
  });
});

describe("verifySamlResponse — conditions", () => {
  it("rejects a wrong issuer (an IdP may only speak as itself)", () => {
    expect(
      codeOf(() =>
        verify(buildResponse({ issuer: "https://evil.example/entity" })),
      ),
    ).toBe("issuer_mismatch");
  });

  it("rejects an audience that isn't us", () => {
    expect(
      codeOf(() =>
        verify(buildResponse({ audience: "https://someone-else/sp" })),
      ),
    ).toBe("audience_mismatch");
  });

  it("rejects a Recipient that isn't our ACS URL", () => {
    expect(
      codeOf(() =>
        verify(buildResponse({ recipient: "https://evil.example/acs" })),
      ),
    ).toBe("recipient_mismatch");
  });

  it("accepts a missing Recipient (optional attribute)", () => {
    expect(verify(buildResponse({ recipient: null })).email).toBe(
      "alice@corp.example.com",
    );
  });

  it("rejects an expired assertion", () => {
    expect(
      codeOf(() => verify(buildResponse({ notOnOrAfter: iso(-10) }))),
    ).toBe("expired");
  });

  it("rejects a not-yet-valid assertion", () => {
    expect(codeOf(() => verify(buildResponse({ notBefore: iso(30) })))).toBe(
      "not_yet_valid",
    );
  });

  it("allows 60s of clock skew", () => {
    const xml = buildResponse({ notOnOrAfter: iso(-0.5) }); // 30s in the past
    expect(verify(xml).email).toBe("alice@corp.example.com");
  });

  it("rejects a non-Success status", () => {
    expect(
      codeOf(() =>
        verify(
          buildResponse({
            status: "urn:oasis:names:tc:SAML:2.0:status:AuthnFailed",
          }),
        ),
      ),
    ).toBe("status_not_success");
  });
});

describe("verifySamlResponse — MFA authn context (#457 interaction)", () => {
  it("single-factor contexts do NOT count as a second factor", () => {
    for (const ctx of [
      "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport",
      "urn:oasis:names:tc:SAML:2.0:ac:classes:Password",
      "urn:federation:authentication:windows",
    ]) {
      expect(verify(buildResponse({ authnContext: ctx })).mfa).toBe(false);
    }
  });

  it("each recognised multi-factor context counts", () => {
    for (const ctx of MFA_AUTHN_CONTEXTS) {
      const out = verify(buildResponse({ authnContext: ctx }));
      expect(out.mfa).toBe(true);
      expect(out.authnContext).toBe(ctx);
    }
  });

  it("a missing AuthnContext fails CLOSED (no second factor)", () => {
    expect(verify(buildResponse({ authnContext: null })).mfa).toBe(false);
  });
});

describe("decodeSamlResponse / normalizeIdpCert / spMetadataXml", () => {
  it("decodes base64 and rejects junk", () => {
    expect(decodeSamlResponse(Buffer.from("<x/>").toString("base64"))).toBe(
      "<x/>",
    );
    expect(codeOf(() => decodeSamlResponse(""))).toBe("malformed");
    expect(codeOf(() => decodeSamlResponse("not-xml-at-all"))).toBe(
      "malformed",
    );
    expect(codeOf(() => decodeSamlResponse("A".repeat(600 * 1024)))).toBe(
      "malformed",
    );
  });

  it("wraps bare base64 metadata cert data into a PEM block, passes PEM through", () => {
    const bare = "MIIB" + "A".repeat(100);
    const pem = normalizeIdpCert(bare);
    expect(pem.startsWith("-----BEGIN CERTIFICATE-----\n")).toBe(true);
    expect(pem.trimEnd().endsWith("-----END CERTIFICATE-----")).toBe(true);
    // 64-char lines, as PEM requires
    expect(pem.split("\n")[1].length).toBe(64);
    expect(normalizeIdpCert(keys.publicKey)).toBe(keys.publicKey.trim());
    expect(codeOf(() => normalizeIdpCert("   "))).toBe("malformed");
  });

  it("emits SP metadata an IdP admin can consume", () => {
    const xml = spMetadataXml({ spEntityId: SP_ENTITY, acsUrl: ACS_URL });
    expect(xml).toContain(`entityID="${SP_ENTITY}"`);
    expect(xml).toContain(
      'Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"',
    );
    expect(xml).toContain(`Location="${ACS_URL}"`);
    expect(xml).toContain('WantAssertionsSigned="true"');
    // No secret, no private key material of any kind.
    expect(xml).not.toContain("PRIVATE");
  });
});

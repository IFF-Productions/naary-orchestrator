import { DOMParser } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";

/**
 * SAML 2.0 assertion verification (design SAML-SSO.md, #455). PURE: no DB, no Nest, no env —
 * everything it needs is an argument, so it is unit-testable against a locally signed
 * assertion.
 *
 * We do NOT hand-roll XML canonicalization: exclusive-c14n is exactly where
 * signature-wrapping bugs live, so signature checking is `xml-crypto` (pinned exactly).
 * What this module owns is the part libraries get wrong or leave to the caller: making sure
 * the signature covers THE ELEMENT WE READ CLAIMS FROM, and that every condition
 * (issuer/audience/recipient/time/status) is checked rather than assumed.
 */

const NS_ASSERTION = "urn:oasis:names:tc:SAML:2.0:assertion";
const NS_PROTOCOL = "urn:oasis:names:tc:SAML:2.0:protocol";
const NS_DSIG = "http://www.w3.org/2000/09/xmldsig#";
const STATUS_SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";

/** AuthnContextClassRefs that constitute an IdP-asserted SECOND FACTOR (#457 interaction).
 *  Anything else ⇒ single factor, so `REQUIRE_MFA` gates the session (fail closed). */
export const MFA_AUTHN_CONTEXTS = [
  "urn:oasis:names:tc:SAML:2.0:ac:classes:MultiFactorAuthentication",
  "urn:oasis:names:tc:SAML:2.0:ac:classes:MultiFactorContract",
  // Entra ID / AD FS
  "http://schemas.microsoft.com/claims/multipleauthn",
];

/** Common attribute names IdPs use for the email address. NameID is preferred when it is an
 *  email; these are the fallbacks (Okta/Entra/ADFS defaults). */
const EMAIL_ATTRS = [
  "email",
  "mail",
  "emailaddress",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  "urn:oid:0.9.2342.19200300.100.1.3",
];
const NAME_ATTRS = [
  "displayname",
  "name",
  "cn",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
  "urn:oid:2.16.840.1.113730.3.1.241",
];

/** Every rejection reason. Coarse + stable: these become the SPA's `sso_error` codes, and
 *  the detail stays in the server log (the connect-return.ts house rule). */
export type SamlRejection =
  | "malformed"
  | "encrypted_not_supported"
  | "multiple_assertions"
  | "multiple_signatures"
  | "signature_invalid"
  | "assertion_not_signed"
  | "issuer_mismatch"
  | "audience_mismatch"
  | "recipient_mismatch"
  | "expired"
  | "not_yet_valid"
  | "status_not_success"
  | "no_subject"
  | "no_email";

export class SamlError extends Error {
  constructor(
    readonly code: SamlRejection,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "SamlError";
  }
}

/** What a verified assertion tells us. Non-secret identity facts only. */
export interface VerifiedAssertion {
  /** The assertion `ID` — consumed single-use to block replay. */
  assertionId: string;
  issuer: string;
  nameId: string;
  email: string;
  name?: string;
  authnContext?: string;
  /** True iff `authnContext` is one of MFA_AUTHN_CONTEXTS. */
  mfa: boolean;
  /** The assertion's validity end (for logging/diagnostics; already enforced). */
  notOnOrAfter?: Date;
}

export interface VerifyOptions {
  /** The IdP entity id we expect in `<Issuer>` (the tenant mapping key). */
  idpEntityId: string;
  /** The IdP signing cert (PEM, bare base64 from metadata, or a public key PEM). */
  idpCertPem: string;
  /** Our SP entity id — must appear in `<AudienceRestriction>`. */
  spEntityId: string;
  /** Our ACS URL — must match `SubjectConfirmationData/@Recipient` when present. */
  acsUrl: string;
  /** Clock skew allowance. Default 60s. */
  skewMs?: number;
  /** Injectable clock (tests). */
  now?: Date;
}

/**
 * An IdP publishes its signing cert inside `<X509Certificate>` as bare base64. Accept that,
 * a full PEM block (cert or public key) — `crypto.createVerify().verify()` takes either — and
 * tolerate stray whitespace. PUBLIC key material only; nothing here is secret.
 */
export function normalizeIdpCert(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("-----BEGIN")) return trimmed;
  const body = trimmed.replace(/\s+/g, "");
  if (body.length === 0) throw new SamlError("malformed", "empty signing cert");
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
}

function elements(
  node: Document | Element,
  ns: string,
  local: string,
): Element[] {
  return Array.from(
    node.getElementsByTagNameNS(ns, local),
  ) as unknown as Element[];
}

function textOf(el: Element | undefined): string | undefined {
  const t = el?.textContent?.trim();
  return t && t.length > 0 ? t : undefined;
}

function parseTime(raw: string | null | undefined): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Verify a decoded SAML Response XML and return the identity it asserts, or throw a
 * `SamlError`. Order matters: cheap structural checks first (they are also the XSW
 * defences), then cryptography, then conditions.
 */
export function verifySamlResponse(
  xml: string,
  opts: VerifyOptions,
): VerifiedAssertion {
  const now = opts.now ?? new Date();
  const skew = opts.skewMs ?? 60_000;

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(
      xml,
      "text/xml",
    ) as unknown as Document;
  } catch {
    throw new SamlError("malformed", "unparseable XML");
  }
  if (!doc?.documentElement)
    throw new SamlError("malformed", "no document element");

  // Encrypted assertions are out of scope for this slice — say so instead of silently
  // finding zero assertions.
  if (elements(doc, NS_ASSERTION, "EncryptedAssertion").length > 0) {
    throw new SamlError("encrypted_not_supported");
  }

  // --- XSW defence 1: exactly ONE assertion and ONE signature in the whole document. ------
  // Every signature-wrapping attack is shaped "a signed thing plus an unsigned thing that
  // the reader picks up instead", so a document with two of either is refused outright
  // rather than disambiguated.
  const assertions = elements(doc, NS_ASSERTION, "Assertion");
  if (assertions.length === 0) throw new SamlError("malformed", "no assertion");
  if (assertions.length > 1) throw new SamlError("multiple_assertions");
  const assertion = assertions[0];

  const signatures = elements(doc, NS_DSIG, "Signature");
  if (signatures.length === 0) throw new SamlError("assertion_not_signed");
  if (signatures.length > 1) throw new SamlError("multiple_signatures");

  // --- Status (only present on a Response; a bare Assertion has none) --------------------
  const statusCodes = elements(doc, NS_PROTOCOL, "StatusCode");
  if (statusCodes.length > 0) {
    const value = statusCodes[0].getAttribute("Value");
    if (value !== STATUS_SUCCESS) {
      throw new SamlError("status_not_success", value ?? "missing");
    }
  }

  // --- Signature -------------------------------------------------------------------------
  const sig = new SignedXml({ publicCert: normalizeIdpCert(opts.idpCertPem) });
  sig.loadSignature(signatures[0] as unknown as Node);
  let valid = false;
  try {
    valid = sig.checkSignature(xml);
  } catch (err) {
    throw new SamlError(
      "signature_invalid",
      err instanceof Error ? err.message : "verify failed",
    );
  }
  if (!valid) throw new SamlError("signature_invalid");

  // --- XSW defence 2: the signature must cover THE ASSERTION WE READ. --------------------
  // A cryptographically valid signature over some *other* element is the entire XSW class,
  // so "checkSignature returned true" is NOT sufficient: assert this element is one of the
  // validated references. (Consequence, documented as a deferral: an IdP that signs only the
  // Response is rejected — we do not half-validate.)
  try {
    sig.validateElementAgainstReferences(assertion as never, doc as never);
  } catch (err) {
    throw new SamlError(
      "assertion_not_signed",
      err instanceof Error
        ? err.message
        : "assertion not covered by the signature",
    );
  }

  // --- Issuer (the tenant mapping key) ---------------------------------------------------
  const issuers = elements(doc, NS_ASSERTION, "Issuer");
  const issuer = textOf(issuers[0]);
  if (!issuer) throw new SamlError("issuer_mismatch", "no issuer");
  for (const el of issuers) {
    // If the Response and the Assertion both name an issuer, BOTH must be the expected IdP.
    if (textOf(el) !== opts.idpEntityId) throw new SamlError("issuer_mismatch");
  }

  // --- Audience --------------------------------------------------------------------------
  const audiences = elements(assertion, NS_ASSERTION, "Audience").map((a) =>
    textOf(a),
  );
  if (audiences.length === 0 || !audiences.includes(opts.spEntityId)) {
    throw new SamlError("audience_mismatch");
  }

  // --- Subject + SubjectConfirmationData -------------------------------------------------
  const subject = elements(assertion, NS_ASSERTION, "Subject")[0];
  const nameId = textOf(
    subject ? elements(subject, NS_ASSERTION, "NameID")[0] : undefined,
  );
  if (!nameId) throw new SamlError("no_subject");

  // The Web-Browser-SSO profile REQUIRES a bearer SubjectConfirmationData carrying both
  // Recipient and NotOnOrAfter, and we enforce that rather than treating them as optional: an
  // assertion with no bound recipient is usable at any SP, and one with no expiry is a
  // credential that never dies (our replay record is pruned after 30 min, so "reject when
  // absent" is the only thing that keeps it single-use forever).
  const scds = subject
    ? elements(subject, NS_ASSERTION, "SubjectConfirmationData")
    : [];
  let boundToUs = false;
  for (const scd of scds) {
    const recipient = scd.getAttribute("Recipient");
    if (recipient && recipient !== opts.acsUrl) {
      throw new SamlError("recipient_mismatch");
    }
    const scdNotOnOrAfter = parseTime(scd.getAttribute("NotOnOrAfter"));
    if (scdNotOnOrAfter && now.getTime() > scdNotOnOrAfter.getTime() + skew) {
      throw new SamlError("expired", "subject confirmation expired");
    }
    if (recipient === opts.acsUrl && scdNotOnOrAfter) boundToUs = true;
  }
  if (!boundToUs) {
    throw new SamlError(
      "recipient_mismatch",
      "no SubjectConfirmationData binding this assertion to our ACS with an expiry",
    );
  }

  // --- Conditions window -----------------------------------------------------------------
  const conditions = elements(assertion, NS_ASSERTION, "Conditions")[0];
  const notBefore = parseTime(conditions?.getAttribute("NotBefore"));
  const notOnOrAfter = parseTime(conditions?.getAttribute("NotOnOrAfter"));
  if (notBefore && now.getTime() + skew < notBefore.getTime()) {
    throw new SamlError("not_yet_valid");
  }
  // REQUIRED, not optional — same reasoning as the subject confirmation above.
  if (!notOnOrAfter) {
    throw new SamlError("expired", "assertion has no Conditions/@NotOnOrAfter");
  }
  if (now.getTime() - skew >= notOnOrAfter.getTime()) {
    throw new SamlError("expired");
  }

  // --- Identity attributes ---------------------------------------------------------------
  const attrs = new Map<string, string>();
  for (const attr of elements(assertion, NS_ASSERTION, "Attribute")) {
    const key = (
      attr.getAttribute("Name") ??
      attr.getAttribute("FriendlyName") ??
      ""
    )
      .trim()
      .toLowerCase();
    const value = textOf(elements(attr, NS_ASSERTION, "AttributeValue")[0]);
    if (key && value && !attrs.has(key)) attrs.set(key, value);
  }
  const isEmail = (v: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  const email =
    (isEmail(nameId) ? nameId : undefined) ??
    EMAIL_ATTRS.map((k) => attrs.get(k)).find((v) => v && isEmail(v));
  if (!email) throw new SamlError("no_email");
  const name = NAME_ATTRS.map((k) => attrs.get(k)).find((v) => !!v);

  const authnContext = textOf(
    elements(assertion, NS_ASSERTION, "AuthnContextClassRef")[0],
  );

  const assertionId = assertion.getAttribute("ID")?.trim();
  if (!assertionId) throw new SamlError("malformed", "assertion has no ID");

  return {
    assertionId,
    issuer,
    nameId,
    email: email.trim().toLowerCase(),
    name,
    authnContext,
    mfa: !!authnContext && MFA_AUTHN_CONTEXTS.includes(authnContext),
    notOnOrAfter,
  };
}

/**
 * The assertion's `<Issuer>`, read WITHOUT verifying anything — it is only a LOOKUP KEY (which
 * `SsoConnection`, hence which cert and tenant). Nothing is trusted on this basis:
 * `verifySamlResponse` re-checks the issuer against the connection it selected, so a forged
 * Issuer can only ever select a connection whose certificate will refuse the signature.
 */
export function peekIssuer(xml: string): string | undefined {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(
      xml,
      "text/xml",
    ) as unknown as Document;
  } catch {
    return undefined;
  }
  if (!doc?.documentElement) return undefined;
  return textOf(elements(doc, NS_ASSERTION, "Issuer")[0]);
}

/** Decode the base64 `SAMLResponse` form field. Rejects anything that isn't XML-ish before
 *  it reaches the parser. */
export function decodeSamlResponse(b64: string): string {
  const raw = (b64 ?? "").trim();
  if (raw.length === 0) throw new SamlError("malformed", "empty SAMLResponse");
  // A generous cap: real assertions are a few KB. Refuse a multi-MB payload outright rather
  // than canonicalizing it (an unauthenticated endpoint must not be a CPU amplifier).
  if (raw.length > 512 * 1024)
    throw new SamlError("malformed", "SAMLResponse too large");
  let xml: string;
  try {
    xml = Buffer.from(raw, "base64").toString("utf8");
  } catch {
    throw new SamlError("malformed", "not base64");
  }
  if (!xml.includes("<")) throw new SamlError("malformed", "not XML");
  return xml;
}

/**
 * SP metadata (the half an IdP admin needs to configure their side). Static, public, and
 * derived only from server config — never from a request parameter.
 */
export function spMetadataXml(opts: {
  spEntityId: string;
  acsUrl: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${escapeXml(
    opts.spEntityId,
  )}">
  <md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</md:NameIDFormat>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${escapeXml(
      opts.acsUrl,
    )}" index="0" isDefault="true"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;
}

function escapeXml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

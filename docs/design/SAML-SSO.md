# Design — SSO / SAML 2.0 (#455)

**AC:** *SP metadata + ACS endpoint; tenant maps IdP; login provisions/links a user.*

> **Testing it:** see [../sso-testing.md](../sso-testing.md) — configuration, a throwaway IdP, and the
> rejection paths worth probing.
>
> **The other half of the roadmap line:** see [LDAP-DIRECTORY.md](./LDAP-DIRECTORY.md) — why LDAP is a
> connectivity design rather than an auth one, and why the recommendation is SCIM over this SAML path
> instead of a directory sync.

Supersedes the "SSO/SAML" v1 non-goal in `PROVISIONING-MULTIUSER.md §2` (and is the piece
`APP-AUTH.md` deferred).

## Where SAML sits relative to Firebase: COEXIST, and we terminate it ourselves

Three options were on the table:

| Option | Verdict |
| --- | --- |
| Let Firebase / Identity Platform terminate SAML (`SAMLAuthProvider`) | **No.** The issue says "beyond Firebase", and it makes every enterprise IdP a Firebase-console config item — invisible to the product, unmappable to a workspace, untestable from here. |
| We terminate SAML, then mint a **Firebase custom token** (`createCustomToken`) | **No.** Needs a signing-capable service account we do not have, so the terminal step would ship permanently unverified. It also depends on Firebase's reserved-claim list to carry the MFA signal. |
| **We terminate SAML and mint our OWN session token** | **Chosen.** `jose` is already an `apps/api` dependency; the whole path — assertion → verify → `Membership` → session → guard → `Principal` — is testable locally with a self-signed assertion. |

So Firebase remains the default human identity provider and is **untouched**. SAML is a
**second identity source** for the same downstream machinery (memberships, roles, the
early-access allowlist, MFA enforcement, invitation accept-on-login).

Session token: `nrys_` + a compact JWS (HS256 over `SSO_SESSION_SECRET`), 8 h default.
Claims: `sub` (the resolved `Membership.userId`), `email`, `email_verified`, `tenant`,
`amr` (`["mfa"]` when the IdP asserted a second factor), `iss`/`aud`/`iat`/`exp`/`jti`.
`SSO_SESSION_SECRET` unset ⇒ SAML login is **off** (the ACS returns a "not configured"
redirect); nothing else changes.

The prefix matters: it is what lets the guard pick an identity source with **no reordering**
of the existing branches, exactly like `nry_` does for API tokens.

## The guard: one insertion, ordering preserved

```
@Public()          → return true                     (unchanged, still first)
nry_…              → API token principal, return     (unchanged, still second)
nrys_…             → SSO session  ─┐
otherwise          → Firebase ID token ─┴→ ONE shared downstream path:
                       early-access allowlist → REQUIRE_MFA → invitation accept-on-login
                       → memberships → active workspace → req.principal
```

`isPublic` and the `nry_` branch still return **before** the MFA claim check, which is what
keeps webhook ingress, hosted forms/chat, OAuth callbacks and signed approve/reject links
working (`MFA-ENFORCEMENT.md §Enforcement point`). The SSO branch deliberately joins the
Firebase branch *after* verification and *before* the policies, so an SSO session is subject
to the same instance-wide policies as a Firebase session — it is not a bypass.

An SSO session **never** sets `claimTenant`. The legacy claim is a transitional *owner*
grant; treating an SSO login as one would silently promote every federated user to owner.
Authority stays the `Membership` row the ACS wrote.

## Tenant → IdP mapping

The ACS POST is unauthenticated — no bearer, no `X-Workspace-Id` — so the mapping key has to
travel inside the assertion. That key is the **IdP entity ID** (`<Issuer>`):

```prisma
model SsoConnection {
  id                  String   @id @default(uuid())
  tenantId            String                      // the workspace this IdP logs into
  slug                String   @unique            // /sso/:slug/metadata + the IdP-initiated URL
  idpEntityId         String   @unique            // ← the mapping key from an anonymous ACS POST
  idpSsoUrl           String
  idpCertPem          String                      // X.509 cert (as published in IdP metadata) or a public key
  allowedEmailDomains String[]                    // REQUIRED, non-empty — see the invariant below
  defaultRole         String   @default("member")
  autoProvision       Boolean  @default(true)
  enabled             Boolean  @default(true)
  ...
}
```

`idpEntityId` is unique **instance-wide**: one IdP entity maps to exactly one workspace, so a
validly-signed assertion can never be ambiguous about which tenant it is for.

## THE SECURITY INVARIANT: an IdP may only speak for its own tenant

Cross-tenant email linking is the characteristic multi-tenant SAML vulnerability: tenant A's
IdP signs an assertion for `alice@tenant-b.com`, and a naive "find the user by email" links
into tenant B. Stated as the invariant of this feature (the way `COMPANIES.md` states
owner-authorized attach):

> Every lookup, provision and link performed by an ACS request is scoped to
> `connection.tenantId` — the tenant of the `SsoConnection` matched by the assertion's
> `Issuer` — and the asserted email's domain must be in that connection's
> `allowedEmailDomains`.

Consequences: `allowedEmailDomains` is required and non-empty (an empty list would mean "any
email", i.e. the hole itself). Membership lookup is `(tenantId, email)`, never email alone.
The `defaultRole` is the connection's, never an assertion attribute (JIT role mapping is
deferred precisely because it makes the IdP an authorization source).

But scoping the ACS is **not sufficient on its own**, and the first draft of this design was
wrong about that. Two further constraints are load-bearing:

### 1. A session is confined to one workspace

The ACS mints a session for an `email_verified` identity. Before SAML, `emailVerified === true`
could only come from Firebase, which proves *mailbox ownership*; a SAML assertion proves only
"this IdP says so". If the resulting principal were a **global** identity, a workspace's own IdP
could assert any address and every email-keyed path in the instance would honour it — invitation
accept-on-login (`acceptPendingInvitations`, historically instance-wide) and the company-member
resolution that maps an email to a `userId`. That is a cross-tenant escalation, not a scoping
nit; and *linking* makes it worse, because a linked session carries a real user's `userId`, whose
`listForUser` spans all their workspaces.

So the session carries its tenant, and the guard **confines** it:

- memberships are filtered to the session's workspace, so a linked user's other workspaces are
  invisible (and cannot be selected as the "sole membership" default);
- invitation acceptance is passed that workspace and converts only its invitations;
- the session never carries `claimTenant` (a legacy *owner* grant).

A Firebase session is NOT confined — its verified email genuinely is instance-wide authority.
The confinement is the price of accepting an IdP's word for an address.

### 2. Registering an IdP is an operator action by default

Nothing in an HTTP request can prove the registrant owns the domains they list. Left
self-service, any user who can create a workspace could register their own certificate for
`victim.com`, self-sign an assertion, and obtain a session asserting a colleague's address
(confined to their own workspace, but still writing a `Membership` row carrying someone else's
email — which the company-member email lookup would later honour). So:

- `PUT /tenants/:id/sso` requires `SSO_SELF_SERVICE=true` — **default off**;
- the default path is the operator CLI `apps/api/src/sso/register-sso-connection.ts`, run after
  checking the domain claim;
- reads and deletes stay owner/admin — neither can widen who may sign in.

A future domain-ownership proof (a DNS TXT challenge) is what would make self-service safe by
default; that is deferred, and the flag exists so an operator can opt in knowingly.

**Known residual, and the second reason registration is operator-gated.** A Membership row written
by an SSO login carries an **IdP-asserted** email. `CompanyService`'s member resolution looks an
email up across the whole instance (`membership.findFirst({ email }, orderBy: { createdAt: desc })`),
so such a row — being the newest — would be picked ahead of the real person's when a company owner
later adds that address. Session confinement does not fix this, because it constrains what a
session can *reach*, not what the ACS *writes*. With registration gated (`SSO_SELF_SERVICE` off,
CLI otherwise), asserting a foreign domain requires an operator to have configured it, which is the
containment. Making that email→userId lookup company-scoped is the real fix and belongs with the
Companies work, not here.

## Assertion validation

In `apps/api/src/sso/saml.ts` (pure functions — no DB, no Nest), using `xml-crypto`
(CJS, pinned exactly) + `@xmldom/xmldom`. Rolling our own XML canonicalization was rejected:
exclusive-c14n is where signature-wrapping bugs live.

1. **Exactly one** `<Assertion>` in the document, and **exactly one** `<Signature>`. More than
   one of either is rejected outright — that is the shape of every XML-signature-wrapping
   (XSW) attack.
2. `checkSignature` against the connection's cert, **then**
   `validateElementAgainstReferences(assertionEl, doc)` — the signature must cover *the very
   element the claims are read from*. A valid signature over some *other* element is the
   whole XSW class, so verifying "a signature is valid" is not enough.
3. `Issuer` (Response and Assertion, when present) equals `connection.idpEntityId`.
4. `Audience` equals our SP entity ID; `SubjectConfirmationData/@Recipient`, when present,
   equals our ACS URL.
5. Time window: `Conditions/@NotOnOrAfter` is **required** (≤ now ≤ it, 60 s skew), `NotBefore`
   is honoured when present, and a bearer `SubjectConfirmationData` binding this assertion to
   our ACS (`Recipient` == our ACS URL) **with** a `NotOnOrAfter` is required. Both are
   mandatory rather than "checked if present" on purpose: an unbound assertion is usable at any
   SP, and one with no expiry is a credential that never dies — our replay record is pruned
   after 30 minutes, so rejecting the absence is what keeps single-use meaningful.
6. `Status` is `urn:oasis:names:tc:SAML:2.0:status:Success`.
7. **Replay**: the assertion `ID` is consumed single-use through the existing `SecretStore`,
   keyed `saml:<sha256(id)>`. The write is `putIfAbsent` — a unique-constrained INSERT, not a
   read-then-write: two concurrent POSTs of the same assertion must not both see "unseen" and
   both mint a session, so the DB decides the race. Consumed *after* the policy checks (a
   `mfa_required` refusal must not burn the id) and *before* any membership write. No new table;
   `prunePrefixOlderThan` for hygiene.

Rejections are coarse to the browser (a redirect with an error code) and detailed only in the
server log — the `connect-return.ts` house rule for browser-facing callbacks.

## Does an IdP-asserted second factor satisfy `REQUIRE_MFA`?

**Yes, if and only if the assertion says so; otherwise no.**

`AuthnStatement/AuthnContext/AuthnContextClassRef` is the SAML statement of *how* the user
authenticated. These count as a second factor:

- `urn:oasis:names:tc:SAML:2.0:ac:classes:MultiFactorAuthentication`
- `urn:oasis:names:tc:SAML:2.0:ac:classes:MultiFactorContract`
- `http://schemas.microsoft.com/claims/multipleauthn` (Entra ID)

When one is present the session carries `amr: ["mfa"]`, and `secondFactorFromClaims()` — the
**existing** `#457` helper, which already filters an OIDC `amr` array — reports a second
factor. So `REQUIRE_MFA` is satisfied with **no change to the enforcement line in the guard**.

When it is absent, the session has no second factor and `REQUIRE_MFA` 403s it with
`mfa_required` — identical treatment to a single-factor Firebase session. Fail closed: we do
not assume "the IdP surely does MFA", and there is no per-connection "trust this IdP's MFA"
override in this slice.

## Both instance policies are re-asserted at the ACS

The ACS route is `@Public()` (an IdP POST carries no bearer), so it bypasses the guard —
including `ACCESS_ALLOWED_EMAILS` and `REQUIRE_MFA`. Provisioning a `Membership` while the
instance is in early-access lockdown would be a real hole, so the ACS re-checks **both**
before any write:

| Policy | At the ACS | Per request |
| --- | --- | --- |
| `ACCESS_ALLOWED_EMAILS` | asserted email must be listed, else `access_not_allowed` — **before** any membership write | guard, unchanged |
| `REQUIRE_MFA` | no MFA authn context ⇒ no session minted, no membership write | guard, unchanged |

Defence in depth: even if a session were minted some other way, the guard re-checks on every
request.

## Provisioning / linking

In order, all scoped to `connection.tenantId`:

1. **Link** — an existing `Membership(tenantId, email)` ⇒ reuse **its** `userId` as the
   session `sub`. A user who signed up with Firebase and is later federated keeps one identity,
   one membership and their existing role.
2. **Invitation** — no membership, but the SSO identity is `email_verified`, so the guard's
   existing accept-on-login converts a pending `Invitation` on the first request.
3. **Auto-provision** — `autoProvision` (default on) ⇒ `ensureMembership(ssoUserId, tenantId,
   connection.defaultRole, email)`, where `ssoUserId` is `sso:<connectionId>:<sha256(nameId)>`
   — deterministic, collision-free against Firebase uids, and it never reveals the NameID.
4. Otherwise `sso_no_membership` — fail closed.

## Endpoints

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /sso/metadata` | `@Public` | SP metadata XML: our entity ID, the ACS URL (HTTP-POST binding), NameIDFormat |
| `POST /sso/saml/acs` | `@Public`, throttled | the assertion consumer; 302s back to the SPA with a one-time-use session in the URL **fragment** |
| `GET /sso/:slug` | `@Public` | IdP-initiated convenience redirect to `idpSsoUrl` |
| `GET/DELETE /tenants/:id/sso` | owner/admin | read + remove the tenant→IdP mapping (nothing in it is secret) |
| `PUT /tenants/:id/sso` | owner/admin **and** `SSO_SELF_SERVICE=true` | register a mapping; default off, operator CLI instead |

The redirect target is always **server-derived** (`appBaseUrl()`), never a request parameter —
the `connect-return.ts` open-redirect rule. `RelayState` is deliberately **not** echoed.

The session lands in the fragment (`#sso_token=…`), not the query: fragments are not sent to
servers, so the token stays out of access logs, referrers and proxy logs. A one-time-code
exchange (the strictly better option, since the fragment persists in browser history) is
listed as deferred.

## Testing

- `apps/api/test/saml.spec.ts` — assertion validation against a **locally generated, really
  signed** assertion (RSA keypair minted in-test, signed with `xml-crypto`): happy path,
  tampered assertion, wrong signing key, **XSW fixture** (a second unsigned assertion wrapped
  in), two-signature document, wrong issuer/audience/recipient, expired / not-yet-valid,
  non-Success status, missing MFA context vs. each MFA context value.
- `apps/api/test/sso.service.spec.ts` — link vs. auto-provision vs. invitation vs. refusal;
  **cross-tenant email refusal** (the invariant); disallowed domain; replay refusal; the two
  instance policies at the ACS; disabled connection.
- `apps/api/test/sso-connections.controller.spec.ts` — self-service is refused by default and
  works when opted in; a member and an `nry_` token cannot configure SSO; an empty domain list is
  refused; entity-id and slug cannot be stolen from another workspace; delete and list are
  tenant-scoped.
- `packages/secrets/test/secret-store.spec.ts` — `putIfAbsent` is atomic (5 concurrent writers,
  exactly one winner), which is the replay guarantee.
- `packages/secrets/test/rotate.spec.ts` — the master-rotation sweep skips external
  (`keyVersion 0`) rows instead of reporting them as failures.
- `apps/api/test/sso-session.service.spec.ts` — mint/verify round trip, `amr` → `secondFactor`,
  expiry, tampering, wrong secret, disabled when unconfigured, and that the token body carries
  no secret material.
- `apps/api/test/auth.guard.spec.ts` — the new branch (13 cases): an SSO session authenticates a
  user and resolves a `Principal`; it works with Firebase **disabled**; ordering is unchanged
  (`@Public` and `nry_` still short-circuit before any SSO work, and an unprefixed bearer still
  goes to Firebase); an SSO session is subject to the allowlist and `REQUIRE_MFA`; an
  IdP-asserted factor satisfies it; a rejected session is 401; no membership ⇒ 403 with no
  implicit owner backfill; cross-workspace access still 403s.
- `apps/api/test/sso.controller.spec.ts` — a REAL HTTP round trip against a minimal Nest app:
  that the **form-urlencoded** `SAMLResponse` body actually parses (a property of the HTTP
  stack, not the controller), that the session lands in the **fragment**, that `RelayState` is
  ignored, that every rejection is a coarse 302 (no 500, no detail), and that `/sso/metadata`
  is not swallowed by the `:slug` route.
- `apps/api/test/auth-guard-di.spec.ts` — extended: the eager `APP_GUARD` must still resolve
  now that it has a third cross-`@Global` dependency (`SsoSessionService`). Without this, a
  missing `SsoModule` would only surface as a boot failure in production.

**Not verified:** no live IdP round trip was performed — no Okta, Entra, Google Workspace or
ADFS instance was contacted. Every assertion in the test suite is generated and signed
locally. What is proven is our *verification* logic against a real XML-DSIG signature; what is
not proven is compatibility with a specific IdP's XML dialect (namespace prefixes, whitespace,
whether it signs the response instead of the assertion), which only a live round trip settles.

## Deferred (explicitly NOT in this slice)

- **SP-initiated flow** (`AuthnRequest`, `InResponseTo` correlation, signed requests). This
  slice is **IdP-initiated only** — the user starts at the IdP dashboard or `/sso/:slug`.
- **Response-level-only signatures.** We require the *assertion* to be signed (what Okta and
  Entra do by default). A response-signed-only IdP is rejected rather than half-validated.
- **Encrypted assertions** (`EncryptedAssertion`) — rejected with a clear code.
- Single Logout (SLO), IdP **metadata XML import** (fields are entered explicitly), signing-key
  rollover (one cert per connection), SCIM provisioning / de-provisioning, JIT role or group
  mapping from assertion attributes, per-connection "trust this IdP's MFA", enforcing
  "SSO-only" (blocking password login for a federated domain), and the SPA screens for
  managing a connection.
- Replacing the fragment hand-off with a one-time-code exchange.
- **Domain-ownership verification** (a DNS TXT challenge), which is what would make
  `SSO_SELF_SERVICE` safe to default on.
- **The SPA side.** The ACS redirects to `${APP_BASE_URL}/app#sso_token=…&workspace=…`, but no
  web code reads that fragment yet, so a federated login does not *complete in the browser* in
  this slice — the API half is what shipped. The follow-up is small (read the fragment, store
  the bearer the same way the Firebase token is stored, strip it from the URL) but it is web
  work with its own screens, and bundling it would have made this slice unverifiable end to end.

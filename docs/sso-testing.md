# Testing SAML SSO

How to exercise SAML single sign-on end to end against a real identity provider.

> **Why this doc exists.** SAML is implemented and unit-tested, but every test so far has run against
> **locally signed** assertions — the code has never met a live IdP. `deploy/.env.prod.example` says so
> too. The point of this guide is that first real run, so use it expecting to find something.

**LDAP is not implemented.** It appears in `docs/ROADMAP-ENTERPRISE.md` as a planned XL item ("SSO SAML
& LDAP") and in the n8n catalog as `status: 'planned'`, and nowhere in the code. There is nothing to
test yet — see [What LDAP would take](#what-ldap-would-take) at the end.

---

## What's implemented

| | |
| --- | --- |
| **Protocol** | SAML 2.0, HTTP-POST binding, **IdP-initiated** — we consume assertions, we never generate an `AuthnRequest` |
| **Identity source** | A *second* one alongside Firebase — not a replacement |
| **Session** | An `nrys_`-prefixed compact JWS (HS256 over `SSO_SESSION_SECRET`) the ACS hands the browser |
| **Per-workspace** | Each workspace maps its own IdP; a connection is matched by the assertion's `Issuer` |
| **Not supported** | Encrypted assertions (`encrypted_not_supported`), SLO, and `AuthnRequest` generation (so no `InResponseTo` to correlate) |

Three public routes (`@Public()`, since an IdP POST carries no bearer):

| Route | Purpose |
| --- | --- |
| `GET /sso/metadata` | The XML your IdP admin imports: entity id, ACS URL, NameID formats |
| `GET /sso/:slug` | **Convenience redirect** to the IdP's SSO URL. It does NOT generate an `AuthnRequest` — it just sends the browser to the IdP, which then posts an unsolicited assertion to the ACS |
| `POST /sso/saml/acs` | Assertion Consumer Service — where the IdP posts back |

## 1. Turn it on

All three are required. With any missing, `/sso/metadata` answers **503** and no SAML login can
complete — that's the fastest way to confirm your config was actually picked up.

```bash
# on the box: /opt/naary/.env
SSO_SESSION_SECRET=$(openssl rand -hex 32)   # 32+ chars; a shorter value is REFUSED and SSO stays off
SSO_SP_ENTITY_ID=https://api.naar-y.com/sso/metadata
SSO_ACS_URL=https://api.naar-y.com/sso/saml/acs
SSO_SESSION_TTL_SECONDS=28800                # optional
```

`SSO_SP_ENTITY_ID` and `SSO_ACS_URL` are **explicit, never derived from the request Host** — they're the
audience and recipient we verify, so deriving them would mean verifying against whatever an attacker
sent. They must match what the IdP admin enters, character for character.

Restart the api, then:

```bash
curl -s https://YOUR-HOST/api/sso/metadata | head -20   # 503 ⇒ config not picked up
```

## 2. Pick a test IdP

**Option A — mock-saml (fastest, no infra).** [mocksaml.com](https://mocksaml.com) is a hosted test IdP.
Good for a first smoke test; don't use it with anything real, since you're handing assertions to a third
party.

**Option B — Keycloak in Docker (realistic, offline).** Preferable for anything beyond a smoke test:
you control the certificate, can edit claim mappings, and can deliberately break things to test the
rejection paths in step 5.

```bash
docker run -p 8081:8080 \
  -e KEYCLOAK_ADMIN=admin -e KEYCLOAK_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:26.0 start-dev
```

Then in Keycloak: create a realm → **Clients → Create client → SAML** → set the client ID to your
`SSO_SP_ENTITY_ID` and *Valid redirect URIs* / ACS to your `SSO_ACS_URL`. Add a user with an email, and
export the realm's signing certificate (**Realm settings → Keys → RS256 → Certificate**).

## 3. Register the workspace's connection

**As an operator** (the default, and the safer path — you check the domain claim yourself first):

```bash
docker compose exec api node -r @swc/register src/sso/register-sso-connection.ts \
  <tenantId> <slug> <idpEntityId> <idpSsoUrl> <certFile> <domain[,domain…]> [role]
```

- `slug` — what appears in the login URL (`/sso/<slug>`).
- `idpEntityId` — must equal the assertion's `Issuer` exactly; that's how the connection is matched.
- `certFile` — the IdP's signing certificate (PEM).
- `domain[,domain…]` — **the security boundary.** See below.

**Self-service** (`PUT /tenants/:id/sso`, owner/admin) requires `SSO_SELF_SERVICE=true`. Only enable
that if you accept that a workspace admin can declare which email domains their own certificate is
allowed to assert.

> ### The domain allowlist is the multi-tenant invariant
> An IdP may only speak for domains its connection allows. Without it, tenant A's IdP could assert
> `alice@tenant-b.com` and link into tenant B. An empty list allows **nothing** — a connection with no
> domains can't log anyone in, deliberately.

## 4. Walk the flow

1. `GET /api/sso/metadata` → hand the XML to the IdP admin (or import it into Keycloak).
2. Visit `https://YOUR-HOST/api/sso/<slug>` → you should be redirected to the IdP. This is a plain
   redirect, **not** an `AuthnRequest`, so configure the IdP for **IdP-initiated** SSO — in Keycloak
   that means setting the client's *IDP Initiated SSO URL Name*; you can equally start from the IdP's
   own application launcher and skip this URL entirely.
3. Log in as your test user.
4. The IdP POSTs to `/sso/saml/acs`.
5. On success you land back in the SPA with an `nrys_` session and should see your workspace.

**Confirm the session is real, not just a redirect that looked right:**

```bash
# the SPA stores it as its bearer; grab it from devtools → Application → Local Storage
curl -s -H "Authorization: Bearer nrys_…" https://YOUR-HOST/api/me
# → { "tenantId": "…", "subject": "sso:<connId>:<hash>", "isOperator": false }
```

A `subject` of `sso:<connectionId>:<hash>` is the tell that you came in via SAML — it's derived from a
hashed NameID, so the same person gets the same stable id on every login.

> **Use a `persistent` or `emailAddress` NameID format, not `transient`.** A transient NameID is a fresh
> value per login by design, so it can't be a stable identity — you'd get a new user on every sign-in.

## 5. Then try to break it

This is the part worth your time — the happy path mostly proves the redirect works. Each of these has a
distinct rejection code (surfaced to the SPA as `sso_error`, with detail in the server log):

| Try this | Expect |
| --- | --- |
| Change `SSO_SP_ENTITY_ID` so it no longer matches the IdP's audience | `audience_mismatch` |
| Point the IdP's ACS at a different URL than `SSO_ACS_URL` | `recipient_mismatch` |
| Sign with a different certificate than the one registered | `signature_invalid` |
| Strip the signature from the assertion | `assertion_not_signed` |
| **Replay** a captured assertion a second time | rejected — assertion ids are consumed single-use, atomically |
| Log in with a user whose email domain isn't in the allowlist | `email_domain_not_allowed` |
| Let the assertion's time window expire before posting it | `expired` / `not_yet_valid` |
| Post an assertion nobody asked for (there is no `AuthnRequest` to correlate) | **accepted** — that's the IdP-initiated model; replay protection is the assertion-id single-use check, not `InResponseTo` |
| Enable assertion encryption at the IdP | `encrypted_not_supported` |

The two worth doing carefully, because they're the ones a subtle bug would hide in:

- **Replay**, because single-use enforcement runs *before* any membership write — so a replayed
  assertion must not be able to create or re-link a user.
- **Signature wrapping (XSW)**: a document with a signed element *plus* an unsigned one carrying the
  claims we actually read. The code defends by requiring exactly one assertion and one signature, and by
  checking the signature covers the element the claims are read from. If you can get a wrapped document
  accepted, that's a serious finding.

## 6. Interactions to check

- **Firebase coexistence** — a Firebase user in the same workspace must still log in normally. SAML is
  an *additional* source, not a replacement.
- **`ACCESS_ALLOWED_EMAILS`** — a SAML user outside the allowlist must be refused. SAML is not a policy
  bypass.
- **`REQUIRE_MFA`** — a SAML session counts as two-factor **only** if the IdP asserts a multi-factor
  `AuthnContextClassRef`. Test both: with and without, and confirm the without case is challenged.
- **Membership** — a first-time SAML user should land in the connection's tenant with the role the
  connection specifies (default `member`), not as an owner.

## What LDAP would take

Not implemented, so there's nothing to test. For scoping (it's an XL roadmap item):

- A directory **sync** rather than a login redirect — LDAP/AD is a queried directory, so it means a
  scheduled or on-demand sync of users and groups, not an assertion arriving at an ACS.
- A bind credential per connection, encrypted at rest like every other tenant secret (Tier-1 §4), plus
  the same domain-claim invariant SAML has so one tenant's directory can't assert another's users.
- A mapping from LDAP groups onto the existing permission groups, which is where it composes with the
  RBAC work rather than duplicating it.
- Either LDAPS or StartTLS enforced, with certificate validation on by default.

The realistic shortcut, if the need is "our IdP is AD": most AD deployments front SAML via ADFS or Entra
ID, which the SAML path above already covers. Worth confirming that isn't sufficient before building a
directory sync.

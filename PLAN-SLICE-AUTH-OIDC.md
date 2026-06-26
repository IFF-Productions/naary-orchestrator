# PLAN — Auth via Keycloak (OIDC) for human users; API tokens for service-to-service

> Replaces the prototype "paste an API token" UX (PR #11/#13) with real **OIDC login
> through Keycloak**, and uses the authenticated session to fix **OAuth callback
> session-binding (Sec#3)**. API tokens stay for service/automation; webhook HMAC is
> unchanged. Recommendation: **yes, Keycloak** — it's a standard self-hostable OIDC IdP,
> runs in the existing docker-compose, and gives login + sessions + (later) RBAC without
> us building an identity store.

---

## 1. Why this shape

- Today: a global `AuthGuard` resolves `tenantId` from a hashed bearer **API token**.
  Good for services/CLI/webhook-senders; wrong UX for human users (pasting tokens).
- Keycloak issues **OIDC JWTs** after a browser login (Authorization Code + PKCE). The
  API verifies the JWT (issuer + audience + signature via JWKS) and derives `tenantId`
  from a claim. This is the "real login" the web app's Auth screen wants.
- **Dual auth, one guard:** accept EITHER a valid Keycloak JWT (humans) OR an API token
  (services). `/hooks/*` stays HMAC; the OAuth redirect stays public but its `state` is
  now bound to the Keycloak session (Sec#3).

## 2. The decision that shapes everything — tenant ↔ Keycloak mapping

Pick one (this is the main thing I need from you):
- **A — Claim on the user** (recommended to start): a `tenant` claim (or `organization`)
  mapped into the token; `tenantId = token.tenant`. Simple; one realm; users can belong
  to one tenant. Good for a first cut.
- **B — Keycloak Groups/Organizations**: model tenants as groups/orgs; derive `tenantId`
  from the group/org claim. Supports a user in multiple tenants + admin tooling, more setup.
- **C — Realm per tenant**: strongest isolation, heaviest ops (a realm each). Overkill now.

## 3. Scope

**Build:**
- Keycloak **docker-compose** service + a seed realm/client (a `naary` realm, a public
  SPA client for the web app, the `tenant` claim mapper) — committed as config/import JSON.
- API: an **OIDC verifier** (verify RS256 via the realm JWKS; check `iss`/`aud`/`exp`)
  and a guard that accepts a Keycloak JWT **or** an API token, attaching the same
  `req.principal = { tenantId, subject }`. `tenantId` from the chosen mapping (§2).
- **Sec#3 fix:** bind OAuth consent `state` to the authenticated principal; `/oauth/start`
  requires a logged-in user, and `completeConsent` verifies the state's principal (+ keep
  the 10-min TTL already shipped). The public callback validates state, not a tenant prefix.
- Web app: **OIDC login** (Authorization Code + PKCE via `keycloak-js`/`oidc-client-ts`);
  store the access token, attach it as the bearer; refresh on expiry. The Auth screen's
  "Sign in" becomes a Keycloak redirect; keep the "paste API token" path as a dev/service
  fallback.

**Out of scope:** full RBAC/roles + per-approval permissions (a follow-up; the Team
screen models it as mock today), SCIM/user provisioning, social-login federation.

## 4. Tasks
- **T1** Keycloak service in docker-compose + exported realm JSON (realm, SPA client,
  `tenant` mapper, a demo user). Boot + log in via the Keycloak UI.
- **T2** API OIDC verifier (`jose` + JWKS cache) + dual `AuthGuard` (JWT or API token →
  principal). Unit tests: valid JWT → principal; bad sig/iss/aud/exp → 401; API token
  path still works; `/hooks/*` + callback exempt.
- **T3** `tenantId` from the chosen mapping (§2) + 403 on a `/tenants/:id/*` mismatch
  (same rule as today).
- **T4** Sec#3: session-bound OAuth `state` (require auth on `/oauth/start`; verify the
  principal on `completeConsent`).
- **T5** Web app OIDC login + token attach/refresh; Auth screen → Keycloak; keep the
  token-paste fallback. Verify end-to-end: log in → live Runs call succeeds (no 401).

## 5. Verification
- `tsc -b` clean; existing tests green; new guard/verifier unit tests.
- Live: Keycloak up; web login yields a JWT the API accepts; an expired/forged JWT → 401;
  an API token still works; cross-tenant still 403; the OAuth consent state is rejected if
  the session principal doesn't match.

## 6. Dependencies / decisions to confirm
1. **Tenant mapping (§2)** — A, B, or C.
2. **Keep API tokens for service/automation?** (recommended yes — webhook senders, CLI,
   CI). The guard accepts both.
3. **Keycloak hosting** — local docker-compose now; managed (e.g., on the AWS-now path)
   later. The verifier only needs the issuer URL + JWKS, so hosting is swappable.

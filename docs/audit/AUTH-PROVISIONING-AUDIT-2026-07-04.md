# Auth / Tenant-Provisioning Audit — naary-orchestrator

**Date:** 2026-07-04
**Scope:** the trust boundary the main audit flagged as outranking everything —
how a caller is assigned a `tenantId`, and whether a user can self-assign or
cross-assign one. Covers `apps/api/src/auth/*`, the tenant-scoped controllers, the
`members` path, and the web `AuthProvider`. Findings confirmed by reading code **and**
live requests against the running stack.

## TL;DR

**The provisioning trust boundary is sound.** There is **no self-service path** to a
tenant: both mechanisms that grant one are operator-only CLIs gated on the service
account / DB. A new user with no tenant is rejected (401), not auto-provisioned.
Cross-tenant access is denied — **verified live** (a `t-alice` token gets `403` on
`t-bob`'s routes, for both read and self-add). The client is never trusted for its
tenant. One **deployment-fragility** issue was found in the guard and **fixed in this
PR**.

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| P-1 | **Med (latent)** | Guard's cross-tenant check keyed off `path.startsWith("/tenants/")` — a global prefix would silently disable isolation for all 8 tenant-scoped controllers | **Fixed (this PR)** |
| P-2 | Info | New Firebase user with no `tenant` claim → 401; provisioning is manual (CLI). Secure, but confirm the SPA handles the "no tenant yet" state as UX, not an error loop | Note |
| P-3 | Info | `@TenantId()` falls back to `""` if principal is unset — unreachable (guard 401s first); an empty scope is no-rows, not a cross-tenant leak | Note |

## How a tenant is granted (both operator-only)

1. **Firebase `tenant` custom claim** — set ONLY by `set-tenant-claim.ts`, a CLI
   requiring the Firebase **service account** (`FIREBASE_SERVICE_ACCOUNT_JSON` /
   `GOOGLE_APPLICATION_CREDENTIALS`). `setCustomUserClaims` appears **nowhere** in a
   request-handling path (grep-confirmed), and the script is not imported by any
   route. Firebase custom claims are **server-set only** — a client cannot forge them,
   and the ID token is signature/issuer/audience/expiry/revocation-verified by
   `firebase-admin` before the claim is read (`firebase-verifier.ts`). A token with a
   missing/empty tenant claim → `principalFromClaims` returns null → 401.
2. **`nry_` API token** — minted ONLY by `mint-token.ts` (CLI); `ApiTokenService.mint`
   has no other caller. Tokens are stored sha256-hashed; the bearer is hashed and
   looked up to a `tenantId`.

**No signup / onboarding / create-tenant / auto-provision endpoint exists.** The
`members` controller (`/tenants/:id/members`) is a **cosmetic directory** — `add()`
upserts a `Member` row and grants **no** authentication (it sets no claim, mints no
token). Adding yourself to a tenant's member list does not let you authenticate as it.

## Cross-tenant enforcement — verified live

The `AuthGuard` resolves `principal.tenantId` from the verified token (never the
path/body) and rejects a `/tenants/:id/...` request whose path tenant ≠ token tenant.
Confirmed against the running API with two minted tokens:

```
alice → GET  /tenants/t-alice/members   → 200   (own)
alice → GET  /tenants/t-bob/members     → 403   Tenant mismatch
alice → POST /tenants/t-bob/members     → 403   (cannot self-add cross-tenant)
(no token) → /tenants/t-alice/members   → 401
```

The 8 controllers under `/tenants/:id/*` (settings, credentials, usage, schedules,
connections, members, webhooks, budget) rely on this check; the rest
(`executions`, `graphs`, `templates`, `me`) self-scope by `principal.tenantId` via
`@TenantId()` — safe irrespective of the path (matches the main audit's "no IDOR").

## P-1 (fixed) — path-prefix bypass of the tenant check

**Before:** `if (path.startsWith("/tenants/") && req.params?.id && …)`. Correct in the
current deploy (no `setGlobalPrefix`; nginx strips `/api` via a trailing-slash
`proxy_pass`, so the API sees `/tenants/...`). But **fragile**: a future
`app.setGlobalPrefix("api")` — or any ingress that forwards the prefix — makes the
path `/api/tenants/...`, `startsWith("/tenants/")` is **false**, and the mismatch
check is **silently skipped for all 8 tenant-scoped controllers at once**. The failure
mode is total tenant-isolation loss from a one-line config change, with no test
catching it (the unit test hard-codes `path: "/tenants/..."`).

**Fix (this PR):** extract the tenant segment by pattern —
`/(?:^|\/)tenants\/([^/]+)/` — which matches regardless of any prefix and does not
depend on `req.params` being populated. Added guard tests: a cross-tenant request
**under an `/api` prefix still 403s**, and a non-tenant route (`/executions/:id`,
whose `:id` is a workflowId) is correctly **not** subjected to the tenant check.
Live-verified: `t-alice`→`t-bob` still 403; `/executions` still 200.

## Not in scope / residual

- **Firebase console / Google project** posture (who holds the service account, break-glass, key rotation) — an ops concern outside the code.
- **`@TenantScoped()` decorator model** — the pattern fix removes the prefix trap; a
  metadata-marker approach (enforce when a controller opts in, fail-closed) would be
  even more robust and is the natural next step if the route surface grows. Tracked,
  not required now.

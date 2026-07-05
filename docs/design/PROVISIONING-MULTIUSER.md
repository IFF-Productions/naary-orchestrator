# Design — Self-Serve Provisioning + Multi-User Workspaces

**Status:** proposed (awaiting sign-off before implementation)
**Author:** — · **Date:** 2026-07-04
**Decisions locked:** multi-workspace membership · role/membership resolved from a
**cache** (in-memory or Redis), not the token claim.
**Why a design doc first:** the tenant-provisioning path is the audit's **#1 trust
boundary** (`docs/audit/AUTH-PROVISIONING-AUDIT-2026-07-04.md`). The security model has
to be right on paper before a line is written.

---

## 1. Current state (grounded)

- **Tenant = workspace.** Access is granted ONLY by the Firebase `tenant` custom claim.
  `principalFromClaims` (`apps/api/src/auth/firebase-verifier.ts:36-41`) reads
  `claims["tenant"]` → `{ tenantId, subject }`; **no claim → `null` → 401**.
- The claim is set **CLI-only** (`set-tenant-claim.ts`, service account). The API only
  *verifies* ID tokens; it never sets a claim.
- **Members are cosmetic** — `MembersService.add` upserts a row and grants no auth.
- `AuthGuard` rejects a `/tenants/:id/...` request whose **path tenant ≠ token tenant**.

**The model is single-tenant-per-token.** Moving to multi-workspace means the token can
no longer carry *the* tenant — see §3.

## 2. Goals / non-goals

**Goals (v1)**
- A new user signs up → creates their OWN workspace → is the owner, no operator.
- A user can belong to **several** workspaces and **switch** between them.
- An owner/admin invites teammates by email → they log in and act, with a role.
- Roles gate destructive actions (owner > admin > member).

**Non-goals (v1)** — org hierarchy, SSO/SAML, per-resource ACLs, billing/plan gating,
nested teams.

## 3. The trust model (the crux) — membership is the authority

Because a user belongs to **many** workspaces, the Firebase token no longer names a
tenant. Instead:

- **The token authenticates the USER** — verified ID token → `{ userId (uid), email,
  email_verified }`. No `tenant` claim is consulted for multi-workspace users.
- **Membership is the authority** — a `Membership { userId, tenantId, role }` row is the
  ONLY thing that grants access to a workspace. Stored in Postgres, **resolved per
  request through a cache** (§6).
- **The active workspace is chosen per request** — via an `X-Workspace-Id` header (SPA
  sends the selected workspace) or, for `/tenants/:id/...` routes, the path id.
- **The guard's #1 check (new):** on every workspace-scoped request, verify the user has
  a Membership in the active workspace, and load their role — **from the cache**. No
  membership → **403**. This *replaces* the old "path tenant == claim tenant" check.

So there is no ambient tenant on the token; every request proves membership in the
workspace it targets.

### The two paths that create a Membership (still the security-critical writes)

**Path A — Create workspace.** An authenticated user calls `POST /workspaces`.
- Server generates a **fresh random `tenantId`** (never from the body).
- Creates a `Membership { userId, tenantId, role: "owner" }` + default rows.
- **Gate:** `email_verified === true`. (No "must have no tenant" rule anymore — a user
  MAY own several workspaces.)

**Path B — Accept invitation.** Owner/admin creates an `Invitation { tenantId, email,
role, tokenHash, expiresAt }`; invitee calls `POST /invitations/:token/accept`.
- **Gates:** token is high-entropy, **single-use**, **expiring** (sha256-hashed); the
  accepting user's **`email_verified` is true AND their token email == the invite email**
  (the token alone is not enough — you must be the intended recipient).
- On success: create the `Membership` with the invite's role; mark accepted.

### Why this is safe (attack scenarios)
| # | Attack | Defense |
|---|--------|---------|
| 1 | Target a workspace you're not in via `X-Workspace-Id` | Guard verifies a **Membership** for (user, active tenant) — 403 if none. **The core check.** |
| 2 | Create a workspace with a chosen `tenantId` | Body ignored; `tenantId` is server-random |
| 3 | Stranger with a leaked invite token accepts | Verified email must equal the invite email |
| 4 | Member escalates their own role | `RolesGuard` (admin+ to manage members); can't set a role ≥ your own |
| 5 | Removed member keeps acting | Removal deletes the Membership **and busts the cache** → access revoked **immediately** (no ≤1h token window — the token was never the authority) |
| 6 | `email_verified=false` user creates/accepts | Both paths require `email_verified` |
| 7 | Stale cache serves a revoked membership/role | Every membership/role write **invalidates** the (user,tenant) cache key; short TTL is a backstop |

**Note this is *stronger* than the claim model:** revocation is immediate (cache bust),
not bounded by the ID-token lifetime.

## 4. Auth changes

- **`AuthGuard`** → resolves the **user** from the verified token (`{ userId, email,
  email_verified }`), reads the active workspace (`X-Workspace-Id` header or `:id` path),
  and resolves `(userId, tenantId) → role` via the **MembershipCache** (§6). Attaches
  `principal = { userId, email, tenantId, role }`. No membership → 403.
- **`@TenantId()`** now returns the validated **active** workspace id (unchanged call
  sites — it still yields a tenantId, now membership-checked).
- **Backward-compat / migration:** existing `tenant`-claim users are migrated to a
  `Membership` row (one-time backfill from the claim, or on first login: if a token has a
  `tenant` claim and no Membership yet, create an owner Membership for it). The CLI stays
  as break-glass and simply writes a Membership going forward.
- **No token refresh needed on role/membership change** — authority is the cache/DB, not
  the claim. (This is the payoff of the cache model.)

## 5. RBAC

- Roles: `owner` > `admin` > `member`.
- `@Roles("admin")` + `RolesGuard` reading `principal.role` (already loaded by the guard
  from the cache — no extra read).
- **Gating:** manage members/invites, save/rotate provider keys, delete connections,
  change budget, delete a workflow, delete the workspace → **admin+** (delete-workspace /
  transfer-ownership → **owner**). Create/edit/run/approve → **member+**.

## 6. Data model + the cache

- **`Membership`** (new, replaces the cosmetic `Member` as the authority):
  `{ id, userId, tenantId, role, email, createdAt, @@unique([userId, tenantId]),
  @@index([tenantId]) }`. `userId` = Firebase uid.
- **`Invitation`** (new): `{ id, tenantId, email, role, tokenHash @unique, invitedBy,
  expiresAt, acceptedAt?, createdAt }`.
- **`MembershipCache`** — an interface `get(userId) → Membership[] | null`,
  `invalidate(userId)`, with two implementations:
  - **in-memory** (TTL + max-size LRU) — the default; fine for a single API instance.
  - **Redis** — for multi-instance deploys; the same interface, `invalidate` publishes so
    all instances drop the key. Selected by `REDIS_URL` (present → Redis, else in-memory).
  - Cache key is per **user** (their full membership set); the guard filters to the active
    tenant. TTL ~60s as a backstop; **every membership/role write calls `invalidate(userId)`**
    so revocation is immediate.

## 7. Endpoints

| Method · Path | Auth | Effect |
|---|---|---|
| `GET /me/workspaces` | user | the caller's workspaces + roles (for the switcher) |
| `POST /workspaces` | user, `email_verified` | create tenant + owner Membership (server-random id) |
| `POST /tenants/:id/invitations` | admin+ | create invite → token returned once |
| `GET /tenants/:id/invitations` | admin+ | list pending |
| `DELETE /tenants/:id/invitations/:iid` | admin+ | revoke |
| `POST /invitations/:token/accept` | user, email-matched | join tenant + role → Membership |
| `GET/DELETE /tenants/:id/members…` | admin+ | manage; **remove deletes Membership + busts cache** |

All workspace-scoped routes require the `X-Workspace-Id` header (or carry `:id`), which
the guard membership-checks.

## 8. Web flow

- **Signup → no workspaces →** a "Create your workspace / accept an invite" screen (not a
  401 loop).
- **Workspace switcher** in the app shell (from `GET /me/workspaces`); the selected id is
  sent as `X-Workspace-Id` on every request.
- **Team screen:** invite by email + role, pending invites, remove members (revokes
  access immediately). Role-aware UI.
- **`/invite/:token`** accept screen.

## 9. Rollout — as slices (each its own PR)

1. **Membership + cache foundation:** `Membership` table, `MembershipCache` (in-memory,
   Redis-ready), guard resolves user→membership→role from the cache + `X-Workspace-Id`,
   `@TenantId()` returns the validated active tenant, one-time claim→Membership migration.
   `GET /me/workspaces`. *(Cross-tenant isolation tests must stay green — this is the
   riskiest slice.)*
2. **Provisioning:** `POST /workspaces` (server-random id + `email_verified`) + web
   "create workspace" empty state + workspace switcher.
3. **Invitations + roles:** `Invitation` table + create/list/revoke + `POST /accept`
   (email-match, expiry, single-use) + `RolesGuard` + `@Roles` on destructive routes +
   member-remove revokes + role-aware Team UI + `/invite/:token`.

## 10. Verification plan (when built)

- **Unit:** guard 403s a request whose `X-Workspace-Id` the user has no Membership for
  (scenario #1); `POST /workspaces` ignores a body `tenantId` + requires `email_verified`;
  accept rejects email-mismatch / expired / reused token; `RolesGuard` 403s a member on an
  admin route; cache `invalidate` on remove → the next request is 403.
- **Live:** sign up → create → invite → accept → switch workspaces → role-gate a
  destructive action → remove a member → their access is gone on the next request.
- The existing cross-tenant isolation tests (guard) MUST stay green through slice 1.

## 11. Residual open questions

- **Redis vs in-memory in prod** — ship in-memory (works single-instance) with the Redis
  impl behind `REDIS_URL`; confirm the target deploy is single- or multi-instance.
- **Claim→Membership migration** — backfill script vs lazy-on-first-login (recommend
  lazy + a backfill for completeness).

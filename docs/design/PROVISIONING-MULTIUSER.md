# Design — Self-Serve Provisioning + Multi-User Workspaces

**Status:** proposed (awaiting sign-off before implementation)
**Author:** — · **Date:** 2026-07-04
**Why a design doc first:** the tenant-provisioning path is the audit's **#1 trust
boundary** (`docs/audit/AUTH-PROVISIONING-AUDIT-2026-07-04.md`). A user must NEVER be
able to self-assign an *existing* tenant. The security model has to be right on paper
before a line is written.

---

## 1. Current state (grounded)

- **Tenant = workspace.** Access is granted ONLY by the Firebase `tenant` custom claim.
  `principalFromClaims` (`apps/api/src/auth/firebase-verifier.ts:36-41`) reads
  `claims["tenant"]` → `{ tenantId, subject }`; **no claim → `null` → 401**. A signed-up
  user with no claim is locked out.
- **The claim is set CLI-only** — `apps/api/src/auth/set-tenant-claim.ts` calls
  `setCustomUserClaims(uid, { tenant })` using the Firebase **service account**. The API
  itself only *verifies* ID tokens; it never sets a claim.
- **Members are cosmetic** — `MembersService.add` (`apps/api/src/members/members.service.ts`)
  upserts a `Member` row and grants **no** auth (no claim, no token). Adding yourself to a
  member list does not let you log in as that tenant.
- **The guard already enforces isolation** — `AuthGuard` rejects a `/tenants/:id/...`
  request whose path tenant ≠ token tenant (hardened in PR #106).

**Gap:** a stranger can sign up (Firebase account) but can't get a *workspace* without an
operator running the CLI. Teammates can't be invited to log in.

## 2. Goals / non-goals

**Goals (v1)**
- A new user signs up → creates their OWN workspace → is the owner, no operator.
- An owner/admin invites teammates by email → they log in and act, with a role.
- Roles gate destructive actions (owner > admin > member).

**Non-goals (v1)** — org hierarchy, SSO/SAML, per-resource ACLs, billing/plan gating,
multi-workspace membership per user (see Open Questions).

## 3. The trust model (the crux)

The `tenant` claim is the ONLY key to a workspace and is **server-set only**. So every
path that sets it is security-critical. There are exactly two:

### Path A — Create workspace (new tenant)
An authenticated Firebase user **with no existing `tenant` claim** calls `POST /workspaces`.

- The server generates a **fresh random `tenantId`** (e.g. `t_<ulid>`) — **never** taken
  from the request body.
- Sets the claim on *that* user (`setCustomUserClaims(uid, { tenant, role: "owner" })`),
  creates the owner `Member` row, and any default rows (settings).
- **Fail-closed rules:**
  1. The caller must have **no existing tenant claim** (a user already in a workspace
     can't mint another this way).
  2. `tenantId` is server-generated → a user **cannot target an existing tenant**.
  3. Require `email_verified === true` in the ID token.

### Path B — Accept invitation (existing tenant)
An owner/admin creates an `Invitation { tenantId, email, role, tokenHash, expiresAt }`.
The invitee calls `POST /invitations/:token/accept` with a verified ID token.

- **Fail-closed rules:**
  1. The token is high-entropy, **single-use**, and **expires** (stored sha256-hashed,
     like `ApiToken`).
  2. The accepting user's **`email_verified` claim must be true AND their token email
     must equal the invite's `email`** — the token alone is not enough; you must be the
     intended recipient.
  3. The invitee must not already hold a *different* tenant claim (v1: one workspace).
- On success: set the invitee's claim to the invite's tenant + role, create the `Member`
  row, mark the invite accepted.

### Why this is safe (attack scenarios)
| # | Attack | Defense |
|---|--------|---------|
| 1 | Create a workspace with a chosen `tenantId` | Body ignored; `tenantId` is server-random |
| 2 | User in tenant A grabs tenant B via `POST /workspaces` | Create requires **no existing claim**, and mints a new id anyway |
| 3 | Stranger with a leaked invite token accepts | Verified email must equal the invite email |
| 4 | Member escalates their own role | `RolesGuard` (admin+ to manage members); can't set a role above your own |
| 5 | Removed member keeps acting | Removal **revokes the claim** (`setCustomUserClaims` clears tenant) + `revokeRefreshTokens`; ID tokens are ≤1h — **document the ≤1h window** |
| 6 | `email_verified=false` user creates/accepts | Both paths require `email_verified` |

## 4. Auth changes

- **`FirebaseAdminService`** (API-side): wraps the Admin SDK to `setTenantClaim(uid,
  tenant, role)` and `clearTenantClaim(uid)`. The API already holds the service account
  (used for verification) — this is the same credential the CLI uses, now behind guarded
  endpoints instead of a shell.
- **Claim carries the role** (`{ tenant, role }`) — enforcement needs no per-request DB
  read; the `Member` row stays the human-facing directory. Changing a role re-sets the
  claim; the user force-refreshes their token to pick it up.
- **`principalFromClaims`** also returns `role`; `Principal` gains `role`.
- **Token refresh:** after any claim change (create / accept / role change / removal),
  the client must **force-refresh** its Firebase ID token. The response signals this; the
  web `AuthProvider` calls `getIdToken(true)`.

## 5. RBAC

- Roles: `owner` > `admin` > `member`.
- `@Roles("admin")` decorator + `RolesGuard` reading `principal.role`.
- **Gating:** manage members/invites, save/rotate provider keys, delete connections,
  change budget, delete a workflow → **admin+**. Create/edit/run/approve → **member+**.
- Exactly one `owner` at creation; owner can transfer ownership (later slice).

## 6. Data model

- **`Invitation`** (new): `{ id, tenantId, email, role, tokenHash @unique, invitedBy,
  expiresAt, acceptedAt?, createdAt }`, indexed `[tenantId, createdAt]`. Token hashed
  (plaintext returned once, at creation).
- **`Member`** (exists): becomes the real directory backing role + membership; on member
  removal the claim is revoked (not just the row deleted).

## 7. Endpoints

| Method · Path | Auth | Effect |
|---|---|---|
| `POST /workspaces` | Firebase token, **no tenant claim** | create tenant + owner claim + Member |
| `POST /tenants/:id/invitations` | admin+ | create invite → token returned once |
| `GET /tenants/:id/invitations` | admin+ | list pending |
| `DELETE /tenants/:id/invitations/:iid` | admin+ | revoke |
| `POST /invitations/:token/accept` | Firebase token, email-matched | join tenant + role |
| `POST/DELETE /tenants/:id/members…` | admin+ | manage; **remove revokes the claim** |

## 8. Web flow

- **Signup → no claim →** land on a "Create your workspace" / "Have an invite?" screen
  (not a 401 error loop). Create → force-refresh token → into the app as owner.
- **Team screen:** invite by email + role, see pending invites, remove members (revokes
  access). Role-aware UI (hide admin-only actions for members).
- **`/invite/:token`** accept screen (sign in if needed, then accept).

## 9. Rollout — as slices (each its own PR)

1. **Provisioning:** `FirebaseAdminService.setTenantClaim` + `POST /workspaces`
   (server-random id, no-existing-claim + email_verified gates) + web "create workspace"
   empty state + token force-refresh. *No invites yet.*
2. **Invitations:** `Invitation` table + create/list/revoke + `POST /accept` with the
   email-match + expiry + single-use gates + `/invite/:token` screen.
3. **Roles/RBAC:** role in the claim + `RolesGuard` + `@Roles` on destructive routes +
   member-remove revokes the claim + role-aware Team UI.

## 10. Open questions (need your call before slice 1)

1. **One workspace per user, or multi-membership?** v1 recommends **one** (matches the
   single `tenant` claim; multi needs a claim that's a *list* + an active-workspace
   switcher — a bigger change). ← recommend one.
2. **Role in the claim (refresh on change) vs live `Member` lookup per request?**
   ← recommend **claim** (no per-request DB read; refresh on change is acceptable).
3. **May a user who's already in a workspace create/join another?** v1 recommends **no**
   (ties to Q1). ← recommend no.
4. **Break-glass CLI** (`set-tenant-claim.ts`) — keep as an operator escape hatch? ←
   recommend keep.

## 11. Verification plan (when built)

- Unit: `POST /workspaces` ignores a body-supplied `tenantId`; rejects a caller who
  already has a claim; rejects `email_verified=false`. Accept: rejects email mismatch,
  expired token, reused token. `RolesGuard`: a member is 403'd on an admin route.
- Live: the whole path against the running stack (sign up → create → invite → accept →
  role-gate a destructive action → remove → access revoked).
- The existing cross-tenant isolation tests (guard) must stay green.

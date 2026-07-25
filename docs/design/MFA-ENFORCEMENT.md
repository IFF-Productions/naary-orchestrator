# Design — Instance-wide 2FA / MFA enforcement (#457)

**AC:** *admin can require MFA; unenrolled users gated until enrolled.*

## Where MFA actually lives

Human login is **Firebase Auth** (`apps/api/src/auth/firebase-verifier.ts` +
`auth.guard.ts`). Firebase/Identity Platform owns enrolment *and* the challenge — we neither
store nor verify factors. What we get is an assertion in the ID token: a session that
completed a second factor carries

```json
{ "firebase": { "sign_in_provider": "password", "sign_in_second_factor": "totp" } }
```

(`"phone"` for SMS). A single-factor sign-in simply omits the field. So enforcement is a
**claim check on a token we already verify** — no DB table, no extra round-trip, and no way
for a client to assert MFA it didn't complete (the token is Google-signed).

> Unrelated: every `totp` hit elsewhere in the repo is the workflow **TOTP node**, not user MFA.

## The toggle

`REQUIRE_MFA=true` — an **instance-wide operator env var**, default **OFF**.

Why env and not a table: the issue asks for *instance-wide*, and every settings row in the
schema is tenant- or env-scoped (`TenantSettings`, `TurnstileConfig`, `Variable`, …) — there
is no instance-settings table to extend. The existing precedent for exactly this shape is
`ACCESS_ALLOWED_EMAILS`, the early-access allowlist parsed in the same guard, logged at boot,
documented in `deploy/.env.prod.example` and passed through `docker-compose.yml`. This
follows it line for line rather than inventing a new mechanism. A per-tenant policy would be a
different (weaker) feature: a user's session is one token across all their workspaces, so
"tenant A requires MFA" can't be enforced without also gating tenant B.

**Default OFF is a safety property, not laziness:** enabling it before anyone has enrolled
locks every human out of the UI. Recovery is unset-and-redeploy, and `nry_` API tokens keep
working throughout, so the instance is never unrecoverable.

**How an operator actually sets it (verified against `.github/workflows/deploy.yml`):** the
box keeps a persistent `/opt/naary/.env`, and deploy runs `docker compose` from `/opt/naary`,
so compose auto-loads it and `REQUIRE_MFA: ${REQUIRE_MFA:-}` in `docker-compose.yml` picks it
up. `deploy.yml` enumerates only the few vars a repo secret may override (Sentry/OTLP); like
`ACCESS_ALLOWED_EMAILS`, this one is host-managed — set it in `/opt/naary/.env` and redeploy
(or `docker compose up -d api`). Nothing to add to the workflow.

## Enforcement point + exempt paths

One check in `AuthGuard.canActivate`, in the Firebase branch, immediately after the email
allowlist and **before** any membership/invitation write (a gated user provisions nothing):

```ts
if (this.requireMfa && user.secondFactor === undefined) throw new ForbiddenException(MFA_REQUIRED);
```

Exempt **by construction** — each returns before that line:

| Path | Why |
| --- | --- |
| `@Public()` routes | No user to enrol. Covers webhook ingress (`hooks.controller`), hosted forms (`forms.controller`) and chat (`chat.controller`), OAuth/App callbacks (`oauth`, `github-app`, `atlassian-oauth`), signed approve/reject links (`approvals-public.controller`), public templates, the MCP surface, `/healthz`, `/metrics`. |
| `nry_` API tokens | Owner-created capabilities (CLI / MCP / CI) with no interactive login, so no second factor is possible. Gating them would break automation without adding security — the token *is* the secret. Same posture as the email allowlist. |

Everything else — including `@UserScoped()` identity routes like `/me/workspaces` — **is**
gated. That's deliberate: it means no workspace/run data is served to a single-factor session,
and the SPA still renders its enrolment state because that state is client-side.

## The response contract

403 with a distinct marker (never a bare 403, never a 401 — the credentials are *valid*, and a
401 would sign the user out and loop them through the same single-factor login):

```json
{ "statusCode": 403, "error": "Forbidden", "code": "mfa_required", "message": "This instance requires two-factor authentication. …" }
```

The SPA maps that **exact** code (in both `http()` and the typed client's `unwrap()`) to
`MfaRequiredError` → `WorkspaceProvider.mfaRequired` → `RequireAuth` renders
`screens/MfaRequired.tsx`. Mirrors the existing `access_not_allowed` → `NotAvailable` path
exactly. An ordinary 403 stays a generic error, so permission failures don't send users to an
enrolment screen.

## Deferred (explicitly NOT in this slice)

- **The enrolment UI itself.** Firebase enrolment is a client-side flow
  (`multiFactor(user).getSession()` → `TotpMultiFactorGenerator.generateSecret()` / phone
  verification → `enroll()`), needs a fresh re-authentication, a QR/secret render, a
  verification step, and recovery handling — and it cannot be verified in this environment (no
  live Firebase project, and MFA must be enabled in the Identity Platform console first). What
  ships is **enforcement + the gated state + a documented entry point**: `MfaRequired.tsx`
  tells the user what must happen and returns them to sign-in. Wiring real enrolment is a
  follow-up slice.
- **Per-tenant / per-workspace MFA policy** — see above; a session is one token.
- **An in-app admin toggle.** The policy is instance-wide, so its natural owner is the
  operator (env + redeploy), not a workspace admin. Add one only alongside a real
  instance-settings surface.
- **Grace periods / "enrol within N days"** and MFA-state reporting on `/me`.

## Testing

No live Firebase MFA enrolment is possible here, so the **mock seam is the verifier**:
`secondFactorFromClaims` is unit-tested against the exact claim shapes `verifyIdToken`
returns, and the guard tests inject a verifier that yields a user with/without
`secondFactor`. Covered: enforced + unenrolled → 403 `mfa_required` (and no membership
writes); enforced + second factor → pass; `nry_` tokens pass; `@Public()` passes; unset ⇒
nothing changes; `parseRequireMfa` accepts only explicit truthy values.

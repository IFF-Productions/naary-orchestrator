# PLAN — Security Hardening Slice (must-fix tier from the QA / Architecture / Security reviews)

> Source: `REVIEW-VALIDATION.md` confirmed **0 / 32 findings fixed**. This slice takes
> the tier all three reviewers converged on as release-blocking, and nothing else —
> the rest stays in the backlog (`REVIEW-VALIDATION.md` §"Suggested order").

---

## 1. Purpose

Close the four findings that block a multi-tenant deployment and undermine the
project's headline guarantees, without a core redesign:

1. **Auth + per-tenant authorization** — stop trusting client-supplied `tenantId`;
   tenant-scope every endpoint incl. `executions/:id`. *(Sec#1 / QA#1 / Arch§3.1 — Critical)*
2. **Provider-error secret hygiene** — sanitize errors before they cross the activity
   boundary into Temporal history/logs. *(Arch§3.2 — High)*
3. **Input validation** — global `ValidationPipe` + DTOs; kills the approve→reject
   footgun and the `serverUrl`/mass-assignment surface. *(Sec#4 / QA#4 — Medium, cheap)*
4. **Usage idempotency** — stop double-bill / double-LLM-call on activity retry.
   *(QA#3 / Arch§4.2 — High)*

These four are cohesive (auth + validation + error hygiene + the one money bug that is
a pure server-side fix) and verifiable end-to-end.

---

## 2. Scope

**Build (this slice):**
- A per-tenant **API-token** auth scheme + a global NestJS guard that resolves a
  trusted `tenantId` from the bearer token; controllers derive `tenantId` from the
  principal, never from path/body.
- An **execution→tenant** ownership record so `GET/POST /executions/:id*` can be
  authorized.
- A global **`ValidationPipe`** (`whitelist`, `forbidNonWhitelisted`, `transform`) with
  `class-validator` DTOs for every request body; `approved` becomes a required boolean;
  `serverUrl` validated as `https` URL; `provider` constrained.
- **Provider-error sanitization** in `runAgent` (and `callMcpTool`): rethrow only
  `statusCode` + a safe message, dropping headers/body/request fields, **preserving
  retryability** — plus a test asserting no `sk-`/`Bearer`/key material in the
  serialized failure.
- **Usage idempotency**: `@@unique([executionId, nodeId])` on `UsageEvent` + an upsert
  in `recordUsage`, so a retried activity can't write a duplicate ledger row. Small
  adjacent fix: map `WorkflowNotFoundError` → 404 on `GET /executions/:id` *(QA#11)*.

**Explicitly OUT of scope (next hardening pass — keep the fence):**
- SSRF `serverUrl` egress allowlist / private-IP blocking *(Sec#2)* — needs its own
  design (DNS-rebinding, forward proxy); validation here only enforces `https`.
- OAuth callback session-binding + state TTL *(Sec#3)*, dedupe/state cleanup *(Sec#9)*.
- Key rotation/versioning + AAD *(Sec#7)*, secret-table split *(Arch§3.3)*, encrypt
  webhook secret *(Sec#8)*.
- CORS allowlist / helmet / rate limiting *(Sec#5)*, global exception filter *(Sec#11)*,
  env fail-fast *(Sec#6)*. *(Note: a CORS allowlist becomes necessary when the new
  `apps/web` talks to the API in a deployed env; flagged for the next pass.)*
- Graph persistence / Slice #5, interpreter versioning, MCP metering, budget-overshoot
  contract, cached-token billing semantics *(QA#2 — verify separately)*.

---

## 3. Key decision — auth mechanism

**Recommended: per-tenant API tokens (bearer).** A `nry_…` token per tenant, stored
**hashed** (SHA-256) in a new `ApiToken` table; `Authorization: Bearer <token>` →
guard hashes → looks up → attaches `{ tenantId }` to the request. Rationale: the control
plane is a service API (the new web app and webhook senders are the clients); tokens are
the lowest-friction credible scheme and need no session/IdP infra for this prototype.
A first token is minted by a small seed script (or `POST /tenants/:id/tokens` guarded by
an admin bootstrap token from env).

Alternatives if you'd rather: short-lived **JWT** (needs an issuer) or **session
cookies** (needs the web app's login wired to it + CSRF). *This is the one choice to
confirm before I build Phase A.*

`/hooks/*` stays HMAC-authenticated (correct already) and is exempt from the bearer
guard. `GET /oauth/callback` stays public (it's a provider redirect) — its proper
session-binding is the separate Sec#3 item, out of scope here.

---

## 4. Tasks

### Phase A — AuthN/AuthZ + validation

- **A1 — `ApiToken` model + mint path.** Prisma `ApiToken { id, tenantId, tokenHash
  @unique, label, createdAt, lastUsedAt? }` + migration; a seed script to mint a token
  for a tenant (prints the plaintext once). **Verify:** `prisma migrate` applies; seed
  prints a token; row stores only the hash.
- **A2 — `AuthGuard` (global) + principal.** Reads bearer, hashes, looks up tenant,
  attaches `req.principal = { tenantId }`; 401 on missing/unknown. Registered globally
  with an exemption for `/hooks/*` and `/oauth/callback`. **Verify:** unit test — valid
  token → principal; bad/missing → 401; exempt routes pass through.
- **A3 — Derive `tenantId` from principal across controllers.** `secrets`, `budget`,
  `usage`, `connections`, `webhooks` use `req.principal.tenantId`; if a path `:id`
  tenant is present it must equal the principal's (else 403). `POST /executions` drops
  body `tenantId` in favor of the principal. **Verify:** integration — tenant A's token
  cannot read/write tenant B's resources (403/404).
- **A4 — Execution ownership.** Persist `Execution { workflowId @id, tenantId,
  createdAt }` on start; `getState`/`approve` load it and 403 if it isn't the principal's
  tenant (404 if absent). **Verify:** A cannot `approve`/`getState` B's run; the
  forged-approval path from Sec#1 is closed by a test.
- **A5 — Global `ValidationPipe` + DTOs.** `class-validator` DTOs for every body;
  `approved: boolean` required; `serverUrl` `@IsUrl({ protocols: ['https'] })`;
  `provider` constrained; `whitelist + forbidNonWhitelisted + transform`. **Verify:**
  missing `approved` → 400 (not silent reject); junk field → 400; `http://` serverUrl
  → 400.

### Phase B — Error-path secret hygiene

- **B1 — Sanitize provider errors.** A `toSafeActivityError(e)` helper: for
  `APICallError`/MCP errors, build a new error with `statusCode` + generic message,
  dropping `requestBodyValues`/headers/url; keep the existing non-retryable mapping for
  401/403/429 and rethrow **sanitized-but-retryable** for transient. Apply in `runAgent`
  and `callMcpTool`. **Verify (test):** simulate an `APICallError` carrying a `Bearer
  sk-…` header; assert the thrown error's serialized form (message + JSON) contains no
  `sk-`/`Bearer`/header material, and that retryability is unchanged.

### Phase C — Usage idempotency + 404

- **C1 — Idempotent usage.** `@@unique([executionId, nodeId])` on `UsageEvent` +
  migration; `recordUsage` becomes an `upsert` (or create-catch-P2002 → no-op).
  **Verify (test):** calling `recordUsage` twice for the same `(executionId, nodeId)`
  yields one row; a simulated post-call retry of `runAgent` doesn't double-write.
- **C2 — `getState` 404.** Catch `WorkflowNotFoundError` → `NotFoundException`.
  **Verify:** `GET /executions/<unknown>` → 404, not 500.

---

## 5. Definition of done

- Every control-plane endpoint (except HMAC `/hooks/*` and the public OAuth redirect)
  rejects unauthenticated calls and is scoped to the authenticated tenant; cross-tenant
  access and forged approvals are proven blocked by tests.
- No provider key / `Bearer` material can appear in a thrown activity error (test-proven).
- A retried agent activity cannot double-write usage (test-proven).
- Malformed bodies return 400; unknown executions return 404.
- `REVIEW-VALIDATION.md` updated: these findings flip to **FIXED** with evidence.
- All existing **67 tests stay green**; `tsc -b` clean; new tests added per task.

## 6. Verification summary (run before done)

- `pnpm test` — existing 67 + new auth/validation/sanitization/idempotency tests.
- `npx tsc -b` clean; `npx prisma migrate dev` applies (ApiToken, Execution, UsageEvent unique).
- Manual `curl`: no token → 401; tenant-A token on tenant-B resource → 403/404;
  missing `approved` → 400; unknown execution → 404.

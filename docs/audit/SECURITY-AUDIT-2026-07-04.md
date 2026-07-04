# Security Audit — naary-orchestrator

**Date:** 2026-07-04
**Branch:** `docs/webhooks` (HEAD `9296ed8`)
**Method:** Read-only source review of `apps/{api,worker,web}` and `packages/*`, cross-referenced against the prior `docs/SECURITY-REVIEW.md`. Every finding below was confirmed by reading the cited code; speculative issues were dropped. Areas explicitly **not** covered this pass are listed under [Scope limits](#scope-limits).

## TL;DR

The security posture has improved substantially since the prior review. The prior review's headline items — **no auth at all** (Sec#1), no input validation (Sec#4), no CORS/headers/rate-limit (Sec#5), plaintext webhook secrets (Sec#8), no exception filter (Sec#11) — are all **fixed and verified in code**. Multi-tenant isolation is enforced two ways (a `/tenants/:id` path-guard and per-row `assertOwner`/`where:{tenantId}` scoping) and I could not find an IDOR.

The residual risk is concentrated in **outbound egress (SSRF)**. The egress guard added since the last review is real and covers HTTP/RSS/SMTP/MCP/OAuth, but it has two bypasses (redirect-follow, DNS-rebind) and one connector — the SQL DSN — is not guarded at all.

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| S-1 | **High** | HTTP/RSS egress guard bypassed by redirect-following | Open (new) |
| S-2 | **Medium–High** | DNS-rebinding TOCTOU between egress check and fetch | Open (new) |
| S-3 | **Medium** | SQL `sqlQuery` DSN host is not egress-guarded | Open (new) |
| S-4 | **Low** | Webhook ingress does a DB read + AES-decrypt before signature check | Open (new) |
| S-5 | **Low** | Abandoned OAuth `state` rows are never swept | Residual of prior QA#10 |
| S-6 | **Low** | Single static master key — no rotation / per-tenant DEK | Residual of prior Sec#7 |
| S-7 | **Info** | MSSQL read-only is weaker than Postgres `READ ONLY` txn | Note |
| S-8 | **Info** | Prompt injection via untrusted webhook payload into an agent node | By design (prior Sec#10) |

---

## Open findings

### S-1 (High) — HTTP/RSS egress guard is bypassed by redirect-following

**Where:** `apps/worker/src/temporal/activities.ts:1306` (`callHttpRequest`) and `:626` (`callRssRead`).

```ts
const url = await __httpDeps.assertEgressAllowed(rawUrl);   // validates the FIRST hop only
...
res = await __httpDeps.fetch(url, { ...init, signal: controller.signal }); // default redirect: 'follow'
```

`assertEgressAllowed` validates the initially-requested URL, but the subsequent `fetch` uses the default `redirect: 'follow'`. A user-controlled workflow can point an `httpRequest`/`rssRead` node at a public server they control that replies `302 Location: http://169.254.169.254/latest/meta-data/...` (or `http://127.0.0.1:7233`, or an internal service). `fetch` follows it **without re-running the guard**, and because redirects aren't restricted to https, this also defeats the https-only rule.

**Attack scenario:** Any tenant who can author a graph configures an `httpRequest` node to `https://attacker.example/redir`. The attacker's server 302-redirects to the cloud metadata endpoint. The response body is returned into the workflow `ctx` and is readable by the tenant via `GET /executions/:id`. Cloud metadata / internal endpoints require no auth, so the token-stripping behaviour of undici on cross-origin redirects does **not** mitigate the read.

**Fix (shared with S-2):** set `redirect: 'manual'` and re-run `assertEgressAllowed` on each `Location` before following, **or** supply a custom undici `Dispatcher` whose connect-time `lookup` validates every resolved IP at socket-connect time. The dispatcher approach closes S-1 and S-2 together. Cap redirect depth.

---

### S-2 (Medium–High) — DNS-rebinding TOCTOU between the egress check and the fetch

**Where:** `apps/worker/src/temporal/activities.ts:1278`→`:1306`; guard in `packages/connections/src/egress.ts:96`.

`assertEgressAllowed` resolves the hostname, validates the returned addresses, and returns the parsed `URL`. The caller then calls `fetch(url, …)`, which **re-resolves the hostname independently**. The guard's own comment claims call-time checking "defeats DNS rebinding," but validating one resolution and then connecting by hostname does not — between the two lookups an attacker-controlled authoritative DNS server (short/zero TTL) can return a public IP to the guard and a private IP to `fetch`.

**Attack scenario:** Tenant configures a node targeting `https://rebind.attacker.example`. First lookup (guard) → public IP, passes. Second lookup (fetch) → `169.254.169.254`. Same read-back path as S-1.

**Fix:** the same connect-time-validating dispatcher/agent as S-1 — pin the connection to the exact IP the guard validated, or validate inside the socket `lookup` hook so guard and connection observe the *same* resolution. This is the only robust fix; re-ordering checks does not help.

---

### S-3 (Medium) — The SQL `sqlQuery` DSN host is not egress-guarded

**Where:** `apps/worker/src/temporal/activities.ts:1476` (`callSqlQuery`) → `packages/sql/src/postgres.ts:17` (`new Client({ connectionString: dsn })`).

Every other outbound connector validates its target — sendEmail (`assertHostPublic`, `:478`), rssRead (`:617`), httpRequest (`:1278`), MCP (`packages/connections/src/mcp.ts:27`), OAuth (`packages/connections/src/oauth.ts:228`). The SQL path resolves a **user-supplied DSN** and connects directly with no host check.

**Attack scenario:** A tenant creates a `db` connection whose DSN points at an internal host — `postgres://user:pass@10.0.0.5:5432/…`, `…@localhost:5432/naary_orchestrator`, an internal RDS instance, etc. The worker connects from inside the trust boundary. Because the driver speaks the Postgres/TDS wire protocol (not HTTP) and errors are sanitized (`:1544-1558`, the DSN never reaches history/logs), the practical impact is **internal port-scanning / reachability probing and reaching internal databases**, not cloud-metadata theft — hence Medium, not High. Connection-refused vs. timeout vs. auth-error timing is still an observable oracle for "is this host:port a live DB."

**Fix:** parse the DSN host in `callSqlQuery` (or in `resolveDbConnection`) and call `assertHostPublic(host)` before `runReadOnly`, mirroring `callSendEmail`.

---

### S-4 (Low) — Webhook ingress does a DB read + AES-decrypt before the signature check

**Where:** `apps/api/src/webhooks/hooks.controller.ts:51-69`.

The `@Public()` ingress calls `getEndpoint` (DB) and `decryptSigningSecret` (AES-GCM) for **every** request, including unsigned ones, before `verifySignature` runs. An attacker who knows an endpoint id (it's in the URL a provider is configured with, and is a plain cuid) can force a DB round-trip + decrypt per request without possessing the secret.

**Mitigation already present:** the global `ThrottlerGuard` (120 req/min/IP, `apps/api/src/app.module.ts:29`) bounds this, so it's Low. Note the throttle is per-IP; a busy real provider (GitHub org behind one egress IP) sharing the limit with an attacker is a minor availability edge.

**Fix:** cheap — nothing urgent. If desired, reject requests missing the signature header before touching the DB.

---

### S-5 (Low) — Abandoned OAuth `state` rows are never swept

**Where:** `packages/connections/src/oauth.ts:302` (`startConsent` writes the state) vs. cleanup at `:361`/`:398` (only on expiry-hit-during-callback or successful completion).

A consent that is *started but never completed* leaves its state record in the secret store forever — there is no periodic sweep of expired-but-untouched states. Unbounded growth over time (residual of prior QA#10, which called out both dedupe and OAuth-state growth; the dedupe side was fixed with a 30-day prune, the OAuth-state side was not). No confidentiality impact — states are single-use, 128-bit, 10-min TTL-enforced on read — purely a storage-hygiene issue.

**Fix:** a periodic job (or opportunistic prune like `isDuplicateDelivery` does) deleting states past `expiresAt`.

---

### S-6 (Low) — Single static master key; no rotation or per-tenant DEK

**Where:** `packages/secrets/src/crypto.ts:34-93`.

The prior Sec#7 (add AAD) is **fixed** — v2 payloads are AAD-bound to `<tenantId>` (`crypto.ts:52`, `webhook.service.ts:62`), so a DB-write attacker can't swap one tenant's ciphertext for another's. But the deeper half of Sec#7 remains: one process-wide `ENCRYPTION_KEY` encrypts every tenant's secrets, with no envelope/KMS DEK and no rotation path beyond the `keyVersion` hook. Compromise of the single key exposes all tenants' credentials.

**Fix:** the `KeyEncryptor` interface (`crypto.ts:23`) is already the seam for a KMS-backed envelope scheme; `keyVersion` is the decrypt-by-version hook. This is a known, deliberately-deferred item — track it, don't treat it as regressed.

---

### S-7 (Info) — MSSQL read-only is weaker than Postgres `READ ONLY`

**Where:** `packages/sql/src/index.ts:12` comment vs. `packages/sql/src/postgres.ts:35` (`BEGIN TRANSACTION READ ONLY`).

Postgres enforces read-only at the engine level (writes are *rejected*). The MSSQL adapter relies on always-rollback, which does not stop statements that auto-commit or perform side effects outside the transaction (some DDL, `xp_`/procedure side effects). Since this is the tenant querying *their own* database, it's a robustness note, not a cross-tenant issue — but "read-only" is a weaker promise on MSSQL than the shared comment implies.

---

### S-8 (Info / by design) — Prompt injection via untrusted webhook payload into an agent node

Unchanged from prior Sec#10. A webhook body flows into `ctx.__input` and can reach an `agent` node's prompt. This is an inherent property of "run an LLM over inbound events." Mitigations (output schema constraints, treating agent output as untrusted, least-privilege tool connections) are product-level, not a code defect.

---

## Verified fixed since the prior review

Each confirmed by reading current code, not just the changelog:

- **Prior Sec#1 / QA#1 — no authN/authZ.** Now a global dual-auth guard (`apps/api/src/auth/auth.guard.ts`): `nry_` API tokens (sha256-hashed at rest, `api-token.service.ts:6-27`) or Firebase ID tokens (`firebase-verifier.ts` — `verifyIdToken` checks signature/issuer/audience/expiry/revocation, rejects empty tenant claim, fails closed). Tenant-scoped routes are guarded by `/tenants/:id` path-match; `executions`/`graphs` self-scope by `assertOwner` / `where:{tenantId}`. **No IDOR found.**
- **Prior Sec#2 — SSRF/token-exfil via `serverUrl`.** Egress guard now exists and covers HTTP/RSS/SMTP/MCP/OAuth. **Mitigated for the direct case; residual via S-1/S-2/S-3.**
- **Prior Sec#3 — OAuth callback.** State is `tenantId.b64url(16 random bytes)` (128-bit), server-stored under the tenant namespace, **single-use** (removed on success and on expiry), **10-min TTL enforced on read** (`oauth.ts:280,360`), PKCE, and RFC 9207 issuer check (`:364`). A forged tenant prefix won't resolve a stored record. **Fixed** (except the sweep, S-5).
- **Prior Sec#4 / QA#4 — input validation.** Global `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })` (`main.ts`). **Fixed.**
- **Prior Sec#5 — CORS / headers / rate limiting.** `helmet()`, explicit CORS allowlist, and a global `ThrottlerGuard` (120/min/IP). **Fixed.**
- **Prior Sec#6 — `ENCRYPTION_KEY` at boot.** `createKeyEncryptor()` throws if unset; key length validated (`crypto.ts:37-44`). **Fixed.**
- **Prior Sec#8 — plaintext webhook secret.** Now encrypted at rest, AAD-bound to tenant, and excluded at the `select` level so it can't reach a response (`webhook.service.ts:61,82`). Verification is length-guarded `timingSafeEqual` (`:122-126`). **Fixed.**
- **Prior Sec#9 — unbounded dedupe table.** 30-day retention prune on each new delivery (`webhook.service.ts:153`). **Fixed.**
- **Prior Sec#11 — no exception filter.** `AllExceptionsFilter` registered globally (`main.ts`). Activity errors are sanitized to generic codes and never carry DSN/token/host into Temporal history (`toSanitizedRetryable`, and the SQL/HTTP catch blocks). **Fixed.**

## Positive controls observed

- Secrets never transit the workflow boundary: `workflows.ts` imports activities **type-only** (`import type * as activities`), only `tenantId` rides in workflow args, and every key is fetched+used inside the activity (agent/mcp/http/sql/hmac/jwt/totp/email all follow this).
- Response `Set-Cookie` headers are stripped before HTTP responses land in `ctx`/history (`activities.ts:1338`).
- JWT node is **mint-only** using the tenant's own key — no verification path, so alg-confusion / `alg:none` does not apply.
- Crypto is AES-256-GCM with a per-message 96-bit random nonce and auth tag (`crypto.ts`).

## Scope limits

Not audited this pass (no implied all-clear):

- **Dependency CVEs** — no `pnpm audit`/SCA run. Note CLAUDE.md's warning to pin `ai` to an exact version for the usage-undefined billing bug.
- **Web XSS surface** — did not read how `apps/web` renders node outputs / run ctx (a run's `ctx` can contain attacker-influenced webhook data; confirm no `dangerouslySetInnerHTML` on it and that the CSP in `apps/web/nginx.conf` is present).
- **MCP client internals** (`packages/connections/src/mcp.ts` beyond the egress call) and the **SecretStore backend** (`packages/secrets/src/secret-store.ts`).
- **authN provisioning trust boundary** — the Firebase tenant custom-claim is trusted; the provisioning path (`set-tenant-claim.ts`) that assigns it was not reviewed. A loose claim-setter would let a user self-assign a tenant, which would outrank everything above.

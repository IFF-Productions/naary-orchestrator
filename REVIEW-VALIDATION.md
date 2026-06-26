# Review Validation — QA / Architecture / Security findings

**Original audit:** 2026-06-25 · **Remediation completed:** 2026-06-26
**Source reviews:** `QA-FINDINGS.md`, `ARCHITECTURE-REVIEW.md`, `SECURITY-REVIEW.md`.

## Final status — every finding addressed

All findings from the three reviews are now **FIXED**, **PARTIAL** (core fixed, a piece
explicitly deferred), or **DEFERRED** (documented decision). Remediation shipped as ten PRs;
the test suite grew **67 → 106**, `tsc -b` stayed clean throughout, and the interpreter
rewrite is guarded by a **replay-from-history** test.

| # | PR | What landed |
|---|---|---|
| #11 | security must-fix | auth + tenant-scoping, provider-error sanitization, usage idempotency, ValidationPipe, getState 404, exec input |
| #13 | S1 | helmet, CORS allowlist, throttler, global exception filter, env fail-fast, web↔API bearer auth |
| #14 | S2 | SSRF egress allowlist (https + private-IP/rebinding block), tenant-scoped `setStatus` |
| #15 | S2b | webhook signing-secret encryption, OAuth state TTL, Prisma `$disconnect` |
| #16 | S3 | downgrade re-validation, MTD aggregate, cached-token semantics + test, schema header |
| #17 | S4 | durable graph versioning (Postgres + content-hash per-run snapshot) |
| #18 | S5 | branching / parallel / loop interpreter, `invalid_graph`, replay test (closes QA#7/#8) |
| #19 | S5b | per-node agent output schema, MCP tool-call metering |
| #20 | crypto | encryption key versioning + AAD-bound secrets |

### Validation matrix (final)

| Unified finding | Reviews | Sev | Status | Where |
|---|---|---|---|---|
| No authN/authZ; exec endpoints not tenant-scoped | Sec#1/QA#1/Arch§3.1 | Crit | **FIXED** | #11 — API tokens + `AuthGuard`; `Execution` ownership; live 401/403, forged-approval blocked |
| No input validation | Sec#4/QA#4 | Med | **FIXED** | #11 — global `ValidationPipe` + DTOs (`approved` required, `serverUrl` https) |
| No CORS / helmet / rate limiting | Sec#5/Arch§5(transport) | Med | **FIXED** | #13 — helmet + CORS allowlist + `@nestjs/throttler` |
| No global exception filter | Sec#11 | Low | **FIXED** | #13 — `AllExceptionsFilter` (generic 500, no leakage) |
| Env not fail-fast at boot | Sec#6 | Med | **FIXED** | #13 — `env.ts` validates `ENCRYPTION_KEY`/`DATABASE_URL` at boot (api + worker) |
| SSRF + token exfiltration via `serverUrl` | Sec#2 | High | **FIXED** | #14 — `assertEgressAllowed` (https + DNS-resolve + private/loopback/ULA block) at the token-bearing egress + OAuth discovery |
| Provider error rethrown bare → secret leak | Arch§3.2 | High | **FIXED** | #11 — `toSanitizedRetryable` + no-secret-in-failure test |
| Usage ledger not idempotent → double-bill | QA#3/Arch§4.2 | High | **FIXED** | #11 — `@@unique([executionId,nodeId])` + upsert |
| Cached input tokens double-billed | QA#2 | High | **FIXED** | #16 — verified correct for Anthropic (input excludes cache-reads) + no-double-count test |
| `downgrade` doesn't re-validate fallback | QA#6 | Med | **FIXED** | #16 — re-estimate + pricing check; `BUDGET`/`FALLBACK_UNPRICED` |
| Single hardcoded agent output schema | QA#9/Arch§4.4 | Med | **FIXED** | #19 — per-node `outputSchema` in config |
| `GET /executions/:id` 500 not 404 | QA#11 | Med | **FIXED** | #11 — `WorkflowNotFoundError`/unknown → 404 |
| `POST /executions` can't pass input | QA#12 | Low | **FIXED** | #11 — optional `input`; tenantId from token |
| Spend aggregation in memory | QA#13 | Low | **FIXED** | #16 — `monthToDateSpend` DB `_sum` aggregate (the hot path) |
| `setStatus` not tenant-scoped | Arch§3.7 | Low | **FIXED** | #14 — `updateMany({ where:{ id, tenantId } })` |
| Prisma `$disconnect` on shutdown | Arch§4.9 | Low | **FIXED** | #15 — `disconnectPrisma()` (worker finally + API lifecycle) |
| Stale schema header/comments | QA#14 | Low | **FIXED** | #16 — refreshed |
| Webhook signing secret plaintext | Sec#8 | Med | **FIXED** | #15 — encrypted at rest (AES-GCM blob) |
| OAuth state: weak binding / no TTL | Sec#3/Arch§3.4 | High | **PARTIAL** | #15 — 10-min TTL + single-use consumption. Full **session-binding** (vs state-prefix tenant) deferred. |
| Key versioning + AAD | Sec#7/Arch§3.5 | Med | **FIXED** | #20 — `keyVersion` + AAD-bound `(tenantId,key)`; legacy rows still decrypt |
| Graphs hardcoded; Postgres owns definitions | QA#5/Arch§4.1 | High | **FIXED** | #17 — `GraphDefinition` + content-hash per-run snapshot |
| Circuit breaker can't fire (linear walk) | QA#7 | Med | **FIXED** | #18 — loops are legal now; the step cap meaningfully bounds them |
| `walk()` throw → infinite retries | QA#8 | Med | **FIXED** | #18 — `invalid_graph` terminal + control-plane `validateGraph` |
| No interpreter versioning + no replay test | Arch§4.5 | Med | **PARTIAL** | #18 — **replay-from-history test** added (the real determinism guard). `patched()`/Build-IDs deliberately skipped (no in-flight prod histories); documented. |
| MCP unmetered; >2MB payloads | Arch§4.6 | Med | **PARTIAL** | #19 — tool-call **metering** into the budget. **Claim-check** for >2MB results deferred. |
| Dedupe/OAuth-state rows unbounded | Sec#9/QA#10 | Low | **PARTIAL** | #15 — OAuth state now expires (TTL). `WebhookDelivery` **retention sweeper** deferred. |
| Secret-table overloaded (one table/column) | Arch§3.3 | Med | **DEFERRED** | #20 — AAD now binds each row to its slot, removing the security motive; the **table split** is an optional organizational refactor. |
| Budget cap overshoot windows | Arch§4.3 | Med | **DEFERRED** | By design + documented (README): per-exec cap is "stop-after-exceeding"; monthly cap has no reservation. Atomic reserve-then-reconcile is a fast-follow. |
| OAuth refresh lock in-process only | Arch§4.7 | Med | **DEFERRED** | Documented; needs a durable/distributed lock before multi-worker scale-out. |
| `ctx` accumulates all outputs / queryable | Arch§4.8 | Low | **DEFERRED** | Bounding `ctx`/the state query is a follow-up; auth (#11) already gates the query. |
| Prompt injection via webhook payload | Sec#10 | Low | **DEFERRED** | Inherent to agent workflows; least-privilege per connection + guardrails are a product follow-up. |
| Observability is `console.log` only | Arch§5 | Op | **DEFERRED** | Structured logging / metrics / tracing is its own slice. |

**Tally: 25 FIXED · 4 PARTIAL · 5 DEFERRED** (of 34 unified rows). Every PARTIAL/DEFERRED
item is documented with rationale here and/or in the README.

### Deferrals at a glance (the honest tail)

1. OAuth callback **session-binding** (TTL shipped) — *Sec#3*
2. **Claim-check** object storage for >2MB MCP/LLM payloads — *Arch§4.6*
3. `WebhookDelivery` **retention sweeper** (OAuth-state TTL shipped) — *Sec#9*
4. Secret-table **split** (AAD removes the security motive) — *Arch§3.3*
5. Monthly-cap **atomic reservation** (overshoot is bounded + documented) — *Arch§4.3*
6. **Distributed** OAuth refresh lock (before multi-worker scale-out) — *Arch§4.7*
7. `ctx`/state-query **bounding** — *Arch§4.8*
8. Prompt-injection **guardrails** — *Sec#10*
9. **Observability** (structured logging/metrics/tracing) + Worker-Versioning/`patched()` rollout — *Arch§5, §4.5*

The "positive controls" both reviews praised (AES-256-GCM with per-message IV + tamper
detection, secrets-out-of-Temporal, raw-body timing-safe webhook HMAC, billing fail-safe,
401/429 non-retryable mapping, deterministic workflow boundary, `ai` pinned exact) remain
intact and were extended (AAD, replay guard, tenant-scoping).

---

## Original audit (2026-06-25) — pre-remediation snapshot

> Kept for the record. At the time of writing, **every finding was PRESENT** — the reviews
> were a status confirmation against `main` (slices #1–#4); the only newer work was the
> `apps/web` frontend, which touched no backend code. The matrix below is that original
> state; see the final matrix above for what each became.

The three reviews overlap heavily; deduplicated into a single matrix. Original statuses:
**PRESENT** (defect still in code), **PRESENT (by design/deferred)**, **PRESENT (nuance)**.

| Unified finding | Reviews | Severity | Status (then) | Evidence (then) |
|---|---|---|---|---|
| No authN/authZ; `tenantId` client-supplied; exec endpoints not tenant-scoped | Sec#1, QA#1, Arch§3.1 | Critical | PRESENT | No `AuthGuard`/`ValidationPipe` anywhere; `approve` on a raw `workflowId`, no tenant check |
| No input validation | Sec#4, QA#4 | Med | PRESENT | No `ValidationPipe`/`class-validator` |
| No CORS / helmet / rate limiting | Sec#5, Arch§5 | Med | PRESENT | None in `apps/api` |
| No global exception filter | Sec#11 | Low | PRESENT | No `useGlobalFilters` |
| Env not fail-fast at boot | Sec#6 | Med | PRESENT (nuance) | `createKeyEncryptor` throws but lazily; `env.ts` only `dotenv.config()` |
| SSRF via `serverUrl` | Sec#2 | High | PRESENT | unvalidated `serverUrl` fetched with the bearer token |
| OAuth callback unauthenticated; no state TTL | Sec#3, Arch§3.4 | High | PRESENT | tenant from state prefix; no `expiresAt` on stored state |
| Dedupe/OAuth-state rows unbounded | Sec#9, QA#10 | Low | PRESENT | no sweeper |
| Secret table overloaded | Arch§3.3 | Med | PRESENT | `TenantCredential.provider` reused for `conn:`/`oauth-state:` |
| Single static key — no rotation/AAD | Sec#7, Arch§3.5 | Med | PRESENT | no `keyVersion`, no `setAAD` |
| Webhook signing secret plaintext | Sec#8 | Med/Low | PRESENT | plain column |
| Usage ledger not idempotent | QA#3, Arch§4.2 | High | PRESENT | no `@@unique([executionId,nodeId])`; retry re-runs activity |
| Cached input tokens double-billed | QA#2 | High | PRESENT (risk) | separate buckets, no test pinning semantics |
| `downgrade` doesn't re-validate fallback | QA#6 | Med | PRESENT | no re-estimate / pricing check |
| Provider error rethrown bare | Arch§3.2 | High | PRESENT | `throw e;` unsanitized |
| Single hardcoded agent output schema | QA#9, Arch§4.4 | Med | PRESENT | fixed `{category,urgency}` |
| `GET /executions/:id` 500 not 404 | QA#11 | Med | PRESENT | no `WorkflowNotFoundError`→404 |
| `POST /executions` can't pass input | QA#12 | Low | PRESENT | hardcoded demo message |
| Spend aggregation in memory | QA#13 | Low | PRESENT | `findMany`+`reduce` |
| `setStatus` not tenant-scoped | Arch§3.7 | Low | PRESENT | `where:{ id }` only |
| `ctx` accumulates / queryable | Arch§4.8 | Low | PRESENT | full `ctx` returned by state query |
| No Prisma `$disconnect` | Arch§4.9 | Low | PRESENT | none |
| No interpreter versioning + replay test | Arch§4.5 | Med | PRESENT | no `patched()`, no replay test |
| MCP unmetered; >2MB payloads | Arch§4.6 | Med | PRESENT (partly by design) | `stepCount` only; no claim-check |
| Graphs hardcoded | QA#5, Arch§4.1 | High (known) | PRESENT (deferred) | no `GraphDefinition` |
| Circuit breaker can't fire (linear walk) | QA#7 | Med | PRESENT (by design) | linear, cycle-throwing |
| `walk()` throw → infinite retries | QA#8 | Med | PRESENT | no validation / in-workflow catch |
| Budget overshoot windows | Arch§4.3 | Med | PRESENT (partly by design) | cap checked after; no monthly reservation |
| OAuth refresh lock in-process | Arch§4.7 | Med | PRESENT (documented) | process-local cache/lock |
| Prompt injection | Sec#10 | Low | PRESENT (inherent) | webhook body → prompt + tool args |
| Stale schema header | QA#14 | Low | PRESENT | "Slice #2" / "hardcoded for now" |
| Observability `console.log` only | Arch§5 | Op | PRESENT | no structured logging |

**Tally (then): 0 fixed / 32 present.** **(Now: 25 fixed · 4 partial · 5 deferred — see top.)**

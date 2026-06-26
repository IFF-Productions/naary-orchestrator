# Review Validation — QA / Architecture / Security findings

**Date:** 2026-06-25
**Validated by:** code inspection of the current tree against the three review docs
(`QA-FINDINGS.md`, `ARCHITECTURE-REVIEW.md`, `SECURITY-REVIEW.md`).

## Update — security must-fix tier remediated (branch `feat/security-hardening`)

The four findings all three reviewers flagged as release-blocking are now **FIXED**
(per `PLAN-SECURITY-HARDENING.md`), proven by new tests + a live curl smoke:

| Finding | Status | How |
|---|---|---|
| No authN/authZ; exec endpoints not tenant-scoped *(Sec#1/QA#1/Arch§3.1)* | **FIXED** | Per-tenant API tokens + global `AuthGuard` (tenantId from token, never path/body); `/tenants/:id/*` path-tenant enforced (403 on mismatch); `Execution{workflowId,tenantId}` ownership record scopes `approve`/`getState`. Live: 401 no/bad token, 403 cross-tenant, forged-approval blocked. |
| No input validation *(Sec#4/QA#4)* | **FIXED** | Global `ValidationPipe({whitelist,forbidNonWhitelisted,transform})` + `class-validator` DTOs; `approved` required, `serverUrl` https-only. Live: 400 on missing/unknown fields (no silent approve→reject). |
| Provider error rethrown bare → secret leak into Temporal history *(Arch§3.2)* | **FIXED** | `toSanitizedRetryable` strips `APICallError` headers/body, keeps status + generic message, preserves retryability. Test asserts no key/`Bearer` in the serialized failure. |
| Usage ledger not idempotent → double-bill on retry *(QA#3/Arch§4.2)* | **FIXED** | `@@unique([executionId,nodeId])` + `recordUsage` upsert (no-op update); a retried activity can't double-write. |
| `GET /executions/:id` 500 not 404 *(QA#11)* | **FIXED** | `WorkflowNotFoundError`/unknown-execution → 404 (also gated by ownership). |
| `POST /executions` can't pass input *(QA#12)* | **FIXED** | accepts optional `input`; `tenantId` now from the token, not the body. |
| SSRF via `serverUrl` *(Sec#2)* | **PARTIAL** | DTO enforces `https`-only (closes `http://` internal targets); full egress allowlist / private-IP + DNS-rebinding block remains the next pass. |

Verification: `tsc -b` clean, **75/75 tests** (67 + 8 new: AuthGuard ×6, sanitization ×2),
migration `20260626000000_security_hardening` applies, live curl smoke 401/403/400/404 all
as expected. Everything below is the original full audit (pre-remediation state).

---

## Headline

**(Original audit — none fixed at the time of writing.)** Every finding described code
that was present, unchanged. The reviews were written against `main` (slices #1–#4), and
the backend had not been touched since:

```
$ git diff --stat main -- apps packages | grep -v apps/web
  (no backend changes vs main)
```

The only work added since the reviews is the `apps/web` frontend, which touches no
`apps/api` / `apps/worker` / `packages/*` code. So this is a *status confirmation*, not
a regression check: each finding below was re-verified against the live source and the
cited file:line still matches.

The three reviews overlap heavily; they are deduplicated into a single matrix. Statuses:

- **PRESENT** — defect/gap still in the code, not addressed.
- **PRESENT (by design / deferred)** — real, but an acknowledged scope decision or a
  later-slice concern, not a regression.
- **PRESENT (nuance)** — accurate, with a clarifying detail.

The "positive controls" both reviews list (AES-256-GCM with per-message IV + tamper
detection, secrets-out-of-Temporal via in-activity key fetch, raw-body timing-safe
webhook HMAC with verify-before-dedupe, billing fail-safe estimate, 401/403/429 →
non-retryable mapping, the deterministic workflow/activity boundary, `ai` pinned exact)
were spot-checked and **remain intact**.

---

## Validation matrix

| Unified finding | Reviews | Severity | Status | Evidence (current code) |
|---|---|---|---|---|
| **No authN/authZ; `tenantId` client-supplied; exec endpoints not tenant-scoped** | Sec#1, QA#1, Arch§3.1 | Critical | **PRESENT** | No `UseGuards`/`AuthGuard`/`ValidationPipe`/auth middleware anywhere in `apps/api/src` (grep: none). `main.ts` adds only `rawBody` + shutdown hooks. Controllers take `tenantId` from param/body; `POST /executions/:id/approve` operates on a raw `workflowId` with no tenant check. |
| **No input validation on any endpoint** | Sec#4, QA#4, Arch§3.1.3 | Med | **PRESENT** | No `useGlobalPipes`/`ValidationPipe`/`class-validator` in `main.ts` or controllers. |
| **No CORS / helmet / rate limiting** | Sec#5, Arch§5 | Med | **PRESENT** | No `enableCors`/`helmet`/`@nestjs/throttler` in `apps/api`. |
| **No global exception filter (error leakage)** | Sec#11 | Low | **PRESENT** | No `useGlobalFilters`/`ExceptionFilter`. |
| **`ENCRYPTION_KEY`/env not fail-fast at boot** | Sec#6 | Med | **PRESENT (nuance)** | `createKeyEncryptor()` *does* throw on missing/wrong-length key (`crypto.ts:28,70`) but is called **lazily** (`activities.ts:69` lazy `getCredentials`). `env.ts` only runs `dotenv.config()`; `DATABASE_URL`/`TEMPORAL_ADDRESS` unvalidated. So there is a guard, but not a fail-fast boot check. |
| **SSRF + token exfiltration via connection `serverUrl`** | Sec#2 | High | **PRESENT** | `connection.service.ts:65` stores `input.serverUrl` with no scheme/allowlist/private-IP check; `mcp.ts:29` does `new URL(input.serverUrl)` and sends `headers` (Bearer token); `oauth.ts:225` follows discovery origin. No validation added. |
| **OAuth callback unauthenticated; weak tenant binding; no state TTL** | Sec#3, Arch§3.4 | High | **PRESENT** | `oauth.controller.ts` `GET /oauth/callback` unauthenticated; tenant taken from `state` prefix (`tenantFromState`). The "Unknown or expired OAuth state" message (`oauth.ts:334`) fires on a missing row only — there is **no `expiresAt`/TTL** on stored state; the `expiresAt` in `oauth.ts:129/194` is the access-token cache, not the consent state. |
| **OAuth-state + webhook-dedupe rows grow unbounded; no cleanup** | Sec#9, QA#10, Arch§3.4 | Low | **PRESENT** | `WebhookDelivery` has `@@unique([endpointId,deliveryId])` but no `expiresAt`/sweeper; OAuth-state rows never pruned. |
| **Secret table overloaded (provider key / conn token / OAuth state in one table+column)** | Arch§3.3 | Med | **PRESENT** | `SecretStore` reuses `TenantCredential.provider` for `conn:<id>` and `oauth-state:<state>`; `put` always writes `isValid:true`. |
| **Single static key — no rotation/versioning, no AAD** | Sec#7, Arch§3.5 | Med | **PRESENT** | `EncryptedPayload` (`crypto.ts:4`) has no `keyVersion`; no `cipher.setAAD(...)`. |
| **Webhook signing secret stored plaintext** | Sec#8, Arch§3.6 | Med/Low | **PRESENT** | `schema.prisma:22` `signingSecret String` plain column. |
| **Usage ledger not idempotent → double-bill + re-call LLM on retry** | QA#3, Arch§4.2 | High | **PRESENT** | `UsageEvent` has `@@index([executionId])` but **no `@@unique([executionId,nodeId])`** (`schema.prisma:75–91`); activity retry (`maximumAttempts:3`) re-runs `runAgent` whole. |
| **Cached input tokens double-billed** | QA#2 | High | **PRESENT (unmitigated risk)** | `pricing.ts:computeCost` bills `inputTokens` full-rate **plus** `cachedInputTokens` cache-rate as separate buckets; `activities.ts` passes both with no subtraction. Real if `inputTokens` includes cached — no test pins the semantics. |
| **`downgrade` policy doesn't re-validate fallback model** | QA#6 | Med | **PRESENT** | `activities.ts` sets `model = budget.fallbackModel` with no re-estimate and no `MODEL_PRICING` membership check (unpriced fallback → spend then `UnknownModelPricingError`, compounding the retry bug). |
| **Provider error rethrown bare → secret can leak into Temporal history/logs** | Arch§3.2 | High | **PRESENT** | `activities.ts` catch ends `throw e;` with no sanitization; an `APICallError` 5xx/timeout (the transient branch) can carry request headers into serialized failure/history. No no-secret-in-failure test. |
| **Single hardcoded agent output schema for every node** | QA#9, Arch§4.4 | Med | **PRESENT** | `activities.ts` `outputSchema` is a fixed `{category,urgency}`; B5 "review" node emits a classification object as the PR comment body. |
| **`GET /executions/:id` returns 500 (not 404) for unknown/closed runs** | QA#11 | Med | **PRESENT** | `executions.service.getState` queries the handle with no `WorkflowNotFoundError`→404 mapping. |
| **`POST /executions` can't accept real input** | QA#12 | Low | **PRESENT** | `executions.service.ts:51` hardcodes `{ message: "I was charged twice this month" }`. |
| **Spend/usage aggregation loads all rows into memory** | QA#13 | Low | **PRESENT** | `spend.ts:10` `findMany`+`reduce`; `usage.service.ts:48` `findMany`. No `aggregate`/`groupBy`. |
| **`ConnectionService.setStatus` not tenant-scoped** | Arch§3.7 | Low | **PRESENT** | `connection.service.ts:94` `update({ where: { id } })` — no `tenantId`. |
| **`ctx` accumulates all node outputs and is returned/queryable** | Arch§4.8 | Low | **PRESENT** | `runGraph` keeps every node output in `ctx`; `stateQuery` returns it whole. |
| **No `$disconnect` / DB lifecycle cleanup on shutdown** | Arch§4.9 | Low | **PRESENT** | No `$disconnect`/`onModuleDestroy` in `packages/db` or `apps/worker`. |
| **No interpreter versioning (`patched`/Worker Versioning) + no replay test** | Arch§4.5 | Med | **PRESENT** | No `workflow.patched()` / Build IDs; no replay-from-history test (grep: none). |
| **MCP tool calls unmetered; large results can exceed 2MB payload** | Arch§4.6 | Med | **PRESENT (partly by design)** | `mcpTool` case adds `stepCount` only, no cost; no claim-check for large outputs. |
| **Graphs hardcoded; Postgres doesn't own definitions (Slice #5 unbuilt)** | QA#5, Arch§4.1 | High (known) | **PRESENT (deferred)** | No `GraphDefinition` model; `schema.prisma:19` "graphs are hardcoded for now"; runtime uses `getGraphForWorkflow`/`graphRegistry`. Matches the still-unstarted `PLAN-SLICE-5.md`. |
| **Circuit breaker can't fire with linear `walk()`** | QA#7 | Med | **PRESENT (by design until Slice #6)** | `walk()` is linear + cycle-throwing; the step cap only trips on a >50-node hand-authored chain. |
| **`walk()` throw inside workflow → infinite workflow-task retries** | QA#8 | Med | **PRESENT** | No pre-start graph validation; no in-workflow catch → a cyclic/dangling graph wedges the run. |
| **Budget cap overshoot windows (per-exec checked after; monthly no reservation)** | Arch§4.3 | Med | **PRESENT (partly by design)** | `workflows.ts` checks `perExecutionCapUsd` at top of loop against already-accrued cost; monthly pre-flight has no reservation/lock. |
| **OAuth refresh lock is in-process only** | Arch§4.7, QA(verified) | Med (known) | **PRESENT (documented)** | `accessCache`/`inflight` in `oauth.ts` are process-local; multi-worker races acknowledged in README. |
| **Prompt injection via untrusted webhook payload** | Sec#10 | Low | **PRESENT (inherent)** | Webhook body → `prompt: JSON.stringify(input)` and into MCP tool args. |
| **Stale schema header/comments** | QA#14 | Low | **PRESENT** | `schema.prisma:1` "Slice #2"; line 19 "hardcoded for now". |
| **Observability is `console.log` only** | Arch§5 | Op gap | **PRESENT** | No structured logging/metrics/tracing. |

**Tally: 0 fixed / 32 present** (of which ~6 are acknowledged by-design/deferred, not regressions).

---

## Suggested order if you want these addressed

Both reviews converge on the same top tier:

1. **Auth + per-tenant authorization** (derive `tenantId` from principal; tenant-scope
   `executions/:id` approve/getState) — the release blocker. *(Sec#1/QA#1/Arch§3.1)*
2. **Sanitize provider errors before rethrow** + a no-secret-in-failure test — protects
   the headline secrets-out-of-Temporal guarantee. *(Arch§3.2)*
3. **Usage idempotency** (`@@unique(executionId,nodeId)` + upsert; gate LLM call) — stops
   double-bill/double-spend. *(QA#3/Arch§4.2)* — pairs with cached-token semantics *(QA#2)*.
4. **Global `ValidationPipe` + DTOs** — cheap; removes the approve→reject footgun. *(QA#4)*
5. **`serverUrl` egress lockdown** (https + host allowlist + block private IPs/rebinding)
   and **OAuth state session-binding + TTL**. *(Sec#2, Sec#3)*
6. Lower-severity cleanup: CORS/helmet/rate-limit, exception filter, env fail-fast,
   key versioning + AAD, encrypt webhook secret, dedupe/state TTL, 404 mapping, spend
   aggregates, `setStatus` scoping, Prisma `$disconnect`, schema-comment refresh.

Items #4.1 (graph persistence) and #4.5 (interpreter versioning) are genuinely future
slices — Slice #5's plan already exists in `PLAN-SLICE-5.md`.

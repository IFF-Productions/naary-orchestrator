# Audit Remediation — 2026-07-04

Status of every finding from the [2026-07-04 audit](./README.md). "Fixed" items were
implemented + tested; "Deferred" items have a rationale and are tracked, not silently
dropped.

## Security

| # | Sev | Status | Where |
|---|-----|--------|-------|
| S-1 | High | **Fixed** — PR #102 | `safeFetch` guarded undici connector re-validates every redirect hop |
| S-2 | Med-High | **Fixed** — PR #102 | same connector resolves once + pins the validated IP (no TOCTOU) |
| S-3 | Med | **Fixed** — PR #102 | `callSqlQuery` → `dsnHost` + `assertHostPublic` before connecting |
| S-4 | Low | **Fixed** — PR #103 | ingress rejects unsigned requests before the DB read/decrypt |
| S-5 | Low | **Fixed** — PR #103 | `startConsent` sweeps abandoned `oauth-state:` rows by age |
| S-6 | Low | **Deferred (tracked)** | single master key → KMS/per-tenant DEK. The `KeyEncryptor` interface + `keyVersion` are the seam; a deliberate, pre-existing roadmap item, not a regression. |
| S-7 | Info | **Accepted** | MSSQL read-only is always-rollback (weaker than PG `READ ONLY`); tenant querying their own DB — robustness note. |
| S-8 | Info | **By design** | prompt injection from a webhook payload into an agent node — inherent to "run an LLM over inbound events"; mitigated at the product level (output schema, least-privilege tools). |

## QA

| # | Sev | Status | Where |
|---|-----|--------|-------|
| Q-1 | Med | **Fixed** — PR #104 | verified control-flow coverage; added the humanApproval **timeout auto-reject** + the **diamond-merge replay** determinism tests (the two gaps). |
| Q-2 | Med | **Accepted** | `respondToWebhook` poll timing — the e2e asserts authoring, not a tight-deadline body, so no flake surface. Revisit if a body-asserting e2e is added. |
| Q-3 | Low | **Deferred (tracked)** | `forEach` cost-cap overshoot (concurrent children share one cap snapshot). Bounded (≤100× cap). Fold into the A-3 concurrency-window change. |
| Q-4 | Low | **Fixed** — PR #104 | diamond fan-out → merge replay test guards the concurrent-arrival-order invariant (see A-2). |
| Q-5 | Low | **Deferred (tracked)** | re-verify `runAgent` billing edge-cases (missing-usage fallback, `totalUsage` vs `usage`, retry double-write) + usage aggregation is a SQL SUM. A focused pass; CLAUDE.md rule 6 is the spec. |
| Q-6 | Info | **Accepted** | e2e is a non-blocking self-hosted job by design; `verify` (typecheck+test+build) is the required gate. |

## Architecture

| # | Status | Where |
|---|--------|-------|
| A-1 | **Deferred (tracked)** | node-type defs spread across ~5 files → a node-definition registry. A real refactor; do it **before** the next big node push, not mid-audit. Highest-leverage debt item. |
| A-2 | **Fixed** — PR #104 | merge fan-in determinism now guarded by the diamond replay test (Q-4). |
| A-3 | **Deferred (tracked)** | `forEach` up to 100 concurrent children — a concurrency window (chunked fan-out) + the Q-3 cap divisor. Caps prevent runaway; relevant to worker capacity planning. |
| A-4 | **Fixed** — PR #<this> | `Execution @@index([tenantId, createdAt])` (Runs list filter+sort) and `WebhookDelivery @@index([endpointId, createdAt])` (retention prune range). GraphDefinition's unique already covers its hot path. |

## Not covered by the audit (still open)

Called out in the audit's scope limits — worth a dedicated pass, not addressed here:
dependency CVE/SCA scan; web XSS surface + nginx CSP on run `ctx` (attacker-influenced
webhook data); MCP client internals; the SecretStore backend; and — highest priority —
the **Firebase tenant-claim provisioning path** (`set-tenant-claim.ts`): a loose
claim-setter would let a user self-assign a tenant and would outrank every finding above.

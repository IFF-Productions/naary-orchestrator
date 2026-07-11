# Architecture Review — naary-orchestrator

**Reviewer role:** Solution Architect
**Date:** 2026-06-25
**Scope reviewed:** Slices #1–#4 as merged on `main` (durable interpreter, BYOK
secrets + spend, budget enforcement, external integrations). The React Flow canvas
(Slice #5) is not yet built.

**Method:** Static review of the monorepo against the stated architecture
(`CLAUDE.md`, `README.md`, `PLAN*.md`) and against general distributed-systems /
multi-tenant-SaaS best practice. Findings are rated by impact on **correctness,
security, and the project's own stated requirements** — not style.

---

## 1. Executive summary

The core architectural bet is sound and well executed. The "one generic Temporal
workflow interprets graph **data**" pattern is implemented cleanly, the
deterministic-workflow / side-effects-in-activities boundary is respected and
defended (type-only activity import, edit-time hooks, replay-safe traversal), and
the "secrets never enter Temporal" principle is correctly realized by fetching and
decrypting provider keys **inside** the activity. Documentation is unusually honest:
most of the limitations below are acknowledged somewhere in the README. The package
decomposition (`dsl`, `contracts`, `secrets`, `usage`, `connections`, `db`) is clean
and the dependency direction is correct.

The architecture is in good shape **as a vertical-slice prototype**. The gaps that
matter are the ones that block it from being a multi-tenant production service:

- **No authentication or authorization anywhere.** `tenantId` is an unauthenticated
  path/body parameter and execution control endpoints are not tenant-scoped at all.
  This is the single most important finding (§3.1) and it directly undermines the
  multi-tenant + BYOK + human-approval-before-merge model.
- **A real path for a tenant secret to leak into Temporal history** via bare-rethrown
  provider errors, which contradicts the project's headline security guarantee (§3.2).
- **The "Postgres owns definitions" half of the data model is not realized** — graphs
  are hardcoded in code, so the system cannot yet do the thing the product is for
  (user-authored workflows). Known, but it's the central architectural debt (§4.1).
- A cluster of **secret-store design issues** (table overloading, no key rotation /
  versioning, ephemeral OAuth state with no TTL) that should be fixed before more
  secret types pile onto the same table (§3.3–§3.5).

None of these are reasons to change the core design. They are the next architectural
slice.

---

## 2. What is done well (keep doing this)

- **Interpreter, not codegen (Tier-1 rule 1).** `runGraph` walks `walk(graph)` over
  graph data; node types are a `switch`. New node types are additive. Correct.
- **Determinism boundary is real and defended.** `workflows.ts` imports activities
  with `import type` only; `@naary/db`/`secrets`/`usage` never reach the workflow
  bundle; `walk()` is pure and cycle-guarded; cumulative budget/circuit state is
  driven only by activity-returned values and a counter, never a DB read. The
  edit-time hooks in `.claude/hooks` add defense-in-depth.
- **Secrets-out-of-Temporal is correctly implemented.** Only `tenantId` /
  `connectionId` / node config flow through workflow args; keys and tokens are
  fetched and used inside activities and never returned.
- **Billing fail-safe and error semantics** match the rules: `totalUsage` over
  `usage`, a non-zero fallback estimate when usage is missing, `401/403/429` mapped
  to **non-retryable** `ApplicationFailure` so retries aren't burned on a bad key.
- **Clean package boundaries** with a client-safe `contracts` package and a swappable
  `KeyEncryptor` interface (KMS-ready). `ai` pinned exact, per the v6 usage bug.
- **Crypto primitives are correct:** AES-256-GCM, 96-bit random IV per message, auth
  tag verified on decrypt (tamper detection), key-length checked at construction.
- **Webhook ingress is solid:** HMAC over the **raw** body, length-guarded
  `timingSafeEqual`, dedupe via a DB unique constraint (P2002), verify-before-dedupe
  ordering, fail-closed for unimplemented providers.
- **Honest, decision-logged documentation.** The READMEs record trade-offs and known
  gaps rather than hiding them — this materially lowers maintenance risk.

---

## 3. Findings — security & multi-tenancy

### 3.1 — CRITICAL: no authentication or authorization; tenant isolation is unenforced

Every control-plane endpoint trusts a caller-supplied `tenantId` and applies no
authentication or authorization:

- `POST /tenants/:id/credentials`, `PUT /tenants/:id/budget`,
  `GET /tenants/:id/usage`, `POST /tenants/:id/connections`,
  `POST /tenants/:id/webhooks` — `:id` is taken at face value. Any caller can write a
  provider key for, set a budget for, or read the spend of **any** tenant.
- `POST /executions` takes `tenantId` from the request body.
- **Worse: the execution endpoints are not tenant-scoped at all.**
  `GET /executions/:id` and `POST /executions/:id/approve` operate on a raw
  Temporal `workflowId` with no tenant check. Anyone who knows/guesses a workflow id
  can read its state **or approve it**.

Why this is the top finding: human approval is described as the security gate before
irreversible MCP actions (e.g. "human approval before any merge" in the GitHub-review
flow). An unauthenticated `approve` endpoint means that gate can be tripped by anyone,
and the BYOK model means one tenant could register a key under another tenant's id, or
read another tenant's usage. No NestJS `Guard`, `ValidationPipe`, or auth middleware
exists in `apps/api` (verified by search).

PLAN #1 explicitly deferred auth ("no auth, no multi-tenancy") — that was correct for
the spine slice. But the system has since grown full multi-tenant surface area
(`tenantId` everywhere) without the corresponding authn/authz. The deferral is now the
gap.

**Recommendation (architectural):**
1. Introduce an authentication layer (API key / OIDC / session) that resolves a
   trusted principal → `tenantId`. Derive `tenantId` from the authenticated principal,
   **never** from the path/body.
2. Add an authorization guard so `GET/approve /executions/:id` verify the execution
   belongs to the caller's tenant. Encode `tenantId` in the workflow id (already
   prefixed `exec-<tenantId>-…`) **and** verify it server-side, or store an
   execution→tenant record and check it.
3. Add a global `ValidationPipe` + DTOs with `class-validator`; controllers currently
   accept untyped `body` and will 500 on malformed input.

### 3.2 — HIGH: tenant provider keys can leak into Temporal history/logs via rethrown errors

`runAgent` deliberately rethrows genuinely-transient provider errors **bare** (comment:
"AI-SDK errors can carry request headers incl. the key"). The intent is right, but the
mechanism does not achieve it: when an activity throws, **Temporal serializes the error
(message, stack, and often `cause`/details) into workflow history and the worker logs**.
`APICallError` from the AI SDK can carry `requestBodyValues`, URL, and header material.
A 5xx/timeout is exactly the "transient" branch that rethrows bare — so a provider error
that embeds the `Authorization` header could land in durable Temporal history, directly
violating the project's headline guarantee ("secrets never enter Temporal … never put in
a span").

**Recommendation:** Before rethrowing, **sanitize**. Convert provider errors into a
purpose-built error that copies only `statusCode` + a safe message and explicitly drops
headers/body/request fields, while preserving retryability (don't convert transient to
non-retryable). Add a test asserting a thrown error's serialized form contains no
`sk-`/`Bearer` material. Consider a custom Temporal `DataConverter`/failure scrubber as
defense-in-depth.

### 3.3 — MEDIUM: the credential table is overloaded with three different secret kinds

`SecretStore` reuses `TenantCredential` (keyed by `(tenantId, provider)`) to store
**connection tokens** (`conn:<id>`) and **ephemeral OAuth state** (`oauth-state:<state>`)
by stuffing them into the `provider` column. Consequences:

- Semantic collision risk: a literal provider named `conn:…` would clash; the `provider`
  column no longer means "provider."
- `SecretStore.put` always writes `isValid: true`, while `CredentialsService` treats
  `isValid` as "key passed validation." The same column now has two meanings.
- Long-lived secrets and throwaway state share one table and lifecycle.

**Recommendation:** Split storage by concern: a `Secret` table keyed by
`(tenantId, scope, key)` (or distinct tables for `ProviderCredential`,
`ConnectionSecret`, `OAuthTransientState`). Keep the `KeyEncryptor` shared; separate the
schemas.

### 3.4 — MEDIUM: ephemeral OAuth state has no TTL/expiry

`startConsent` writes `oauth-state:<state>` rows that `completeConsent` deletes on the
happy path. Abandoned consents (user closes the tab, callback never fires) leave rows
forever. The code/README refer to "expired OAuth state," but **nothing expires it** —
there is no `expiresAt` and no sweeper. These rows hold a PKCE verifier + client creds.

**Recommendation:** Add `expiresAt` to transient state, reject/ignore expired state on
callback, and add a periodic cleanup (a Temporal Schedule fits the stack). This pairs
naturally with §3.3.

### 3.5 — MEDIUM: single encryption key with no versioning or rotation path

`EncryptedPayload` stores `ciphertext/iv/authTag` but **no key id/version**. Rotating
`ENCRYPTION_KEY` would make every stored secret undecryptable; there is no
re-encryption path and no envelope/per-tenant data key. The `KeyEncryptor` interface is
KMS-swappable (good), but the at-rest format isn't rotation-ready.

**Recommendation:** Add a `keyVersion` (or KMS key-arn) column to the encrypted record
now, while the data set is tiny. Decrypt by stored version; encrypt with current. This
unblocks rotation and a future envelope-encryption / KMS migration without a format
break.

### 3.6 — LOW: webhook signing secret stored in plaintext

`WebhookEndpoint.signingSecret` is a plaintext column (acknowledged in code as "plain
per plan"). It's an HMAC secret and inconsistent with the otherwise encrypt-everything
posture; a DB read discloses it. Low severity (it's not a provider credential) but worth
aligning: encrypt it with the same store, or document the accepted risk explicitly.

### 3.7 — LOW: `ConnectionService.setStatus` is not tenant-scoped

`setStatus(id, status)` updates `where: { id }` with no `tenantId`. Today ids are UUIDs
and callers are internal, so impact is low, but it's the one connection mutation that
breaks the otherwise-consistent tenant-scoping convention. Scope it by tenant for
consistency and defense-in-depth.

---

## 4. Findings — correctness, data model & runtime

### 4.1 — HIGH (known): graph definitions are hardcoded; "Postgres owns definitions" is unrealized

The schema persists credentials, usage, budgets, connections, and webhook endpoints —
but **not graphs**. `sampleGraph`, `webhookSampleGraph`, and `githubReviewGraph` live in
`@naary/dsl`, and `getGraphForWorkflow` resolves a webhook's `workflowId` against an
in-code `graphRegistry`. So the product's core promise (users author workflows on a
canvas → DSL → interpreter) is not yet expressible: there is no graph table, no
versioning, no content-hash snapshot at execution start (a `CLAUDE.md` convention).

This is explicitly the next slice, so it's debt rather than a defect — but it's the
**central** architectural debt, and several other limitations (webhook→graph mapping,
per-node agent schema in §4.4) are downstream of it.

**Recommendation for the next slice:** a `GraphDefinition` table with immutable
versions + a content hash; `POST /executions` snapshots the version and passes the
resolved graph as a workflow arg (the start already does this for the hardcoded graph,
so the interpreter side is ready). Version the **interpreter** separately via
`workflow.patched()` / Worker Versioning (§4.5).

### 4.2 — MEDIUM (known): usage ledger has no idempotency key → double-bill + double-LLM-call on retry

`UsageEvent` has no unique `(executionId, nodeId)` (or attempt) constraint. If the
activity fails **after** the model call (e.g. the `recordUsage` write throws, or a
worker dies post-call), Temporal retries the whole activity — re-calling the LLM and
writing a second `UsageEvent`. This both over-bills and double-spends the tenant's key.
The README acknowledges it.

**Recommendation:** Make the activity idempotent. Add `@@unique([executionId, nodeId])`
(plus an attempt/idempotency token) and upsert; ideally gate the LLM call on a
"already-recorded?" check so retries don't re-call the model. This is the highest-value
correctness fix after auth.

### 4.3 — MEDIUM: budget enforcement has structural overshoot windows (partly known)

Three issues, two acknowledged:
- **Per-execution cap is checked at the top of the loop** against cost already
  accumulated, so a single agent call can push spend past `perExecutionCapUsd` and only
  the **next** node halts. The cap is a "stop after exceeding," not a "never exceed."
- **Monthly cap pre-flight has no reservation/locking** → concurrent runs for one tenant
  can overshoot (acknowledged).
- **MCP tool nodes have no cost accounting** (see §4.6), so spend via tools is invisible
  to both caps.

For a product whose differentiator includes cost control, "caps can be exceeded by a
bounded amount" should be a deliberate, documented contract.

**Recommendation:** Document the overshoot bound explicitly; for the monthly cap, move
toward an atomic reserve-then-reconcile (ledger reservation row) as a fast-follow.

### 4.4 — MEDIUM: a single hardcoded output schema is applied to every agent node

`runAgent` always coerces model output to `{ category, urgency }` via one
`outputSchema` baked into the activity. Every agent node — "classify a message,"
"review a PR," "summarize an event" — is forced into the same shape. This won't survive
real multi-purpose workflows and couples the activity to one use case.

**Recommendation:** Carry the output schema (or a schema ref) in node config and pass it
to the activity, so the interpreter routes per-node schemas. Pairs with §4.1.

### 4.5 — MEDIUM: no interpreter versioning strategy (`patched`/Worker Versioning)

`CLAUDE.md` calls for versioning interpreter changes with `workflow.patched()` / Worker
Versioning, and the differentiator is **long-running** flows (days). Any change to
`runGraph`/`walk` traversal logic risks nondeterministic replay for in-flight runs.
Today there is a single task queue, no Build IDs, and no `patched()` usage.

**Recommendation:** Adopt Worker Versioning / Build IDs before the interpreter evolves,
and establish a `patched()` discipline. Add a **replay test from recorded histories**
(the authoritative determinism guard per `CLAUDE.md`); the current e2e is a fresh run,
which does not catch replay regressions.

### 4.6 — MEDIUM (partly known): MCP tool nodes are unmetered and unbounded in payload

`callMcpTool` results flow into `ctx[node.id]` and are returned through the workflow.
Two issues: (a) no cost/billing accounting (only `stepCount`), so tool spend escapes the
budget system; (b) results can exceed Temporal's ~2MB payload cap (acknowledged) — large
results should be claim-checked to object storage with a reference passed.

**Recommendation:** Add a claim-check pattern for large activity outputs and a basic
tool-call accounting hook; both are also relevant to the long-running history-growth
concern.

### 4.7 — MEDIUM (known): OAuth refresh lock is in-process only

The access-token cache + per-connection refresh lock (`accessCache`/`inflight`) are
process-local. With multiple workers, concurrent refreshes race and, under refresh-token
rotation, can invalidate each other → `needs_reauth` storms. Acknowledged.

**Recommendation:** Serialize refresh through a durable point — a dedicated Temporal
workflow/activity per connection, or a distributed lock — before scaling out workers.

### 4.8 — LOW: `ctx` accumulates all node outputs and is returned/queryable

`runGraph` keeps every node's output in `ctx` for the run's lifetime and exposes it via
`stateQuery`. For long, many-node flows this grows event history and the query payload,
and (combined with no auth on the query, §3.1) exposes intermediate data. Bound what
`ctx` retains and what the state query returns.

### 4.9 — LOW: lifecycle / resource cleanup gaps

The Prisma client singleton is never `$disconnect`-ed on shutdown (worker closes the
Temporal connection but not the pg pool). The worker's `createKeyEncryptor()` fail-fast
at boot is good; mirror a DB connectivity check similarly. Minor, but tidy these before
production.

---

## 5. Cross-cutting / operational gaps

- **Observability.** Only `console.log`. For a durable, long-running, multi-tenant
  orchestrator this is the biggest *operational* gap after auth: no structured logging,
  metrics, or tracing. When adding tracing, enforce the rule that spans never carry
  secrets (related to §3.2). The web app has an Observability screen, but it's mock data.
- **Rate limiting / abuse controls.** None. Combined with §3.1, the credential-save and
  execution-start endpoints are open to abuse (and each agent run spends a real key).
- **Input validation.** No DTO validation layer (see §3.1.3).
- **Migrations/runtime config.** `DATABASE_URL`/`ENCRYPTION_KEY` are required at boot
  (good). Confirm `.env` is git-ignored (it appears to be — only `.env.example` is
  tracked) and that production secret delivery is documented.

---

## 6. Prioritized recommendations

| # | Priority | Finding | Action |
|---|----------|---------|--------|
| 1 | **Critical** | §3.1 No authn/authz, execution endpoints not tenant-scoped | Add auth layer; derive `tenantId` from principal; tenant-scope `executions/:id`; add `ValidationPipe` |
| 2 | **High** | §3.2 Secret leak into Temporal history via rethrown errors | Sanitize provider errors before rethrow; add a no-secret-in-failure test |
| 3 | **High** | §4.2 No usage idempotency → double-bill / double-LLM-call | `@@unique(executionId,nodeId)` + idempotent upsert; gate LLM call on prior record |
| 4 | **High** | §4.1 Graphs hardcoded; definitions not persisted | `GraphDefinition` table w/ immutable versions + content-hash snapshot at start |
| 5 | **Medium** | §3.3–§3.5 Secret-store overloading, no TTL, no key versioning | Split secret tables; add `expiresAt` + sweeper; add `keyVersion` for rotation |
| 6 | **Medium** | §4.5 No interpreter versioning + replay test | Worker Versioning / `patched()`; add history-replay determinism test |
| 7 | **Medium** | §4.3/§4.6 Budget overshoot + unmetered MCP + large payloads | Document cap contract; reservation for monthly cap; claim-check large outputs |
| 8 | **Medium** | §4.4 Single hardcoded agent output schema | Per-node schema in DSL config |
| 9 | **Medium** | §4.7 In-process OAuth refresh lock | Durable/serialized refresh before scaling workers |
| 10 | **Low** | §3.6/§3.7/§4.8/§4.9 + §5 | Encrypt webhook secret; tenant-scope `setStatus`; bound `ctx`/queries; lifecycle cleanup; observability; rate limiting |

---

## 7. Verdict

The riskiest, most defensible part of the system — a durable, crash-surviving,
human-in-the-loop graph interpreter with a clean secrets-out-of-Temporal boundary — is
implemented correctly and is the right foundation. The architecture earns the right to
keep going.

The blockers to "production multi-tenant service" are concentrated and addressable:
**authentication/authorization (§3.1)** and **error-path secret hygiene (§3.2)** are the
two security must-fixes; **usage idempotency (§4.2)** and **persisted, versioned graph
definitions (§4.1)** are the two correctness/product must-fixes. Most other items are
already acknowledged in the docs and fit cleanly as the next slice's scope. No core
redesign is warranted.

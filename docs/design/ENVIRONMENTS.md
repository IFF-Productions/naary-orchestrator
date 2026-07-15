# Environments (per-tenant sandbox / UAT / prod)

**Status:** design (doc-first). No schema/code changes land with this doc.
**Decisions taken (via product Q&A):** environments are **fully separate spaces** (each env owns
its own workflows, runs, credentials, connections, triggers), and a workflow moves between them by
**copy-on-promote with lineage** (build in sandbox → promote a copy to UAT → prod; each env's copy
binds to *that* env's credentials/connections).

Related: **RBAC** — a companion design (to land at `docs/design/RBAC.md`); today's workspace roles
live in [`docs/design/PROVISIONING-MULTIUSER.md`](./PROVISIONING-MULTIUSER.md). Environments make
several actions env-scoped permissions ("who can promote to prod"); the two are designed together and
this doc calls out the seam (§9).

---

## 1. Goal

A tenant can create N named environments (e.g. **Sandbox**, **UAT**, **Production**). Each is an
isolated space: its own workflow definitions, runs, schedules, trigger endpoints, credentials, and
connections. You build/test a workflow in one env and **promote** a copy forward. Editing sandbox
never affects prod until the next promote.

Non-goals (v1): per-env *billing caps* (billing rolls up per tenant — see §4), cross-env data
sharing, environment-level network policy.

## 2. The `Environment` entity

```prisma
model Environment {
  id        String   @id @default(uuid())
  tenantId  String
  name      String   // display: "Sandbox", "UAT", "Production"
  slug      String   // stable, header/URL-safe: "sandbox", "uat", "prod"
  isDefault Boolean  @default(false) // exactly ONE per tenant — where legacy + un-scoped data lands
  createdAt DateTime @default(now())

  @@unique([tenantId, slug])
  @@index([tenantId])
}
```

**Default identity (single source of truth):** the default env is **the row with the reserved `prod`
slug**. `isDefault` is a **convenience flag kept in sync with that** (true iff `slug = "prod"`) — it
exists so a query/UI can filter on a boolean, but the `prod` slug is canonical. Both §4 (resolution)
and §5 (the shim) look the default up the same way: *the tenant's `prod`-slug row* (equivalently, its
`isDefault` row). There is exactly one, guaranteed three ways:
- `@@unique([tenantId, slug])` — at most one `prod` row per tenant;
- the service is the **sole writer** — it only ever creates a default via an idempotent upsert on
  `(tenantId, "prod")`, and never sets `isDefault=true` on any other row;
- a **partial unique index** `("tenantId") WHERE isDefault` (in the migration; not expressible in
  Prisma's DSL) enforces one default at the DB level as defense in depth.

Deleting an environment is refused if it is the default or still holds workflows/runs (a later slice
may offer archive).

## 3. Scope boundary — what is env-scoped vs tenant-level

This is the crux. Getting it wrong is expensive to unwind after the schema lands.

### Env-scoped (gain `environmentId`)
Definitions, execution state, triggers, and the secrets a run uses:

- `GraphDefinition` (the workflow definition — the thing promoted)
- `Execution`, `Schedule`, `PollState`, `PinnedData`, `ErrorHandler`, `WorkflowActivation`
- `WebhookEndpoint`, `FormEndpoint`, `ChatEndpoint`, `ChatMessage`, `VectorChunk`, `WebhookDelivery`
- `Connection`, `TenantCredential` — **separate creds/connections per env** (a sandbox run uses test
  keys; prod uses live keys). This is what makes environments *meaningfully* separate; it's also why
  promote does **not** copy them (§6).
- `NotificationChannel` / `NotificationSettings` — a sandbox failure must not page prod's Slack.

All composite keys/uniques gain `environmentId`, e.g.
`@@unique([tenantId, workflowKey, version])` → `@@unique([tenantId, environmentId, workflowKey, version])`.

### Tenant-level (unchanged — workspace scope, not env scope)
- `Member`, `Membership`, `TenantSettings`, `UserPreference`, `AuditEvent` — who's in the workspace
  and their settings; roles are workspace-wide (RBAC layers env-scoped *permissions* on top).
- Billing: `TenantBudget`, `UsageEvent`, `UsageReservation` — **one bill per tenant**. `UsageEvent`
  gains an `environmentId` **tag** (for per-env cost visibility) but budget caps stay tenant-level.

### The load-bearing exception: `ApiToken` (and trigger endpoints) MUST bind to an env
An external caller hitting `POST /hooks/:id` (or a form/chat surface) authenticates with an
`nry_` token and **starts a run** — which must land in exactly one environment. The external caller
cannot send `X-Environment-Id`. If the token/endpoint were env-agnostic, every triggered run would
silently land in the default env (prod) — the "sandbox test fires prod" footgun.

Design: **the trigger endpoint carries the `environmentId`** (a webhook registered in sandbox fires
sandbox runs; the prod webhook fires prod runs). The endpoint is created within an env context, so
its `environmentId` is intrinsic. `ApiToken` also gains an **optional** `environmentId` (a token's
*default* target env — e.g. a CI token scoped to sandbox); when a token starts a run via a
non-endpoint route it uses its bound env, else the tenant default.

**Consistency rule:** when a token triggers an endpoint, the run's env = **the endpoint's env**
(the resource being invoked wins). If the token is env-bound and disagrees with the endpoint's env,
reject (a sandbox-scoped token may not fire a prod endpoint). This keeps a scoped token from
reaching across environments. **Confirmed (§8): the endpoint's env wins.**

## 4. Env resolution (request → environment)

Mirrors the existing workspace resolution (`X-Workspace-Id` → `Principal.tenantId`, membership-
checked in `AuthGuard`):

- New header `X-Environment-Id`. **Resolution contract (deterministic):** trim the value, then try an
  exact **`id`** match first; only if that misses, try the (lowercased) **`slug`** — two ordered
  lookups, never an ambiguous `OR`. (A uuid *is* `[a-z0-9-]`, but a slug is capped at 32 chars while a
  uuid is 36, so a slug can never equal an id; the id-first order removes any doubt regardless.) A
  value that matches neither is an **error** (never a silent fallback — that would cross envs).
  **Absent** → the tenant's default (`prod`-slug) env. Resolved in `AuthGuard` → `Principal.environmentId`.
  (Implemented in `EnvironmentsService.resolveEnvId`, Slice 1.)
- The SPA gains an **environment switcher** (next to the workspace switcher) that sets the header,
  like `activeWorkspaceId` today.
- API-token principals resolve to the token's bound env (§3) or the default.

## 5. Migration strategy — compatibility shim, NOT an atomic mega-PR

**Evidence:** env-scoping touches ~15 models and **29 `workflowKey`-keyed query sites across 13
files** (api + worker; 91 `getPrisma()` call sites total). Converting every
`(tenantId, workflowKey)` query to `(tenantId, environmentId, workflowKey)` in one PR is a
high-risk, unreviewable change.

Instead:
1. **Backfill:** for each tenant, create a default `Production` environment; assign every existing
   env-scoped row to it. `environmentId` is added as **nullable first**, backfilled, then the
   composite keys are migrated — additive, reversible per step.
2. **Compatibility shim:** a resolver `resolveEnvId(tenantId, selected?)` that returns the selected
   env's id when given (validated to belong to the tenant), else **the tenant's default env id** —
   the `prod`-slug row per §2 (there is no `Tenant.defaultEnvironmentId` column), lazily created if
   absent. A query that hasn't yet been env-migrated
   (or a caller that sends no env) resolves to the default env — so existing behavior is byte-identical
   until a call site opts in. This lets the 29 sites migrate **incrementally, per slice**, each
   independently shippable + verifiable, instead of atomically. (Implemented in Slice 1,
   `EnvironmentsService.resolveEnvId`.)
3. Only once every call site is env-aware do we drop the nullable/default fallback (a late slice).

This shim is the single most important mechanic in the program: it converts a mega-PR into a
sequence of small, safe ones.

## 6. Promote (copy-on-promote + lineage)

Promote copies a workflow **definition** from a source env to a target env:

1. Read the source env's `GraphDefinition` (chosen version, default = latest).
2. Write it into the target env as a **new version** (content-hashed like a normal save; a no-op if
   the target already has that exact graph).
3. Optionally carry the workflow's pins / error-handler binding (config, not secrets).
4. **Do NOT copy** `TenantCredential` / `Connection` — the target env binds to its own. A promoted
   graph references connections *by role/key*; the target env must have matching connections
   configured (surface missing ones as a pre-promote checklist).

**Lineage — a dedicated `Promotion` audit row** (not just `sourceEnvironmentId` columns on
`GraphDefinition`), because RBAC wants "who promoted what, when" for enforcement + audit:

```prisma
model Promotion {
  id             String   @id @default(uuid())
  tenantId       String
  workflowKey    String
  fromEnvId      String
  toEnvId        String
  fromVersion    Int
  toVersion      Int      // the version created in the target env
  actor          String   // OIDC subject / api-token
  createdAt      DateTime @default(now())
  @@index([tenantId, workflowKey])
}
```

## 7. Slice plan

Each slice is independently shippable behind the §5 shim.

1. **Foundation** — `Environment` model + management API (list/create/rename/delete) + default-env
   backfill + `Principal.environmentId` resolution (`X-Environment-Id`) + the `envId ?? default`
   shim. **No data env-scoped yet** — purely additive; existing behavior unchanged.
2. **Workflows** — env-scope `GraphDefinition` (+ pins/error-handler/activation); the SPA env
   switcher; the graphs/executions read paths become env-aware.
3. **Promote** — the copy-on-promote flow + `Promotion` lineage + the missing-connections checklist.
4. **Triggers + tokens** — env-bind `Webhook/Form/Chat` endpoints + `ApiToken`; enforce the §3
   consistency rule so a triggered run lands in the endpoint's env.
5. **Credentials + connections** — env-scope `TenantCredential` / `Connection`.
6. **Notifications + usage** — env-scope `NotificationChannel`; tag `UsageEvent` with `environmentId`.
7. **Cleanup** — drop the nullable/default fallback once all call sites are env-aware.

## 8. Decisions (confirmed — was "open before Slice 1")

- **Token ↔ endpoint env consistency (§3): ENDPOINT's env wins.** A triggered run lands in the
  endpoint's environment; an env-bound token may only fire endpoints in its own env (else rejected),
  so a sandbox-scoped token can never reach prod.
- **Default env name: "Production"** (slug `prod`) — existing data is live/prod.
- **Env switcher: per-user active env** (persists across the app, like the workspace switcher);
  `Principal.environmentId` from `X-Environment-Id`, defaulting to the tenant's default env.

## 9. RBAC seam

Environments make several actions env-scoped permissions (owned by RBAC, designed together):
- `promote:prod` — only certain roles may promote *to* the production env.
- `env:create` / `env:delete`.
- run/edit within an env may itself be role-gated per env (e.g. read-only in prod).
The `Promotion` audit row (§6) is the enforcement + audit substrate.

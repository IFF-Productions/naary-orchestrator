# Design — Public API + CLI (`naary` — programmatic control plane)

**Status:** proposed · **Date:** 2026-07-17 · **Purpose:** publish a **stable, versioned,
documented** REST surface (`/api/v1`) over naary's control plane, plus a `naary` CLI on top of
it, so workflows can be driven from CI/CD, scripts, and terminals — not only the SPA and MCP
agents.

This is the "**Control Naary via API / CLI**" row of [ROADMAP-ENTERPRISE.md](../ROADMAP-ENTERPRISE.md#a-api--cli-control)
(§A). It is **hardening, versioning, docs, and a thin CLI** — almost none of the underlying
machinery is new. The NestJS controllers, the `nry_` token auth, the Swagger/OpenAPI pipeline,
and even the rate limiter already exist; the work is drawing a **stable contract** around them
and shipping a client.

It composes with, but is distinct from, [MCP-SERVER.md](./MCP-SERVER.md): MCP is the
*agent-native* interface (a toolset an LLM discovers and calls); the public REST API is the
*developer-native* interface (a curl/CLI/SDK surface for humans and CI). Both wrap the **same
services** with the **same `nry_` token auth** and the **same tenant isolation**.

---

## 1. What already exists (grounded)

The public API is a re-packaging exercise. Everything below already ships:

- **Token auth built for machines.** `apps/api/src/auth/api-token.service.ts` mints
  `nry_<base64url>` tokens (sha256-hashed at rest, plaintext shown once) and `verify(token) →
  { tenantId, environmentId }`. The global `apps/api/src/auth/auth.guard.ts` is dual-auth: an
  `nry_` bearer authenticates a **non-human principal for exactly one tenant**
  (`role: "owner"`), resolving `tenantId` **server-side from the token** — no `tenantId` ever
  travels in a request body or path for token callers. `POST/GET/DELETE /tokens`
  (`apps/api/src/auth/tokens.controller.ts`) already mints/lists/revokes them.
- **Workspace + environment scoping via headers.** `X-Workspace-Id` and `X-Environment-Id`
  (auth.guard.ts:24–27). A token bound to an environment carries it authoritatively; an
  env-bound token that *also* sends `X-Environment-Id` is **rejected** (auth.guard.ts:141) —
  a constraint the CLI must respect (see §6).
- **OpenAPI already published.** `apps/api/src/main.ts:74–98` wires `@nestjs/swagger`: an
  interactive UI at `/docs` and the **machine-readable schema at `/docs-json`**, with a single
  bearer scheme marked required on every operation. A house helper
  (`apps/api/src/swagger/api-decorators.ts` — `@ApiEndpoint`, `@ApiStandardErrors`) keeps each
  route one line and documents the standard 400/401/403/404/500 bodies.
- **Rate limiting already wired.** `@nestjs/throttler` is global in
  `apps/api/src/app.module.ts:42` (`120 req / 60 s`) with per-route `@Throttle` overrides
  (e.g. `forms.controller.ts`, `chat.controller.ts`). It is **per-IP** today — per-*token*
  keying is the one genuinely new rate-limit piece (§7).
- **The controllers themselves.** Executions, graphs, variables, secrets, usage — all already
  exist as NestJS controllers backed by services (§4). The public API mostly *blesses* these.

> **The one thing that does NOT exist yet:** a *stable versioned contract*. The API has no
> global prefix (`grep setGlobalPrefix` → nothing) and Swagger reports version `0.1.0`. Today's
> routes are internal — the SPA (`apps/web/src/lib/api.ts`) and webhooks call them directly, and
> they churn freely. Turning any of them into `/api/v1` is a **promise not to break them**.

---

## 2. Goal & motivation

MCP + tokens already let an *agent* operate naary. The gap this closes is **everything that
isn't an LLM agent**:

- **CI/CD** — promote a workflow, kick a run, and gate a pipeline on its result from a GitHub
  Action or Jenkins step (`naary runs watch --exit-code`).
- **Scripting / glue** — `curl`-able, `jq`-able JSON for ops runbooks and cron jobs.
- **Infra-as-code** — export/import workflow definitions to version them in git.
- **A real CLI** — `naary workflows run refund --input @payload.json` from a terminal.

The differentiator is unchanged (CLAUDE.md): a run started over the API is **durable** — the
CLI process can exit and the multi-day, human-in-the-loop run survives. `naary runs watch` is
just reconnecting to Temporal-owned state.

---

## 3. Auth model — REUSE, do not reinvent

**No new auth.** The public API is the existing `nry_` bearer token, full stop.

```
Authorization: Bearer nry_<...>        # required on every request
X-Workspace-Id:  <tenantId>            # optional; the token already implies its one tenant
X-Environment-Id: <environmentId>      # optional; forbidden if the token is env-bound
```

- **`tenantId` is resolved server-side from the token** (`ApiTokenService.verify`); it is
  **never** a body field or path segment for a token caller. This is CLAUDE.md Tier-1 §4 and
  the cross-tenant isolation invariant — carry it verbatim.
- **Workspace scoping** is the `X-Workspace-Id` header. For a token that owns exactly one
  tenant it's redundant (the guard rejects a mismatch, auth.guard.ts:134); we keep it for
  symmetry with the SPA and forward-compat with multi-workspace tokens.
- **Environment scoping** is `X-Environment-Id` **or** an env-bound token — never both.
- **Token scope is coarse today** (`role: "owner"` — full read/write/destroy). Finer scopes
  (run-only, workflow allow-lists, RBAC) are an **open question** (§12), the same one
  MCP-SERVER.md §10 raises. v1 ships owner-scoped tokens; we do not imply otherwise.

Publishing `/api/v1` does **not** change how tokens are minted — `POST /tokens` already does it.
A later slice adds a CLI-friendly `naary auth login` that stores a token you pasted (§6).

---

## 4. API surface (`/api/v1`)

The public surface is a **curated router** over the existing services (see §5 for why a curated
module beats reprefixing the whole app). Almost every row **already exists** — the "New work"
column is the honest delta.

### 4.1 Workflows (graphs) — backed by `apps/api/src/graphs/graphs.controller.ts`

| Public route | Maps to | New work |
|---|---|---|
| `GET /api/v1/workflows` | `GET /graphs` (`list`) | rename `graphs`→`workflows` in the public vocabulary |
| `GET /api/v1/workflows/:key` | `GET /graphs/:key` (`get`) | — |
| `GET /api/v1/workflows/:key/versions` | `GET /graphs/:key/versions` | — |
| `GET /api/v1/workflows/:key/diff` | `GET /graphs/:key/diff` | — (Workflow Diff, ROADMAP §B) |
| `PUT /api/v1/workflows/:key` | `POST /graphs` (`save`, upsert) | REST-ify to PUT-by-key for import/export idempotency |
| `POST /api/v1/workflows/:key/promote` | `POST /graphs/:key/promote` | — (env promotion) |
| `DELETE /api/v1/workflows/:key` | `DELETE /graphs/:key` (`remove`) | destructive — see token-scope open Q |
| `POST /api/v1/workflows/generate` | `POST /graphs/generate` | NL→graph draft (BYOK); optional in v1 |

Export/import = `GET`/`PUT` the graph JSON — the content is the `GraphDefinition` we already
content-hash and version, so round-tripping through git is safe by construction.

### 4.2 Executions (runs) — backed by `apps/api/src/executions/executions.controller.ts`

| Public route | Maps to | New work |
|---|---|---|
| `POST /api/v1/runs` | `POST /executions` (`start`) | start a run `{ workflowKey, input? }` → `{ workflowId }` |
| `GET /api/v1/runs` | `GET /executions` (`list`) | list/paginate the run read-model |
| `GET /api/v1/runs/:id` | `GET /executions/:id` (`getState`) | status + current node + output |
| `GET /api/v1/runs/:id/history` | `GET /executions/:id/history` | timeline for `runs watch` |
| `POST /api/v1/runs/:id/cancel` | `POST /executions/:id/cancel` | terminates the workflow |
| `POST /api/v1/runs/:id/rerun` | `POST /executions/:id/rerun` | new run, original input; optional `graphVersion` |
| `GET /api/v1/runs/awaiting` | `GET /executions/awaiting` | runs paused on approval (for `approvals list`) |

Naming note: internally the resource is "execution"; the product/CLI word is **run**. The
public router aliases `runs`→`executions` in one place so the vocabulary is consistent with the
UI and the CLI without touching internal code.

### 4.3 Approvals (HITL) — the **token-auth** path, NOT the signed-link one

| Public route | Maps to | New work |
|---|---|---|
| `POST /api/v1/runs/:id/approve` | `POST /executions/:id/approve` | body `{ approved: bool, comment? }` |
| `POST /api/v1/runs/:id/reject` | same handler, `approved:false` | thin alias for CLI ergonomics |
| `POST /api/v1/approvals/approve-batch` | `POST /executions/approve-batch` | bulk decide |

**Precision:** there is **one** approve handler (`ApproveDto { approved, comment? }`,
executions.controller.ts:154) — reject is `approved:false`, not a separate service call. This is
distinct from `apps/api/src/executions/approvals-public.controller.ts` (`/approvals/:id/decide`),
which is `@Public()` **signed-link** auth for a human clicking an email/Slack button — that one
is **not** part of the token-authenticated public API and must not be conflated with it.

### 4.4 Config: three DISTINCT resources — keep them separate

| Public route | Maps to | Semantics |
|---|---|---|
| `GET/PUT/DELETE /api/v1/variables[/:key]` | `apps/api/src/variables/variables.controller.ts` | `$vars` — non-secret, **readable** |
| `GET/PUT/DELETE /api/v1/secrets[/:name]` | `apps/api/src/env-secrets/env-secrets.controller.ts` | `$secrets` — **write-only**: `GET` returns **names only**, never values |
| (not in v1) | `apps/api/src/secrets/secrets.controller.ts` (`tenants/:id/credentials`) | BYOK model-provider keys — deliberately **out of scope** (§9) |

**Secrets are write-only over the API, always.** `GET /api/v1/secrets` yields
`[{ name }]` and nothing else — the value is set/replaced but never read back (the worker
decrypts it in-activity; it never enters an API response, graph, ctx, or history — CLAUDE.md
Tier-1 §4, env-secrets.controller.ts:32–45). Both variables and secrets are **environment-scoped**
via `X-Environment-Id`.

### 4.5 Usage (read-only) — backed by `apps/api/src/usage/usage.controller.ts`

`GET /api/v1/usage` → the tokens/cost ledger (env-tagged). Ledger stores **tokens + cost only,
never prompt/completion text** (CLAUDE.md privacy rule) — safe to expose.

---

## 5. The versioning decision — a curated `/api/v1` module (Option B)

The central design fork, stated plainly:

- **Option A — bless the existing routes.** Add `setGlobalPrefix` / a version and declare the
  current controllers the v1 contract. **Rejected as the default:** it reprefixes *every* route
  the SPA (`apps/web/src/lib/api.ts`) and webhooks already call — a breaking change to internal
  callers — and it couples the public contract's stability to controllers that must stay free to
  churn for the UI.
- **Option B — a curated `V1Module` (proposed).** A dedicated `apps/api/src/v1/` router,
  mounted at `/api/v1`, whose thin controllers call the **same services** (`ExecutionsService`,
  `GraphsService`, `EnvSecretsService`, …). Internal controllers keep changing for the SPA; the
  v1 surface changes only on a deliberate, versioned decision. This also lets us **normalize
  scoping**: v1 is uniformly header-scoped (`X-Workspace-Id`), dropping the redundant
  `/tenants/:id/...` path param that some internal controllers still carry — for a
  token-authenticated caller the tenant comes from the token, so the path id is noise.

**How `/v1` stays stable:**
- v1 controllers depend only on **service method signatures**, not on internal DTO churn; a
  public DTO layer (v1-owned response classes) insulates the wire shape from Prisma/internal
  models.
- **Additive-only within a major:** new optional fields and new endpoints are non-breaking;
  removing/renaming a field or changing a status code requires `/api/v2`.
- **Deprecation policy:** a field/endpoint marked deprecated stays for **≥1 minor cycle** (or a
  published window, e.g. 90 days), emits a `Deprecation` + `Sunset` header, and is called out in
  the OpenAPI description before removal. `/v1` and `/v2` run **side by side** during migration.

---

## 6. CLI (`naary`)

A thin Node CLI (new package `packages/cli`, `bin: { naary }`, published to npm) that is a
**pure client of `/api/v1`** — zero business logic, so the API is the single source of truth.

### 6.1 Command surface

```
naary auth login                 # paste an nry_ token; store it (see 6.2). --workspace, --environment optional
naary auth status                # who am I / which workspace+env is active
naary auth logout                # forget the stored token

naary workflows list             # GET /api/v1/workflows            (table or --json)
naary workflows get <key>        # GET /api/v1/workflows/:key
naary workflows run <key> [--input @file.json | --input '{...}']    # POST /api/v1/runs → prints runId
naary workflows export <key> > wf.json      # GET  the graph JSON
naary workflows import <key> < wf.json      # PUT  the graph JSON (idempotent)

naary runs list [--status running|failed|awaiting]
naary runs get <id>              # GET /api/v1/runs/:id
naary runs watch <id> [--exit-code]   # poll history until terminal; --exit-code maps status→process exit (CI gate)
naary runs cancel <id>
naary runs rerun <id> [--version <n>]

naary approvals list             # GET /api/v1/runs/awaiting
naary approvals approve <id> [--comment ...]
naary approvals reject  <id> [--comment ...]

naary variables list|set|delete
naary secrets    list|set|delete        # set is write-only; list shows NAMES only (mirrors the API)
```

### 6.2 Config / auth storage

- Token resolution order: `--token` flag → `$NAARY_TOKEN` env → config file
  `~/.config/naary/config.json` (0600). The env var is the CI path (store it as a masked secret);
  the config file is the interactive path (`naary auth login`).
- The config also holds the **base URL** (`--url` / `$NAARY_API_URL`, default the SaaS host) so
  the CLI works against self-hosted instances, and the default **workspace/environment**.
- **Respect the env-bound-token rule (§3):** the CLI attaches `X-Environment-Id` **only** when
  `--environment` is given for an *unbound* token. If a call returns the "token is scoped to a
  fixed environment; do not send X-Environment-Id" 403 (auth.guard.ts:141), surface it as a
  clear CLI error rather than retrying.

### 6.3 Output formats

- Default **human table**; `--json` for scripting (`| jq`). `--json` output is the raw API body,
  so a script and the CLI never disagree.
- Non-zero exit codes on API error (4xx/5xx) and, with `runs watch --exit-code`, on a
  failed/terminated run — the CI-gate primitive.

### 6.4 Generate the client from the spec

Because the spec is already published at `/docs-json` (§1), the CLI's HTTP layer (types +
request signatures) can be **generated from the OpenAPI document** rather than hand-written and
drifting. This also feeds the just-shipped **HTTP OpenAPI/Swagger introspection** feature
(ROADMAP §B, #331): naary can point its own `httpRequest` node at its own `/docs-json` — the
API becomes a first-class, self-describing integration target.

---

## 7. Rate limiting & abuse

- **Infra exists, keying is new.** `@nestjs/throttler` is already global (app.module.ts:42,
  `120/60s`, **per-IP**). For the public API, add a `ThrottlerGuard` whose tracker is keyed on
  the **`ApiToken` id** (not IP) for `nry_` callers — behind a shared proxy/CI, many callers
  share an egress IP, so per-IP is both too loose (one tenant floods) and too tight (unrelated
  tenants collide). The token id is already in hand (the guard resolved it) and
  `ApiTokenService.verify` already stamps `lastUsedAt`, so per-token accounting is a natural fit.
- **Per-token quotas**: a default requests/min ceiling per token, with room for a per-token
  override (an enterprise plan lever). Emit standard `Retry-After` + `RateLimit-*` headers so the
  CLI can back off.
- **Cost is bounded independently** of request rate by the existing **budget cap**
  (`apps/api/src/budget/*`) — a run that burns tokens is metered and capped there, so a
  low-request-rate-but-expensive attack is already contained. Rate limiting here protects the
  *control plane*, not model spend.

---

## 8. Non-negotiables carried into every slice

- **Secrets never cross the API boundary** — write-only; `tenantId` comes from the token, never
  an argument; provider keys stay in activities (CLAUDE.md Tier-1 §3–4).
- **Tenant isolation == token.** Every v1 route inherits the token's single `tenantId`; no
  cross-tenant path/body argument exists to abuse (the isolation tests stay green).
- **Runs are durable.** A run started via the API meters usage and survives exactly like a
  UI/MCP-started run (same `ExecutionsService.start` → same ledger + same Temporal workflow).
- **The API is the contract, the CLI is a client.** No logic lives only in the CLI.

---

## 9. Out of scope (explicit fence)

- **BYOK provider credentials** (`tenants/:id/credentials`) over the public API — model keys are
  set in the UI; exposing a write API for them is a separate security review, not v1.
- **A hand-crafted SDK** beyond the generated HTTP client (an ergonomic TS/Python SDK is a
  follow-on).
- **Fine-grained token scopes / RBAC** — v1 tokens are owner-scoped (§3, §12).
- **Webhook/trigger ingestion** — that is the `hooks`/`webhooks` surface with its own HMAC auth,
  not this token-authed control plane.
- **The MCP agent interface** — covered by [MCP-SERVER.md](./MCP-SERVER.md); this doc is the
  REST/CLI sibling, not a replacement.
- **Streaming run progress** (websocket/SSE `runs watch`) — v1 polls history; live push is a
  later enhancement (mirrors MCP-SERVER.md §10).

---

## 10. Rollout — as slices (each its own PR)

1. **`V1Module` + versioned executions (start / get / list) + per-token rate limit.** Stand up
   `/api/v1`, the public DTO layer, the token-keyed throttler, and the run read paths. Proves the
   versioned boundary + auth + limiting end-to-end against the existing `ExecutionsService`.
2. **Cancel / rerun / approve + approvals list.** The write + HITL run operations — the CI-gate
   and human-in-the-loop primitives.
3. **Workflows CRUD + export/import.** `GET/PUT/DELETE /workflows`, versions, promote — the
   git-round-trip story.
4. **Variables + write-only secrets + usage.** Config resources, with the secrets write-only
   invariant asserted by test.
5. **`naary` CLI** (new `packages/cli`): `auth`, `workflows`, `runs watch --exit-code`,
   `approvals`, `variables`, `secrets` — generated HTTP client from `/docs-json`, table/JSON
   output, config-file + env-var auth. Published to npm.

Slices 1–2 are the minimum that demonstrates the whole loop (start → supervise → approve/cancel)
from `curl`. The CLI (5) is pure client work once 1–4 stabilize the contract.

---

## 11. Verification plan

- **Contract tests** hit `/api/v1` with a real `nry_` token against a dev Temporal and assert a
  run reaches `completed`; a second tenant's token sees none of the first's runs (isolation).
- **The published spec is the oracle:** `/docs-json` validates against the OpenAPI schema, and the
  generated CLI client is regenerated from it in CI — drift fails the build.
- **Rate-limit tests:** two tokens behind one IP get **independent** budgets (per-token keying);
  a flooding token gets `429 + Retry-After`.
- **Secret write-only test:** `PUT` then `GET /api/v1/secrets` returns the name and **never** the
  value; the value never appears in any response body, log, or the OpenAPI examples.
- **CLI e2e:** `naary workflows run … && naary runs watch --exit-code` returns non-zero on a
  failed run (the CI-gate contract).

---

## 12. Open questions

- **Versioning approach:** curated `V1Module` (Option B, proposed) vs blessing existing routes
  (Option A)? B keeps the public contract decoupled from SPA churn — confirm.
- **Token scope:** do we ship **narrower** token scopes (run-only, workflow allow-list, read-only)
  before/with v1, or accept owner-scoped tokens for v1 and add RBAC later (as MCP-SERVER.md §10
  also defers)? Destructive routes (`DELETE workflow`, `cancel`) inherit owner today.
- **Default rate limits:** what per-token ceiling ships as the default, and is it a per-plan
  (Company/billing) lever?
- **CLI distribution:** single npm package `@naary/cli` with `naary` bin, or also standalone
  binaries (pkg/bun-compiled) for CI images without Node?
- **`workflows generate` in v1:** include the NL→graph endpoint (BYOK model spend from a script)
  or keep generation UI/MCP-only for v1?
- **Idempotency keys** for `POST /runs`: do we accept an `Idempotency-Key` header so a retried CI
  step doesn't double-start a run? (Likely yes — cheap insurance for the CI use case.)

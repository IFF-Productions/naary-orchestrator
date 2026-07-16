# Enterprise / parity backlog

Captured from product direction. Grouped by theme; each item notes rough size (S/M/L/XL),
dependencies, whether infra already exists, and whether it needs a design doc first. **Not
committed order** — see [Suggested sequencing](#suggested-sequencing). The bottom "packaging" section is product tiering /
commercial ops, not engineering.

## A. API & CLI control
| Feature | Size | Notes |
|---|---|---|
| **Import cURL commands** | **S** | Parse a `curl …` into an httpRequest node (method/url/headers/query/body). **Auth is NOT imported** — Authorization/Cookie/`-u` are stripped (secrets never persist in a graph/history; the user wires a connection). HTTP node already exists (`packages/dsl/src/http-request.ts`). Self-contained → **good first pick** (shipped, PR #312). |
| Control Naary via API (public API) | M–L | A documented, stable public REST surface for workflows/executions/creds. Much exists internally (NestJS controllers + `nry_` tokens + Swagger); this is hardening + versioning + docs + scoping tokens to actions. |
| Control Naary via CLI | M | A `naary` CLI wrapping the public API (auth, run/list/export/import workflows). Depends on the public API being stable. |

## B. Authoring
| Feature | Size | Notes |
|---|---|---|
| **Global Variables** | M | Per-tenant (and per-env) key→value store injected into expressions (`$vars.x`). New `Variable` model (env-scoped, mirrors the creds pattern). Non-secret; pairs with Secrets below. |
| **Environment Secrets** | S–M | User-facing named secrets scoped to an environment. The store already exists + is env-scoped (`SecretStore`, Slice 5). Mostly a UI + a `$secrets.x` expression binding + a management API over the existing store. |
| **Global Secrets** | S–M | Same as above but tenant-wide (not env-scoped) — a secret shared across all envs. One flag on the secrets model / a null env. |
| **Workflow Diff** | M | Compare two `GraphDefinition` versions (node/edge/config adds-removes-changes) — powers "what changed" + safer promote. We already version + content-hash graphs; this is a diff algorithm + a UI. Complements copy-on-promote ([ENVIRONMENTS.md](./design/ENVIRONMENTS.md)). |

## C. Observability & Insights
| Feature | Size | Notes |
|---|---|---|
| Audit logging | **S (mostly EXISTS)** | `AuditEvent` model + `apps/api/src/audit/*` (interceptor/service/controller) already ships. Gap analysis: coverage of sensitive actions + a UI/export. Likely "extend + surface," not build-from-zero. |
| Search executions by contained data | L | Full-text / field search over run inputs/outputs. Today run I/O lives in Temporal history + object storage, NOT indexed in PG. Needs an indexed projection (opt-in, privacy-sensitive — ledger stores tokens only today). Design-first. |
| Stream logs to external services (Datadog) | M | We already have pino→Sentry + metrics dual-emit (observability program). Add a log/metric egress sink (Datadog/OTLP) behind env config. Reuses the scrubber-on-egress work. |
| Insights (dashboards) | L | Overview banner + workflow-metrics table (sortable) + evolution-over-time charts + filters (date range 7–365d, granularity hourly/daily/weekly). Data substrate is `UsageEvent` — **env-tagged by Slice 6a** ([PR #308](https://github.com/tarazena/naary-orchestrator/pull/308), pending merge) so per-env insights become possible once it lands. Big UI + aggregate query layer. Design-first. |
| Worker view | M | Live view of connected workers + their queues/load. Depends on **Queue mode** (a worker registry / heartbeat). |

## D. Scale & infra
| Feature | Size | Notes |
|---|---|---|
| Queue mode (multiple instances) | L | Horizontal scaling — multiple worker instances pulling from Temporal task queues (Temporal already supports this; the work is worker registry/heartbeat, config, and the ops story). Prereq for Worker view. Design-first. |
| External storage in S3 | M | The claim-check store for large LLM/file payloads → S3 (today: local/other). We already pass references not blobs ([CLAUDE.md](../CLAUDE.md)); this is a storage-driver swap + config. |

## E. Enterprise security
| Feature | Size | Notes |
|---|---|---|
| SSO SAML & LDAP | XL | Enterprise auth beyond Firebase — SAML IdP + LDAP directory sync. Large; composes with the workspace/company membership model + RBAC. Design-first. |
| External secret store integration | L | Back the secret store with Vault / AWS Secrets Manager / etc. instead of (or alongside) the local AES-GCM store. A `SecretProvider` interface behind `CredentialsService`/`SecretStore`. Design-first; composes with Environment/Global Secrets. |
| Enforce 2FA across the instance | M | Require MFA for all users (Firebase MFA enrollment gate). Instance-level policy + enrollment flow. |

## F. Product packaging (NOT engineering — commercial/ops)
These describe plan tiers + commercial terms, not features to build:
- **Insights tiers**: Starter (overview banner + sortable metrics table) → higher (evolution dashboards, filters, granularity). The *engineering* is item C-Insights; the tiering is packaging/gating.
- **Support tiers**: forum → email → dedicated + SLA. Ops/support offering.
- **Billing & contract**: pay-by-invoice, sales-assisted procurement. Commercial/billing ops (some may need invoice-mode billing support in-app — small if so).

## Suggested sequencing

_(proposal — confirm/reorder)_

**Quick wins first (self-contained, high value, no design gate):**
1. **Import cURL** (S) — starting now.
2. **Environment Secrets + Global Secrets** (S–M) — the store is already env-scoped; mostly UI + `$secrets` binding.
3. **Global Variables** (M) — sibling of secrets; `$vars` binding.
4. **Audit logging** gap-fill (S) — surface/extend what exists.
5. **Stream logs → Datadog** (M) — reuses observability egress.
6. **Workflow Diff** (M) — leverages existing versioning; complements promote.
7. **External storage S3** (M) — storage-driver swap.

**Design-first programs (each its own doc + slices, like Environments/Companies):**
- Insights dashboards (L) — data substrate ready once Slice 6a's `UsageEvent` env-tagging (PR #308) merges.
- Public API hardening (M–L) → CLI (M).
- Queue mode (L) → Worker view (M).
- Search executions by data (L).
- External secret store (L), SSO SAML/LDAP (XL), Enforce 2FA (M).

Dependencies to respect: CLI needs the public API; Worker view needs Queue mode; per-plan Insights gating needs Insights + the Companies billing rollup.

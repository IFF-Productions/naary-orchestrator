# Production Readiness — Naary Orchestrator

Status of the system against what a real, multi-tenant production deployment needs.
Grounded in the current `main` (slices 1–5 + the review-remediation PRs #11–#24) and the
open auth work (#25). Honest about what's done, what's stubbed, and what's not started.

> TL;DR — the **durable-execution core is real and tested** (interpreter, determinism
> replay test, BYOK encryption, budget enforcement, graph versioning, claim-check,
> dual auth). What's missing for production is mostly **operational**: managed infra,
> secrets management, observability, a few correctness tails, and the web-app auth wiring.

---

## 1. Running it locally

### Prerequisites
- Node 20+, [pnpm](https://pnpm.io), Docker (for Postgres), and the
  [Temporal CLI](https://docs.temporal.io/cli) (`brew install temporal`).

### One-time setup
```bash
pnpm install
cp .env.example .env          # then fill in the values below

# generate the 32-byte encryption master key
openssl rand -hex 32          # paste into ENCRYPTION_KEY in .env
```

Set in `.env`: `POSTGRES_PASSWORD`, `ENCRYPTION_KEY`, and the matching `DATABASE_URL`.
For human browser login, also set `FIREBASE_PROJECT_ID` (`naary-7b78f`) and a service
account (`FIREBASE_SERVICE_ACCOUNT_JSON` inline, or `GOOGLE_APPLICATION_CREDENTIALS`
file). Leave the service account **unset** for API-token-only mode (no browser login;
`nry_` tokens only).

### Fastest path — the whole stack in Docker
```bash
docker compose up -d --build   # Postgres, Temporal, migrate, api, worker, web
```
Web → http://localhost:8081 · API → http://localhost:3000 (`/healthz` public) ·
Temporal UI → http://localhost:8233. The
`migrate` service runs `prisma migrate deploy` before api/worker start. This is a
dev stack (single-binary Temporal, ts-node runtime) — production images/cluster
are §3.A below.

### Or run the processes on the host (backend inner loop)
```bash
docker compose up -d postgres                                # just the datastore
pnpm --filter @naary/db exec prisma migrate deploy           # apply DB migrations

# 1) Temporal dev server (persistent DB so restarts survive)
temporal server start-dev --db-filename temporal.db          # UI http://localhost:8233

# 2) Worker (bundles the workflow, polls the 'orchestrator' task queue)
pnpm build && pnpm run worker

# 3) NestJS control plane
pnpm run start                                               # http://localhost:3000
```

### Smoke test
```bash
# API-token mode: mint a token (see ApiTokenService) and call:
curl -XPOST localhost:3000/executions -H "Authorization: Bearer nry_…"

# Firebase mode: humans sign in via the web app (Google / email+password), which
# sends a Firebase ID token on each API call. Assign a user's tenant once with:
#   pnpm --filter @naary/api exec ts-node src/auth/set-tenant-claim.ts <firebaseUid> <tenantId>
# (Requires a configured Firebase service account; without one there is no browser login.)
```

### Tests
```bash
pnpm test        # builds, then vitest (incl. the pause→signal→resume + replay DoD)
pnpm typecheck   # tsc -b + per-app --noEmit
```

---

## 2. Already production-grade

These are built and tested — not gaps:

- **Interpreter, not codegen** — one generic Temporal workflow walks graph data.
- **Determinism boundary** — enforced and guarded by a **replay-from-history test**;
  all I/O / time / randomness is in activities.
- **BYOK secret encryption** — AES-256-GCM with AAD binding each ciphertext to its slot,
  key versioning; `ENCRYPTION_KEY` required at boot; decryption happens in-activity;
  secrets never enter Temporal args/history/logs/spans.
- **Budget enforcement** — per-execution cap (stop-after-exceeding) + monthly-cap
  **reservation** (reserve→reconcile, 5-min TTL); billing fails safe (fallback estimate,
  never zero); MCP tool calls are metered.
- **Graph versioning** — graph is content-hashed/snapshotted at execution start; editing
  a flow creates a new version and can't corrupt in-flight runs.
- **Large-payload claim-check** — >1MB activity results offload to object storage (S3),
  references pass through Temporal (stays under the ~2MB payload cap).
- **Dual auth** — API tokens (`nry_…`) + Firebase Auth ID tokens (tenant from a Firebase
  `tenant` custom claim, verified by the Firebase Admin SDK); tenant-scoped routes enforce
  path-tenant == token-tenant (403 on mismatch).
- **Webhook ingress** — HMAC-verified, fails closed; delivery-dedup with a retention sweeper.

---

## 3. What's left for production

Ordered roughly by "blocks launch" → "hardening". Each item says **why** and **where**.

### A. Infrastructure & deployment (BLOCKER — nothing is deployed yet)
- [ ] **Container images + IaC for AWS** — Dockerfiles for `api` and `worker`; deploy to
      ECS/EKS. The cloud abstraction already exists (ObjectStore → S3 now, GCS later).
- [ ] **Managed Postgres** (RDS/Aurora) with backups, PITR, connection pooling (PgBouncer
      / RDS Proxy). Run `prisma migrate deploy` in a release step, not by hand.
- [~] **Temporal in production** — Temporal Cloud or self-hosted cluster (the local
      `start-dev` single binary is not production). **Connection layer is ready**:
      the api client + worker resolve address / namespace / TLS / API-key from env
      via `@naary/temporal-config`, defaulting to the local dev server — so pointing
      at Temporal Cloud (API-key or mTLS) is env-only, no code change. Cloud
      connectivity itself is unverified (no account). Still to do: a Cloud/cluster
      namespace with retention + mTLS provisioned, and Worker Versioning / Build IDs
      for safe interpreter rollouts.
- [ ] **Secrets management** — `ENCRYPTION_KEY`, DB creds, and the **Firebase service
      account** in AWS Secrets Manager / SSM, not `.env`. Plan **KMS-backed key wrapping
      + rotation** for the master key (the code already supports key versions).
- [ ] **CI/CD** — there are currently **no GitHub Actions workflows**. Add: typecheck +
      `pnpm test` on PR, build/push images, run migrations, deploy. Make the determinism
      replay test a required gate.

### B. Identity & auth
- [x] **Firebase Auth for human login** — replaces Keycloak/OIDC. The SPA signs in with
      the Firebase JS SDK (Google + email/password); the API verifies Firebase ID tokens
      with the Firebase Admin SDK and reads the tenant from a `tenant` custom claim. Off
      unless a service account is configured; `nry_` API tokens unchanged. *(Supersedes
      the old Keycloak realm + web-OIDC items.)*
- [ ] **OAuth `state` session-binding** (Sec#3) — for the **MCP connection OAuth** (not
      user login): currently TTL + single-use; bind to the session, not just a
      tenant-prefixed state.
- [ ] **Production Firebase** — real Firebase project, restrict enabled sign-in providers,
      enable **App Check**, rotate the service-account key, and set appropriate session /
      token lifetimes.

### C. Scale & concurrency
- [ ] **Distributed OAuth refresh lock** (Arch§4.7) — the token cache + refresh lock are
      **in-process only**; multi-worker scale-out needs a durable/distributed lock
      (Redis/DynamoDB) to avoid refresh storms / races.
- [ ] **`continueAsNew` for long agent loops** — bound Temporal event-history growth on
      long-running / many-step flows.
- [ ] **`ctx` / state-query bounding** (Arch§4.8) — `ctx` accumulates every node output;
      cap it (and the queryable state) for large graphs.

### D. Observability
- [x] **Error monitoring (Sentry)** — `@naary/observability` inits Sentry in the API +
      worker (OFF unless `SENTRY_DSN` set); 5xx/unexpected errors are captured with
      tenant/execution tags. A security-critical `beforeSend` scrubber drops
      sensitive keys + redacts secret-shaped substrings (unit-tested) so keys never
      reach telemetry. Optional perf tracing via `SENTRY_TRACES_SAMPLE_RATE`.
- [x] **Structured logging** (JSON, correlation/tenant/execution IDs, no secrets) —
      `@naary/logging` (pino) replaces `console.log` in the api + worker. Each API
      request gets a correlation id (echoed as `x-request-id`) and an access-log line
      (method/path/status/duration/tenant); activities log execution-correlated
      completion lines (executionId/nodeId/tenantId + token/cost numbers, never
      prompt/completion text). Both message and structured fields pass through the
      audited `@naary/observability` scrubber, so secrets never reach the logs.
      `LOG_LEVEL` controls verbosity. (NOT imported by `workflows.ts` — logging is
      I/O and would break deterministic replay.)
- [ ] **Metrics** — execution counts/latency, budget usage, activity retries, queue depth.
- [ ] **Tracing** — full OpenTelemetry across API → Temporal → activities (Sentry
      tracing is a partial start).
- [ ] **Alerting** — wire Sentry alerts (+ failed executions, budget-cap trips, DLQ).

### E. Security hardening
- [x] **Resolve the 5 Dependabot alerts** (2 high, 3 moderate) — patched via
      `pnpm-workspace.yaml` overrides (multer ≥2.2.0, protobufjs ≥7.6.3,
      @hono/node-server ≥1.19.13); all transitive, minor/patch bumps. Suite green.
- [ ] **GitGuardian** — resolve the intentional demo-secret finding in the dashboard
      (see PR #25 notes); add ggshield to CI as a real pre-merge gate.
- [ ] **Prompt-injection guardrails** (Sec#10) — least-privilege per connection + input
      guardrails for agent nodes fed by untrusted webhook payloads.
- [ ] **Rate limiting / WAF** at the edge (throttling exists in-app; add infra-level).
- [ ] **Secret-table split** (Arch§3.3) — optional organizational refactor (AAD already
      removed the security motive).

### F. Product / data
- [ ] **Object-storage lifecycle** — TTL/cleanup for claim-checked payloads in S3.
- [ ] **Usage-ledger reporting / export** for billing (ledger stores tokens+cost only —
      keep it that way; never prompt/completion text).
- [ ] **Atlassian inbound webhooks** (only GitHub-style HMAC implemented today).
- [x] **`POST /executions/:id/approve` error mapping** — approving a closed/failed
      workflow now returns **409 Conflict** (was an unhandled 500); the signal's
      `WorkflowNotFoundError` is caught, mirroring `getState`'s 404 handling with
      write-appropriate semantics. Verified e2e (approve→complete→approve = 409).
- [ ] **Backup/restore + DR runbook**; data-retention & privacy review.

---

## 4. Suggested order

1. **CI/CD + infra + managed Postgres + Temporal Cloud** (A) — you can't ship without a
   deploy target and a pipeline.
2. **Secrets management + KMS** (A) — before any real tenant key is stored.
3. **Production Firebase** (B) — real project + App Check + restricted providers, so
   humans can safely log in.
4. **Observability** (D) — you'll need it the moment real traffic hits.
5. **Scale/concurrency** (C) and the **security tail** (E/F) — as load and tenants grow.

# PLAN.md — Vertical Slice #2: Real Agent + BYOK Secrets + Spend Tracking

> **For the executing agent:** This slice builds directly on Slice #1 (the durable
> interpreter spine with human-approval pause). Do not rebuild that. Work one task
> at a time, in order; do not start a task until the previous task's verification
> passes and you've shown the output. Stay in plan mode until this plan is approved.

## 1. Purpose

Replace the stubbed agent activity from Slice #1 with a **real LLM call**, under a
**bring-your-own-key (BYOK)** model where each tenant supplies their own provider
credentials, and **record token spend per call** so usage is visible through our
platform. Three capabilities land together because they're coupled:

1. A real agent node that calls an LLM via the AI SDK with structured output.
2. Per-tenant encrypted credential storage; the agent uses the tenant's own key.
3. A usage ledger that records tokens + computed cost for every model call.

## 2. Scope

**In scope:**
- Postgres + an ORM (Prisma; Drizzle acceptable) — Slice #1 had no DB; introduce it here.
- `tenant_credentials` table (encrypted) + `usage_events` table (the spend ledger).
- An envelope-style crypto module (AES-256-GCM, swappable for AWS KMS later).
- A credentials service: save (with validation), retrieve-decrypted.
- A real agent activity: AI SDK `generateText` with structured `Output`, provider
  built from the tenant's decrypted key, usage recorded, auth/quota errors handled.
- `tenantId` threaded through the workflow and the start endpoint.
- `GET /tenants/:id/usage` exposing aggregated + line-item spend.

**Explicitly OUT of scope (do NOT build):**
- No MCP tool nodes yet (Slice #3).
- No budget *enforcement* / pre-flight rejection / circuit-breaking — we **record**
  spend this slice; enforcement is a fast-follow (noted in §9).
- No multi-model routing/fallback chains; one model per node from config.
- No React canvas; still linear graph from `sample-graph.ts`.
- No prompt storage in the usage ledger (tokens/cost only — privacy + size).

## 3. Architecture constraints (carry over from CLAUDE.md, plus new ones)

1. **Secrets never enter Temporal.** Workflow args/history must contain **only
   `tenantId`**, never an API key. Temporal persists every input to replayable
   history — a key passed as a workflow/activity *argument that originates in the
   workflow* would be written to history. The key is fetched **inside the activity**
   by `tenantId` and never returned from it.
2. **All key handling is I/O → lives in the activity**, consistent with the
   determinism rule. The workflow never sees plaintext or ciphertext keys.
3. **Never log keys.** No keys in app logs, Temporal payloads, or AI SDK DevTools /
   `experimental_telemetry` spans. Scrub at the boundary; keep DevTools off in prod.
4. **Billing must fail safe.** If token usage comes back missing, we must NOT record
   zero and silently let the call be free (see Task 5 gotcha).

## 4. Data model

```prisma
model TenantCredential {
  id              String   @id @default(uuid())
  tenantId        String
  provider        String   // 'anthropic' | 'openai' | 'google' | 'ollama'
  ciphertext      String   // base64 AES-256-GCM ciphertext
  iv              String   // base64 nonce
  authTag         String   // base64 GCM auth tag
  isValid         Boolean  @default(false)
  lastValidatedAt DateTime?
  createdAt       DateTime @default(now())
  @@unique([tenantId, provider])
}

model UsageEvent {
  id                String   @id @default(uuid())
  tenantId          String
  executionId       String   // Temporal workflowId
  nodeId            String
  provider          String
  model             String
  inputTokens       Int
  outputTokens      Int
  totalTokens       Int
  cachedInputTokens Int      @default(0)
  reasoningTokens   Int      @default(0)
  costUsd           Decimal  @db.Decimal(12, 6)
  createdAt         DateTime @default(now())
  @@index([tenantId, createdAt])
  @@index([executionId])
}
```

## 5. Tasks

### Task 0 — Postgres + ORM + migrations
- Add Postgres (docker-compose service), Prisma schema above, run migration.
- **Verify:** migration applies; `prisma studio` or a `SELECT` shows both tables.

### Task 1 — Crypto module (envelope-ready)
- **Files:** `src/secrets/crypto.ts`. AES-256-GCM `encrypt(plaintext): {ciphertext,
  iv, authTag}` and `decrypt(...)` using a 32-byte master key from `ENCRYPTION_KEY`
  (`openssl rand -hex 32`). Wrap behind an interface (`KeyEncryptor`) so a future
  `KmsKeyEncryptor` (AWS KMS / Secrets Manager) is a drop-in swap.
- **Verify:** unit test — `decrypt(encrypt(x)) === x`; tampering with `authTag`
  throws.

### Task 2 — Credentials service
- **Files:** `src/secrets/credentials.service.ts`, `secrets.controller.ts`.
- `saveCredential(tenantId, provider, apiKey)` → **validate** via a cheap provider
  call (e.g. a 1-token `generateText`), encrypt, upsert, set `isValid`/`lastValidatedAt`.
- `getDecryptedKey(tenantId, provider)` → returns plaintext key in memory only;
  throws a typed `MissingCredentialError` if absent/invalid.
- `POST /tenants/:id/credentials` (body `{ provider, apiKey }`); never echo the key back.
- **Verify:** save a key → row has ciphertext (not plaintext); `getDecryptedKey`
  returns the original; an invalid key sets `isValid=false` and the endpoint reports it.

### Task 3 — Pricing + cost calculation
- **Files:** `src/usage/pricing.ts`. A `MODEL_PRICING` map (per-MTok input/output,
  and cache-read rate where applicable) and `computeCost({provider, model,
  inputTokens, outputTokens, cachedInputTokens})`. Treat prices as config — they
  change; document the "as of" date and source.
- **Verify:** unit test — known token counts produce the expected USD figure;
  cache-read tokens are billed at the reduced rate.

### Task 4 — Usage recording service
- **Files:** `src/usage/usage.service.ts`.
- `recordUsage({tenantId, executionId, nodeId, provider, model, usage})` → computes
  cost via Task 3 and inserts a `UsageEvent`.
- **Verify:** unit test inserts a row with correct `costUsd`.

### Task 5 — Real agent activity (the core)
- **Files:** rewrite `src/temporal/activities.ts` `runAgent`.
- Use AI SDK v6. Build the provider from the **tenant's** key, generate with a
  structured `Output` schema, record usage, map auth/quota errors to **non-retryable**
  Temporal failures. Reference sketch (verify exact API names against the installed
  `ai` version — v6 unified `generateObject` into `generateText` + `Output`):

  ```ts
  import { generateText, Output, APICallError } from 'ai';
  import { createAnthropic } from '@ai-sdk/anthropic';
  import { ApplicationFailure } from '@temporalio/activity';
  import { z } from 'zod';

  export async function runAgent(
    cfg: { provider: string; model: string; systemPrompt: string },
    input: unknown,
    meta: { tenantId: string; executionId: string; nodeId: string },
  ) {
    const apiKey = await credentials.getDecryptedKey(meta.tenantId, cfg.provider);
    const provider = createAnthropic({ apiKey }); // switch on cfg.provider
    const schema = z.object({ category: z.string(), urgency: z.number() });

    try {
      const result = await generateText({
        model: provider(cfg.model),
        system: cfg.systemPrompt,
        prompt: JSON.stringify(input),
        output: Output.object({ schema }), // (or experimental_output per version)
        // experimental_telemetry intentionally OFF here — avoid logging prompts/keys
      });

      // BILLING GOTCHA: use totalUsage (sums across tool steps), and guard for
      // undefined — a known ai@6 bug (≈v6.0.97 via AI Gateway) returns undefined
      // usage, which would silently bill nothing. PIN the ai version and fall back.
      const u = result.totalUsage ?? result.usage;
      if (!u?.inputTokens && !u?.outputTokens) {
        // fallback estimate so we never record a free call by accident
        const est = estimateTokens(cfg.systemPrompt, input, result.text);
        await usage.recordUsage({ ...meta, ...cfg, usage: est });
        logger.warn('usage undefined — used fallback estimate', meta);
      } else {
        await usage.recordUsage({ ...meta, ...cfg, usage: u });
      }

      return { status: 'ok', output: result.output };
    } catch (e) {
      if (e instanceof APICallError && e.statusCode === 401) {
        throw ApplicationFailure.nonRetryable('Invalid provider credentials', 'AUTH', { tenantId: meta.tenantId });
      }
      if (e instanceof APICallError && e.statusCode === 429) {
        throw ApplicationFailure.nonRetryable('Provider rate limit / quota (tenant key)', 'QUOTA');
      }
      throw e; // genuine transient errors: let Temporal retry policy handle them
    }
  }
  ```
- Key behaviours to enforce: key fetched in-activity only; `401`/`429` are
  non-retryable (don't burn retries on a bad/exhausted tenant key); usage always
  recorded (real or fallback).
- **Verify:** integration test with a mocked provider — (a) success path returns
  structured `output` and writes one `UsageEvent` with non-zero cost; (b) simulated
  `401` produces a non-retryable failure and writes no charge; (c) simulated
  undefined-usage path writes a fallback `UsageEvent` (non-zero).

### Task 6 — Thread tenantId through workflow + start endpoint
- `runGraph(graph, input, ctx: { tenantId, executionId })`; pass `ctx` + `nodeId`
  into `runAgent`. `tenantId` is **not** a secret, so it is fine in workflow args.
- `POST /executions` now accepts `{ tenantId }`; `executions.service` sets it as a
  workflow arg and uses it as part of the `workflowId`.
- **Verify (worker running):** start an execution with a `tenantId` that has a valid
  saved credential and an agent node configured with a real model → execution
  completes, `GET /executions/:id` shows structured output, one `UsageEvent` row exists.

### Task 7 — Expose spend through the platform
- **Files:** `src/usage/usage.controller.ts`.
- `GET /tenants/:id/usage?from=&to=` → `{ totalCostUsd, totalTokens, byModel: [...],
  events: [...] }` aggregated from `usage_events`.
- **Verify:** after Task 6 runs, `curl` returns the aggregated cost and at least one
  line item; numbers match the recorded `UsageEvent`.

### Task 8 — Guardrails & docs
- Pin `ai` to an exact version in `package.json` (no caret) per the usage-undefined
  bug; document why. Add a redaction check: grep app logs and assert no key material.
- README: BYOK flow, the "secrets never enter Temporal" rule, and the billing
  fallback rationale.
- **Verify:** `grep` over a captured log of a full run finds no API key; version is pinned.

## 6. Definition of done
- [ ] A tenant can save a provider key; it is stored encrypted and validated.
- [ ] An execution uses the tenant's own key, fetched inside the activity only.
- [ ] No API key appears in Temporal history, workflow args, logs, or telemetry.
- [ ] Every successful model call writes a `UsageEvent` with correct cost; the
      undefined-usage path writes a fallback, never zero.
- [ ] `401`/`429` from a tenant key fail fast (non-retryable) with a clear reason.
- [ ] `GET /tenants/:id/usage` shows accurate aggregated spend.
- [ ] `ai` version pinned; redaction check passes; `npm test` green.

## 7. Security notes (call out explicitly to the reviewer subagent)
- Confirm no code path passes a decrypted key as a workflow/activity *return value*
  or as a value that re-enters workflow code.
- Confirm `ENCRYPTION_KEY` is required at boot and never logged.
- Confirm usage ledger stores tokens/cost only — no prompt or completion text.

## 8. Verification philosophy
Show evidence: test output, the `curl` responses for credential save + usage, a log
capture proving no key leakage. Run a review subagent against this plan; flag only
gaps affecting correctness, security, or the stated requirements.

## 9. Next slices (context only — do NOT build now)
1. **Budget enforcement** — pre-flight cost estimate + reject/escalate when a tenant
   is over budget; circuit-breaking on runaway agent loops.
2. **MCP tool nodes** — MCP client in an activity; per-tenant OAuth tokens stored in
   the same encrypted store (same fetch-in-activity pattern as keys).
3. **Multi-model routing & fallback** — route by node/task; provider fallback chains.
4. **Graph from Postgres + per-execution version snapshot.**
5. **React Flow canvas + executed-path trace overlay.**

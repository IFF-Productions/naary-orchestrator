# Design — External secret store (Vault / AWS Secrets Manager) (#458)

**AC:** *pluggable provider; in-activity resolution unchanged; secrets never enter Temporal.*

## What is pluggable, and what is not

A `SecretProvider` owns the **key material** of a tenant BYOK provider credential. The
`TenantCredential` row stays in Postgres as the **index**: which provider slots a tenant has
in an env, `isValid`, `lastValidatedAt`. So "move our LLM keys into Vault" is an env change,
not a schema or code change.

Scope fence, taken literally from the issue ("a `SecretProvider` **behind
`CredentialsService`**"):

| Path | Store | Why |
| --- | --- | --- |
| BYOK provider keys (`anthropic`, `openai`, `google`, `claude-code`, `cursor`, `copilot`) | pluggable | the enterprise ask: these are the keys a security team wants in Vault |
| `SecretStore` — connection PATs, OAuth refresh tokens, env/global secrets, OAuth `state` | Postgres only | `prunePrefixOlderThan` (createdAt-ordered TTL sweep) and `removeAllEnvs` (cross-env scan) are relational operations with no KV equivalent; `listProviders` already namespaces that table (`conn:`, `secret:`, `turnstile:`) |

`ENCRYPTION_KEY` therefore stays **required** with an external store: legacy rows and every
non-BYOK secret are still DB-encrypted under the per-tenant DEK envelope.

## The seam

`packages/secrets/src/secret-provider.ts`

```ts
interface SecretProvider {
  readonly name: string;                                          // "db" | "vault"
  put(ref: CredentialRef, plaintext): Promise<StoredMaterial>;     // → the index row's columns
  get(ref: CredentialRef, stored: StoredMaterial): Promise<string>;
  remove(ref: CredentialRef): Promise<void>;
}
```

`CredentialRef` is `{ tenantId, environmentId, provider }` — ids and a slot name, never
material. `StoredMaterial` is exactly the four at-rest columns.

- **`DbSecretProvider` (default)** — the behaviour Naary always had: AES-256-GCM under the
  tenant's own DEK, AAD `${tenantId}:${provider}`, `keyVersion 3`. Unchanged, so every
  pre-existing row keeps decrypting. Constructed **lazily** — building a provider must not
  demand `ENCRYPTION_KEY` at import time (the worker's `getCredentials()` laziness depends
  on this).
- **`VaultSecretProvider`** — HashiCorp Vault KV v2 over plain `fetch` (no new dependency).
  Path `<prefix>/<tenantId>/<environmentId>/<provider>` under the KV mount — tenant-first so
  a Vault policy can scope a token to one tenant's subtree.

## Coexistence: routed per ROW, not per process

A global "the store is Vault now" switch would orphan every existing row the moment an
operator flips the env var. Instead the row says where its material lives, reusing the
`keyVersion` routing idiom that already distinguishes at-rest formats:

| `keyVersion` | Meaning |
| --- | --- |
| 1 | legacy master-key ciphertext, no AAD |
| 2 | master-key ciphertext, AAD-bound |
| 3 | per-tenant DEK envelope (today's default write) |
| **0** | **material is EXTERNAL**; `ciphertext`/`iv`/`authTag` are empty strings |

`0` was free, and the columns are `String NOT NULL`, so a sentinel — not a nullable column —
expresses "elsewhere". **No migration.**

Consequences:
- Flipping `SECRET_PROVIDER=vault` is safe: new saves land in Vault (`keyVersion 0`), old
  rows still resolve through the provider's DB fallback. A tenant converges as keys are
  re-saved.
- Flipping back is also safe for rows written before the flip; a `keyVersion 0` row read by
  a DB-only process fails **loudly** (`"…stored in an external secret store; this process has
  SECRET_PROVIDER=db"`) instead of returning an empty key.
- `deleteCredential(tenantId, envId, provider)` drops the row **and** the external material.
  Deleting only the row would leave an orphaned live secret in Vault forever; there is no
  delete route today, so this is the hook one must use.

## Config, and failing closed

| Env | Default | Notes |
| --- | --- | --- |
| `SECRET_PROVIDER` | `db` | `db` \| `vault`; anything else throws |
| `VAULT_ADDR`, `VAULT_TOKEN` | — | required for `vault`; missing either throws |
| `VAULT_KV_MOUNT` | `secret` | KV v2 mount |
| `VAULT_PATH_PREFIX` | `naary` | prefix under the mount |
| `VAULT_NAMESPACE` | — | Vault Enterprise |
| `VAULT_TIMEOUT_MS` | `5000` | per request |

`assertSecretProviderConfig()` runs at boot in **both** processes — `SecretsModule`'s factory
(api) and `run()` in `worker.ts` — next to the existing `createKeyEncryptor()` fail-fast.
A half-configured fleet (api writing to Vault, worker reading Postgres) cannot boot. The
boot log records the **mode** only.

`VAULT_ADDR` is operator env config, never tenant input, so it is not an SSRF surface; path
segments are still `encodeURIComponent`d and rejected if they contain `/` or `..`, so no ref
can escape the tenant subtree.

## Secrets never enter Temporal (Tier-1 §4)

Unchanged by construction: the interpreter still passes `tenantId` / `environmentId` /
provider **name**, and `CredentialsService.getDecryptedKey(tenantId, environmentId,
provider)` is still called **inside** the activity with the same signature. The provider adds
one new leak surface — an external store's **error** — so:

- `VaultRequestError` carries the **status code only**. A Vault 403 body echoes the request
  path and policy detail, and transport errors carry request headers (i.e. `X-Vault-Token`);
  both are dropped at construction, not at the boundary. `toSanitizedRetryable` cannot help
  here — it only keeps a duck-typed `statusCode` and runs after the fact.
- The index row written under an external provider contains no material (asserted).

## Testing

- `packages/secrets/test/secret-provider.contract.spec.ts` — the **provider contract**
  (6 rules: round-trip, no material in `StoredMaterial`, absence rejects, ref isolation,
  idempotent `remove`, no material/token in errors), run against `DbSecretProvider`,
  `VaultSecretProvider` (stubbed KV v2 HTTP) and a third ~25-line in-memory implementation
  that exists only to prove the seam is genuinely pluggable. **This suite is the acceptance
  harness for the next adapter.**
- `packages/secrets/test/vault-secret-provider.spec.ts` — wire protocol (paths, method,
  `X-Vault-Token`, `data.data` envelope, `metadata` delete, 404 tolerance), path-escape
  rejection, DB-fallback coexistence, error hygiene, env factory.
- `packages/secrets/test/credentials-external-store.spec.ts` — service level: row shape,
  `isValid` gate, coexistence, delete-both, and a Tier-1 §4 guard modelling the activity
  boundary (material absent from activity args, activity result, and log lines, for **both**
  providers).
- `apps/api/test/secrets-module-di.spec.ts` — the module still compiles with the seam, and
  **fails to boot** on incomplete/unknown provider config or a missing `ENCRYPTION_KEY`.

**Not verified:** no Vault server and no AWS Secrets Manager account was contacted at any
point. The Vault adapter's wire protocol is covered only against a stub `fetch`. The first
deployment against a live Vault is the remaining verification step.

## Deferred (explicitly NOT in this slice)

- **AWS Secrets Manager adapter.** The seam is the deliverable; ASM is one class implementing
  the same three methods (`@aws-sdk/client-secrets-manager`, which the repo does not yet
  depend on — `@aws-sdk/client-s3` is in `@naary/storage`). Its acceptance criterion is the
  contract suite plus a live smoke test.
- Migrating existing rows into Vault (a rewrap-style CLI, alongside `rotate.ts`). Today a
  tenant converges by re-saving a key.
- Vault auth methods other than a token (AppRole login, Kubernetes auth, token renewal).
  Operators supply an already-issued token via env.
- Making `SecretStore` (connection tokens, env secrets) pluggable — see the fence above.
- A credential **delete** route in the API (the service hook exists; the UI only overwrites).

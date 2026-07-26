import { type KeyEncryptor } from "./crypto";
import { TenantKeyService, getTenantKeyService } from "./tenant-keys";

/**
 * External secret store seam (#458).
 *
 * A `SecretProvider` owns the KEY MATERIAL of a tenant provider credential; the
 * `TenantCredential` row stays in Postgres as the INDEX (which provider slots exist,
 * `isValid`, `lastValidatedAt`) regardless of provider. So an operator can move the
 * material into Vault / AWS Secrets Manager without changing:
 *  - the in-activity resolution contract (`CredentialsService.getDecryptedKey(tenantId,
 *    environmentId, provider)` — same signature, still called INSIDE the activity), or
 *  - Tier-1 §4: nothing here ever crosses a Temporal boundary. Only `tenantId` /
 *    `environmentId` / the provider NAME are arguments; plaintext is returned in memory
 *    to the activity that asked and is never logged, returned to an API caller, or put
 *    in a span.
 *
 * SCOPE FENCE (deliberate, per the issue text "a SecretProvider behind
 * CredentialsService"): only the BYOK provider-key path is pluggable. `SecretStore`
 * (connection PATs, OAuth refresh tokens, env secrets, OAuth state) stays DB-backed —
 * its `prunePrefixOlderThan` (createdAt-ordered sweep) and `removeAllEnvs` (cross-env
 * scan) are relational operations with no KV equivalent.
 */

/** The slot a provider key occupies — the full coordinates of one credential. */
export interface CredentialRef {
  tenantId: string;
  /** Env-scoped since ENVIRONMENTS Slice 5: a sandbox key and a prod key are separate. */
  environmentId: string;
  /** The credential slot, e.g. `anthropic` / `openai` / `claude-code`. */
  provider: string;
}

/**
 * The at-rest columns of the `TenantCredential` index row. A DB-backed provider fills
 * these with real AES-GCM output; an EXTERNAL provider writes empty strings +
 * `EXTERNAL_KEY_VERSION` (the columns are `String` NOT NULL in the schema, so a
 * sentinel — not null — is how "material is elsewhere" is expressed).
 */
export interface StoredMaterial {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

/**
 * `keyVersion` marker meaning "the material is NOT in this row — ask the external store".
 * `keyVersion` already routes at-rest formats (1 = legacy no-AAD, 2 = AAD-bound, 3 =
 * per-tenant DEK envelope), and `0` was free, so external material is just another route.
 *
 * Why per-ROW and not a global "the store is Vault now" switch: flipping
 * `SECRET_PROVIDER=vault` on an instance that already has v1/v2/v3 rows must not orphan
 * them. A Vault-backed provider reads THIS row's keyVersion and falls back to the DB
 * decryption path for anything it did not write, so DB and Vault rows coexist and a
 * tenant converges to Vault as keys are re-saved.
 */
export const EXTERNAL_KEY_VERSION = 0;

/** True when a row's material lives outside Postgres (see EXTERNAL_KEY_VERSION). */
export function isExternalMaterial(keyVersion: number): boolean {
  return keyVersion === EXTERNAL_KEY_VERSION;
}

/**
 * Pluggable backing store for provider-key MATERIAL.
 *
 * Contract every implementation must satisfy (enforced by
 * `test/secret-provider.contract.spec.ts`, which runs against every provider):
 *  1. `put` then `get` with the same ref returns the exact plaintext (byte-identical,
 *     including unicode and long values).
 *  2. `put` returns the `StoredMaterial` to persist on the index row. It must NEVER
 *     contain the plaintext (checked for every provider).
 *  3. `get` of a ref that was never written throws (absence is the caller's
 *     `MissingCredentialError`, so a provider must not invent an empty string).
 *  4. Refs are isolated: `(t1,e1,p)`, `(t2,e1,p)`, `(t1,e2,p)` and `(t1,e1,p2)` are four
 *     different secrets, and a `StoredMaterial` from one ref must not decrypt under another.
 *  5. `remove` is idempotent — removing an absent ref resolves.
 *  6. Errors never carry the plaintext, nor the store's own access token.
 */
export interface SecretProvider {
  /** Stable id for logs/diagnostics (`db` | `vault`). Never any material. */
  readonly name: string;
  /** Store material; returns the columns the index row should carry. */
  put(ref: CredentialRef, plaintext: string): Promise<StoredMaterial>;
  /** Resolve material for a row. `stored` is that row's at-rest columns. */
  get(ref: CredentialRef, stored: StoredMaterial): Promise<string>;
  /** Delete material. Idempotent. The index row is the caller's concern. */
  remove(ref: CredentialRef): Promise<void>;
}

/**
 * Default provider: the behaviour Naary has always had — AES-256-GCM under the tenant's
 * own DEK (envelope, `keyVersion 3`), ciphertext in the `TenantCredential` row. Reads
 * route by the row's keyVersion, so legacy v1/v2 master-key rows still decrypt.
 *
 * The AAD stays `${tenantId}:${provider}` (NOT env-bound) — unchanged from before this
 * seam existed, so every pre-existing row keeps decrypting.
 */
export class DbSecretProvider implements SecretProvider {
  readonly name = "db";
  private readonly opts?: {
    encryptor?: KeyEncryptor;
    tenantKeys?: TenantKeyService;
  };
  private cached?: TenantKeyService;

  constructor(opts?: {
    encryptor?: KeyEncryptor;
    tenantKeys?: TenantKeyService;
  }) {
    this.opts = opts;
  }

  /** LAZY on purpose: `createKeyEncryptor()` demands `ENCRYPTION_KEY`, and constructing a
   *  provider (e.g. as a Vault provider's legacy-row fallback, or in the env factory) must
   *  not require it until a secret is actually read or written. Fail closed on first USE. */
  private get keys(): TenantKeyService {
    this.cached ??=
      this.opts?.tenantKeys ??
      (this.opts?.encryptor
        ? new TenantKeyService({ master: this.opts.encryptor })
        : getTenantKeyService());
    return this.cached;
  }

  private aad(ref: CredentialRef): string {
    return `${ref.tenantId}:${ref.provider}`;
  }

  async put(ref: CredentialRef, plaintext: string): Promise<StoredMaterial> {
    const enc = await this.keys.encrypt(ref.tenantId, plaintext, this.aad(ref));
    return {
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
      keyVersion: enc.keyVersion ?? 1,
    };
  }

  async get(ref: CredentialRef, stored: StoredMaterial): Promise<string> {
    if (isExternalMaterial(stored.keyVersion)) {
      // The row was written by an EXTERNAL provider but this process is configured
      // DB-only — the material is unreachable here. Fail loudly (and without any
      // material in the message) rather than returning a bogus empty key.
      throw new Error(
        `Credential '${ref.provider}' is stored in an external secret store; this process has SECRET_PROVIDER=db`,
      );
    }
    return this.keys.decrypt(
      ref.tenantId,
      {
        ciphertext: stored.ciphertext,
        iv: stored.iv,
        authTag: stored.authTag,
        keyVersion: stored.keyVersion,
      },
      this.aad(ref),
    );
  }

  /** No-op: for DB material, deleting the index row IS deleting the material. */
  async remove(_ref: CredentialRef): Promise<void> {}
}

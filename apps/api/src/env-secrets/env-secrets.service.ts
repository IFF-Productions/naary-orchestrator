import { BadRequestException, Injectable } from "@nestjs/common";
import { SecretStore } from "@naary/secrets";

// A secret is referenced as `{{ $secrets.NAME }}` and resolved by name in-activity, so NAME must be a
// single identifier — matches @naary/secrets SECRET_TOKEN_RE (letters/digits/underscore, no lead digit).
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// The store is shared with BYOK provider keys + connection tokens; user Environment Secrets live under
// this namespace so they never collide with a provider name or a `conn:` token.
const PREFIX = "secret:";

/**
 * Environment Secrets ($secrets) — user-named, env-scoped SECRET values referenced in node config as
 * `{{ $secrets.NAME }}`. This service is WRITE-ONLY by design: it lists NAMES and sets/removes values,
 * but NEVER returns a value (the worker reads + decrypts in-activity; the value never reaches the API
 * response, the graph, ctx, or Temporal history — CLAUDE.md Tier-1 §4). Backed by the encrypted,
 * env-scoped SecretStore (AES-256-GCM); env-scoped so sandbox and prod hold separate secrets.
 */
@Injectable()
export class EnvSecretsService {
  constructor(private readonly store: SecretStore) {}

  /** The secret NAMES configured for a workspace+env (never the values), key-sorted. */
  list(tenantId: string, environmentId: string): Promise<string[]> {
    return this.store.listKeys(tenantId, environmentId, PREFIX);
  }

  /** Create or replace a secret's value. Validates the NAME is a usable `$secrets.` identifier and
   *  the value is a non-empty string. The plaintext is encrypted at rest and never returned. */
  async set(
    tenantId: string,
    environmentId: string,
    name: string,
    value: unknown,
  ): Promise<void> {
    const n = (name ?? "").trim();
    if (!NAME_RE.test(n)) {
      throw new BadRequestException(
        "Secret name must be a valid identifier (letters, digits, underscore; not starting with a digit) — it's referenced as {{ $secrets.NAME }}.",
      );
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new BadRequestException("Secret value must be a non-empty string.");
    }
    await this.store.put(tenantId, environmentId, PREFIX + n, value);
  }

  /** Delete a secret (no-op if absent). Trims the name so it matches how `set` stored it. */
  async remove(
    tenantId: string,
    environmentId: string,
    name: string,
  ): Promise<void> {
    await this.store.remove(
      tenantId,
      environmentId,
      PREFIX + (name ?? "").trim(),
    );
  }

  // --- Tenant-wide (global) secrets (#459) — same namespace + validation, but NO env. A tenant-wide
  // secret applies in every environment; an env-specific secret of the same NAME overrides it (the
  // worker resolves env-first via getWithGlobalFallback). Still WRITE-ONLY: names in, values never out.

  /** The tenant-wide secret NAMES (never the values), key-sorted. */
  listGlobal(tenantId: string): Promise<string[]> {
    return this.store.listGlobalKeys(tenantId, PREFIX);
  }

  /** Create or replace a TENANT-WIDE secret's value. Same NAME + value validation as `set`. */
  async setGlobal(
    tenantId: string,
    name: string,
    value: unknown,
  ): Promise<void> {
    const n = (name ?? "").trim();
    if (!NAME_RE.test(n)) {
      throw new BadRequestException(
        "Secret name must be a valid identifier (letters, digits, underscore; not starting with a digit) — it's referenced as {{ $secrets.NAME }}.",
      );
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new BadRequestException("Secret value must be a non-empty string.");
    }
    await this.store.putGlobal(tenantId, PREFIX + n, value);
  }

  /** Delete a TENANT-WIDE secret (no-op if absent). */
  async removeGlobal(tenantId: string, name: string): Promise<void> {
    await this.store.removeGlobal(tenantId, PREFIX + (name ?? "").trim());
  }
}

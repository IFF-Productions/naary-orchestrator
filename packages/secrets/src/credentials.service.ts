import { getPrisma } from "@naary/db";
import { type KeyEncryptor } from "./crypto";
import { TenantKeyService, getTenantKeyService } from "./tenant-keys";
import {
  validateAnthropicKey,
  validateClaudeCodeKey,
  validateCopilotKey,
  validateCursorKey,
  validateGoogleKey,
  validateOpenAiKey,
} from "./provider-validate";

/** Thrown when a tenant has no usable (present + valid) credential for a provider. */
export class MissingCredentialError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly provider: string,
    /** The env the lookup missed in (Slice 5) — a key may exist in another env; naming it here
     *  makes "valid key, wrong env" debuggable. Optional so older call sites still compile. */
    public readonly environmentId?: string,
  ) {
    super(
      `No valid '${provider}' credential for tenant '${tenantId}'` +
        (environmentId ? ` in environment '${environmentId}'` : ""),
    );
    this.name = "MissingCredentialError";
  }
}

/** Verifies a provider key is usable. Injectable so tests don't hit a provider. */
export type ProviderValidator = (
  provider: string,
  apiKey: string,
) => Promise<boolean>;

const defaultValidator: ProviderValidator = (provider, apiKey) => {
  if (provider === "anthropic") return validateAnthropicKey(apiKey);
  if (provider === "openai") return validateOpenAiKey(apiKey);
  if (provider === "google") return validateGoogleKey(apiKey);
  // The Claude Code CLI credential (API key OR subscription setup-token) — format check only;
  // the Integrations "Run test" is its real verification. Distinct slot from `anthropic`.
  if (provider === "claude-code") return validateClaudeCodeKey(apiKey);
  // The other code-agent CLI slots (dedicated, separate from any model key). Format-only, like
  // claude-code — a live run is the real check. See code-agent-drivers.ts (cursor/copilot).
  if (provider === "cursor") return validateCursorKey(apiKey);
  if (provider === "copilot") return validateCopilotKey(apiKey);
  throw new Error(`Unsupported provider: ${provider}`);
};

export interface SaveCredentialResult {
  id: string;
  provider: string;
  isValid: boolean;
}

/**
 * Stores tenant provider keys encrypted, and hands the plaintext back only
 * in-memory to the activity that needs it. The key is NEVER returned to the
 * caller of saveCredential, logged, or echoed in API responses.
 */
export class CredentialsService {
  private readonly keys: TenantKeyService;
  private readonly validate: ProviderValidator;

  constructor(opts?: {
    /** Master (KEK) override — wrapped in a fresh TenantKeyService. Tests inject this. */
    encryptor?: KeyEncryptor;
    /** Full envelope-service override; wins over `encryptor`. */
    tenantKeys?: TenantKeyService;
    validate?: ProviderValidator;
  }) {
    this.keys =
      opts?.tenantKeys ??
      (opts?.encryptor
        ? new TenantKeyService({ master: opts.encryptor })
        : getTenantKeyService());
    this.validate = opts?.validate ?? defaultValidator;
  }

  /** Validate, encrypt, and upsert. Returns metadata only — never the key. Env-scoped (Slice 5):
   *  the credential lives in `environmentId`, so a sandbox key and a prod key are separate rows. */
  async saveCredential(
    tenantId: string,
    environmentId: string,
    provider: string,
    apiKey: string,
  ): Promise<SaveCredentialResult> {
    const isValid = await this.validate(provider, apiKey);
    // AAD binds the ciphertext to this tenant+provider slot (Sec#7). It stays (tenant, provider) —
    // NOT env-bound — so env is purely a row-lookup dimension and backfilled rows keep decrypting.
    // Encrypted with the tenant's own DEK (envelope, keyVersion 3) — see tenant-keys.ts.
    const enc = await this.keys.encrypt(
      tenantId,
      apiKey,
      `${tenantId}:${provider}`,
    );

    const row = await getPrisma().tenantCredential.upsert({
      where: {
        tenantId_environmentId_provider: { tenantId, environmentId, provider },
      },
      create: {
        tenantId,
        environmentId,
        provider,
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        authTag: enc.authTag,
        keyVersion: enc.keyVersion ?? 1,
        isValid,
        lastValidatedAt: new Date(),
      },
      update: {
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        authTag: enc.authTag,
        keyVersion: enc.keyVersion ?? 1,
        isValid,
        lastValidatedAt: new Date(),
      },
    });

    return { id: row.id, provider, isValid };
  }

  /** The env's configured *model* providers — names + validity only, NEVER key material. This table
   *  is namespaced: connection tokens under `conn:`, user Environment Secrets under `secret:`, and
   *  the Turnstile secret under `turnstile:` are NOT model providers, so all are excluded (a provider
   *  name never contains a `:`). */
  async listProviders(
    tenantId: string,
    environmentId: string,
  ): Promise<{ provider: string; isValid: boolean }[]> {
    const rows = await getPrisma().tenantCredential.findMany({
      where: {
        tenantId,
        environmentId,
        NOT: [
          { provider: { startsWith: "conn:" } },
          { provider: { startsWith: "secret:" } },
          { provider: { startsWith: "turnstile:" } },
        ],
      },
      select: { provider: true, isValid: true },
      orderBy: { provider: "asc" },
    });
    return rows.map((r) => ({ provider: r.provider, isValid: r.isValid }));
  }

  /** Decrypt and return the plaintext key (in memory only). Throws if absent/invalid. Env-scoped:
   *  the run's environment selects which key (sandbox test key vs prod live key). */
  async getDecryptedKey(
    tenantId: string,
    environmentId: string,
    provider: string,
  ): Promise<string> {
    const row = await getPrisma().tenantCredential.findUnique({
      where: {
        tenantId_environmentId_provider: { tenantId, environmentId, provider },
      },
    });
    if (!row || !row.isValid) {
      throw new MissingCredentialError(tenantId, provider, environmentId);
    }
    // Routed by keyVersion: v3 rows use the tenant DEK; legacy v1/v2 rows the master key.
    return this.keys.decrypt(
      tenantId,
      {
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.authTag,
        keyVersion: row.keyVersion,
      },
      `${tenantId}:${provider}`,
    );
  }
}

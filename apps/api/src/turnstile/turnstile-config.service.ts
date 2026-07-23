import { BadRequestException, Injectable } from "@nestjs/common";
import { getPrisma } from "@naary/db";
import { SecretStore } from "@naary/secrets";

/** Reserved SecretStore key (namespaced with `:` so it's excluded from the model-provider listing,
 *  like `conn:`/`secret:`) under which the Turnstile SECRET key is encrypted at rest. */
const SECRET_KEY = "turnstile:secret";

/** Public view of a tenant/env Turnstile config — NEVER carries the secret key (only whether one is
 *  set). The site key is public (rendered in the browser widget), so it IS returned. */
export interface TurnstileConfigView {
  siteKey: string;
  enabled: boolean;
  hasSecret: boolean;
}

export interface TurnstileConfigInput {
  siteKey?: unknown;
  /** Write-only: set/replaced, never read back. Omitted/empty on update ⇒ keep the existing secret. */
  secretKey?: unknown;
  enabled?: unknown;
}

/**
 * Cloudflare Turnstile bot-protection config, per (tenant, environment) — see
 * docs/design/TURNSTILE-BOT-PROTECTION.md. The public site key + enable toggle live in the
 * `TurnstileConfig` table; the SECRET key is stored encrypted in the SecretStore (per-tenant DEK,
 * write-only) under `turnstile:secret`, mirroring how connection tokens (`conn:`) and $secrets
 * (`secret:`) are namespaced there. The secret never leaves the server (Tier-1 §4).
 */
@Injectable()
export class TurnstileConfigService {
  // Injected via the module's useFactory (so Nest doesn't try to DI SecretStore); tests pass a stub.
  // The default `new SecretStore()` reads ENCRYPTION_KEY at construction (fail-fast at boot).
  constructor(private readonly secrets: SecretStore = new SecretStore()) {}

  /** The config view for an env, or null if none is set. `hasSecret` reflects whether a secret key
   *  is stored (checked without exposing it). */
  async get(
    tenantId: string,
    environmentId: string,
  ): Promise<TurnstileConfigView | null> {
    const row = await getPrisma().turnstileConfig.findUnique({
      where: { tenantId_environmentId: { tenantId, environmentId } },
    });
    if (!row) return null;
    const secret = await this.secrets.get(tenantId, environmentId, SECRET_KEY);
    return {
      siteKey: row.siteKey,
      enabled: row.enabled,
      hasSecret: secret != null,
    };
  }

  /** Create/update the config. The site key is required; the secret key is write-only (set only when
   *  a non-empty value is supplied, so a site-key/enabled edit keeps the existing secret). */
  async save(
    tenantId: string,
    environmentId: string,
    input: TurnstileConfigInput,
  ): Promise<TurnstileConfigView> {
    const siteKey =
      typeof input.siteKey === "string" ? input.siteKey.trim() : "";
    if (!siteKey)
      throw new BadRequestException("A Turnstile site key is required.");
    const enabled = input.enabled === undefined ? true : Boolean(input.enabled);

    await getPrisma().turnstileConfig.upsert({
      where: { tenantId_environmentId: { tenantId, environmentId } },
      create: { tenantId, environmentId, siteKey, enabled },
      update: { siteKey, enabled },
    });

    const secretKey =
      typeof input.secretKey === "string" ? input.secretKey.trim() : "";
    if (secretKey) {
      await this.secrets.put(tenantId, environmentId, SECRET_KEY, secretKey);
    }

    // Non-null: we just upserted the row.
    return (await this.get(tenantId, environmentId)) as TurnstileConfigView;
  }

  /** Remove the config AND its stored secret (idempotent). */
  async remove(tenantId: string, environmentId: string): Promise<void> {
    await getPrisma().turnstileConfig.deleteMany({
      where: { tenantId, environmentId },
    });
    await this.secrets.remove(tenantId, environmentId, SECRET_KEY);
  }
}

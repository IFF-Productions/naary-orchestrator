import { BadRequestException, Injectable } from "@nestjs/common";
import { getPrisma } from "@naary/db";
import { SecretStore } from "@naary/secrets";

/** Reserved SecretStore key (namespaced with `:` so it's excluded from the model-provider listing,
 *  like `conn:`/`secret:`) under which the Turnstile SECRET key is encrypted at rest. */
const SECRET_KEY = "turnstile:secret";

/** Cloudflare's server-side token verification endpoint. */
const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** Bound the siteverify round-trip so a hung Cloudflare doesn't hold the ingress request. */
const SITEVERIFY_TIMEOUT_MS = 5_000;

/** Injectable I/O seam (swapped in tests so no real Cloudflare call is made). */
export const __turnstileDeps = {
  fetch: (url: string, init: RequestInit): Promise<Response> =>
    fetch(url, init),
};

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

  /**
   * The public site key to render the widget on this env's public form/chat page, or null when the
   * gate isn't active — disabled, unconfigured, OR enabled-but-no-secret (we only advertise the
   * widget when we can actually verify a token, else the page would gate a submit we'd let through).
   * Anonymous callers reach this via the public form/chat GET definition.
   */
  async publicSiteKey(
    tenantId: string,
    environmentId: string,
  ): Promise<string | null> {
    const row = await getPrisma().turnstileConfig.findUnique({
      where: { tenantId_environmentId: { tenantId, environmentId } },
    });
    if (!row || !row.enabled) return null;
    const secret = await this.secrets.get(tenantId, environmentId, SECRET_KEY);
    return secret ? row.siteKey : null;
  }

  /**
   * Gate check for an anonymous submission. Returns `true` to ALLOW, `false` to DENY (→ the caller
   * 403s). Not enforced (disabled / no config / no secret) ⇒ allow. Enforced + missing token ⇒ deny.
   * Otherwise verify with Cloudflare: a `success:false` (invalid/expired/reused) ⇒ deny; a
   * timeout/network/5xx ⇒ **fail-open** (allow) — this gate is defense-in-depth and the tenant budget
   * cap is the real cost backstop, so a Cloudflare blip must not brick every public form. No
   * `remoteip` is sent (behind a proxy it's the proxy's address, which can turn valid solves into
   * failures). The secret is decrypted in-request, used, never logged.
   */
  async verify(
    tenantId: string,
    environmentId: string,
    token: string | undefined,
  ): Promise<boolean> {
    const row = await getPrisma().turnstileConfig.findUnique({
      where: { tenantId_environmentId: { tenantId, environmentId } },
    });
    if (!row || !row.enabled) return true; // not enforced
    const secret = await this.secrets.get(tenantId, environmentId, SECRET_KEY);
    if (!secret) return true; // enabled but unconfigured — can't enforce (UI prevents this)
    if (!token) return false; // enforced, but the client sent no challenge
    return this.siteverify(secret, token);
  }

  /** POST the token to Cloudflare; true = solved. Fail-open on any transport failure (see `verify`). */
  private async siteverify(secret: string, token: string): Promise<boolean> {
    const body = new URLSearchParams();
    body.set("secret", secret);
    body.set("response", token);
    try {
      const res = await __turnstileDeps.fetch(SITEVERIFY_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
      });
      if (!res.ok) return true; // 5xx/4xx from Cloudflare → fail-open
      const json = (await res.json()) as { success?: boolean };
      return json?.success === true;
    } catch {
      return true; // timeout / network → fail-open
    }
  }
}

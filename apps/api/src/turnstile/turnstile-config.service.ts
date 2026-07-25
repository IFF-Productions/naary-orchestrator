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
  /** The SHARED domain allowlist (#615 + #617): hostnames these public pages may be served/embedded
   *  from. Empty ⇒ unrestricted. Used by BOTH the Turnstile solved-hostname check and the public
   *  embed CORS layer. */
  allowedHostnames: string[];
}

export interface TurnstileConfigInput {
  siteKey?: unknown;
  /** Write-only: set/replaced, never read back. Omitted/empty on update ⇒ keep the existing secret. */
  secretKey?: unknown;
  enabled?: unknown;
  /** The shared domain allowlist (#615 Turnstile hostnames + #617 embed CORS origins). Non-array ⇒
   *  unchanged; entries are normalized to bare hostnames + de-duped. */
  allowedHostnames?: unknown;
}

/**
 * Normalize one entry of the shared domain allowlist to a bare HOSTNAME. Users paste origins
 * (`https://example.com/`), hosts with ports (`example.com:3000`), or plain hosts — and the list is
 * matched against BOTH Turnstile's solved hostname (never has a scheme/port) and a CORS request
 * origin's hostname (#617), so every form must collapse to the same thing. Returns "" when the
 * entry has no usable host.
 */
function toHostname(raw: string): string {
  let s = raw.trim().toLowerCase();
  if (!s) return "";
  if (s.includes("://")) {
    try {
      s = new URL(s).hostname;
    } catch {
      return "";
    }
  } else {
    s = s.split("/")[0]; // strip any path
    // Strip a :port — but never break an IPv6 literal ("[::1]:3000" → "[::1]").
    if (s.startsWith("[")) s = s.slice(0, s.indexOf("]") + 1) || s;
    else s = s.split(":")[0];
  }
  return /^[a-z0-9._[\]:-]+$/.test(s) ? s : "";
}

/** Normalize an allowed-hostnames input to a clean string[] (to bare hostnames, drop empties,
 *  de-dupe), or null when the caller didn't supply an array (⇒ leave the stored value unchanged). */
function normalizeHostnames(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const h of v) {
    if (typeof h !== "string") continue;
    const t = toHostname(h);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * Cloudflare Turnstile bot-protection config, per (tenant, environment) — see
 * docs/design/TURNSTILE-BOT-PROTECTION.md. Also the home of the SHARED public-pages domain
 * allowlist (`allowedHostnames`), which #617 unified: ONE list per (tenant, env) drives both the
 * Turnstile solved-hostname check and the public embed CORS layer, rather than two competing lists.
 * The public site key + enable toggle live in the `TurnstileConfig` table; the SECRET key is stored
 * encrypted in the SecretStore (per-tenant DEK, write-only) under `turnstile:secret`, mirroring how
 * connection tokens (`conn:`) and $secrets (`secret:`) are namespaced there. The secret never leaves
 * the server (Tier-1 §4).
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
      allowedHostnames: row.allowedHostnames,
    };
  }

  /**
   * Create/update the config. The secret key is write-only (set only when a non-empty value is
   * supplied, so a site-key/enabled edit keeps the existing secret).
   *
   * The site key is required only when the bot gate is ENABLED (#617): the row now also carries the
   * shared embed-domain allowlist, so a tenant who wants embed domains but no CAPTCHA must be able
   * to save one with `enabled: false` and no keys. An `enabled: true` row with no site key anywhere
   * would render no widget, so that combination still 400s. An omitted/empty site key KEEPS the
   * stored one (like the secret) — so a domains-only save can never silently wipe working keys.
   */
  async save(
    tenantId: string,
    environmentId: string,
    input: TurnstileConfigInput,
  ): Promise<TurnstileConfigView> {
    const existing = await getPrisma().turnstileConfig.findUnique({
      where: { tenantId_environmentId: { tenantId, environmentId } },
    });
    const supplied =
      typeof input.siteKey === "string" ? input.siteKey.trim() : "";
    const siteKey = supplied || existing?.siteKey || "";
    const enabled = input.enabled === undefined ? true : Boolean(input.enabled);
    if (enabled && !siteKey) {
      throw new BadRequestException(
        "A Turnstile site key is required to enable bot protection.",
      );
    }
    const hostnames = normalizeHostnames(input.allowedHostnames);

    await getPrisma().turnstileConfig.upsert({
      where: { tenantId_environmentId: { tenantId, environmentId } },
      create: {
        tenantId,
        environmentId,
        siteKey,
        enabled,
        ...(hostnames ? { allowedHostnames: hostnames } : {}),
      },
      // Only overwrite the hostname list when the caller sent an array (else keep the stored one).
      update: {
        siteKey,
        enabled,
        ...(hostnames ? { allowedHostnames: hostnames } : {}),
      },
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
   * cap is the real cost backstop, so a Cloudflare blip must not brick every public form. When a
   * non-empty `allowedHostnames` list is set (#615), the solved `hostname` from siteverify (tied to
   * the token, not a spoofable header) must be in it — a server-side "allowed domains" that also kills
   * site-key-lift replay. No `remoteip` is sent (behind a proxy it's the proxy's address, which can
   * turn valid solves into failures). The secret is decrypted in-request, used, never logged.
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

    const result = await this.siteverify(secret, token);
    if (result === "unavailable") return true; // Cloudflare blip → fail-open
    if (!result.success) return false; // invalid / expired / reused
    // Optional "allowed domains": the solved hostname must be on the list (empty ⇒ any host).
    const allow = row.allowedHostnames ?? [];
    if (allow.length > 0) {
      const host = result.hostname?.toLowerCase();
      if (!host || !allow.includes(host)) return false;
    }
    return true;
  }

  /**
   * POST the token to Cloudflare. Returns the solved result `{ success, hostname }`, or the marker
   * `"unavailable"` on any transport failure (timeout/network/5xx) so `verify` can fail-open.
   */
  private async siteverify(
    secret: string,
    token: string,
  ): Promise<{ success: boolean; hostname?: string } | "unavailable"> {
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
      if (!res.ok) return "unavailable"; // 5xx/4xx from Cloudflare → fail-open
      const json = (await res.json()) as {
        success?: boolean;
        hostname?: string;
      };
      return {
        success: json?.success === true,
        ...(typeof json?.hostname === "string"
          ? { hostname: json.hostname }
          : {}),
      };
    } catch {
      return "unavailable"; // timeout / network → fail-open
    }
  }
}

import { BadRequestException, Injectable } from "@nestjs/common";
import { getPrisma } from "@naary/db";
import { SecretStore } from "@naary/secrets";
import { AppCheckVerifier } from "./app-check-verifier";

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
/** Which bot gate guards a tenant/env's public pages (docs/design/TENANT-BOT-GATE-PROVIDERS.md).
 *  `turnstile` = the tenant's own Cloudflare keys; `app_check` = the PLATFORM's Firebase App Check,
 *  where the tenant supplies nothing. */
export type BotGateProvider = "turnstile" | "app_check";

export const BOT_GATE_PROVIDERS: readonly BotGateProvider[] = [
  "turnstile",
  "app_check",
];

/** Narrow an unknown provider input; anything unrecognized ⇒ null (the caller decides). */
export function toBotGateProvider(v: unknown): BotGateProvider | null {
  return typeof v === "string" &&
    (BOT_GATE_PROVIDERS as readonly string[]).includes(v)
    ? (v as BotGateProvider)
    : null;
}

/**
 * Pull the bot-gate token off an anonymous submission body.
 *
 * `botToken` is the provider-neutral name (an App Check attestation isn't a "turnstile token"), but
 * `turnstileToken` stays accepted: an embedded iframe on a tenant's site can be running a CACHED
 * older bundle that only sends the old name, and breaking those pages to rename a field would be a
 * bad trade. Neither is a declared form field, so `validateSubmission` strips both before anything
 * reaches the graph. Removed in the design's slice 4.
 */
export function botTokenFrom(
  body: { botToken?: unknown; turnstileToken?: unknown } | null | undefined,
): string | undefined {
  // Each candidate is checked in turn rather than `a ?? b`: an EMPTY `botToken` (a page that
  // initialised the new field but got no token) must fall through to the legacy one, not mask it.
  for (const raw of [body?.botToken, body?.turnstileToken]) {
    if (typeof raw === "string" && raw.length > 0) return raw;
  }
  return undefined;
}

/**
 * What a PUBLIC (anonymous) page needs to render the gate. Replaces the old
 * `publicSiteKey(): string | null` — App Check has no site key to hand out, so a bare string can't
 * express both providers and both controllers used to branch on its truthiness.
 * `null` ⇒ no active gate.
 */
export type PublicGate =
  { provider: "turnstile"; siteKey: string } | { provider: "app_check" };

export interface TurnstileConfigView {
  siteKey: string;
  enabled: boolean;
  hasSecret: boolean;
  /** Which mechanism guards this env's public pages. Pre-existing rows read as `turnstile`. */
  provider: BotGateProvider;
  /** Whether the PLATFORM can verify App Check tokens at all (service account present). False ⇒ the
   *  settings UI must not offer `app_check`, because enabling it would gate submissions we couldn't
   *  verify. Derived, never stored. */
  appCheckAvailable: boolean;
  /** The SHARED domain allowlist (#615 + #617): hostnames these public pages may be served/embedded
   *  from. Empty ⇒ unrestricted. Used by BOTH the Turnstile solved-hostname check and the public
   *  embed CORS layer. */
  allowedHostnames: string[];
}

export interface TurnstileConfigInput {
  /** `turnstile` | `app_check`. Omitted ⇒ keep the stored provider (default `turnstile`). */
  provider?: unknown;
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
  constructor(
    private readonly secrets: SecretStore = new SecretStore(),
    /** App Check verification (the second provider). Its own `enabled` decides whether `app_check`
     *  may be offered/enforced at all. */
    private readonly appCheck: AppCheckVerifier = new AppCheckVerifier(),
  ) {}

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
      provider: toBotGateProvider(row.provider) ?? "turnstile",
      appCheckAvailable: this.appCheck.enabled,
      allowedHostnames: row.allowedHostnames,
    };
  }

  /** Whether this deployment can verify App Check tokens — so the settings UI can offer (or hide)
   *  that provider even when no config row exists yet. */
  get appCheckAvailable(): boolean {
    return this.appCheck.enabled;
  }

  /**
   * Boot check: are there tenants relying on an App Check gate this deployment CANNOT verify?
   *
   * Enabling `app_check` requires a live round trip (design §5), so it can't be saved broken — but
   * that proves nothing about later deploys. A release that drops the Firebase service account (or
   * the web build's App Check site key) would leave those tenants' gates unenforceable, which
   * otherwise shows up only as public forms quietly losing their protection. Logged loudly at boot
   * instead. Never throws: a DB hiccup here must not block startup.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (this.appCheck.enabled) return;
    try {
      const count = await getPrisma().turnstileConfig.count({
        where: { provider: "app_check", enabled: true },
      });
      if (count > 0) {
        console.warn(
          `[bot-gate] ${count} environment(s) have App Check bot protection enabled, but this instance has no Firebase service account — those gates CANNOT be enforced and their public pages are ungated. Configure FIREBASE_SERVICE_ACCOUNT_JSON (or GOOGLE_APPLICATION_CREDENTIALS), or switch those environments to Turnstile.`,
        );
      }
    } catch (e) {
      // Still never throws — a DB hiccup here must not block startup. But it must not be SILENT
      // either (#830): the only two outcomes used to be "nothing printed because every gate is
      // enforceable" and "nothing printed because the check itself died", and an operator reading
      // the boot log cannot tell those apart. For a check whose entire subject is "are public
      // pages ungated right now", clean-looking silence is the wrong default — say the check
      // didn't run, so the absence of the warning below can be trusted when it IS absent.
      console.warn(
        `[bot-gate] could not check for unenforceable App Check gates at boot — treat the absence of a warning as unknown, not as all-clear: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
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

    // Provider: omitted ⇒ keep what's stored (pre-#782 rows read as turnstile). An unrecognized
    // value is refused rather than silently coerced — a typo must not switch a tenant's gate.
    let provider: BotGateProvider =
      toBotGateProvider(existing?.provider) ?? "turnstile";
    if (input.provider !== undefined) {
      const wanted = toBotGateProvider(input.provider);
      if (!wanted) {
        throw new BadRequestException(
          `Unknown bot-protection provider. Expected one of: ${BOT_GATE_PROVIDERS.join(", ")}.`,
        );
      }
      provider = wanted;
    }

    // The "enabled ⇒ keys required" rule is PROVIDER-CONDITIONAL. Only Turnstile has tenant keys;
    // requiring a site key for app_check would 400 every App Check enable (design §2).
    if (enabled && provider === "turnstile" && !siteKey) {
      throw new BadRequestException(
        "A Turnstile site key is required to enable bot protection.",
      );
    }
    // App Check is the platform's, so a tenant can only switch to it where the platform can actually
    // verify tokens — otherwise the page would gate a submit we'd wave through.
    if (enabled && provider === "app_check" && !this.appCheck.enabled) {
      throw new BadRequestException(
        "App Check bot protection isn't available on this instance (no Firebase service account configured). Use Turnstile, or ask an operator to configure App Check.",
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
        provider,
        ...(hostnames ? { allowedHostnames: hostnames } : {}),
      },
      // Only overwrite the hostname list when the caller sent an array (else keep the stored one).
      update: {
        siteKey,
        enabled,
        provider,
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
    const gate = await this.publicGate(tenantId, environmentId);
    return gate?.provider === "turnstile" ? gate.siteKey : null;
  }

  /**
   * What an anonymous page needs to render the active gate, or null when there isn't one.
   *
   * The "only advertise a gate we can actually verify" rule applies to BOTH providers — otherwise
   * the page would gate a submit the server would wave through:
   *   - turnstile ⇒ enabled AND a secret is stored
   *   - app_check ⇒ enabled AND this deployment can verify App Check tokens
   */
  async publicGate(
    tenantId: string,
    environmentId: string,
  ): Promise<PublicGate | null> {
    const row = await getPrisma().turnstileConfig.findUnique({
      where: { tenantId_environmentId: { tenantId, environmentId } },
    });
    if (!row || !row.enabled) return null;
    const provider = toBotGateProvider(row.provider) ?? "turnstile";
    if (provider === "app_check") {
      return this.appCheck.enabled ? { provider: "app_check" } : null;
    }
    const secret = await this.secrets.get(tenantId, environmentId, SECRET_KEY);
    return secret && row.siteKey
      ? { provider: "turnstile", siteKey: row.siteKey }
      : null;
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

    // App Check: the platform's own gate, no tenant keys. Verdict mapping is deliberate —
    // `unavailable` (not configured / network blip) ALLOWS, matching the siteverify posture below,
    // while a replayed token is a definite negative and denies. `allowedHostnames` has NO analogue
    // here: an App Check token carries no solved hostname, so that check is Turnstile-only (this is
    // the capability a tenant gives up by choosing App Check — design §1).
    if ((toBotGateProvider(row.provider) ?? "turnstile") === "app_check") {
      if (!this.appCheck.enabled) return true; // can't enforce (UI prevents saving this)
      if (!token) return false; // enforced, but the client sent no attestation
      const verdict = await this.appCheck.verify(token);
      return verdict !== "denied";
    }

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

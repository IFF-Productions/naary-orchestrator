/**
 * Every environment variable `apps/api` reads, in one file — with its parsing, its default, and
 * WHY that default. See docs/design/CONFIG-CENTRALIZATION.md (slice 1 of 3).
 *
 * FUNCTIONS, NOT CONSTANTS, deliberately. `export const FOO = process.env.FOO` evaluates at import
 * time, which would make dotenv boot-order a correctness property for every variable here —
 * `env.ts` exists precisely because dotenv must run before anything reads config, and an import
 * moved innocently to the top of a file would then silently read `undefined` with nothing failing
 * loudly. It would also destroy the injectable-env test seams the newer code already relies on
 * (`platformOperatorEmails(env)`, `ssoConfig(env)`, the `SSO_ENV` DI token).
 *
 * So every accessor takes `env = process.env`. Callers that already accept an injected env pass it
 * straight through; everything else gets the default and behaves exactly as the inline read did.
 *
 * This module is a LEAF: it imports nothing from the app. Anything here that needs a Nest service,
 * a DB, or a domain type belongs at the call site, not in config.
 */

type Env = NodeJS.ProcessEnv;

/** The env shape the SSO services inject (a plain record, not NodeJS.ProcessEnv). */
type PlainEnv = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// parsing helpers — shared so "truthy" means one thing across the whole API
// ---------------------------------------------------------------------------

/**
 * The project's one definition of a boolean env value. EXPLICIT opt-in only: anything else,
 * including "", "0", "no" and a typo, is false. Every flag below defaults OFF, so a
 * misspelt value fails closed rather than silently enabling something.
 */
function parseBool(raw: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((raw ?? "").trim().toLowerCase());
}

/** Comma-separated list → trimmed, non-empty entries. */
function parseList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// core process
// ---------------------------------------------------------------------------

/** Postgres connection string. No default — `env.ts` fails the boot without it. */
export function databaseUrl(env: Env = process.env): string | undefined {
  return env.DATABASE_URL;
}

/**
 * The master encryption key (64 hex chars). No default and never logged: `env.ts` validates it at
 * boot, so a running process always has one. Returned as `string | undefined` anyway, because two
 * callers legitimately run outside that boot path — the rotation CLI and the OpenAPI emitter.
 */
export function encryptionKey(env: Env = process.env): string | undefined {
  return env.ENCRYPTION_KEY;
}

/** HTTP port. 3000 matches the Dockerfile EXPOSE and every compose/nginx upstream. */
export function port(env: Env = process.env): number {
  return Number(env.PORT ?? 3000);
}

/**
 * Origins allowed to call the API, as configured. EMPTY when unset — callers that need a
 * dev-friendly default use {@link browserCorsOrigins}; callers that derive a public base URL from
 * it must NOT (see {@link appBaseUrlCandidates}), or an unset var would hand them a localhost URL
 * in production.
 */
export function corsOrigins(env: Env = process.env): string[] {
  return parseList(env.CORS_ORIGINS);
}

/**
 * CORS for the browser app, falling back to the Vite dev server so `npm run start` works bare.
 *
 * The fallback applies to UNSET only, not to empty. `CORS_ORIGINS=""` is an operator explicitly
 * allowing no browser origin, and must stay that way — quietly re-admitting localhost because the
 * list parsed empty would reverse a deliberate lockdown.
 */
export function browserCorsOrigins(env: Env = process.env): string[] {
  return parseList(env.CORS_ORIGINS ?? "http://localhost:5173");
}

/**
 * Candidates for the SPA's public base URL, in precedence order: `APP_BASE_URL`, then each
 * `CORS_ORIGINS` entry. ALWAYS server-derived, never from a request parameter — that is what stops
 * the connection-callback redirect from becoming an open redirect.
 *
 * Returned unnormalized (and including a possibly-empty first entry) because the two consumers
 * validate differently: connect-return wants a bare http(s) prefix, notifications runs its own
 * `normalizeBaseUrl`. Centralising the READ without forcing them to share a normalizer keeps this
 * a config change and not a behaviour change.
 */
export function appBaseUrlCandidates(env: Env = process.env): string[] {
  return [env.APP_BASE_URL ?? "", ...(env.CORS_ORIGINS ?? "").split(",")];
}

/** Omit /docs + /docs-json. Default ON (documented API); set to 1 in a hardened deployment. */
export function swaggerDisabled(env: Env = process.env): boolean {
  return env.SWAGGER_DISABLED === "1";
}

// ---------------------------------------------------------------------------
// access control
// ---------------------------------------------------------------------------

/**
 * Early-access email allowlist. `null` = OPEN (the default): this gates a private beta, so an
 * unset var must not lock every user out of a self-hosted install. Distinct from
 * PLATFORM_OPERATORS below, which fails the other way on purpose.
 */
export function accessAllowedEmails(
  env: Env = process.env,
): Set<string> | null {
  const list = parseList(env.ACCESS_ALLOWED_EMAILS).map((e) => e.toLowerCase());
  return list.length > 0 ? new Set(list) : null;
}

/** Instance-wide MFA requirement (#457). Default OFF — turning it on locks out single-factor users. */
export function requireMfa(env: Env = process.env): boolean {
  return parseBool(env.REQUIRE_MFA);
}

/**
 * Who may read cross-tenant infra telemetry (the Workers fleet view). Unset ⇒ NOBODY, deliberately:
 * a security posture that depends on remembering to set an env var isn't one. See
 * auth/platform-operators.ts for the full rationale.
 */
export function platformOperators(env: Env = process.env): string[] {
  return parseList(env.PLATFORM_OPERATORS).map((e) => e.toLowerCase());
}

/** Let tenant admins configure their own SAML, rather than an operator doing it. Default OFF. */
export function ssoSelfService(env: Env = process.env): boolean {
  return parseBool(env.SSO_SELF_SERVICE);
}

/** Signs SSO session cookies. Unset ⇒ SAML stays disabled; the length floor is enforced at the
 *  call site, which logs the refusal (a short secret would let anyone mint a principal). */
export function ssoSessionSecret(env: PlainEnv = process.env): string {
  return (env.SSO_SESSION_SECRET ?? "").trim();
}

/** How long an SSO session lasts. NaN/absent/non-positive ⇒ the caller's DEFAULT_TTL_SECONDS,
 *  which lives beside the session it bounds. */
export function ssoSessionTtlSeconds(env: PlainEnv = process.env): number {
  return Number(env.SSO_SESSION_TTL_SECONDS ?? "");
}

/** SP entity id — must match what the IdP admin entered, so it is explicit env and never derived
 *  from a (spoofable) Host header. */
export function ssoSpEntityId(env: PlainEnv = process.env): string {
  return (env.SSO_SP_ENTITY_ID ?? "").trim();
}

/** SP assertion-consumer-service URL. Same reasoning as {@link ssoSpEntityId}. */
export function ssoAcsUrl(env: PlainEnv = process.env): string {
  return (env.SSO_ACS_URL ?? "").trim();
}

// ---------------------------------------------------------------------------
// Firebase (ID-token verification, App Check, the tenant-claim CLI)
// ---------------------------------------------------------------------------

/** A service-account JSON blob. Either this or ADC enables Firebase auth — `verifyIdToken`
 *  requires a service-account credential, so with neither, Firebase auth stays off. */
export function firebaseServiceAccountJson(
  env: Env = process.env,
): string | undefined {
  return env.FIREBASE_SERVICE_ACCOUNT_JSON;
}

/** Path to an ADC credential file — the other way to supply the same thing. */
export function googleApplicationCredentials(
  env: Env = process.env,
): string | undefined {
  return env.GOOGLE_APPLICATION_CREDENTIALS;
}

/** Explicit project id. Usually inferable from the credential, hence optional. */
export function firebaseProjectId(env: Env = process.env): string | undefined {
  return env.FIREBASE_PROJECT_ID || undefined;
}

/** Which custom claim carries the tenant id. "tenant" is what set-tenant-claim.ts writes. */
export function firebaseTenantClaim(env: Env = process.env): string {
  return env.FIREBASE_TENANT_CLAIM ?? "tenant";
}

// ---------------------------------------------------------------------------
// outbound integrations
// ---------------------------------------------------------------------------

/** Platform SMTP. Unset ⇒ mail send is a no-op (a dev install shouldn't need a mail server). */
export function smtpUrl(env: Env = process.env): string | undefined {
  return env.SMTP_URL?.trim() || undefined;
}

/** From-address for platform mail. The default is deliberately a `.local` address: undeliverable,
 *  so a misconfigured install can't send from something that looks real. */
export function mailFrom(env: Env = process.env): string {
  return env.MAIL_FROM?.trim() || "Naary <no-reply@naary.local>";
}

/** Where the generic MCP OAuth consent returns. Must match what was registered with the provider;
 *  the localhost default only fits local dev. */
export function oauthRedirectUri(env: Env = process.env): string {
  return (
    env.OAUTH_REDIRECT_URI ?? `http://localhost:${port(env)}/oauth/callback`
  );
}

/** Same, for Atlassian 3LO — a separate variable because the paths differ and both must match the
 *  URI registered on the Atlassian app. */
export function atlassianOauthRedirectUri(env: Env = process.env): string {
  return (
    env.ATLASSIAN_OAUTH_REDIRECT_URI ??
    `http://localhost:${port(env)}/atlassian/oauth/callback`
  );
}

/** Override the public MCP server registry. Unset ⇒ the caller's own DEFAULT_REGISTRY_URL, which
 *  lives beside the fetch that uses it. */
export function mcpRegistryUrl(env: Env = process.env): string | undefined {
  return env.MCP_REGISTRY_URL?.trim() || undefined;
}

// ---------------------------------------------------------------------------
// execution / storage
// ---------------------------------------------------------------------------

/** Resume snapshots. Default ON — the feature is only useful if it captured state BEFORE the
 *  failure it's meant to recover from, so it can't be opt-in per run. */
export function resumeSnapshotsEnabled(env: Env = process.env): boolean {
  return (env.RESUME_SNAPSHOTS ?? "on").toLowerCase() !== "off";
}

/** Object-store backend. Only "s3" persists resume snapshots anywhere the API can read. */
export function storageProvider(env: Env = process.env): string | undefined {
  return env.STORAGE_PROVIDER;
}


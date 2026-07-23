# Design — Cloudflare Turnstile bot protection for public forms & chat

**Status:** proposed · **Date:** 2026-07-23 · **Why a doc:** a new tenant-configured external-service
integration touching two anonymous ingress surfaces, encrypted per-tenant credentials, the public
SPA pages, and CSP — plus it's the first step toward tenants hosting/embedding forms on their own
sites. Design pass before code.

## Motivation

The public **form** (`POST /forms/:id`) and **chat** (`POST /chat/:id`) endpoints are `@Public()`,
anonymous, and start real workflows (which spend the tenant's BYOK LLM budget). Today the only
backstops are a per-IP `@Throttle` (a distributed flood bypasses it) and the tenant's monthly budget
cap (the *cost* backstop, but it still lets bots burn the whole cap). There is no **bot gate**.
Cloudflare **Turnstile** is a privacy-friendly CAPTCHA that adds one: a human-verification token the
server checks before starting a run.

## Decision: per-tenant BYO keys (confirmed with user)

Each tenant registers **their own** Turnstile keys (site key + secret key) rather than one
platform-wide account. Rationale the user gave: tenants should be able to **host/embed forms & chat
on their own sites** — and a Turnstile site key is bound to the hostname(s) registered in *that*
Cloudflare account. Per-tenant keys are the prerequisite for the tenant-owned-domain direction.

> **Scope fence:** custom domains / iframe embedding of public pages is a SEPARATE future program
> ("self-hosted public pages"). This design only adds the Turnstile bot gate with per-tenant keys —
> which is the foundation that direction needs, without building the routing/CORS/domain-verification
> that embedding requires.

## Storage (reuse the encryption infra we already have)

A Turnstile config is per **(tenant, environment)** — mirroring Variables/Secrets, and letting a
sandbox form use a test key while prod uses the live one.

- **Secret key** (a credential) → `@naary/secrets` **`SecretStore`** (`put`/`getWithGlobalFallback`):
  env-scoped, encrypted at rest under the per-tenant DEK, **write-only** (never read back to the UI).
  Exactly the contract secret keys need. Stored under a reserved key (e.g. `__turnstile_secret`).
- **Site key** (public, safe to serve to any browser) + an **enabled** flag → a small dedicated
  `TurnstileConfig` row `{ tenantId, environmentId, siteKey }` (unique per tenant+env). Not a Variable
  (keeps it out of the `$vars` list and the graph namespace — it's config, not an expression input).

Rejected: a platform-wide env key (user chose BYO); stuffing the site key into Variables (leaks into
`$vars`); a brand-new encryptor (SecretStore already wraps `createKeyEncryptor()`).

## Flow

1. **GET definition** (`/forms/:id`, `/chat/:id`) — already served to the anonymous page. When the
   tenant has an enabled Turnstile config for the endpoint's env, include `turnstileSiteKey` in the
   public definition. Absent ⇒ the page renders no widget (fully backward-compatible).
2. **Public page** (`FormPage` / `ChatPage`) — when `turnstileSiteKey` is present, load Turnstile's
   script (`challenges.cloudflare.com`) and render the widget; on success it yields a token. Submit
   is disabled until the token exists.
3. **POST** — the page sends the token (field `turnstileToken`). The controller, when the tenant has
   Turnstile enabled, **requires** it and verifies it server-side via Cloudflare's
   `https://challenges.cloudflare.com/turnstile/v0/siteverify` (POST `secret` + `response` +
   `remoteip`) BEFORE `startForm`/`startChat`. Missing/invalid ⇒ **403**, no run started
   (**fail-closed** once a tenant opts in). Not configured ⇒ unchanged.

Verification is **API-side I/O at ingress** (pre-workflow) — a NestJS service, not a Temporal
activity (nothing durable to run yet). The secret is decrypted in-request, used, never logged.

## Tier-1 / security alignment

- Secret key encrypted at rest (per-tenant DEK via SecretStore); decrypted only in the API request
  that verifies; never enters a workflow, history, telemetry, or logs (§4).
- Site key is public by design (it's rendered in the browser) — safe in the GET definition.
- `siteverify` egress is a fixed Cloudflare host (no SSRF surface — not tenant-supplied).
- Fail-closed: a tenant who enables Turnstile can't have it silently bypassed by a client that omits
  the token.

## Web / CSP

The public pages load Turnstile's script + iframe. The SPA CSP (`apps/api/src/main.ts`) must allow
`https://challenges.cloudflare.com` in `script-src` and `frame-src`. Scoped narrowly to that host.

## Suggested slices (user chose forms + chat together)

1. **Config + storage + Settings UI.** `TurnstileConfig` model + migration; a service that stores the
   site key (plain) + secret key (via SecretStore, write-only) per env; `/turnstile-config` CRUD; a
   "Bot protection" card in Settings (enter site + secret key, enable/disable). Verify: save + reload
   shows enabled with the site key, secret write-only.
2. **Ingress verify + public widgets (forms AND chat).** Shared `verifyTurnstile(token, ip, meta)`
   helper; both GET definitions surface `turnstileSiteKey`; both POSTs require+verify when enabled;
   `FormPage`/`ChatPage` render the widget; CSP allowance. Verify: a real Turnstile test key gates a
   submission (bad/missing token → 403; solved → run starts).

## Open questions

- **Enforce vs. audit-only** for a first rollout? Proposed: enforce (fail-closed) as soon as a tenant
  enables it — that's the point. No audit mode.
- **Env fallback:** should a prod config fall back to a global/default env config?
  `SecretStore.getWithGlobalFallback` supports it; proposed **no fallback** for v1 (explicit per-env).
- **Rate-limit interaction:** keep the existing per-IP `@Throttle` as a cheap first filter in front of
  the Turnstile check (verify only after the throttle passes).

# Design — App-based connection auth (GitHub App + Atlassian OAuth 2.0 3LO)

> **Status: SPEC ONLY — not implemented. Awaiting approval before any build.**
> This replaces pasted personal tokens (PATs) with *app-based* auth, the way Sentry /
> Vercel / Linear connect: the user installs/authorizes a **Naary app**, and we store a
> **grant** (installation id / refresh token), not a long-lived personal credential.
> Most of the OAuth plumbing already exists (§1) — this is mostly filling the
> "fixed app client" gap, not greenfield.

## 0. Why — the class of failure we're closing

A PAT is a *person's* credential with that person's global scopes. It broke a real
production run: a GitHub `comment_issue` write returned **404** because the pasted token
lacked access to the target private repo (GitHub 404-masks-403). PATs are the wrong shape:

| | PAT (today) | GitHub App / Atlassian 3LO (this spec) |
|---|---|---|
| Belongs to | a person — dies when they leave | the org/app — independent of any user |
| Scope | the token's global scopes | fine-grained, **per-repo / per-site** the installer picks |
| Call-time cred | static token, sent as-is | **short-lived** (installation token / access token), auto-rotating |
| Revocation | manual, all-or-nothing | uninstall / revoke grant per resource |
| Our 404 | token simply lacked the repo | installer explicitly granted the app that repo |

The end state: a **"Connect GitHub" / "Connect Jira"** button → provider consent → we store
a grant. No pasted secrets, least-privilege, auto-rotating call-time credentials.

## 1. What ALREADY exists (reuse as-is — do not rebuild)

The repo already has a substantial OAuth 2.1 stack (built for MCP servers via Dynamic Client
Registration). Almost all of it is provider-agnostic and reusable:

- **Encrypted secret store** — `packages/secrets` `SecretStore` over `TenantCredential`
  (AES-256-GCM, AAD-bound to `${tenantId}:${key}`, `keyVersion 2`). Connection secrets are
  keyed `conn:<connectionId>`; OAuth states `oauth-state:<state>`. `ENCRYPTION_KEY` is one
  global master key (fail-at-boot). **Reuse for app grants + app client secrets.**
- **Connection model + service** — `Connection` (`schema.prisma:213-226`): `type`,
  `authMode`, `serverUrl`, `scopes[]`, `status` (`connected|needs_reauth|error`). Secret is
  NOT a column — it's in the store under `conn:<id>`. `ConnectionService`
  (`packages/connections/src/connection.service.ts`).
- **OAuth consent flow** — `packages/connections/src/oauth.ts` + `oauth.controller.ts`:
  **PKCE S256**, `state` param carrying tenantId (10-min TTL, replay-protected, swept),
  `authorization_code` exchange, issuer validation (RFC 9207), `POST …/oauth/start` +
  `GET …/oauth/callback` (`@Public()`). Redirect URI from `OAUTH_REDIRECT_URI`.
- **Refresh + call-time resolution** — `getOAuthAccessToken` (`oauth.ts:170-245`): a process-
  local access-token cache (~1h TTL, 30s skew), 60s status revalidation, **refresh-token grant
  with rotation** (re-persists the rotated refresh token), `invalid_grant` → flips connection
  to `needs_reauth` + throws `NeedsReauthError`. Worker path `resolveAuthHeader`
  (`packages/connections/src/auth.ts:20-52`) already branches `authMode === "oauth"` →
  `getOAuthAccessToken` → `Bearer`.
- **Jira Basic re-wrap** — the integration activity already converts a non-oauth Jira token to
  `Basic base64(email:token)` (`activities.ts:2439-2446`); oauth Bearer passes through.
- **Webhook ingress + GitHub HMAC verify** — `hooks.controller.ts` verifies
  `x-hub-signature-256` over the raw body, dedupes on `x-github-delivery`, resolves the target
  graph by `endpoint.workflowId` (a workflowKey), starts the run.

**Implication:** the Atlassian 3LO path is ~80% done — it's OAuth 2.0 authorization-code +
refresh, which the machinery above already does. The main missing piece for BOTH providers is
a **fixed app client** (a preregistered `client_id`/`client_secret` + fixed endpoints), because
today's flow assumes **Dynamic Client Registration + `.well-known` discovery** off `serverUrl`.

## 2. The gaps to build

1. **App-client credential source.** A static, *platform-level* (not per-tenant) registry of
   app credentials: GitHub App id + private key (PEM) + client id/secret + webhook secret;
   Atlassian OAuth app client id + secret. These are OUR secrets, one set per deployment.
   Store as env (`GITHUB_APP_*`, `ATLASSIAN_OAUTH_*`) decrypted/loaded at boot, *never* in
   Temporal, *never* per-tenant. (Per-tenant is the *grant*, not the app.)
2. **Provider endpoint + scope registry.** Hardcoded authorize/token URLs + default scope sets
   per provider (GitHub, Atlassian) — today endpoints come only from `.well-known` discovery,
   which these providers don't expose in the DCR shape. A small `PROVIDER_OAUTH` table in
   `packages/connections`.
3. **GitHub App installation-token flow** (does not exist at all): app JWT (RS256, signed with
   the app private key, ≤10-min exp) → exchange for a **short-lived installation access token**
   (~1h) scoped to the installation's repos. This is a *new* `authMode: "github_app"` call-time
   path parallel to `getOAuthAccessToken`.
4. **Atlassian 3LO wiring**: fixed-client authorize/token (reusing `exchangeCode`/`refreshGrant`
   with a **confidential** client — pass `client_secret` on the token call; today's DCR path is a
   public client with `token_endpoint_auth_method: "none"`).
5. **Connection-save/"test" validation** — today a connection saves without any live check; an
   app grant should verify (list installations / call `/myself`) and set `status` accordingly.
6. ~~**(Optional) Atlassian inbound webhook verification** — currently a fail-closed stub.~~
   **DONE (#467).** Atlassian's inbound scheme is GitHub-compatible (`sha256=<hmac>` over the raw
   body) in a differently-named header (`X-Hub-Signature`), so `verifySignature` is now
   provider-agnostic and the controller selects the header per provider.

## 3. Provider specifics

### 3a. GitHub App (`authMode: "github_app"`)
- **One-time (ops):** register the "Naary" GitHub App — permissions `pull_requests:read`,
  `issues:write`, `contents:read`, `metadata:read`; subscribe to `pull_request`, `issues`
  events; set the callback + webhook URLs; generate a private key. Config → env.
- **Connect flow:** button → GitHub **install** URL → user picks repos → GitHub redirects to
  our callback with `installation_id` (+ `state` for CSRF, reusing the state store). We create a
  `Connection { type:"github", authMode:"github_app" }` and store the grant
  `{ installationId }` under `conn:<id>` (encrypted). No token is stored.
- **Call time (activity):** mint app JWT (RS256 over `{iss: appId, iat, exp≤600}`) → `POST
  /app/installations/<installationId>/access_tokens` → installation token (~1h) → cache like
  `accessCache` → `Authorization: Bearer <installationToken>`. Discard after use; never returned
  from the activity, never logged.
- **Webhooks:** already verified via `x-hub-signature-256`; the app webhook secret replaces the
  per-endpoint secret for app-delivered events (or we keep per-endpoint — decide in Slice 3).

### 3b. Atlassian OAuth 2.0 3LO (`authMode: "oauth"`, confidential client)
- **One-time (ops):** register an Atlassian OAuth 2.0 (3LO) app — scopes
  `read:jira-work`, `write:jira-work`, `read:jira-user`, `offline_access`; callback URL; client
  id/secret → env. The scopes must ALSO be enabled on the app itself (Permissions → Jira API):
  requesting a scope the app does not hold fails at consent. `read:jira-user` is what
  `GET /rest/api/2/myself` needs — the `get_myself` probe, i.e. the connection check — and it is
  not implied by `read:jira-work`.
- **Connect flow:** button → `auth.atlassian.com/authorize` (fixed endpoint + our client id +
  scopes + `state` + PKCE) → consent → callback `?code&state` → `exchangeCode` **with
  client_secret** → store `{ refreshToken, cloudId/site, scopes }` under `conn:<id>`. Resolve
  the site's `cloudId` (`/oauth/token/accessible-resources`) → derives `serverUrl`
  (`https://api.atlassian.com/ex/jira/<cloudId>`).
- **Call time:** existing `getOAuthAccessToken` path — refresh-token rotation already handled.
  Only change: the fixed endpoints + confidential-client secret come from the provider registry
  (§2.2), not DCR/discovery.

## 4. Data model changes

- `Connection.authMode` union gains **`"github_app"`** (schema comment only — it's a `String`;
  no migration needed for the enum itself).
- No new columns required: the grant (installationId / refreshToken+cloudId) rides the existing
  `conn:<id>` secret blob (JSON), exactly like today's `OAuthConfig`.
- **Possible** new: an `installationId` convenience column if we need to look up by installation
  on inbound webhooks (an app webhook carries `installation.id`, not our connectionId). TBD in
  Slice 3 — may instead map installation→connection via a store key `gh-install:<id>`.

## 5. Security (Tier-1 alignment)

- App private key + client secrets are **platform** secrets (env, loaded at boot), **never** per
  tenant, **never** in Temporal args/history/logs/spans. Only `tenantId` + `connectionId` flow
  through the workflow; the grant is fetched + the short-lived token minted **inside the
  activity**, used in memory, never returned. (CLAUDE.md rules 3–4.)
- Installation/access tokens are short-lived and cached in-process only (mirrors `accessCache`),
  so a worker crash loses nothing sensitive.
- `state` (CSRF) + PKCE already enforced; reuse verbatim. Callback stays `@Public()` but is
  state-gated.
- Least-privilege scopes baked into the provider registry; the installer narrows further
  (per-repo / per-site).

## 6. Slices (each independently shippable + verifiable)

1. **App-client registry + config** — `PROVIDER_OAUTH` table (endpoints/scopes) +
   `GITHUB_APP_*` / `ATLASSIAN_OAUTH_*` env loading (fail-safe if unset: feature simply
   unavailable). No user-facing change yet. *Verify:* unit tests on config load + registry.
2. **Atlassian 3LO connect (confidential client)** — wire the fixed-endpoint authorize/token
   through the existing consent flow with `client_secret`; store refresh grant; `cloudId`
   resolution. *Verify:* e2e consent against a test app → a Jira read via `getOAuthAccessToken`.
3. **GitHub App connect + installation tokens** — install callback storing `installationId`;
   new `github_app` call-time minting (JWT → installation token, cached). Repoint the
   github-review template's connection. *Verify:* activity test mints + caches a token; a
   `comment_issue` write succeeds against a granted repo (the original 404 case).
4. **"Connect" UI + status** — replace the token text field with per-provider Connect buttons;
   surface `needs_reauth`; save-time validation ("test connection"). *Verify:* Playwright connect
   flow + a `needs_reauth` re-consent.
5. **(Optional) Atlassian inbound webhook verification** — implement the fail-closed stub.

## 7. Out of scope (explicit fence)

- Migrating existing PAT connections automatically — PAT (`authMode:"pat"`) stays supported and
  coexists; users opt into app auth per connection.
- Providers beyond GitHub + Atlassian (Slack/Google/etc.) — the registry makes them additive
  later, but not now.
- GitHub org-level policy / SSO enforcement, Atlassian Connect (Forge) apps — 3LO only.
- Any change to the interpreter or the integration catalog (`integrations.ts`) — this is an
  **auth/connection** change; the `integration` node calls the same `resolveAuthHeader` seam.

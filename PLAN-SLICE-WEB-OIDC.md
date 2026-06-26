# PLAN — Slice: Web-app OIDC login (Keycloak, Phase 2 of #25)

**Goal:** humans log into the SPA via Keycloak (Authorization Code + PKCE), the
access token is attached to API calls and **silently refreshed**, and the
containerized API accepts that token. The `nry_` token paste stays as a secondary
("advanced") path. Backend dual-auth already exists (#25); this is the SPA + the
last bit of API/realm wiring to make it work end-to-end.

Decisions (confirmed): **keycloak-js**; **OIDC primary + keep token paste**;
**must work in the full container stack too** (api in docker), not just host-dev.

## The issuer/JWKS problem (and the fix)
The browser logs into Keycloak at `http://localhost:8080`, so tokens carry
`iss: http://localhost:8080/realms/naary`. The API must validate that exact issuer.
- **Host-dev** (api via `pnpm start`): `localhost:8080` resolves for the api too →
  issuer check + JWKS fetch both work. No change needed.
- **Container** (api in docker): `localhost:8080` is NOT Keycloak inside the
  container (it's `keycloak:8080`). So: validate `iss == localhost:8080/...` but
  **fetch JWKS from `keycloak:8080/...`**. JWKS content is host-independent, so the
  signature still validates. Implement via a new optional `OIDC_JWKS_URI` env in
  `oidc-verifier` (falls back to `${issuer}/protocol/openid-connect/certs`). No
  `/etc/hosts` hack required.

## Tasks
### Backend (risk-first — land + verify before the UI)
1. `apps/api/src/auth/oidc-verifier.ts` — add optional `jwksUri` to `OidcConfig`;
   `fromEnv()` reads `OIDC_JWKS_URI`; `verify()` uses it for `createRemoteJWKSet`
   when set. Update `oidc-verifier.spec.ts` (local key source already injected; add
   a case asserting jwksUri override is honored).
2. `docker-compose.yml` — turn OIDC **on** for the container stack: api gets
   `OIDC_ISSUER=http://localhost:8080/realms/naary` (default) +
   `OIDC_JWKS_URI=http://keycloak:8080/realms/naary/protocol/openid-connect/certs`.
3. `infra/keycloak/realm-naary.json` — add `http://localhost:8081/*` to the
   `naary-web` client `redirectUris` + `webOrigins` (docker web origin) and the
   post-logout uris. Keep `5173` (vite dev).
4. `.env.example` — document `OIDC_JWKS_URI`.

**Verify backend:** bring the stack up with OIDC on; obtain a real token via the
password grant (what the SPA gets post-login) and confirm the **containerized API**
accepts it on a protected route (proves issuer-check + JWKS-via-keycloak + audience
+ tenant claim). This is the genuinely hard part — prove it before building UI.

### Web SPA
5. `apps/web` — add `keycloak-js` dep.
6. `apps/web/src/lib/keycloak.ts` — singleton Keycloak instance (url/realm/clientId
   from `import.meta.env.VITE_KEYCLOAK_*`, dev defaults `http://localhost:8080` /
   `naary` / `naary-web`). `initKeycloak()` (idempotent, `check-sso` + silent iframe)
   and `getBearerToken()` → fresh OIDC token (`updateToken`) else the pasted `nry_`.
7. `apps/web/public/silent-check-sso.html` — silent SSO helper page.
8. `apps/web/src/auth/AuthProvider.tsx` — context: `{ ready, authenticated, subject,
   login(), logout() }`; runs `initKeycloak()` on mount; wires
   `keycloak.onTokenExpired → updateToken`.
9. `apps/web/src/lib/api.ts` — `http()` awaits `getBearerToken()` (OIDC preferred,
   paste fallback) instead of reading localStorage directly.
10. `apps/web/src/screens/AuthPage.tsx` — primary "Sign in with Keycloak" button →
    `login()`; keep the `nry_` paste as a secondary option.
11. `apps/web/src/main.tsx` — wrap `RouterProvider` in `AuthProvider`.
12. `apps/web/src/router.tsx` + a small `RequireAuth` guard on `/app` — redirect to
    `/auth` when neither an OIDC session nor a pasted token exists. Keycloak-js
    processes the `?code=` callback on init at the app root (no separate route).

## Out of scope (do NOT build ahead)
- Production Keycloak (real realm, MFA, HTTPS, token lifespans) — PROD-READINESS §3.B.
- Logout-everywhere / account management UI beyond a basic logout button.
- Canvas wiring — the next slice.

## Verification (DoD)
- Backend: containerized API accepts a Keycloak token on a protected route (curl
  with a password-grant token) AND still accepts `nry_` tokens. `oidc-verifier`
  tests green; full suite green; typecheck green.
- Web: `pnpm --filter @naary/web build` succeeds; web image builds. (The interactive
  redirect can't be clicked headlessly — verify init config + token acceptance +
  build; note that the click-through login is manual QA.)

## Security (CLAUDE.md)
- SPA holds only the user's own OIDC token (public client, PKCE) — no client secret.
- No secrets baked into the web image; Keycloak URL is public config.
- API still derives tenantId from the verified `tenant` claim; never trusts client.

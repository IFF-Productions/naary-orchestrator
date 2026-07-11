# Security Review — naary-orchestrator

**Date:** 2026-06-25
**Reviewer:** Security advisor (AI)
**Scope:** Full repository — NestJS control plane (`apps/api`), Temporal worker
(`apps/worker`), shared packages (`packages/*`), config, and dependencies.
**Method:** Manual source review against the project's own Tier‑1 rules
(`CLAUDE.md`) and standard web/app-sec checklists (access control, secrets, SSRF,
injection, transport, config).

> This review reflects the codebase as built across Slices #2–#4. Several findings
> are partly acknowledged in `README.md` as "known limitations / deferred," but
> they are restated here with severity because they materially affect the security
> posture of any non-local deployment.

---

## Summary

| # | Severity | Finding | Area |
|---|----------|---------|------|
| 1 | **Critical** | No authentication or authorization on the entire HTTP API (`tenantId` is client-supplied) | Access control |
| 2 | **High** | SSRF + token exfiltration via user-controlled connection `serverUrl` | Connections / worker |
| 3 | **High** | OAuth callback is unauthenticated; tenant binding derived from the `state` value; no TTL | OAuth |
| 4 | **Medium** | No input validation on any request body/param | API |
| 5 | **Medium** | No CORS policy, security headers, or rate limiting | API transport |
| 6 | **Medium** | `ENCRYPTION_KEY` not validated at boot (lazy init) | Config |
| 7 | **Medium** | Single static master key — no rotation, no per-tenant DEK/KMS, no AAD | Crypto |
| 8 | **Medium** | Webhook signing secret stored in plaintext DB column | Webhooks |
| 9 | **Low** | Webhook delivery dedupe table is unbounded; no timestamp/replay window | Webhooks |
| 10 | **Low** | Prompt injection: untrusted webhook payload flows into LLM prompt & tool args | Worker |
| 11 | **Low** | No global exception filter — risk of leaking internals/headers in errors | API |
| 12 | **Info** | Positive controls observed (crypto, secret hygiene, hooks) | — |

The headline issue is **#1**: the multi-tenant security model rests entirely on
`tenantId`, but `tenantId` is never authenticated. Everything else compounds it.

---

## Findings

### 1. No authentication/authorization on the API (Critical)

Every controller takes the tenant as an untrusted path/body parameter and performs
no identity check. There is no `AuthGuard`, no `UseGuards`, no global guard in
`apps/api/src/main.ts`, and no auth middleware anywhere.

Examples:

```16:25:apps/api/src/connections/connections.controller.ts
@Controller("tenants/:id/connections")
export class ConnectionsController {
  constructor(private readonly connections: ConnectionService) {}

  @Post()
  create(
    @Param("id") tenantId: string,
    @Body() body: CreateConnectionInput,
  ): Promise<ConnectionView> {
```

```9:20:apps/api/src/secrets/secrets.controller.ts
  @Post()
  save(
    @Param("id") tenantId: string,
    @Body() body: { provider: string; apiKey: string },
  ): Promise<SaveCredentialResult> {
    return this.credentials.saveCredential(
```

```9:22:apps/api/src/executions/executions.controller.ts
  @Post()
  start(@Body() body: { tenantId: string }): Promise<{ workflowId: string }> {
    return this.executions.start(body.tenantId);
  }

  @Post(":id/approve")
  @HttpCode(202)
  async approve(
    @Param("id") id: string,
    @Body() body: { approved: boolean },
  ): Promise<{ accepted: true }> {
```

**Impact.** With no auth, any network client can:

- **Overwrite any tenant's provider API key** (`POST /tenants/:id/credentials`) —
  inject an attacker key, or perform DoS by writing junk that fails validation.
- **List / create / delete any tenant's connections**, including deleting their
  integrations.
- **Read and set any tenant's budget** (`GET`/`PUT /tenants/:id/budget`) — disable
  cost controls (`monthlyCapUsd`) or bankrupt a tenant via their BYOK key.
- **Read any tenant's usage** (`GET /tenants/:id/usage`).
- **Start executions as any tenant** (`POST /executions`), spending that tenant's
  key/budget.
- **Approve or reject ANY human-in-the-loop execution** (`POST /executions/:id/approve`).
  This is especially serious: the product's stated differentiator is durable
  *human-in-the-loop* approval, and the approval signal can be forged by anyone who
  can guess/observe a workflow id. The core safety gate is bypassable.
- **Read any execution's live state** (`GET /executions/:id`), exposing `ctx`
  (workflow context, which may contain LLM/tool outputs).
- **Register webhooks for any tenant** (`POST /tenants/:id/webhooks`) and receive
  the signing secret.

This is a textbook Broken Access Control / IDOR across the entire surface. The
`README.md` and `CLAUDE.md` correctly note "tenantId is not a secret," but that is
only safe once requests are authenticated and the caller is *authorized* for that
tenant — which is not implemented.

**Recommendation.**
- Add authentication (e.g., session/JWT or signed API tokens) and a NestJS guard
  that resolves the authenticated principal.
- Derive `tenantId` from the authenticated principal (or verify the path
  `tenantId`/`workflowId` belongs to it) — never trust it from the client.
- Scope `executions` endpoints to the owning tenant; verify ownership of the
  Temporal `workflowId` before allowing `approve`/`getState`.
- Treat this as a release blocker for any shared/hosted environment.

---

### 2. SSRF and token exfiltration via connection `serverUrl` (High)

`Connection.serverUrl` is a free-form, user-supplied string (`packages/db/prisma/schema.prisma`
line 41) that is later fetched server-side with **no allowlist, no scheme
restriction, and no private-IP/metadata blocking**:

- OAuth discovery fetches `${origin}/.well-known/...` from it:

```225:232:packages/connections/src/oauth.ts
  const origin = new URL(serverUrl).origin;
  const prm = (await (
    await fetchFn(`${origin}/.well-known/oauth-protected-resource`)
  ).json()) as { authorization_servers?: string[] };
  const asOrigin = new URL(prm.authorization_servers?.[0] ?? origin).origin;
```

- The MCP activity opens an HTTP client to it and **sends the connection's Bearer
  token in the request headers**:

```28:39:packages/connections/src/mcp.ts
  const transport = new StreamableHTTPClientTransport(
    new URL(input.serverUrl),
    {
      requestInit: { headers: input.headers },
    },
  );
  try {
    await client.connect(transport);
    const result = await client.callTool({
```

**Impact.** Combined with Finding #1 (anyone can create a connection), an attacker
can point `serverUrl` at:
- Internal services / cloud metadata (`http://169.254.169.254/...`), the Temporal
  endpoint, the database host, etc. → internal network reconnaissance and pivot.
- An attacker-controlled host, then trigger an MCP call so the orchestrator sends
  the stored **PAT / OAuth access token as a `Bearer` header to the attacker** —
  direct credential exfiltration of the tenant's third-party token.

The OAuth authorization-server URL (`authorization_servers[0]`) returned by the
remote is also followed without validation, widening the SSRF further.

**Recommendation.**
- Restrict `serverUrl` to `https://` only.
- Enforce an allowlist of permitted MCP hosts (or, at minimum, resolve the host and
  reject RFC 1918 / link-local / loopback / unique-local addresses, including after
  DNS resolution, to defeat DNS rebinding).
- Validate the AS origin from discovery against the connection's expected issuer
  before following it.
- Consider egressing all outbound MCP/OAuth traffic through a forward proxy with an
  allowlist.

---

### 3. OAuth callback: unauthenticated, weak tenant binding, no TTL (High)

`GET /oauth/callback` is unauthenticated and `completeConsent` derives the tenant
directly from the `state` string:

```43:50:apps/api/src/connections/oauth.controller.ts
  @Get("oauth/callback")
  callback(
    @Query("state") state: string,
    @Query("code") code: string,
    @Query("iss") iss?: string,
  ): Promise<{ connectionId: string }> {
    return completeConsent({ state, code, iss });
  }
```

```266:270:packages/connections/src/oauth.ts
const encodeState = (tenantId: string) =>
  `${tenantId}.${b64url(randomBytes(16))}`;
const tenantFromState = (state: string) => state.split(".")[0] ?? "";
const stateKey = (state: string) => `oauth-state:${state}`;
```

Mitigating factors: the `state` is persisted server-side at `startConsent`, consumed
once (`store.remove` after exchange), and carries 128 bits of randomness — so it
behaves like a single-use bearer secret. However:

- **No binding to the initiating user/session.** Whoever presents a valid `state`
  completes the flow; the `tenantId` is taken from the (attacker-readable) state
  prefix, not from an authenticated session. This enables connection/account
  confusion (attaching a token under the wrong tenant) if a `state` can be planted
  or leaked (e.g., via referrer, logs, or a crafted authorize link).
- **No expiry / TTL** on stored state, so a leaked `state` remains usable
  indefinitely until consumed.
- The PKCE `code_verifier`, `clientId`, and `clientSecret` are stored in the secret
  store as JSON — fine — but the state record's lifetime/cleanup is unmanaged for
  abandoned flows.

**Recommendation.**
- Require an authenticated session on `/oauth/start` and `/oauth/callback`; bind the
  `state` to that session (and verify it on callback) rather than trusting the
  embedded tenant id.
- Add a short TTL to stored OAuth state and reject expired states; garbage-collect
  abandoned flows.
- Keep the existing `iss` check (RFC 9207) — good — and make it mandatory where the
  provider supports it.

---

### 4. No input validation on request bodies/params (Medium)

There is no `ValidationPipe`, no `class-validator`, and no Zod validation on inbound
DTOs (`apps/api/src/main.ts` installs no global pipe). Bodies are typed but not
validated at runtime:

- `{ provider, apiKey }` — `provider` is free-form and is used as a store key and a
  `switch` discriminator (`defaultValidator` throws on unknown, but `SecretStore`
  keys are arbitrary).
- `CreateConnectionInput.serverUrl` is not validated as a URL/scheme (feeds #2).
- `SetBudgetInput`, webhook `{ workflowId, provider }`, `{ approved }` etc. are
  unchecked → mass-assignment / type-confusion surface.

**Recommendation.** Add a global `ValidationPipe({ whitelist: true, forbidNonWhitelisted:
true, transform: true })` with `class-validator` DTOs (or Zod), and explicitly
validate `serverUrl` (https + host allowlist) and `provider` (enum).

---

### 5. No CORS policy, security headers, or rate limiting (Medium)

`apps/api/src/main.ts` enables only `rawBody` and shutdown hooks — no `app.enableCors(...)`
with an explicit origin allowlist, no `helmet`, and no throttling
(`@nestjs/throttler`).

**Impact.** Unauthenticated, unthrottled endpoints (credential save, execution
start, webhook ingress) are exposed to brute force, abuse, and DoS. Absent security
headers, the API is more exposed if/when served to browsers. (Note: until auth
exists, CSRF is somewhat moot — but it becomes relevant the moment cookies/sessions
are added, so configure CORS deliberately when you do.)

**Recommendation.** Add `helmet`, a strict CORS allowlist, and request rate limits
(especially on `/tenants/:id/credentials`, `/executions`, `/oauth/*`, `/hooks/*`).

---

### 6. `ENCRYPTION_KEY` not enforced at boot (Medium)

`CLAUDE.md` requires `ENCRYPTION_KEY` "at boot," but construction is lazy:
`createKeyEncryptor()` is only called when a `CredentialsService`/`SecretStore` is
first instantiated, and the worker constructs credentials lazily:

```67:73:apps/worker/src/temporal/activities.ts
// Constructed lazily so importing this module doesn't require ENCRYPTION_KEY
// until an agent actually runs.
let credentials: CredentialsService | undefined;
function getCredentials(): CredentialsService {
  credentials ??= new CredentialsService();
  return credentials;
}
```

Neither `apps/api/src/env.ts` nor `apps/worker/src/env.ts` validates required env
vars; they only `dotenv.config()`. A process can start "healthy" with a missing or
malformed key and fail only on the first credential operation — a configuration
footgun that can also let an instance run with an unintended/empty key surviving
startup checks.

**Recommendation.** Validate required env (`ENCRYPTION_KEY` 64-hex, `DATABASE_URL`,
`TEMPORAL_ADDRESS`) at process start (fail fast), e.g., a Zod-parsed `env` module
imported first.

---

### 7. Single static master key — no rotation, no per-tenant DEK, no AAD (Medium)

Encryption is AES‑256‑GCM with one process-wide master key from `ENCRYPTION_KEY`:

```36:48:packages/secrets/src/crypto.ts
  encrypt(plaintext: string): EncryptedPayload {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
```

Concerns:
- **No key rotation / versioning.** Ciphertext rows carry no key id, so rotating
  `ENCRYPTION_KEY` requires bulk re-encryption and there is no graceful migration.
- **No envelope/KMS in use.** The `KeyEncryptor` interface anticipates a KMS-backed
  impl, but the local static key is the only one — a single point of compromise for
  *all* tenants' provider keys, PATs, and OAuth refresh tokens.
- **No Additional Authenticated Data (AAD).** Ciphertext is not bound to its
  `(tenantId, provider/key)`. A party with DB write access could swap a victim's
  encrypted row for another valid row without GCM detecting it (the auth tag only
  protects the bytes, not their context).

**Recommendation.** Add a key id/version column and rotation path; bind GCM with AAD
= `tenantId|provider`; plan for KMS-backed envelope encryption (per-tenant data keys)
for production.

---

### 8. Webhook signing secret stored in plaintext (Medium)

The HMAC signing secret is a plaintext DB column (by design per plan, but it is a
bearer secret):

```22:23:packages/db/prisma/schema.prisma
  provider      String // 'github' | 'atlassian' | 'generic'
  signingSecret String // plain column per plan §4 (HMAC secret; never logged)
```

**Impact.** Any read of the database (backup leak, SQLi elsewhere, over-broad
access) discloses the secret, letting an attacker **forge validly-signed webhook
deliveries** and start workflows as the tenant. HMAC verification itself is done
correctly (raw-body, length-guarded `timingSafeEqual`), so the secret's at-rest
exposure is the weak link.

**Recommendation.** Encrypt the signing secret with the existing `SecretStore`, or
store only a hash and compare HMACs derived from a value the provider also holds.
At minimum, document the DB-trust assumption explicitly.

---

### 9. Webhook dedupe table is unbounded; no replay window (Low)

`isDuplicateDelivery` inserts a `WebhookDelivery` row per delivery id and relies on a
unique constraint. There is no TTL/cleanup and no timestamp-based replay window —
the table grows unbounded (storage/DoS over time), and a very old but never-seen
delivery id would still be accepted.

**Recommendation.** Add a retention/TTL job for `WebhookDelivery`, and optionally a
timestamp tolerance check where the provider supplies one.

---

### 10. Prompt injection via untrusted webhook payload (Low / by-design risk)

Webhook event bodies flow unmodified into the agent's LLM prompt and into MCP tool
arguments:

```157:163:apps/worker/src/temporal/activities.ts
    const result = await generateText({
      model: buildModel(cfg.provider, model, apiKey),
      system: cfg.systemPrompt,
      prompt: JSON.stringify(input),
      output: Output.object({ schema: outputSchema }),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
```

Untrusted external content (e.g., a GitHub issue body) can attempt to steer the
agent or influence which tools it calls. This is inherent to agent workflows, but
worth tracking given tools can perform real side effects via MCP.

**Recommendation.** Treat webhook content as untrusted: keep tool capabilities
least-privileged per connection, prefer structured extraction over free-form tool
selection, and consider input sanitization/guardrails for high-impact tool nodes.

---

### 11. No global exception filter — error leakage risk (Low)

There is no global exception filter to normalize/redact errors. The agent activity
deliberately rethrows transient AI‑SDK errors *bare* (good — those can carry the API
key in headers) and avoids logging them, which is correct. But at the API layer,
unhandled errors fall through to Nest defaults; depending on deployment, stack
traces / internal identifiers could be returned or logged verbosely.

**Recommendation.** Add a global exception filter that returns generic messages to
clients and ensures no secret-bearing error (provider errors, DB errors) is logged
with sensitive context.

---

### 12. Positive controls observed (Informational)

The codebase gets several important things right:

- **Strong symmetric crypto:** AES‑256‑GCM, fresh random 96‑bit IV per message, key
  length validated (`packages/secrets/src/crypto.ts`); auth-tag tamper detection via
  `.final()`.
- **Secrets kept out of Temporal:** only `tenantId` crosses the workflow boundary;
  the provider key is fetched and decrypted **inside the activity** and never
  returned/logged. Connection tokens resolved in-activity too.
- **Webhook HMAC done correctly:** verified over the **raw** bytes, length-guarded
  `timingSafeEqual` (no `===`), fail-closed for unsupported Atlassian scheme,
  dedupe only after signature verification.
- **Credential responses never echo the key** (`SaveCredentialResult` is metadata
  only); `ConnectionView` excludes tokens.
- **Provider auth errors (401/403/429) mapped to non-retryable** so a bad key isn't
  hammered, and errors aren't logged with the key.
- **Dev-time guardrails:** `.claude/hooks/no-secrets.sh` (blocks hardcoded keys /
  secret logging), `bash-guard.sh`, determinism check; `.gitignore` excludes `.env`;
  `docker-compose.yml` forces `POSTGRES_PASSWORD` (no hardcoded default).
- **Dependency hygiene:** `ai` pinned to an exact version (`6.0.210`) per the known
  usage-undefined billing bug; Dependabot configured (`.github/dependabot.yml`).
- **Connection reads are tenant-scoped** (`getById`/`list`/`remove` filter by
  `tenantId`) — correct *once* an authenticated `tenantId` is enforced (see #1).

---

## Prioritized remediation

1. **Implement authentication + per-tenant authorization** and stop trusting
   client-supplied `tenantId`/`workflowId` (Finding #1). Gate `approve`/`getState`
   on workflow ownership. — *release blocker*
2. **Lock down `serverUrl` egress** (https-only, host allowlist, block private IPs +
   DNS-rebinding) to close SSRF/token exfiltration (Finding #2).
3. **Harden the OAuth callback** with session-bound state and TTL (Finding #3).
4. Add **global input validation**, **CORS/helmet/rate limiting**, and a **global
   exception filter** (Findings #4, #5, #11).
5. **Fail-fast env validation** for `ENCRYPTION_KEY` et al. (Finding #6).
6. Plan **key rotation/versioning + AAD + KMS envelope** for secrets, and **encrypt
   webhook signing secrets** (Findings #7, #8).
7. Add **retention for webhook deliveries** and document **prompt-injection**
   handling for tool-enabled agents (Findings #9, #10).

---

## Notes / scope limits

- This was a static source review; no dynamic testing, dependency CVE scan
  (`npm/pnpm audit`), or infrastructure review was performed. Recommend adding
  `pnpm audit` / `gitleaks` / `trufflehog` to CI.
- Some findings are acknowledged in `README.md` as deferred (auth, OAuth multi-proc
  lock). They are included here because they are security-relevant for any
  non-local deployment, regardless of slice scope.

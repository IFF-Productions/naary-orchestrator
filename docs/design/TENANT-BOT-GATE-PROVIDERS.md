# Tenant bot gate: choosing Turnstile *or* App Check

Extends `TURNSTILE-BOT-PROTECTION.md`. Today a tenant's public form/chat pages can be
gated by **Cloudflare Turnstile only**, with the tenant supplying their own site+secret
key. This adds a second option — the platform's **Firebase App Check** — so a tenant
with no Cloudflare account still gets a gate.

Our own sign-in uses App Check and nothing else (`docs/app-check.md`, #785). That is a
separate surface and is not configurable.

---

## 1. Read this first: the two gates answer different questions

This is the whole design constraint, not a footnote.

| | **Turnstile** | **App Check** |
|---|---|---|
| Question answered | "did *this submission* pass a challenge?" | "did this come from *our real app*?" |
| Keys | tenant's own (BYO, per env) | **ours** — the platform's Firebase project |
| Scoped to the tenant? | yes (their site key, their secret) | **no** — project-wide (see below) |
| Solved-hostname check (`allowedHostnames`, #615) | ✅ enforced, tied to the token | ❌ **no analogue** |
| Per-submission challenge | ✅ | ❌ one attestation per page/session |
| Defeats a scripted `curl` POST | ✅ | ✅ |
| Defeats a real browser driven by Puppeteer on our page | partly (challenge + risk score) | ✗ |
| Works on a tenant's custom domain | ✅ | ✗ (see §7) |

**App Check tokens are not tenant-scoped.** They attest the Firebase *project*. A token
minted on `naar-y.com/f/<tenant-A-form>` verifies fine against a submission to tenant
B's form. That is not a privilege escalation — the gate's question is "is this our
app?", and the answer is genuinely yes — but it means anyone who can load *any* hosted
form page in a real browser can mint tokens for *every* tenant's form.

So: **App Check is the weaker gate**, and choosing it silently drops the
solved-hostname check, because there is no solved hostname to compare against. The
settings UI must say so at the point of choosing (§6) — a tenant who picks "the
built-in one" because it needs no keys should know what they gave up, or we will have
quietly downgraded protection for everyone who doesn't read docs.

Turnstile stays the recommended option. App Check is for "I have no Cloudflare account
and I want *something*".

---

## 2. Data model

`TurnstileConfig` gains one column (the table keeps its name — renaming it costs a
migration on a hot table for no functional gain; the model comment carries the history):

```prisma
provider String @default("turnstile")   // "turnstile" | "app_check"
```

Expand/contract-safe: additive, defaulted, so old rows read as `turnstile` and an
older API image ignores the column.

**`provider` is orthogonal to whether a gate is on.** #617 made a row that exists purely
to hold `allowedHostnames` for embed CORS legal — `siteKey: ""`, `enabled: false`. So
the existing invariant must become **provider-conditional**:

```
enabled && provider === "turnstile"  ⇒  siteKey required (400 otherwise)
enabled && provider === "app_check"  ⇒  no tenant keys at all; requires the
                                        verify-before-enable round trip (§5)
```

Getting this wrong 400s every App Check enable, so it is called out explicitly.

No tenant secret is stored for `app_check` — there is nothing tenant-side to store. The
`turnstile:secret` SecretStore entry is untouched (and deliberately *not* deleted when a
tenant switches to App Check, so switching back doesn't lose their key).

---

## 3. The service seam changes

`publicSiteKey(): string | null` is the wrong shape now — both controllers branch on its
truthiness, and App Check has no site key to return. Replace it:

```ts
type PublicGate =
  | { provider: "turnstile"; siteKey: string }
  | { provider: "app_check" };

publicGate(tenantId, environmentId): Promise<PublicGate | null>   // null ⇒ no gate
```

The existing "only advertise a gate we can actually verify" rule carries over:

- `turnstile` ⇒ advertise only if `enabled` **and** a secret is stored.
- `app_check` ⇒ advertise only if `enabled` **and** the API's Firebase Admin SDK is
  configured (else we'd gate a submit we would let through).

`verify(tenantId, envId, token)` keeps its signature and dispatches on `provider`.

### App Check verification

```ts
getAppCheck().verifyToken(token, { consume: true })
```

- transport/network/timeout failure ⇒ **allow** (fail-open), matching `siteverify`'s
  `"unavailable"` posture exactly: this gate is defense-in-depth and the tenant budget
  cap is the real cost backstop, so a Google blip must not brick every public form.
- invalid/expired token ⇒ **deny**.
- `alreadyConsumed: true` ⇒ **deny**. This is a *successful* verification with a
  definite answer, not a blip — it must not fall into the fail-open bucket.
- admin SDK not configured ⇒ allow (can't enforce), consistent with the existing
  "enabled but no secret" branch. Made visible by the boot log in §5.

**Unverified, must be checked against the live project (see the tracking issue):**
`consume: true` only has teeth if the client used `getLimitedUseToken()` **and** replay
protection is enabled for the app in the Firebase console. Neither is visible from our
code. If `verifyToken` reports `alreadyConsumed: false` unconditionally when replay
protection is off, our "single-use" claim is decoration and this doc must say so rather
than implying one-shot semantics we don't have.

---

## 4. Wire format

The public definition response carries a gate object instead of a bare key:

```jsonc
"botGate": { "provider": "turnstile", "siteKey": "0x4AAA…" }
"botGate": { "provider": "app_check" }
// absent ⇒ no gate
```

`turnstileSiteKey` is still emitted alongside it for the Turnstile case, for one
release: hosted pages are served from our own bundle, but an embedded iframe on a
tenant's site can hold a **cached** older bundle that only knows the old field.
Deprecated, removed a release later.

Submissions may send the token as `botToken`; `turnstileToken` stays accepted for the
same cached-bundle reason. Both are stripped before the payload reaches the graph (they
are not declared form fields).

---

## 5. Verify-before-enable, and the failure it prevents

A tenant selecting `app_check` depends on **two** deployment facts that live in
different places:

1. the web bundle was built with `VITE_FIREBASE_APPCHECK_SITE_KEY` (build-time), and
2. the API has Firebase Admin credentials (runtime).

If (1) is false the page can't mint a token; if the server then enforces, **every
submission is denied**. Neither half can see the other.

So enabling `app_check` requires a **live round trip**: the settings UI mints a real App
Check token in the operator's browser and the API verifies it; only then is
`enabled: true` persisted. Same principle as "provider keys are validated on save"
(CLAUDE.md). A tenant cannot save a gate that was already broken.

What that proves and what it doesn't: it proves the browser doing the enabling could
mint a token and the API could verify it — exactly the two halves above. It proves
**nothing about future deploys**: a release that drops the site key from the CI secret
would break every `app_check` tenant's forms. So the API also **logs at boot** when any
tenant has `provider: "app_check"` and the admin SDK cannot verify, making that failure
visible instead of surfacing as silent 403s on public forms.

---

## 6. Settings UI

`TurnstileSection` becomes a provider choice. The App Check branch has **no key
fields** — it says, in the UI and not only here:

- no keys needed, it uses the platform's own bot protection
- it is the **weaker** option: attests that the request came from our app, but does not
  challenge each submission and **does not enforce your allowed-domains list**
- allowed domains still apply to embed CORS (#617), which is independent of the gate
- Turnstile is recommended if you have (or can create) a free Cloudflare account

The enable button runs the §5 round trip and reports the actual result.

---

## 7. Known limitations

- **Custom domains break App Check.** The embedded-public-pages program plans tenant
  custom domains; the reCAPTCHA key's domain allowlist is **ours**, so every tenant
  domain would have to be added to *our* key — a platform action per tenant, and a hard
  scaling limit. Turnstile has no such coupling (the tenant owns their key). An
  `app_check` tenant moving to a custom domain must switch to Turnstile.
- **Public-page CSP.** `/f/` and `/c/` currently receive `frame-ancestors *` as their
  *entire* CSP, so those pages have no `script-src` and reCAPTCHA loads unrestricted —
  no CSP change is needed for this feature. Recorded deliberately: a future change that
  tightens public-page CSP will break App Check there, and needs to allow
  `www.google.com` + `www.gstatic.com` (as `apps/web/nginx.conf` already does for the
  app routes).
- Turnstile's site-key-lift defence (solved hostname tied to the token) has no App Check
  equivalent, as covered in §1.

---

## 8. Slices

1. **Backend** — `provider` column, the `publicGate()` seam, provider dispatch in
   `verify()`, the App Check verifier, provider-conditional save validation, boot log.
   Tests: dispatch, each verdict branch, fail-open vs `alreadyConsumed`, save
   validation for both providers.
2. **Public pages** — a `BotGate` component dispatching to the existing
   `TurnstileWidget` or an invisible App Check token fetch; form + chat pages read
   `botGate`; `botToken` on submit.
3. **Settings** — provider picker, the verify-before-enable round trip, the §6 copy.
4. **Cleanup** — drop `turnstileSiteKey`/`turnstileToken`, telemetry per provider,
   and record the §3 replay-protection finding once verified live.

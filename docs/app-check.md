# Firebase App Check

Browser **attestation** in front of Firebase Auth: Google refuses auth requests that
don't carry a token proving they came from our real app.

## Why this and not a CAPTCHA on the sign-up form

Firebase account creation is **client-side** — `apps/web/src/lib/firebase.ts` calls
`createUserWithEmailAndPassword` straight against Firebase, so **our API never sees a
signup or a login**. There is no server-side hook to verify a Turnstile/reCAPTCHA token
against, which means a widget on the form would raise the bar for someone using a
browser and not at all for anyone POSTing to Firebase's REST endpoint with the web API
key (public by design). App Check is enforced by Google in front of Firebase Auth
itself, which is the layer we otherwise can't reach.

Turnstile still owns the surfaces where it *is* enforceable: the anonymous public
form/chat ingress, per tenant. App Check covers our own login.

## The ordering trap

Two halves, and they must land in this order:

1. **This code, deployed with a site key** → the SPA starts sending attestation tokens.
2. **Enforcement flipped on** in the Firebase console → Google starts *requiring* them.

Doing (2) first breaks **every sign-in**, because a bundle built without
`VITE_FIREBASE_APPCHECK_SITE_KEY` sends no token. Registering an app and leaving it in
**monitoring** mode is safe at any time and is how you check traffic before enforcing.

`VITE_*` values are inlined by Vite at **build** time, so adding the key to
`/opt/naary/.env` and restarting changes nothing — the web **image must be rebuilt**. On
the GH-Actions path the value comes from a repo secret, not the server `.env`.

## Setup

1. Firebase console → **App Check** → **Apps** → register the web app. Pick a provider
   (reCAPTCHA **Enterprise** is the current default) and copy the **site key** — it is
   public and belongs in the bundle.
2. Add repo secrets (Settings → Secrets and variables → Actions):
   - `VITE_FIREBASE_APPCHECK_SITE_KEY` — the site key
   - `VITE_FIREBASE_APPCHECK_PROVIDER` — `enterprise` (default) or `v3`, matching the
     key you were given. **The two key types are not interchangeable**, and a mismatch
     fails at *token fetch* rather than at startup — so it looks like a network or CSP
     problem, not a config error. That's why the provider is env-selectable: a mismatch
     is a secret change, not a code change.
3. Run a **release** (rebuilds and pushes the web image, then deploys).
4. Verify in the browser (below).
5. Only then: Firebase console → App Check → **APIs** → Authentication → **Enforce**.

## Verifying

With a site key baked in, on the sign-in page:

- DevTools → Network: a request to
  `content-firebaseappcheck.googleapis.com/v1/projects/<id>/apps/<app>:exchange…`
  returning **200**.
- No CSP violations mentioning `www.google.com` / `www.gstatic.com`. Those hosts are
  allowed in `script-src`/`frame-src` in `apps/web/nginx.conf` for exactly this reason —
  without them App Check init is blocked by our own header.
- Firebase console → App Check → the web app shows **verified** requests climbing.

Then flip enforcement and confirm sign-in still works, in a fresh/incognito window.

## Local development

App Check stays **off** locally unless you set the site key, and that is the
recommended state — nothing to configure.

If you do need to exercise it, the dev build (and only the dev build) sets
`FIREBASE_APPCHECK_DEBUG_TOKEN = true`, which makes the SDK print a debug token to the
console; register it under App Check → Apps → **Manage debug tokens**. A debug token
mints *valid* attestations for anyone holding it, so it is gated on Vite's `DEV` flag
rather than on any env var, and no token string is ever committed or baked into a
production bundle. Delete debug tokens you're done with.

## What this does NOT do

App Check protects **Firebase** endpoints. Our own API is unchanged: it authorizes on
the Firebase **ID token** (and the `tenant` custom claim) exactly as before. Requiring
App Check tokens on `/api` too would be a separate piece of work, and it buys little
while `POST /workspaces` — the only endpoint where a new account costs us anything —
already requires a signed-in, **email-verified** user.

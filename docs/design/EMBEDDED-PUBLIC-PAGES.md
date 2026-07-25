# Design — Self-hosted / embedded public pages (forms & chat on the tenant's own site)

**Status:** proposed · **Date:** 2026-07-23 · **Tracking:** #617 · **Why a doc:** a new
distribution surface for the public form/chat pages spanning framing/CSP, CORS, an embed SDK, and
(later) custom domains + TLS — a program, not a slice. Design pass before code.

## Motivation

Tenants want their forms & chat to live **on their own sites**, not only at `app.naar-y.com/f/:id`.
This was the stated reason we chose **per-tenant BYO Turnstile keys** (#612) — that decision is the
foundation this program builds on. Today the only distribution is "share the link"; there's no embed.

## The load-bearing security insight (what makes this cheap and safe)

The public form/chat endpoints are **anonymous — no cookies, no session, no ambient credentials**.
Two consequences settle most of the "security" questions before they're asked:

- **Framing is safe — two independent reasons.** (a) **Cross-origin iframe isolation:** a hostile
  host page that frames `/f/:id` **cannot read the framed document's DOM or the visitor's
  keystrokes** — the same-origin policy forbids it. So the visitor's *input* can't be harvested by
  the framer. (b) **No ambient credentials:** there's no cookie/session to ride, so **credentialed**
  CSRF/clickjacking is N/A — a force-submit or overlay gains an attacker nothing a direct call
  doesn't. The residual (a malicious framer tricking a visitor into a *spurious* submit) is bounded
  by exactly the layers already shipped — **Turnstile especially** (Cloudflare's widget resists
  invisible/hidden framing, so an overlay can't silently harvest a solved token), plus rate limits +
  budget cap. So the Turnstile work partly *is* the clickjacking mitigation. No credential/session
  escalation exists to defend against.
- **CORS is *enablement*, not a security control.** It only governs browsers, and bots ignore it
  (see the Turnstile discussion). The real protection stays: **Turnstile bot gate (#612/#614/#619) +
  Turnstile hostname allowlist (#615) + per-endpoint & per-IP rate limits (#616/#618) + the tenant
  budget cap.** Those hold *regardless of origin* — nothing here weakens them, and CORS/allowlist
  changes must never become the only thing between a bot and a workflow start.

So the security posture is already in place. This program is mostly **distribution plumbing + UX**.

## Current state (what already works / doesn't)

- Public SPA routes `/f/:formId`, `/c/:chatId` served from `app.naar-y.com`; public APIs
  `GET|POST /forms/:id`, `/chat/:id` (`@Public`, anonymous).
- **No framing headers** are set (`nginx.conf` sets only `Document-Policy`) — so iframe embedding is
  *not blocked today*, but there's no product surface for it, no embed-optimized page, and no
  explicit, documented decision to allow it.
- No CORS config on the public routes (same-origin only today).

## Embedding modes (deliberately ordered easiest→hardest)

1. **iframe** — `<iframe src="https://app.naar-y.com/f/FORMID">`. The page loads **same-origin inside
   the frame**, so its API calls are same-origin → **no CORS needed**. Lowest risk, works with the
   security already shipped. This is the MVP.
2. **JS embed widget** — a `<script>` snippet that mounts the form/chat into a `<div>` on the
   tenant's page (Turnstile/Intercom style). Two implementations: (a) it just injects the iframe
   (still same-origin inside) + handles resize — no CORS; or (b) it renders natively and calls the
   API cross-origin — needs **per-tenant CORS allowlisting**. Prefer (a) first.
3. **Custom domain** — serve `/f/:id` on `forms.tenant.com`. Requires DNS (CNAME), **TLS issuance**
   (Cloudflare for SaaS / ACME), domain verification, and host→tenant routing. The big infra piece.

## Suggested slices

1. **iframe embed (MVP).**
   - An **embed-optimized render**: `/f/:id?embed=1` (and `/c/:id?embed=1`) drops the outer
     `PublicFrame` chrome/margins so it sits flush in a frame; transparent background; sensible min
     height.
   - **Explicitly allow framing** of the public routes (and *only* those) — set
     `Content-Security-Policy: frame-ancestors *` (or, when a tenant sets an allowlist, their
     origins) for `/f/*` and `/c/*`, and ensure no `X-Frame-Options: DENY` is added. Document *why
     it's safe* (anonymous, no ambient auth → no clickjacking).
   - **Auto-resize**: the framed page `postMessage`s its scroll height to the parent; a tiny loader
     snippet resizes the iframe. (Optional in v1; a fixed-height iframe is a fine fallback.)
   - **Admin UX**: an **"Embed"** action on the hosted-form/chat management row → a copy-paste
     `<iframe>` snippet (+ the raw link). This is the visible deliverable.
   - Verify: paste the snippet into a scratch HTML file, load it from a *different* origin, submit a
     gated form end-to-end (Turnstile solves on the framed origin — ties into #615's hostname list).

2. **JS embed widget.** A hosted `embed.js` that reads `data-naary-form="ID"` on a `<div>`/script and
   injects the iframe + wires resize (mode 2a — no CORS). Nicer DX than hand-writing an iframe; still
   same-origin inside.

3. **Per-tenant CORS + native embed (mode 2b).** ✅ **SHIPPED** (#617). A per-tenant
   **allowed-domains** list → the public routes reflect `Access-Control-Allow-Origin` for listed
   origins. Security still = Turnstile + limits + budget; CORS only permits the legit cross-origin
   fetch.

   Decisions taken while building it:
   - **ONE shared field, not two lists with shared UX.** The list is
     `TurnstileConfig.allowedHostnames` — already per (tenant, environment), already surfaced in
     Settings, already normalized. Two fields would be two things to keep in sync for one
     product question ("which hosts are these pages served from?"), with no user benefit.
     Consequence: a `TurnstileConfig` row may now exist with `enabled: false` and an empty
     `siteKey` (a domains-only config), so nothing may assume the row implies a bot gate.
     No migration — the column already exists and nothing about it changed.
   - **The one place the two consumers genuinely differ — documented in the UI, not split.** For a
     **direct-fetch** embed the widget renders on the tenant's own page, so Turnstile's solved
     hostname *and* the CORS origin are both `tenant.com` — one entry serves both. For an
     **iframe** embed (slice 1) the widget renders inside *our* framed document, so the solved
     hostname is **this instance's** host, while CORS isn't involved at all (same-origin inside
     the frame). A tenant who lists only `tenant.com` and runs the iframe snippet with the gate on
     would have every submission denied. That trap predates #617 (#615 behaved this way), so the
     fix is help text that names both cases — not a second field, which wouldn't remove the need
     to explain it.
   - **`Remove` clears the shared list too** (it deletes the row), so embed access reverts from
     narrowed to `*`. Called out in the UI copy; not a security regression under the framing
     above, but it is a silent widening.
   - **Hostname matching, not origin matching.** The shared list holds bare hostnames (Turnstile's
     solved hostname never carries a scheme/port), so CORS compares the request origin's hostname
     and ignores scheme/port. Tightening that would break http/localhost embeds and buy nothing —
     `Origin` is client-supplied and forged trivially by any non-browser client.
   - **Empty list ⇒ `*`, unchanged.** Every pre-#617 tenant has an empty list, so no live embed
     changes behaviour. Configuring domains is opt-in narrowing.
   - **`Vary: Origin` on every public-embed response** (allowed or not), so no shared cache can
     serve one origin's `Access-Control-Allow-Origin` to another.
   - **Fail-permissive.** The resolver (`EmbedOriginsService`, 30s memo) returns `[]` on any DB
     error → `*`. It's an enablement layer; a DB blip must not break every tenant's live embed. It
     returns hostnames only — never a tenant/env/workflow id.

4. **Custom domains.** Cloudflare for SaaS (or ACME) for per-tenant TLS on `forms.tenant.com`, a TXT
   domain-verification flow, and routing the custom host → the tenant's form/chat. Largest slice;
   design separately when slices 1–3 land.

## Tier-1 / security alignment

- No new trust boundary: framing + CORS are *enablement*; Turnstile + rate limits + budget cap remain
  the enforcement, unchanged and origin-independent.
- **No tenant identifiers** leak — the public definition already carries none; the embed snippet and
  any CORS response must not add `tenantId`/`workflowId`.
- Framing scoped to the public routes only — the authenticated app (`/app/*`, `/auth`) keeps its
  default (unframable) posture; never blanket-allow framing.
- The Turnstile **hostname allowlist (#615)** is the domain-restriction knob for gated forms — an
  embed on an unlisted host can't solve a challenge, so the submit is denied server-side.

## Open questions

- Embed chrome: a subtle "Powered by Naary" in embedded mode (default on, removable on paid)?
- Resize via `postMessage` in v1 vs. a fixed-height iframe (defer resize to slice 2)?
- Custom-domain TLS: Cloudflare for SaaS (fits the existing cloudflared ingress) vs. self-managed
  ACME — decide at slice 4.
- Do we gate embedding behind a tenant setting (off by default), or is a public form implicitly
  embeddable? Proposed: implicitly embeddable (it's already a public link); the allowlist (#615) is
  the restriction knob.
- **How do we scope `frame-ancestors` to the public routes at the SPA/nginx layer?** The SPA is one
  `index.html` served by nginx's catch-all for *every* route — there's no distinct location for
  `/f/` vs `/app/` today. Allowing framing only on `/f/*` + `/c/*` while keeping `/app/*`
  unframable needs explicit `location ^~ /f/ { … }` / `/c/ { … }` blocks that still serve the SPA
  entrypoint (with the relaxed header), not a blanket `add_header`. Resolve in slice 1 so it isn't
  discovered late. Implementation note: also confirm no CDN / cloudflared layer injects
  `X-Frame-Options` *above* nginx (the repo grep covers our code, not the edge).

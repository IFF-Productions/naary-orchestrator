# Submitting a form without our hosted page

Every Form Trigger workflow gets a hosted page at `/f/:formId`. You don't have to use it — the same
endpoint accepts a plain JSON `POST`, so you can build your own UI, submit from a script, or wire a
form you already have to a Naary workflow.

Two routes matter:

| Route | What it gives you |
| --- | --- |
| `GET /forms/:formId/schema` | A **JSON Schema** for the submission body |
| `POST /forms/:formId` | Starts the workflow with the submitted fields |

Both are anonymous. The opaque `formId` is the only capability — there's no token to manage, and
nothing in either response identifies your workspace or workflow.

## 1. Fetch the schema

```bash
curl https://YOUR-HOST/api/forms/3f9a1c2e-…/schema
```

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Contact us",
  "type": "object",
  "properties": {
    "email":    { "type": "string", "title": "Email", "format": "email",
                  "pattern": "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", "maxLength": 10000, "minLength": 1 },
    "message":  { "type": "string", "title": "Message", "maxLength": 10000,
                  "x-naary-multiline": true },
    "priority": { "type": "string", "title": "Priority", "enum": ["Low", "High"] }
  },
  "required": ["email"],
  "additionalProperties": true,
  "x-naary-submit": {
    "method": "POST",
    "path": "/forms/3f9a1c2e-…",
    "botProtection": false,
    "notes": ["…"]
  }
}
```

It's draft 2020-12, so you can hand it straight to a validator (ajv, Pydantic) or a code generator
(`quicktype`, `datamodel-codegen`) and get types for free. It reflects whatever the form is *now* —
edit the fields on the canvas and the schema changes with them.

## 2. Submit

```bash
curl -X POST https://YOUR-HOST/api/forms/3f9a1c2e-… \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","message":"Hello","priority":"Low"}'
```

```json
{ "status": "started" }
```

`202 Accepted`. The response deliberately carries **no run id**: the workflow may still be running,
or waiting days on a human approval, and the internal id embeds your workspace id. Use the Runs
screen (or the [public API](../README.md)) to follow the run.

## What the schema guarantees

**A payload the schema accepts is a payload the endpoint accepts.** That direction is enforced by a
test (`apps/api/test/form-schema.spec.ts`) over a generated cross-product of field types and edge-case
values, so conforming to the schema is enough — you'll never be surprised by a `400`.

The reverse is *not* promised, because the endpoint is more forgiving than it advertises:

- **Numeric strings are coerced.** `{"age": "36"}` is accepted even though the schema says `number`.
  Send a real number; the schema describes the shape we recommend, not the loosest one we tolerate.
- **Unknown keys are discarded, not rejected.** Hence `additionalProperties: true` — extras won't
  fail the request, but they never reach the workflow either. Only declared fields do.
- **Empty strings count as absent.** So a required field carries `minLength: 1`; `{"email": ""}`
  fails exactly as omitting it would.

A *stricter* client is therefore always safe.

## Validation you should expect

Nothing an anonymous caller sends reaches the workflow unchecked:

- Undeclared keys are stripped.
- Required fields are enforced.
- Values are coerced to the field's declared type, and a `select` must match one of its options.
- Every value is capped at 10,000 characters.

A structural problem returns `400` with a message naming the field.

## Bot protection changes the answer

If you've enabled Cloudflare Turnstile for the environment (Settings › Bot protection), the schema
gains a **required `turnstileToken`** and `x-naary-submit.botProtection` becomes `true`.

Read that as: **this form can't be submitted from a script.** Turnstile tokens are single-use and
solved by a browser running the widget — there's no server-side way to mint one, and if you've also
set a domain allowlist the token is additionally pinned to an approved origin. The gate is checked
*before* the body is validated, so a request without a token gets `403` no matter how correct the
payload is.

If you need headless submission, either use the hosted page (or the
[embeddable widget](./design/EMBEDDED-PUBLIC-PAGES.md)) for public traffic, or turn bot protection
off for the environment your integration submits to. Environments are separate here — a sandbox form
can stay ungated while production is protected.

## Branding the hosted page

If you *do* use the hosted page (`/f/:formId`), the Form Trigger's **Hosted page** section on the
canvas controls how it looks and what happens after a submit. Everything is optional — leave it alone
and the page renders exactly as before.

| Option | What it does |
| --- | --- |
| **Success heading / message** | Replaces the default "Request received" copy. Plain text — newlines are honoured, HTML is not. |
| **Redirect after submit** | Sends the visitor to your own thank-you page instead of the success card. |
| **Accent colour** | Recolours the submit button, top strip, focus rings and chips from one `#rrggbb`. |
| **Theme** | Force light or dark, or follow the visitor's own setting. |
| **Desktop layout** | One or two columns. |
| **Card width** | Narrow (460px) or wide (640px). |
| **Logo** | Replaces the Naary mark in the page header. |

A few behaviours worth knowing, because they're deliberate rather than incidental:

- **The redirect wins.** With a redirect set, the success heading and message never appear on a
  top-level page — the canvas says so next to the field, so you don't write copy nobody sees.
- **Embedded forms are never auto-redirected.** On `?embed=1` the visitor gets the success card with a
  **Continue** link instead. Navigating your iframe would either strand them in a frame with no URL
  bar and no back button, or frame-bust your page on your behalf; neither is ours to decide.
- **Redirects must be `https://`, with no `user:pass@`.** `javascript:` and `data:` would be stored
  XSS on our origin runnable by anyone with your form link; `http://` would downgrade a visitor who
  just submitted over TLS. Credentials are refused because `https://trusted.com@evil.com` reads as one
  site and resolves to another, and we show the destination.
- **The accent must be a full 6-digit hex** (`#f2622e`, not `#f62` or `orange`). It becomes a CSS
  custom property, and one accepted syntax is far easier to keep safe than several. Text ink on the
  button is picked from the accent's luminance, so a pale brand colour stays readable.
- **Two columns is a desktop-only idea.** Phones always get one column, and long-answer and choice
  fields keep a full row even on desktop — a paragraph box in half a row is worse than no columns.

### The logo

Upload it in the canvas (PNG, JPEG, GIF or WebP, up to 512 KB) and we store it — **the config holds an
asset id, not a URL**, and the image is served from your form's own origin at `/forms/assets/:id`.

That's deliberate. An external URL would make every visitor's browser fetch a third-party address from
a page we serve: egress we don't control, a tracking pixel we'd be laundering on your behalf, and a
logo that breaks the moment that host does. An id we issued is also checked against your workspace
environment when the workflow is saved, so it can't point at another workspace's asset.

Two things follow from how uploads are validated:

- **The file's contents decide, not its name.** We read the image's magic bytes and ignore the
  `Content-Type` you send, because these bytes are served back from our origin and a file labelled
  `image/png` can be anything. Renaming a file won't get it accepted.
- **SVG isn't accepted.** It's scriptable XML with no signature to identify it, so "is this really an
  SVG" can only be answered by parsing — and a hostile one served from our origin would be a real
  problem. Export a PNG instead.

Re-uploading the same file returns the same asset id rather than storing another copy, which is also
why the image is cached aggressively: a given id's bytes can never change.

**Self-hosting?** Logo uploads need object storage configured (`STORAGE_PROVIDER=s3` + `S3_BUCKET`,
plus a region and credentials; set `S3_ENDPOINT` for R2/B2/MinIO). Without it an upload fails with a
clear 503 rather than appearing to work — a logo held in one API process's memory would vanish on the
next deploy and differ between replicas.

Invalid values are **dropped, not repaired**: a malformed accent falls back to the default and a
rejected redirect falls back to the success card, so a bad setting degrades the page instead of
breaking it.

## Rate limits and cost

`POST` is throttled per IP (10/minute). That's per-IP, so it bounds accidents more than a
distributed flood — the real backstop on spend is your workspace's **monthly budget cap**, which is
required before a form endpoint can be registered and is enforced per LLM call.

There is no submission dedupe: submitting twice starts two runs, deliberately (forms have no natural
idempotency key). If you're retrying after a network error, expect that a run may already have
started.

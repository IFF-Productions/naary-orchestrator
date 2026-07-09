# Design (stub) — Form Trigger

**Status:** proposed / not started · **Date:** 2026-07-09 · **Why a doc, not a slice:**
unlike the other n8n-parity slices, a form trigger is a **new public subsystem**, not a node
you drop on the canvas. It needs its own design pass before code.

## What it is

n8n's Form Trigger: a workflow starts from a **hosted public form**. An anonymous visitor
opens a URL, fills fields defined on the trigger node, submits, and a run starts with the form
data as the trigger output (the "completion" screen can show a message or a later node's result).

## Why it's bigger than a slice (the surfaces it opens)

1. **A form-endpoint registry.** A public form needs a stable, non-guessable id that resolves to
   `(tenantId, workflowKey)` — mirror the existing webhook-endpoint registry (`createWebhook` →
   `endpointId`), NOT tenantId-in-the-URL. New DB model or a reuse of the webhook endpoint row.
2. **A public web route + page.** A route OUTSIDE `RequireAuth` (like `/auth`, `/design`) that
   fetches the form definition and renders it, plus a completion state. New anonymous-facing UI.
3. **Anonymous-submission security.** No bearer, no HMAC — so: per-endpoint rate limiting, payload
   size caps, field validation server-side, optional CAPTCHA/turnstile, and spam/abuse handling.
   This is the real reason it's not a quick slice.
4. **The `formTrigger` node + config.** Field schema (`{key,label,type,required,options}`),
   entry-node interpreter passthrough (output IS the submitted data, like `webhookTrigger`), canvas
   config panel, node-catalog entry, `ENTRY_TYPES` registration.

## Grounding (what already exists to build on)

- **Entry-node pattern:** `webhookTrigger` (node-catalog + `workflows.ts` case + interpreter entry)
  is the exact template — its output IS the event payload; formTrigger's output IS the form data.
- **Public ingress + run start:** `hooks.controller.ts` (`@Public() @Post(":endpointId")`) →
  `WebhookService` resolves endpoint → `ExecutionsService.startWebhook(...)`. A form POST is the
  same shape minus HMAC, plus field validation.
- **Public route precedent:** `router.tsx` already has top-level public routes (`/auth`, `/design`).

## Suggested slices (when picked up)

1. `formTrigger` node + config + interpreter entry + canvas panel (no public surface yet; test via
   a direct run with sample form data).
2. Form-endpoint registry + `@Public()` `GET/POST /forms/:formId` (definition + submit→start) with
   validation, size caps, and rate limiting.
3. Public form page (route outside `RequireAuth`) + completion screen; mint/copy the form URL in
   Integrations (mirror the MCP-token / webhook-register cards).

## Open questions

- Reuse the webhook endpoint row (add a `kind: webhook|form`) vs. a dedicated `FormEndpoint` model?
- Multi-step forms / file uploads (n8n supports both) — defer to v2.
- Completion modes: static message vs. wait-for-a-node's-output (couples to the wait/respond nodes).
- Anti-abuse baseline for v1: rate limit + size cap is the floor; CAPTCHA optional per endpoint.

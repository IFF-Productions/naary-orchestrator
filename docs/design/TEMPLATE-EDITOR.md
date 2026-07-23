# Design — Templates & the shared Form / Email editor

**Status:** proposed · **Date:** 2026-07-23 · **Why a doc, not a slice:** this is a new authoring
*subsystem* (a stored Template entity + a reusable editor component shared by two surfaces), not a
node you drop on the canvas. It needs a design pass before code, and it fixes a real bug on the way.

## The trigger (two user reports)

1. **"The email body is a JSON dump, not a readable email."** Root cause: `send-email.ts`'s
   `toField` does `JSON.stringify(value)` whenever an email field (`text`/`html`) resolves to an
   **object** — e.g. the body is bound to a whole agent/node output (`{{ agent }}`) instead of a
   string path. There is no good generic "readable form of an arbitrary object"; the fix is to let
   authors write a **template** (readable copy + `{{ }}` placeholders for specific fields).
2. **"Maybe an editor we can reuse to build forms *and* email templates."** Forms
   (`formTrigger`) and emails (`sendEmail`) both want the same primitive: a **fields-and-preview
   editor**. Forms author *input* fields; emails author *output* copy with interpolated fields.
   One editor, two bindings.

## What it is

- A stored **`Template`** entity, tenant + environment scoped (like `Variable` / `SecretStore`):
  `{ id, tenantId, environmentId?, kind: "email" | "form", name, subject?, body, fields? }`.
  `body` is copy with `{{ }}` placeholders; `fields` is the `{key,label,type,required,options}`
  list forms already use (see `FORM-TRIGGER.md`).
- A **reusable editor component** (`<TemplateEditor kind=… />`): a field/block list + live preview.
  `kind: "form"` authors the input schema; `kind: "email"` authors subject + body copy with a
  field-insert palette (the run's node outputs) and a rendered preview.
- **In-activity rendering** for email (Tier-1 §3): the `sendEmail` activity resolves the template's
  `{{ nodeId.path }}` placeholders against ctx to readable HTML/text — the same `resolveTemplates`
  path the node config already uses, so no new expression engine.

## Why the JSON-dump goes away

Today: bind `text` → `{{ agent }}` (an object) → `toField` → `JSON.stringify` → a raw dump.
With templates: author a body like `Hi {{ form.name }},\n\n{{ agent.summary }}\n\n— Acme`, where
each `{{ }}` targets a **string path**. The renderer interpolates those specific values into the
readable copy; an author never binds a whole object to the body. (We also harden `toField` to
render objects more gracefully as a defensive fallback, but templates are the real fix.)

## Grounding (what already exists to build on)

- **`sendEmail` node config** (`registry.ts`): `{connectionId, from?, to?, subject?, text?, html?,
  fieldBindings?}`. Add a `templateId?` (or inline `template`) mode; when set, the activity renders
  from the template instead of the raw `text`/`html`.
- **`resolveTemplates`** already interpolates `{{ nodeId.path }}` in node config against ctx,
  deterministically and purely — reuse it for the body render (in-activity for email).
- **Form field model + public form page** (`FORM-TRIGGER.md`, `FormPage.tsx`): the `fields` schema
  and its renderer already exist; the shared editor authors that same schema.
- **Env-scoped stores** (`Variable`, `SecretStore`): the exact `(tenantId, environmentId, key)`
  pattern for the `Template` table + its CRUD + the Settings surface (a "Templates" tab next to
  Secrets / Variables).

## Suggested slices

1. **Email templates (fixes the bug).** `Template` model + migration (email kind) · CRUD API
   (env-scoped, mirrors Variables) · `sendEmail` gains `templateId` — the activity renders the
   template's subject/body via `resolveTemplates` over ctx → readable HTML · a minimal editor
   (subject + body textarea + `{{ }}` field-insert + live preview) in Settings › Templates. Verify:
   a run whose email node uses a template sends readable HTML, not a JSON dump. **Independently
   shippable and the concrete win.**
2. **Extract `<TemplateEditor>`.** Pull the Slice-1 email editor's field-insert + preview into a
   reusable component with a `kind` prop; email authoring adopts it.
3. **Forms adopt it.** `formTrigger` config + the public form page author/consume `Template`
   (kind: "form") through the same editor, replacing the ad-hoc field config.

## Tier-1 / security alignment

- **Rendering is in-activity** (§3) for email — the SMTP send already is; the render joins it there.
- **No secret ever enters a template.** `{{ $secrets.X }}` stays resolved in-activity per its own
  contract (`secret-refs.ts`); a template body is non-secret copy that rides history like other
  config. A template referencing `$secrets` resolves at send, never stored expanded.
- **Env-scoped** so a sandbox template and a prod template are separate rows (like Variables).

## Open questions

- Inline template on the node vs. a referenced `templateId` (reuse across workflows) — Slice 1 can
  do inline first, add the stored table + reference as 1b.
- Rich HTML editing (WYSIWYG blocks) vs. a Markdown/`{{ }}` textarea for v1 — start textarea +
  preview; blocks are a later editor iteration.
- Do forms and emails share ONE `Template` table (kind column) or two tables? One table, kind
  column — the editor and CRUD stay shared, which is the whole point.
- Template-level attachments / multipart email — defer past v1.

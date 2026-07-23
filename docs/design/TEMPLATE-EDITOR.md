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
- A **reusable drag-and-drop block editor** (`<TemplateBlockEditor kind=… />`) — DECIDED
  paradigm (2026-07-23): a **block canvas**, not a textarea or a plain WYSIWYG box. A palette of
  blocks drags onto a canvas; blocks reorder; clicking a block edits it; a live preview renders
  against sample data. Blocks are the shared primitive that unifies both surfaces — `kind: "email"`
  uses content blocks; `kind: "form"` uses input-field blocks; a rich-text block gives
  WYSIWYG-within-a-block for prose. Uses **@dnd-kit** (already vetted here — react-grid-layout
  crashes on React 19; see the web-react19-dnd note).
- **In-activity rendering** for email (Tier-1 §3): the `sendEmail` activity resolves the template's
  `{{ nodeId.path }}` placeholders against ctx to readable HTML/text — the same `resolveTemplates`
  path the node config already uses, so no new expression engine.

## Why the JSON-dump goes away

Today: bind `text` → `{{ agent }}` (an object) → `toField` → `JSON.stringify` → a raw dump.
With templates: author a body like `Hi {{ form.name }},\n\n{{ agent.summary }}\n\n— Acme`, where
each `{{ }}` targets a **string path**. The renderer interpolates those specific values into the
readable copy; an author never binds a whole object to the body. (We also harden `toField` to
render objects more gracefully as a defensive fallback, but templates are the real fix.)

## Block model (the shared primitive)

`Template.body` is an ordered `Block[]` (not raw HTML), so the same array both renders to an email
and drives a form. A block is a tagged union in `@naary/dsl`:

```ts
type TemplateBlock =
  // content blocks — email + form layout
  | { id: string; type: "heading"; level: 1 | 2 | 3; text: string }   // text may hold {{ field }}
  | { id: string; type: "text"; html: string }                        // rich-text (WYSIWYG), {{ }} chips
  | { id: string; type: "image"; src: string; alt?: string }
  | { id: string; type: "button"; label: string; href: string }
  | { id: string; type: "divider" }
  | { id: string; type: "spacer"; size: number }
  // input block — FORM only (ignored when rendering an email)
  | { id: string; type: "field"; key: string; label: string;
      fieldType: "text" | "textarea" | "number" | "email" | "select";
      required: boolean; options?: string[] };
```

- **Email render** (in-activity, pure): `renderEmailHtml(blocks, ctx)` → email-safe HTML; every
  `{{ node.path }}` in a heading/text/button resolves via the existing `resolveTemplates`. `field`
  blocks are skipped. This is what the `sendEmail` activity calls.
- **Form render** (public form page): `field` blocks → the `{key,label,type,required,options}`
  schema `FormPage` already renders; content blocks become the form's heading/intro/layout.
- Blocks carry a stable `id` (for @dnd-kit keys + reorder). Ids are assigned in the editor/API
  (non-deterministic) — never minted in the workflow (Tier-1 §2).

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

1. **Block model + email renderer (pure, no UI/DB).** The `TemplateBlock` union in `@naary/dsl` +
   a pure, tested `renderEmailHtml(blocks, ctx)` (email-safe HTML; `{{ }}` via `resolveTemplates`;
   `field` blocks skipped). Lowest-risk foundation — types + pure functions, unit-tested, no
   migration, no DnD. Proves the core render.
2. **`Template` table + CRUD + `sendEmail` integration.** Env-scoped `Template` Prisma model
   (mirrors `Variable`) + migration + CRUD API · `sendEmail` gains `templateId`; the activity loads
   the template and calls `renderEmailHtml` in-activity → readable HTML. Verify: a run whose email
   node references a template sends real email, not a JSON dump. (Authoring still via API/seed here.)
3. **The DnD block editor `<TemplateBlockEditor>`.** @dnd-kit palette → canvas, reorder, per-block
   edit panel, rich-text block, live preview against sample ctx. Email kind first, in
   Settings › Templates. This is the big UI slice.
4. **Forms adopt it.** `field` blocks + `formTrigger`/`FormPage` author/consume `Template`
   (kind: "form") through the same editor, replacing the ad-hoc field config.

## Tier-1 / security alignment

- **Rendering is in-activity** (§3) for email — the SMTP send already is; the render joins it there.
- **No secret ever enters a template.** `{{ $secrets.X }}` stays resolved in-activity per its own
  contract (`secret-refs.ts`); a template body is non-secret copy that rides history like other
  config. A template referencing `$secrets` resolves at send, never stored expanded.
- **Env-scoped** so a sandbox template and a prod template are separate rows (like Variables).

## Open questions

- Inline template on the node vs. a referenced `templateId` (reuse across workflows) — the stored
  `Template` table + `templateId` reference is the target (Slice 2); an inline block array on the
  node is a possible convenience later.
- ~~WYSIWYG vs. textarea vs. blocks~~ — **DECIDED: drag-and-drop blocks** (@dnd-kit), rich-text
  within a text block. See "Block model".
- Do forms and emails share ONE `Template` table (kind column) or two tables? One table, kind
  column — the editor and CRUD stay shared, which is the whole point.
- Email-client HTML compatibility: table-based layout + inlined styles (the render target is real
  mail clients, not a browser) — settle the exact HTML shape in Slice 1's renderer.
- Template-level attachments / multipart email — defer past v1.

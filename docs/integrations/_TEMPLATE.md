# The integration-page template

Every file in this directory except `README.md`, `VERIFICATION.md` and this one is a **generated**
provider setup guide. This page documents the shape they all share, so the same structure can be
reused for the marketing site, the docs site, or a blog series without anyone reverse-engineering it
from the output.

**Do not hand-write a new provider page.** Add a prose entry and regenerate — see
[Adding a provider](#adding-a-provider) below.

---

## Where each section comes from

The split is the point: anything a machine can know is derived from the catalog, so it cannot drift
from what the `integration` node actually sends over the wire.

| Section | Source | Hand-editable |
| --- | --- | --- |
| Frontmatter | `packages/dsl/src/integrations/` + prose | no |
| `# Title` + lede | prose `tagline` | via prose |
| **Before you start** | prose (`credentialName`, `scopes`) + catalog (`authScheme`, `baseUrl`) | partly |
| **Get your credentials** | prose `steps` | via prose |
| **Connect it in Naary** | catalog (does it need a Server URL?) | no |
| **Verify it works** | catalog (is there an argument-free read?) + prose `verifyExample` | partly |
| **Actions** table | catalog (`method`, `pathTemplate`, `fields`, `write`) | no |
| **Flat fields → nested payload** | catalog (`bodyPath`) | no |
| **Output** | fixed — identical for every provider | no |
| **Gotchas** | prose `gotchas` | via prose |
| **Troubleshooting** | catalog (`authScheme`, Server URL) + fixed rows | no |

Enforced by `packages/dsl/test/integration-docs.spec.ts`, which re-renders all 38 pages and diffs
against disk. Hand-edit a generated section and that test fails. That guarantee is the reason
anything downstream can trust these files.

## Frontmatter contract

Stable, machine-readable, and safe for a static site generator or gallery to consume:

```yaml
title: 'One-sentence description.'   # the tagline; usable as a meta description
provider: stripe                     # catalog key — stable, use it as the slug
label: 'Stripe'                      # display name
category: 'Finance & Accounting'     # gallery grouping
authType: bearer                     # bearer | basic | custom-header
serverUrlRequired: false             # does the user have to supply a base URL?
actionCount: 5
writeActionCount: 3                  # 0 means the integration is read-only
oneClickTestable: true               # is there an argument-free read to probe with?
probeAction: list_charges            # present only when oneClickTestable
liveVerified: false                  # has a live test ever called the real API?
```

**`liveVerified` is the honest one.** It is `true` only where a `*.live.spec.ts` proves the provider
against the real service — today that is GitHub alone. Every other page carries a visible warning
that its request shape is typed and unit-tested but has never touched the live API. If you surface
these pages publicly, **do not** drop that warning to make the catalog look more finished than it is;
the number flips to `true` per provider as real proof lands. See
[VERIFICATION.md](./VERIFICATION.md) for the full picture.

## What belongs in prose, and what does not

Prose (`packages/dsl/src/docs/integration-prose.ts`) is for what a machine cannot know:

- **`tagline`** — one sentence, user-facing. Say what a user gets, not what the API is.
- **`credentialName`** — the phrase to look for in the provider's own console, verbatim.
- **`steps`** — 2–4 steps naming the *settings area*, not a deep click path. Provider consoles get
  reorganised constantly and we cannot re-verify 38 of them; a confidently wrong menu path wastes
  more of the reader's time than a slightly vague correct one.
- **`scopes`** — only where the provider has a scope model.
- **`serverUrl`** — the required format, for the 6 providers with no fixed base. This is the single
  most common setup failure, so give a concrete example, not a description.
- **`gotchas`** — the traps. The bar: *would omitting this cost someone an afternoon?* Wrong host
  for a plan, an unshared page, a token that silently expires in an hour, a known bug of ours.
- **`verifyExample`** — optional; a concrete first run, best used to show create-then-bind chaining.

**Never restate the catalog in prose.** No endpoints, no header names, no field lists — the renderer
emits those and will keep them correct. If a gotcha is really a catalog bug, fix the catalog.

## Adding a provider

1. Add `packages/dsl/src/integrations/providers/{provider}.ts` (actions, fields, `write` flags,
   auth) and list it in `packages/dsl/src/integrations/catalog.ts` — where it goes in that object
   literal is where its tile lands in the palette and its row in the README index, so place it
   deliberately rather than sorting.
2. Add an `INTEGRATION_PROSE` entry — the generator **fails** without one, on the grounds that an
   integration nobody can set up is not shipped.
3. Run `pnpm gen:integration-docs`. It writes the page and updates the README index.
4. Run `npx vitest run packages/dsl/test/integration-docs.spec.ts`.

`pnpm check:integration-docs` regenerates and fails on any diff — the same pattern as
`check:api-types` for `openapi.json`.

## Reusing these pages downstream

- **Slug** on `provider`, not the title — the title can be reworded, the key cannot.
- **Group** on `category`.
- **Filter** on `writeActionCount > 0` for "can act", `oneClickTestable` for "can self-check",
  `serverUrlRequired` for "self-hosted-friendly".
- Markdown is CommonMark plus tables. The one non-portable construct is `<sub>` in the README index.
- The body is deliberately provider-specific: the generic material (adding a node, binding fields,
  reading output) lives in [README.md](./README.md) and is linked rather than repeated, so 38 pages
  do not have 38 copies of it to keep in sync.

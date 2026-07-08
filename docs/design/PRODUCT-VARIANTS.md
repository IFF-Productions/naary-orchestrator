# Design — Two product variants (Builder vs Simple)

**Status:** proposed · **Date:** 2026-07-08 · **Purpose:** serve two audiences from ONE product —
**power users** (developers) who want the full visual canvas, and **non-developers** who want to
describe an automation in plain English, review it as a simple numbered step list, and run it —
never touching a graph. Chosen shape: **hybrid** (AI draft → form-based step list) for Simple mode,
selected by a **per-user preference**.

---

## 1. The one non-negotiable: one engine, two front-ends

A Simple-mode "automation" **is a normal graph** — same `GraphDef`, same `POST /graphs`, same
Temporal interpreter, same runs. Simple mode is a **presentation + a curated authoring flow**, NOT a
separate backend or data model. Consequences:

- Switching modes never migrates data. A power user can "Open in Builder" any Simple automation;
  a Simple user's automations run identically to a Builder's.
- Everything already built (interpreter, `generateGraph`, connections, approvals, billing, MCP)
  is reused. Simple mode adds a **vocabulary + view layer**, not new execution.
- The graph is the source of truth; the step list is a linear projection of it (§4).

## 2. What each variant is

| | **Builder** (power) | **Simple** (non-dev) |
|---|---|---|
| Create | the canvas — full node palette, edges, config | **describe in English** → `generateGraph` drafts it |
| Edit | the ReactFlow canvas + inspector | a **numbered step list**, friendly per-step forms |
| Concepts exposed | nodes, edges, `{{ expressions }}`, connectionIds, MCP, single-node test | "steps", plain-language fields, connection **pickers** |
| Vocabulary | Workflows · nodes · runs | **Automations · steps · runs** |
| Nav surfaces | everything (Canvas, Integrations, Observability, Billing, MCP) | Home · Automations · Runs · Approvals · Settings (+ guided "Connect AI") |

Builder mode is exactly today's app. Simple mode is the new layer.

## 3. Selecting the variant — per-user preference

- A `mode: "builder" | "simple"` preference **per user**, switchable anytime (a toggle in
  Settings + first-run prompt). Because it's per-user, a Builder and a non-dev can share a
  workspace on the same automations.
- **Storage (slice 1):** `localStorage` (client-only) — no backend, instant. There is no `User`
  table today (auth is Firebase; `Membership`/`TenantSettings` are per-workspace), so a
  cross-device DB-backed pref is a later slice (`UserPreference { userId, mode }` keyed by the
  Firebase uid). Default for a brand-new user: **Simple** (friendlier first touch); a returning
  user keeps their choice.
- The preference gates the shell (nav + routes) and the create/edit flows — nothing server-side.

## 4. Simple mode — the step list (the core new view)

Render a saved `GraphDef` as an ordered list of **step cards**, one per node, using the existing
`decompileGraph` + a topological walk from `startNodeId`:

- Each step = an icon + a **plain-language title** from `NODE_CATALOG` (e.g. agent → "Ask the AI",
  humanApproval → "Wait for your approval", sendEmail → "Send an email", webhookTrigger → "When a
  webhook arrives") + a **curated, friendly subset** of its config (agent → "Instructions" +
  "Model"; sendEmail → "To / Subject / Body"; connection fields → a **label picker**, never a raw
  id; `{{ }}` and advanced fields hidden).
- **Branches:** a purely linear graph maps 1:1. A graph with `switch`/`if`/`forEach`/parallel is
  shown with grouped "If X …" blocks where feasible, else a read-only "Advanced step — open in
  Builder to edit" card. Simple mode never silently drops structure.
- **Node types not in the friendly catalog** (e.g. `code`, `sqlExec`) render as read-only advanced
  cards — visible, runnable, editable only in Builder.

Editing a step patches `node.config` and re-saves the graph via the same `POST /graphs` — identical
persistence + validation to the canvas.

## 5. Simple mode — create flow (AI-first)

1. A single "What do you want to automate?" prompt → `POST /graphs/generate` (existing AI builder,
   BYOK provider) → a draft graph.
2. The draft opens directly in the **step list** (§4) for review — the user tweaks fields, not
   nodes.
3. "Turn it on" saves + (for a trigger automation) registers its webhook/schedule, exactly as the
   canvas Save does today.

No canvas is ever shown. A guided **"Connect your AI"** step replaces the raw Integrations screen
for BYOK key entry (Simple mode still needs a provider key — presented friendly).

## 6. Shell gating

`AppShell` reads the mode and renders one of two nav sets + guards the routes:

- **Builder:** today's nav (Operate/Build/Insights groups, Canvas editor, Integrations, …).
- **Simple:** Home · Automations · Runs · Approvals · Settings. `/app/canvas`, `/app/integrations`
  (raw), `/app/observability`, `/app/mcp` are hidden from the nav and redirect Simple users to a
  friendly equivalent (or the automations list). The mode toggle lives in Settings for both.

## 7. Rollout — as slices (each its own PR)

1. **Mode preference + shell gating** — `useMode()` (localStorage) + a Settings toggle + first-run
   default; Simple nav set + route guards. No new authoring yet: Simple users get the simplified
   nav and can still view runs/approvals. Visible immediately, low risk.
2. **Simple create flow** — the AI-prompt "new automation" screen → `generateGraph` → save. Non-dev
   never sees the canvas.
3. **Step-list view (read + run)** — render a saved graph as step cards (titles from
   `NODE_CATALOG`), with "Turn on/off" + run + a run history. Read-only config first.
4. **Step-list editing** — per-node-type friendly config forms (curated field subset + connection
   label pickers), patch + re-save. Branch/advanced handling.
5. **Guided "Connect AI"** + a `friendlyCatalog` (per-node-type: title, icon, editable fields) that
   both the step list and the create flow read. (Later: DB-backed `UserPreference`.)

Slices 1–2 ship a usable Simple experience (simplified nav + describe-to-create + run); 3–5 make it
fully self-serve for editing.

## 8. Non-negotiables carried in

- **One graph, one engine.** Simple automations are normal graphs — no data fork, no migration on
  mode switch, no second interpreter (Tier-1 rule 1).
- **Reuse, don't rebuild.** `generateGraph`, `decompileGraph`, `NODE_CATALOG`, connections,
  approvals, the runs read-model, billing — all reused. Simple mode is UI.
- **Progressive disclosure, never data loss.** Simple mode hides complexity; it never deletes or
  can't-represent a graph — anything it can't edit is shown read-only with "open in Builder".
- **Secrets unchanged.** BYOK keys still entered by the user + used in-activity; the guided
  "Connect AI" is just a friendlier front-end to the same credential store (Tier-1 rule 4).

## 9. Verification plan

- Round-trip: an automation created in Simple mode opens + runs identically in Builder, and a
  Builder graph renders as a sensible step list (or read-only advanced cards for unsupported nodes).
- Mode gating: a Simple user can't reach `/app/canvas`; the toggle flips nav + persists across
  reloads.
- Parity: a Simple-created + a canvas-created equivalent graph produce identical `contentHash`.

## 10. Residual open questions

- **Cross-device preference** — localStorage is per-device; a `UserPreference` table (Firebase uid)
  makes it follow the user. Defer to a slice once there's demand.
- **Branch/loop rendering in the step list** — how much structure to show vs punt to "open in
  Builder". Start conservative (linear + simple if/switch; everything else read-only advanced).
- **friendlyCatalog authoring** — the per-node-type friendly title/fields map is hand-curated; it
  must stay in sync with `NODE_CATALOG` as nodes are added (compile-enforce like the catalog does).
- **Default mode** — Simple-by-default is friendlier but could surprise a developer; revisit after
  the onboarding-choice slice.

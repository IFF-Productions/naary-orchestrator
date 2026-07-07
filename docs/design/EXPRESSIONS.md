# Design — Expressions (template-lite `{{ nodeId.path }}`)

**Status:** proposed · **Date:** 2026-07-07 · **Purpose:** let authors reference upstream node
outputs *inline* inside string config fields — `https://api/x/{{ agent.output.id }}`, `Re:
{{ start.subject }}` — the single biggest ergonomics gap vs n8n. Deliberately a **template**, not
an expression *language*: no `eval`, no arithmetic, no functions — just deterministic path
interpolation. Full logic stays in the `code` node.

---

## 1. What naary has today (grounded)

- **Structured bindings only.** A node references an upstream output via an `ArgBinding`
  `{ from, path }` (`packages/dsl/src/types.ts`), resolved in the interpreter with
  `getByPath(ctx[from], path)` (`packages/dsl/src/mcp-args.ts`; used ~40× in
  `apps/worker/src/temporal/workflows.ts`). Every connection-based field (mcpTool
  `argumentBindings`, set `fieldBindings`, number `aBinding`, …) uses this.
- **`ctx`** is the interpreter's per-run map: `ctx[nodeId]` = that node's output. Deterministic
  (built from prior node outputs), lives in workflow code.
- **Free-text strings are literal.** An httpRequest `url`, an agent `systemPrompt`, a sendEmail
  `subject` are used verbatim — you can't splice an upstream value into them without a `set`/`text`
  node first. That's the gap.
- **The escape hatch** for real logic is the `code` node (sandboxed QuickJS in an activity).

## 2. The idea

A string field may contain `{{ nodeId.path }}` tokens. Before a node runs, the interpreter
resolves every token against `ctx` and substitutes the value. `{{ agent.output }}` → the whole
output (JSON-stringified if an object); `{{ agent.output.category }}` → the nested value. No token
→ the string is unchanged (zero-cost, backward-compatible).

This is **`getByPath` we already have**, applied to inline strings instead of only to
`{from,path}` fields. It is NOT an expression engine: `{{ 1 + 2 }}`, `{{ upper(x) }}`,
`{{ a || b }}` are explicitly unsupported (they'd need eval → nondeterminism / a sandbox). Those
belong in the `code` node, or a future Phase 3.

## 3. Where resolution happens (Tier-1 safe)

Pure string→string substitution over `ctx` is **deterministic** → it runs in **workflow code**,
not an activity (CLAUDE.md Tier-1 rule 2 is satisfied; no I/O, no `Date.now`, no randomness).

- New pure helper `resolveTemplates(config, ctx)` in `@naary/dsl` (`template.ts`): deep-walks a
  config object; for each **string** value, replaces `{{ … }}` tokens via `getByPath(ctx, token)`;
  leaves non-strings and untokened strings untouched. Exported + unit-tested in isolation.
- The interpreter applies it **once per node**, at the top of `execNode(node)`:
  `const cfg = resolveTemplates(node.config ?? {}, ctx)` — and each `case` reads `cfg` instead of
  `node.config`. (Mechanical: ~40 `node.config` → `cfg` swaps, one shim line.)
- Because it's pure and deterministic, replay is stable and no `workflow.patched()` gate is needed
  for *new* graphs; existing graphs are unaffected (no `{{ }}` in their strings).

## 4. Semantics (the decisions)

| Question | Decision |
|---|---|
| Token grammar | `{{` + trimmed `nodeId.dotted.path` + `}}`. `{{ nodeId }}` = whole output. |
| Whole string is one token | Return the **typed** value (so a body field can become an object/number), not a string. |
| Token embedded in text | Coerce to string: primitives as-is, objects → `JSON.stringify`. |
| Missing path | Resolve to empty string (embedded) / `undefined` (whole-string); never throw — a run mustn't die on a typo. Surface unknown-token *warnings* at compile time (see §6). |
| Escaping a literal `{{` | `\{{` emits a literal `{{`. Rare; documented. |
| Which fields | ALL string config values by default (uniform, predictable). Opt-out isn't needed — a string with no `{{ }}` is untouched. |
| Interaction with `{from,path}` bindings | Both stay. Bindings are the typed/structured path (and what the canvas generates); templates are the inline convenience. A field uses one or the other. |

## 5. Web — authoring affordance (Phase 2)

The runtime works with no UI change (type `{{ }}` in any field). To make it *discoverable*:
- In the node inspector, string inputs get a small "insert reference" affordance that lists
  upstream node ids + their output paths (derived from the graph + any pinned/sample data — see
  the single-node-execution design) and inserts a `{{ … }}` token at the cursor.
- Tokens render with a subtle highlight so a field with a live reference is visually distinct from
  literal text.

## 6. Validation

`validateGraph` (or a new lint pass) scans string fields for `{{ nodeId.path }}` and flags tokens
whose `nodeId` isn't an **upstream** node (unreachable ⇒ always empty) — a compile-time warning on
the canvas, not a hard error (the run still tolerates it). This catches the common typo without
making templates brittle.

## 7. Non-negotiables carried in

- **Deterministic.** Resolution is pure `getByPath` over `ctx` in workflow code — no eval, no I/O,
  no clock/random. Replay-safe (Tier-1 rule 2).
- **No secret exposure.** Templates read `ctx` (node outputs), never provider keys — those never
  enter `ctx` or workflow history (Tier-1 rule 4).
- **Fail-open at runtime, warn at author time.** A bad token yields empty, never a crashed run;
  the canvas surfaces it.

## 8. Rollout — as slices (each its own PR)

1. **`resolveTemplates` in `@naary/dsl`** + exhaustive unit tests (whole-value vs embedded,
   objects→JSON, missing path, escaping). Pure, no interpreter change yet.
2. **Wire it into `execNode`** (the `cfg` shim + `node.config`→`cfg` swaps) + an interpreter e2e:
   a graph whose httpRequest url / agent systemPrompt embeds `{{ upstream.path }}` resolves.
3. **Compile-time lint** for unknown/non-upstream tokens (warning).
4. **Web insert-reference affordance** + token highlighting.

Slices 1–2 deliver the whole runtime capability; 3–4 are ergonomics.

## 9. Verification plan

- DSL unit tests for every semantic in §4.
- Interpreter e2e (worker test): templated url/subject/prompt resolve from a prior node's output;
  a missing token yields empty and the run still completes.
- A replay/determinism check: the same graph + inputs produce identical history (no nondeterminism
  introduced).

## 10. Residual open questions

- **Array iteration** (`{{ items[*].id }}`) — deferred; it entangles with the items-model work.
  Template-lite handles a single path only.
- **Default/fallback** (`{{ a ?? "n/a" }}`) — tempting, but it's the first step onto the
  expression-language slope. Hold for Phase 3 unless demand is high.
- **Type preservation across embedding** — a whole-string token keeps its type; a mixed string
  coerces. Confirm this matches author expectations for the `body` field specifically.

/**
 * Regression guard for the tight touch-target clusters fixed under #1076.
 *
 * apps/web's vitest environment is `node` — no jsdom, so a spec cannot render a screen and read a
 * rect (same constraint as settings-touch-targets.spec.ts and overlay-containing-block.spec.ts).
 * The numbers below were measured with Playwright against the BUILT SPA (not Storybook) at
 * 390x844, with `**\/api\/**` stubbed; what this file pins is the SOURCE shapes those numbers
 * depend on.
 *
 * Storybook is deliberately NOT the evidence here. #1076 quoted "97x30 sandbox, gap 11px" and
 * eighteen `211x35 gap 1` rail links from `app-chrome-shell--context-bar-story` / `--rail`, and
 * those stories pass DESKTOP props (`compact={false} phone={false}`, `touch` unset) which are then
 * rendered at 390px. In the real app `AppShell` passes `compact={smallShell}` / `touch={smallShell}`
 * from a media query, and the same controls measure: drawer nav row 259x44, context-bar-phone 0
 * unsafe. Those clusters were phantoms; the ones below are not.
 *
 * ── The dead `all: unset` rules ──────────────────────────────────────────────────────────────
 * components.css carried `.ctx-bar [role="group"] button`, `.ctx-bar [aria-haspopup="menu"]` and
 * `.drawer-context button { min-height: 44px }` under a comment claiming "a stylesheet min-height
 * still wins since it isn't in their inline style". It IS in their inline style: React writes
 * `style={{ all: "unset" }}` to the element, `all` expands to every longhand including
 * `min-height: unset`, and inline beats an author stylesheet. Measured `getComputedStyle` at 390:
 *
 *   environment dropdown ...  97.3 x 29.8   min-height: auto   ->  97.3 x 44
 *   variant "Builder" ......  60.8 x 25.8   min-height: auto   ->  60.8 x 44
 *   workspace switcher .....  255  x 31.7   min-height: auto   ->  255  x 44
 *
 * ── The one genuinely tight cluster ─────────────────────────────────────────────────────────
 * Approvals' select-all `.check` measured 18x18 with the "All N" chip 11px away. A 44px area
 * centred on an 18px tile needs 13px per side, so growing the tile would have OVERLAPPED the chip
 * — tapping the filter you can see would have toggled the selection (the #511 / #1074 failure).
 * `Checkbox`'s `hitArea` makes the BUTTON 44x44 with the 18px tile centred inside, in layout, so
 * flex reflow pushes the chips right instead: 18x18 -> 44x44, chip x 49 -> 73.
 *
 * ── Deliberately NOT changed ────────────────────────────────────────────────────────────────
 * `AppShell`'s "switch to Simple" (96.1 x 19.4) is an inline link inside a wrapping sentence; a
 * 44px box would overlap the text lines above and below it. Runs' "All" chip stays 39px WIDE with
 * its neighbour 2px away — 39x44 is a usable target and widening it is the overlap being avoided.
 *
 * Desktop (1440x900) is untouched throughout, which is what pins these to the touch range:
 * checkbox 18x18, chip 50.7x27, "View full run" 185.3x15, "Remind now" 122.2x34, env 78.3x25.8.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../src");
const read = (p: string) => readFileSync(path.join(SRC, p), "utf8");

const componentsCss = read("components/components.css");
const forms = read("components/forms.tsx");
const approvals = read("screens/app/Approvals.tsx");
const detailPanel = read("screens/app/approvals/DetailPanel.tsx");
const contextBar = read("app/ContextBar.tsx");
const envSwitcher = read("workspace/EnvironmentSwitcher.tsx");
const wsSwitcher = read("workspace/WorkspaceSwitcher.tsx");
const runs = read("screens/app/Runs.tsx");

/** The body of a top-level `function <name>(` / `export function <name>(`, by brace balance. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const open = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0)
      return source.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

describe("touch targets — tight clusters (#1076)", () => {
  it("the dead `all: unset` min-height rules are gone from components.css", () => {
    // Not reworded — REMOVED. A corrected comment above a rule that still cannot win is worse
    // than no rule, and the next sweep would read the selector as coverage that exists.
    //
    // Comments are stripped first: the replacement comment in that file NAMES the three dead
    // selectors so the next reader knows why they aren't there, and a raw source match would
    // then fail on the explanation rather than on a live rule.
    const rules = componentsCss.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).not.toMatch(/\.ctx-bar \[role="group"\] button/);
    expect(rules).not.toMatch(/\.ctx-bar \[aria-haspopup="menu"\]/);
    expect(rules).not.toMatch(/\.drawer-context button/);
    // The claim that made them look correct is quoted in the replacement comment — it has to be,
    // or a future reader re-adds the selectors. What's pinned is that it's quoted as WRONG.
    expect(componentsCss).toMatch(/That was FALSE/);
    expect(componentsCss).toMatch(/min-height: auto/);
  });

  it("the `.btn` / `.btn-icon` touch rules that DO work are still there", () => {
    // Those beat class-based buttons fine — only `all: unset` inline styles defeated them.
    const media = componentsCss.slice(
      componentsCss.indexOf("@media (max-width: 1024px)"),
    );
    expect(media).toMatch(/\.ctx-bar \.btn-icon/);
    expect(media).toMatch(/\.ctx-bar \.btn\s*\{[^}]*min-height:\s*44px/);
  });

  it.each([
    ["environment dropdown", envSwitcher, "belowDrawer"],
    ["workspace switcher", wsSwitcher, "touch"],
    ["variant switcher", contextBar, "touch"],
  ])("the %s sets its own 44px minHeight inline", (_label, source, flag) => {
    // The ONLY place a min-height can reach an `all: unset` button is the same inline style.
    expect(source).toMatch(/all:\s*"unset"/);
    expect(source).toMatch(new RegExp(`minHeight:\\s*${flag}\\s*\\?\\s*44`));
    // Media-query driven, so desktop density is unchanged.
    expect(source).toMatch(/BELOW_DRAWER_QUERY/);
  });

  it("Checkbox grows the BUTTON, not the tile, and keeps the tile presentational", () => {
    const body = functionBody(forms, "Checkbox");
    expect(body).toMatch(/hitArea/);
    // The button carries the size...
    expect(body).toMatch(/width:\s*hitArea/);
    expect(body).toMatch(/height:\s*hitArea/);
    // ...and the 18px `.check` moves INSIDE it as aria-hidden presentation. A nested interactive
    // element here would rebuild the #511 bug (a tap performing a different action). Two `<button`
    // occurrences are expected — the two branches — so what's asserted is that neither branch
    // NESTS one: the only child element of the hit-area branch is a span.
    expect(body).toMatch(/<span className=\{cls\} aria-hidden>/);
    const hitBranch = body.slice(body.indexOf("width: hitArea"));
    expect(hitBranch).not.toMatch(/<button/);
    expect(body.match(/<button/g)?.length).toBe(2);
  });

  it("the hit area is real layout, never a pseudo-element", () => {
    // A `::after` overlay is invisible to getBoundingClientRect, so an overlay that overlapped its
    // neighbour would measure identical to one that didn't and the audit could never catch it.
    // Laid-out growth pushes siblings instead, which makes overlap impossible by construction.
    expect(componentsCss).not.toMatch(/\.check::(after|before)/);
    expect(functionBody(forms, "Checkbox")).not.toMatch(/::(after|before)/);
  });

  it("Checkbox forwards an accessible name", () => {
    // `role="checkbox"` on a <button> takes its name from aria-labelledby / aria-label / content
    // only — and the content is a decorative tick. Measured on the built approvals screen: 4 of 4
    // had NO accessible name, including the select-all this PR promoted to a 44x44 control.
    // The prop TYPES live in the signature, which `functionBody` starts after — so they're
    // matched against the file and the forwarding against the body.
    expect(forms).toMatch(/ariaLabel\?: string/);
    expect(forms).toMatch(/ariaLabelledBy\?: string/);
    const body = functionBody(forms, "Checkbox");
    // BOTH branches — the 18px one is the default and most call sites use it.
    expect(body.match(/aria-label=\{ariaLabel\}/g)?.length).toBe(2);
    expect(body.match(/aria-labelledby=\{ariaLabelledBy\}/g)?.length).toBe(2);
  });

  it("every Checkbox call site names its control", () => {
    // A wrapping <label> does NOT name a <button role="checkbox">, and a labelled ancestor row
    // names the ROW, not its separately focusable child — the two traps that left all four
    // unnamed. `aria-labelledby` at the sites that have visible text beside the box, so the two
    // cannot drift; a literal label only where nothing visible names it.
    const sites: [string, string][] = [
      ["screens/app/Approvals.tsx", "ariaLabel="],
      ["screens/app/approvals/QueueRow.tsx", "ariaLabelledBy="],
      ["screens/app/Workflows.tsx", "ariaLabelledBy="],
      ["screens/app/WorkflowTagsDialog.tsx", "ariaLabelledBy="],
      ["screens/app/groups/GrantEditor.tsx", "ariaLabelledBy="],
      ["screens/canvas/ApprovalRoutingFields.tsx", "ariaLabelledBy="],
    ];
    for (const [file, prop] of sites) expect(read(file), file).toContain(prop);
    // The standalone one is the only place a literal string is right: nothing visible names it.
    expect(approvals).toMatch(
      /ariaLabel=\{allSelected \? "Clear selection" : "Select all approvals"\}/,
    );
    // Every id an `ariaLabelledBy` points at must be rendered by the same file.
    for (const [file] of sites) {
      const src = read(file);
      for (const m of src.matchAll(/ariaLabelledBy=\{`([^`]+)`\}/g)) {
        const tmpl = m[1].replace(/\$\{[^}]+\}/g, "");
        expect(src, `${file}: no id= for ${m[1]}`).toContain(`id={\`${tmpl}`);
      }
    }
    // ...and the one non-template id (QueueRow builds it into a const first).
    expect(read("screens/app/approvals/QueueRow.tsx")).toMatch(
      /id=\{titleId\}/,
    );
  });

  it("Approvals passes hitArea only in the touch range", () => {
    expect(approvals).toMatch(/hitArea=\{stacked \? 44 : undefined\}/);
    expect(approvals).toMatch(/BELOW_DRAWER_QUERY/);
  });

  it("the approvals filter chips grow on HEIGHT only", () => {
    // They are each other's horizontal neighbours at 9px; widening them is the overlap. All three
    // already measure >= 44px wide, so height was the whole deficit anyway.
    const body = functionBody(approvals, "FilterChip");
    expect(body).toMatch(/minHeight:\s*touch \? 44/);
    expect(body).not.toMatch(/minWidth:/);
    // Every call site must pass it, or one chip stays 27px next to two 44px siblings.
    expect(approvals.match(/touch=\{stacked\}/g)?.length).toBe(3);
  });

  it("both `Remind now` buttons and the run link take the touch height", () => {
    // `.btn`'s height is set INLINE at both call sites, so it beats every media rule in
    // components.css — the touch range has to be spelled out at each one. Two, not one: the
    // routed and un-routed gates render different copies, and only the un-routed one appeared in
    // the first measurement.
    expect(detailPanel.match(/height:\s*touch \? 44 : 34/g)?.length).toBe(2);
    expect(detailPanel).toMatch(/minHeight:\s*touch \? 44 : undefined/);
  });

  it("Runs grows the filter chips and search vertically, and NOT horizontally", () => {
    // "All" is 39px wide with 2px to "Waiting". 39x44 is a usable target; 44x44 is an overlap.
    expect(runs).toMatch(/minHeight:\s*touch \? 44 : undefined/);
    expect(runs).toMatch(/height:\s*touch \? 46 : 34/);
    expect(runs).toMatch(/height:\s*touch \? 44 : 32/);
    expect(runs).not.toMatch(/minWidth:\s*touch \? 44/);
    // Hit areas gate on <= 1024 like the rest of the app, NOT on this screen's <= 640 layout
    // switch — otherwise a tablet shows 25px chips beside a 44px context bar.
    expect(runs).toMatch(/const touch = useMediaQuery\(BELOW_DRAWER_QUERY\)/);
  });
});

describe("responsive-audit harness (#1076)", () => {
  const harness = readFileSync(
    path.resolve(__dirname, "../scripts/responsive-audit.mjs"),
    "utf8",
  );

  it("drops inert and HORIZONTALLY off-viewport controls before measuring neighbours", () => {
    // A closed drawer is only TRANSLATED away; its dense link stack became the "nearest
    // neighbour" of every real control. Dropping it took the approvals screen's drawer-open
    // reading from 19 small targets to 6.
    expect(harness).toMatch(/el\.closest\('\[inert\]'\)/);
    expect(harness).toMatch(/r\.right > 0 && r\.left < VW/);
  });

  it("does NOT filter vertically — below the fold is reachable, off to the side is not", () => {
    // `global.css` clamps the root with `overflow-x: hidden`, so a box past a side edge is behind
    // a hard wall; vertically the page scrolls. Measured: of 75 sub-44px targets across ten
    // screens, 4 sit below the fold (Integrations' "Add connection", y 923..1365) and a vertical
    // clause would drop all four — hiding real defects rather than phantoms. This asserts the
    // absence, because "we forgot the other axis" and "we ruled it out" look identical in a diff.
    expect(harness).not.toMatch(/r\.bottom > 0 && r\.top < VH/);
    expect(harness).toMatch(
      /HORIZONTAL ONLY, and that asymmetry is deliberate/,
    );
  });

  it("reports the neighbour's AXIS alongside the isotropic `safe` flag", () => {
    // Additive on purpose: three passes on #511 drew wrong conclusions from a CHANGED probe, so
    // `safe` keeps its documented centre-grow meaning and the directional read sits beside it.
    expect(harness).toMatch(/dx:/);
    expect(harness).toMatch(/dy:/);
    expect(harness).toMatch(/needX:/);
    expect(harness).toMatch(/needY:/);
    expect(harness).toMatch(/safeOnAxis:/);
    expect(harness).toMatch(/safe: gap === Infinity \? true : gap >= need,/);
  });
});

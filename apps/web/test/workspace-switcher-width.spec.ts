/**
 * Regression guard: the workspace switcher sizes to its LABEL, not to the whole app bar.
 *
 * THE BUG. `WorkspaceSwitcher`'s root was `style={{ flex: 1, minWidth: 0 }}`, and `flex: 1` is
 * `1 1 0%` — a grow factor of 1 with a ZERO basis. In the `ContextBar` flex row (app/ContextBar.tsx)
 * that made it the only item that could absorb slack, so it swallowed the bar: at 1440 the switcher
 * occupied 553px around a 72px workspace name, and the chevron that belongs beside the name floated
 * ~460px away from it. Its sibling `EnvironmentSwitcher` was already wrapped in
 * `{ minWidth: 0, display: "flex", flexShrink: 1 }` — shrink, no grow — which is the shape this one
 * was missing.
 *
 * The zero basis is the SECOND half of the same defect, and the one that is easy to miss: a flex
 * item shrinks FROM its basis, so a `1 1 0%` item with `minWidth: 0` shrinks to literally nothing
 * the moment the row runs a deficit. Measured at 760px the switcher's root rect was 0.0px wide —
 * the active workspace name was not on screen at all.
 *
 * `flex: "0 1 auto"` is the content basis on both sides of that: no grow, and a shrink measured
 * from the name's own width rather than from 0. `minWidth: 0` is retained deliberately, so what a
 * narrow bar takes is spent on the label's `text-overflow: ellipsis` instead of overflowing the row.
 *
 * apps/web's vitest environment is `node` — no jsdom/testing-library, so nothing here can render a
 * bar and measure a rect (same constraint as canvas-top-bar-responsive.spec.ts and
 * overlay-containing-block.spec.ts). The numbers below were taken with Playwright against a built
 * Storybook, probing `app-chrome-shell--context-bar-story` (the only story that puts this component
 * in the REAL ContextBar row — `app-chrome-switchers--workspace` renders it as a block-level div in
 * a block container, where `flex` is inert and before/after are identical). What this file guards is
 * that the SOURCE shapes those numbers depend on don't quietly come back.
 *
 * Switcher root `getBoundingClientRect().width`, and whether the label's ellipsis is engaged:
 *
 *                                     before            after
 *   1440  "Acme Corp" ............... 553.0           →   91.7   (= 71.7 label + 6 gap + 14 chevron)
 *   1440  56-char name .............. 553.0           →  390.8
 *   1100  "Acme Corp" ............... 213.0           →   91.7
 *   1100  56-char name .............. 213.0 (…)       →  274.2 (…)
 *    760  "Acme Corp" ...............   0.0 (…)       →   28.3 (…)
 *    760  56-char name ..............   0.0 (…)       →   46.7 (…)
 *
 * (…) = `label.scrollWidth > label.clientWidth`, i.e. the name is truncated rather than overflowing.
 * The right-hand action cluster's right edge measured `viewport - 16` (the header's own padding) at
 * every width in BOTH builds, and `header.scrollWidth - header.clientWidth` was 0 throughout: this
 * change gives width back, it never pushes a control off the bar. 760 is a stress case, not a real
 * viewport — the bar renders this component only while `!compact` (> 1024px) — but it is the width
 * that exposed the collapse-to-zero, so it is measured.
 *
 * THE OTHER RENDER SITE. `ContextBar` is not the only caller: below 1024 the bar drops the switcher
 * and `AppShell.tsx`'s `drawer-context` box renders it at the top of the nav drawer instead. That
 * box is a flex COLUMN, so `flex` governs its children's HEIGHT and their width comes from
 * `align-items: stretch` — and the box is `flex: "none"` with a content-determined height, so there
 * is no free space on its main axis either. Measured (real switcher DOM re-parented into a replica
 * of that container, 288px drawer): 260.0 × 31.7 with a 58.7 box under BOTH `1 1 0%` and
 * `0 1 auto`, no ellipsis in either. The change is inert there, which is why the fix belongs on the
 * component root rather than on the ContextBar call site.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  path.resolve(__dirname, "../src/workspace/WorkspaceSwitcher.tsx"),
  "utf8",
);

/** Source with `//` and block comments stripped — assertions must not pass on prose (the fix's
 *  own comment quotes `flex: 1` to explain what it replaced). */
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * `text.indexOf(needle, from)`, but LOUD when the anchor has moved.
 *
 * Every slice below is taken between two anchors, and a bare `indexOf` answers -1 for one that
 * moved — which `String.slice` then reads as "one character from the end", so `slice(from, -1)`
 * silently returns the whole REST OF THE FILE. That is not a false alarm, it is a vacuous PASS:
 * measured on this file's own drawer slice, mangling the end anchor grew it from 300 to 3368
 * characters and swept in three unrelated `flexDirection: "column"` declarations, so the positive
 * control kept passing while guarding nothing at all.
 */
function mustIndexOf(
  text: string,
  needle: string | RegExp,
  what: string,
  from = 0,
): number {
  let i: number;
  if (typeof needle === "string") {
    i = text.indexOf(needle, from);
  } else {
    const re = new RegExp(needle.source, needle.flags.replace("g", "") + "g");
    re.lastIndex = from;
    i = re.exec(text)?.index ?? -1;
  }
  if (i < 0) {
    throw new Error(
      `workspace-switcher-width.spec: anchor not found — ${what}. The source shape this guard ` +
        `slices on has moved; re-anchor it rather than deleting the assertion.`,
    );
  }
  return i;
}

/** `<WorkspaceSwitcher />` as JSX rather than as text: prettier may or may not put a space before
 *  the self-closing slash, and may wrap a call that gains props onto several lines. What is being
 *  pinned is "this parent renders the switcher", not one particular run of whitespace. */
const RENDERS_SWITCHER = /<WorkspaceSwitcher\s*(?:\/>|[^/>][\s\S]{0,200}?\/>)/;

/** The label `<span>` — the flex child inside the trigger whose `flex: 1` is the OPPOSITE of the
 *  root's rule and must survive. Whitespace-tolerant for the same reason as above. */
const LABEL_SPAN =
  /<span\s+style=\{\{\s*flex:\s*1,\s*minWidth:\s*0,?\s*\}\}\s*>/;

/** The ROOT element's own style object — the flex item in the ContextBar row. Its children carry
 *  `flex`/`minWidth` of their own, so a file-wide assertion would read the wrong box. */
const rootStyle = (() => {
  const from = mustIndexOf(
    code,
    "style={{",
    "the root element's style object, after `return (`",
    mustIndexOf(code, "return (", "the component's `return (`"),
  );
  return code.slice(
    from,
    mustIndexOf(code, "}}", "the root style's `}}`", from) + 2,
  );
})();

/** The trigger `<button>` — from its own `style={{` to the chevron `<Icon>` that closes it. */
const trigger = code.slice(
  mustIndexOf(
    code,
    "style={{",
    "the trigger button's style object",
    mustIndexOf(code, 'title="Switch workspace"', "the trigger button"),
  ),
  mustIndexOf(code, 'name="chevron-up-down"', "the trigger's chevron Icon"),
);

describe("workspace switcher sizes to its label, not to the app bar", () => {
  it("the scan is actually looking at the root flex item", () => {
    // The positive control. Every assertion below is a claim about `rootStyle`, and a slice that
    // came back empty (a refactor to a styled component, an extracted wrapper, a `return` that
    // moved) would satisfy the `not.toMatch` ones perfectly and guard nothing.
    expect(rootStyle.length).toBeGreaterThan(20);
    expect(rootStyle).toContain('position: "relative"');
    // …and that the component is still IN that row, which is what makes `flex` mean anything.
    const bar = readFileSync(
      path.resolve(__dirname, "../src/app/ContextBar.tsx"),
      "utf8",
    );
    expect(
      bar,
      "the ContextBar no longer renders WorkspaceSwitcher — the desktop app bar is the row whose " +
        "spare width `flex: 1` used to absorb, so without it this whole file guards nothing",
    ).toMatch(RENDERS_SWITCHER);
    expect(bar, "the ContextBar is no longer a single-line flex row").toMatch(
      /display: "flex",[\s\S]{0,600}?flexWrap: "nowrap"/,
    );
    // The only OTHER caller is the nav drawer's context box, and the reason a root-level fix is
    // safe there is that it lays out as a COLUMN (see the header). If that ever becomes a row,
    // `0 1 auto` would unpin the chevron from the drawer's right edge and the fix has to move out
    // to the ContextBar call site as a wrapper — the shape EnvironmentSwitcher already uses.
    const shell = readFileSync(
      path.resolve(__dirname, "../src/app/AppShell.tsx"),
      "utf8",
    );
    const drawerFrom = mustIndexOf(
      shell,
      'className="drawer-context"',
      "AppShell's drawer-context box",
    );
    const drawer = shell.slice(
      drawerFrom,
      mustIndexOf(
        shell,
        RENDERS_SWITCHER,
        "the drawer's <WorkspaceSwitcher />",
        drawerFrom,
      ),
    );
    // AppShell holds FOUR `flexDirection: "column"` declarations, so this assertion is only
    // meaningful while the slice is actually the drawer box — hence a bound on its size rather
    // than the near-vacuous `toContain("flex")` this used to be ("flex" is a substring of
    // "flexDirection"). The box is ~300 characters; the rest of the file is ~3400.
    expect(
      drawer.length,
      "the drawer-context slice is not the box",
    ).toBeLessThan(1000);
    expect(drawer).toContain('flex: "none"');
    expect(
      drawer,
      "the drawer context box is no longer a COLUMN — a root-level `flex: 0 1 auto` is only " +
        "inert at this second render site while its main axis is vertical",
    ).toContain('flexDirection: "column"');
  });

  it("the root does not GROW — no `flex: 1` / no grow factor above 0", () => {
    // 553px of switcher around a 72px name at 1440. `flex: 1` is the exact spelling that caused
    // it, but so would `flex: "1 1 auto"` or a bare `flexGrow`, so match the property not the
    // literal. `0 1 auto` is the flex INITIAL value and could be written by deleting the
    // declaration entirely — it is spelled out so this file has something to anchor on, and so
    // that "sized to content, still shrinkable" reads as a decision rather than an omission.
    expect(rootStyle).toContain('flex: "0 1 auto"');
    expect(rootStyle).not.toMatch(/flex:\s*[1-9]/);
    expect(rootStyle).not.toMatch(/flexGrow:\s*[1-9]/);
    expect(rootStyle).not.toMatch(/flex:\s*"[1-9]/);
  });

  it("…and it does not lose the ability to SHRINK either", () => {
    // The other way to "size to content" is `flex: "none"`, which is a different bug: a nowrap
    // label that cannot shrink pushes the rest of the bar toward the right edge of an
    // `overflow-x: hidden` root (the defect canvas-top-bar-responsive.spec.ts exists for).
    // `minWidth: 0` is what makes the shrink land on the label's ellipsis instead of being
    // refused by its min-content width.
    expect(rootStyle).not.toContain('flex: "none"');
    expect(rootStyle).toContain("minWidth: 0");
  });

  it("the trigger still fills the root, so a squeezed label truncates in place", () => {
    // `width: 100%` is what keeps the chevron pinned to the right edge of whatever width the root
    // ends up with, and the `flex: 1` on the label span INSIDE the button is load-bearing for the
    // same reason — it is the opposite of the root's rule, and must not be "fixed" to match it.
    expect(trigger).toContain('width: "100%"');
    expect(trigger).toContain("minWidth: 0");
    expect(
      trigger,
      "the label span lost its own `flex: 1` — that is what lets the label absorb the button's " +
        "width so the chevron pins right and the ellipsis has somewhere to happen. It is the " +
        "OPPOSITE of the root's rule on purpose; do not 'fix' it to match",
    ).toMatch(LABEL_SPAN);
  });

  it("the label truncates rather than overflowing", () => {
    // The shrinkable half of the requirement, and the part a future edit is most likely to drop:
    // without all three the root's `minWidth: 0` just lets a long name spill out of the bar.
    const labelFrom = mustIndexOf(code, LABEL_SPAN, "the label span");
    const label = code.slice(
      labelFrom,
      mustIndexOf(
        code,
        /\{active\s*\?\s*workspaceLabel\(/,
        "the workspace name expression that ends the label span",
        labelFrom,
      ),
    );
    expect(label).toContain('whiteSpace: "nowrap"');
    expect(label).toContain('overflow: "hidden"');
    expect(label).toContain('textOverflow: "ellipsis"');
    // The chevron is the one thing in the trigger that may NOT give — a 14px glyph has nothing to
    // truncate, and shrinking it is how the control stops reading as a control.
    expect(code).toMatch(/name="chevron-up-down"[\s\S]{0,120}?flex: "none"/);
  });
});

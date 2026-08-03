/**
 * Regression guard for the Re-run split button's two halves being the SAME HEIGHT on a phone.
 *
 * apps/web's vitest environment is `node` — no jsdom, no rects (same constraint as
 * settings-touch-targets.spec.ts and overlay-containing-block.spec.ts). The numbers below came
 * from Playwright against a built Storybook; what this file guards is that the SOURCE shapes they
 * depend on don't quietly come back.
 *
 * Measured on `screens-rundetail--failed`, reading both `.btn-split > .btn` children:
 *
 *              390px          375px      768px      1440px
 *   before  34 / 44 px      34 / 44     34 / 44     34 / 34
 *   after   44 / 44 px      44 / 44     44 / 44     34 / 34
 *
 * Before, the caret's bottom edge sat at 253 against the primary's 243 — a 10px overhang on the
 * one control whose entire design is a single continuous outline. Reported twice as "the Re-run
 * button is not aligned on mobile". 1440 is unchanged in both, which is what pins the fix to the
 * touch range rather than to the control.
 *
 * CAUSE, and why it is a CSS guard rather than a component one: the app-wide `<= 1024` touch rule
 * grows every `.btn-icon` to 44px. A split pair is one primary + one icon-only caret, so it grew
 * exactly half of this control. Flex stretch cannot rescue it — `.btn` sets a definite `height`,
 * and a definite height beats `align-items: stretch`.
 *
 * Only a LABELLED primary is affected. The Runs list passes no label, so `iconOnly` makes both
 * halves `.btn-icon` and the touch rule already equalised them (measured 44/44 at 390, identical
 * before and after). Run detail passes `label="Re-run"`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../src");
const css = readFileSync(path.join(SRC, "components/components.css"), "utf8");
const rerunMenu = readFileSync(
  path.join(SRC, "screens/app/RerunMenu.tsx"),
  "utf8",
);

/**
 * Every `@media (max-width: 1024px) { … }` body, matched by BRACE BALANCE.
 *
 * Deliberately not `indexOf(start)`…`indexOf(end)`: that idiom answers -1 when an anchor moves,
 * and `slice(from, -1)` reads -1 as "one from the end" — so the slice silently becomes the whole
 * rest of the file and the assertion passes against unrelated CSS. That exact false-pass was found
 * in workspace-switcher-width.spec.ts (#1071). Here a missing block throws instead.
 */
function touchRangeBlocks(source: string): string[] {
  const out: string[] = [];
  const re = /@media\s*\(max-width:\s*1024px\)\s*\{/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end === -1)
      throw new Error("unbalanced braces in a <= 1024 media block");
    out.push(source.slice(open, end + 1));
  }
  if (out.length === 0) {
    throw new Error(
      "no `@media (max-width: 1024px)` block found in components.css",
    );
  }
  return out;
}

describe("split button — both halves match on a phone", () => {
  const blocks = touchRangeBlocks(css);

  it("the <= 1024 touch range sets a height on `.btn-split > .btn`, not only on the caret", () => {
    // The defect was the caret growing alone. Whichever block carries it, SOME rule in the touch
    // range must size the split pair's children as a pair.
    const sizing = blocks.filter((b) => /\.btn-split\s*>\s*\.btn\b/.test(b));
    expect(
      sizing.length,
      "no `.btn-split > .btn` rule inside a <= 1024 media block — the caret will grow to 44px alone",
    ).toBeGreaterThan(0);
    expect(
      sizing.some((b) =>
        /\.btn-split\s*>\s*\.btn[^{]*\{[^}]*height:\s*44px/.test(b),
      ),
      "the split pair is not equalised to the 44px the touch rule gives the caret",
    ).toBe(true);
  });

  it("beats `.btn-sm` / `.btn-icon.btn-sm`, which are the same specificity as a bare `.btn-split > .btn`", () => {
    // `.btn-split > .btn` is (0,2,0) — a tie with `.btn-icon.btn-sm`, so a bare selector would
    // depend on source order. Naming the class makes it (0,3,0) and order-independent.
    const sizing = blocks
      .filter((b) => /\.btn-split\s*>\s*\.btn\b/.test(b))
      .join("\n");
    expect(sizing).toMatch(/\.btn-split\s*>\s*\.btn\.btn-icon/);
    expect(sizing).toMatch(/\.btn-split\s*>\s*\.btn\.btn-sm/);
  });

  it("desktop is untouched — the equalising rule lives ONLY in the touch range", () => {
    // A `.btn-split > .btn { height: 44px }` at top level would make every split button 44px on a
    // 1440px screen, which is not the bug and would not have been noticed here.
    const outsideMedia = css.replace(
      /@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g,
      "",
    );
    expect(outsideMedia).not.toMatch(
      /\.btn-split\s*>\s*\.btn[^{]*\{[^}]*height:\s*44px/,
    );
  });

  it("`.btn` still sets a definite height — the reason flex stretch cannot do this for us", () => {
    // If this ever becomes `min-height`, stretch equalises the pair on its own and the rule above
    // is dead weight rather than load-bearing. Fail here so whoever changes it reads why.
    expect(css).toMatch(/^\.btn \{[^}]*\n\s*height:\s*34px;/m);
  });

  it("run detail is the LABELLED case the measurements were taken on", () => {
    // `iconOnly={!label}`: with a label the primary is not a `.btn-icon`, which is exactly why the
    // touch rule missed it. If the label ever goes away, these measurements stop describing it.
    expect(rerunMenu).toMatch(/iconOnly=\{!label\}/);
    expect(
      readFileSync(path.join(SRC, "screens/app/RunDetail.tsx"), "utf8"),
    ).toMatch(/label="Re-run"/);
  });
});

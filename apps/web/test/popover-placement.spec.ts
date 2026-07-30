/**
 * Popover placement (#511) — the row-action menus that opened OFF the screen.
 *
 * ## What was wrong, measured
 *
 * All three numbers below come from `apps/web/scripts/responsive-audit.mjs` driving the built
 * Storybook at **390×844**, its own default phone viewport, with the menus OPEN (stories
 * `settings-rowmenu--open-near-the-bottom` and `screens-rundetail--failed-rerun-menu-open`, both
 * added in this pass — no story had ever opened these states, so no sweep had ever measured them):
 *
 * | surface | before | after |
 * |---|---|---|
 * | `RowMenu` on the last of 16 rows | top 811, bottom **885 / 844**; `Delete` **36px below the fold**, wholly offscreen | top 687, bottom **761 / 844**, flipped above; 0px out |
 * | `RowMenu` on the real Settings screen @375×667 | top 671, bottom **745 / 667** — **78px past the fold**, entirely offscreen | 545 / 619; 0px out |
 * | `RerunMenu` on a failed run | **left −121**; all 4 items **114px off the left edge** | left **8**; 0px out |
 *
 * Desktop is unchanged, measured at 1440×900: `RerunMenu` left 1140 / right 1412 both before and
 * after, and `RowMenu` still opens BELOW its row (top 803, bottom 877 / 900) because there is room.
 *
 * The `RowMenu` case is the severe one: the menu is `position: fixed`, so page scroll cannot move
 * it, AND the component closes on any scroll — the gesture that would bring it into view destroys
 * it. The row's only actions, one of them `Delete`, could not be reached by any means.
 *
 * ## Why this file tests functions and not components
 *
 * `apps/web`'s vitest environment is `node`, so there is no layout engine: a rendered menu has no
 * rect to assert on (see `settings-touch-targets.spec.ts`, which had to scan source text instead).
 * The placement arithmetic is therefore a pure function, which IS testable here — every edge case
 * below is a real configuration the app produces, not a hypothetical.
 *
 * The source scan at the bottom covers the parts that aren't arithmetic: that the call sites feed
 * the helper NATURAL sizes rather than clamped ones, and that the scroll-close listener ignores
 * scrolls the menu itself produced.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { placeFixedPopover, shiftIntoView } from "../src/lib/popoverPlacement";

const PHONE = { width: 390, height: 844 };
/** A 44px kebab on the last row of the 16-row secrets list, as measured at 390×844. */
const LAST_ROW_KEBAB = { top: 763, bottom: 807, left: 331, right: 375 };
/** The RowMenu with two items ("Update value…", "Delete"), as measured. */
const TWO_ITEM_MENU = { width: 150, height: 74 };

describe("placeFixedPopover", () => {
  it("keeps the menu below the anchor when there is room", () => {
    const p = placeFixedPopover(
      { top: 100, bottom: 144, left: 331, right: 375 },
      TWO_ITEM_MENU,
      PHONE,
    );
    expect(p.side).toBe("below");
    expect(p.top).toBe(148);
    // Right-aligned to the anchor: 375 - 150.
    expect(p.left).toBe(225);
  });

  it("flips above the anchor rather than off the bottom of a phone", () => {
    // The regression: 807 + 4 + 74 = 885 in an 844px viewport — 41px past the fold.
    const p = placeFixedPopover(LAST_ROW_KEBAB, TWO_ITEM_MENU, PHONE);
    expect(p.side).toBe("above");
    expect(p.top + TWO_ITEM_MENU.height).toBeLessThanOrEqual(PHONE.height - 8);
    expect(p.top).toBe(685); // 763 - 4 - 74
  });

  it("never places a menu past any edge, wherever the anchor is", () => {
    const menu = { width: 220, height: 300 };
    for (const top of [-40, 0, 8, 200, 500, 820, 900]) {
      for (const right of [-10, 0, 30, 200, 389, 420]) {
        const p = placeFixedPopover(
          { top, bottom: top + 44, left: right - 44, right },
          menu,
          PHONE,
        );
        const height = Math.min(menu.height, p.maxHeight);
        const width = Math.min(menu.width, p.maxWidth);
        expect(p.top).toBeGreaterThanOrEqual(8);
        expect(p.left).toBeGreaterThanOrEqual(8);
        expect(p.top + height).toBeLessThanOrEqual(PHONE.height - 8);
        expect(p.left + width).toBeLessThanOrEqual(PHONE.width - 8);
      }
    }
  });

  it("caps the height and lets the menu scroll when neither side fits it whole", () => {
    // A 10-item menu on a landscape phone: 390px tall, anchor in the middle.
    const landscape = { width: 844, height: 390 };
    const p = placeFixedPopover(
      { top: 180, bottom: 224, left: 700, right: 744 },
      { width: 150, height: 400 },
      landscape,
    );
    // Above has 180-4-8 = 168 of room; below has 390-8-228 = 154. Above is roomier.
    expect(p.side).toBe("above");
    expect(p.maxHeight).toBe(168);
    expect(p.top).toBe(8);
  });

  it("caps the width for a menu wider than the viewport", () => {
    const p = placeFixedPopover(
      { top: 100, bottom: 144, left: 300, right: 344 },
      { width: 600, height: 74 },
      PHONE,
    );
    expect(p.maxWidth).toBe(374); // 390 - 2*8
    expect(p.left).toBe(8);
  });

  it("does not report a negative maxHeight for an anchor already off the bottom", () => {
    const p = placeFixedPopover(
      { top: 900, bottom: 944, left: 331, right: 375 },
      TWO_ITEM_MENU,
      PHONE,
    );
    expect(p.maxHeight).toBeGreaterThanOrEqual(0);
    expect(p.top).toBeGreaterThanOrEqual(8);
  });
});

describe("shiftIntoView", () => {
  it("pushes a right-anchored popover back inside the left edge", () => {
    // The measured RerunMenu on a failed run: left -121, right 151, width 272.
    expect(shiftIntoView({ left: -121, right: 151 }, { width: 390 })).toBe(129);
  });

  it("leaves a popover that already fits alone", () => {
    // The same component on a completed run — desktop and phone must not move.
    expect(shiftIntoView({ left: 28, right: 300 }, { width: 390 })).toBe(0);
    expect(shiftIntoView({ left: 1140, right: 1412 }, { width: 1440 })).toBe(0);
  });

  it("pulls a popover back inside the right edge", () => {
    expect(shiftIntoView({ left: 200, right: 420 }, { width: 390 })).toBe(-38);
  });

  it("prefers the left edge when the popover is wider than the viewport", () => {
    // Reading starts at the left, so that edge wins when both are violated.
    const shift = shiftIntoView({ left: -50, right: 500 }, { width: 390 });
    expect(shift).toBe(58);
  });
});

const src = (p: string) =>
  readFileSync(join(import.meta.dirname, "..", "src", p), "utf8");

describe("the call sites keep the properties the numbers depend on", () => {
  it("RowMenu measures the rendered menu in a layout effect, not in the click handler", () => {
    const s = src("screens/app/settings/shared.tsx");
    // Placement needs the menu's height, which does not exist until it has rendered. The old code
    // computed `top` inside `toggle()`, where a 2-item and a 5-item menu are indistinguishable.
    expect(s).toMatch(/useLayoutEffect\(\(\) => \{[\s\S]*placeFixedPopover/);
    expect(s).not.toMatch(
      /function toggle\(\)[\s\S]{0,400}getBoundingClientRect/,
    );
  });

  it("RowMenu ignores scroll events its own menu produced", () => {
    const s = src("screens/app/settings/shared.tsx");
    // A capped menu scrolls internally; without the origin guard that scroll would close it —
    // reintroducing the very failure this pass fixes, one level down.
    expect(s).toMatch(/menuRef\.current\?\.contains\(e\.target\)/);
  });

  it("both portal menus hide the frame before placement instead of painting it unclamped", () => {
    for (const f of [
      "screens/app/settings/shared.tsx",
      "screens/app/integrations/shared.tsx",
    ]) {
      expect(src(f)).toMatch(/visibility: pos \? "visible" : "hidden"/);
    }
  });

  it("both portal menus feed placement a NATURAL size, not the clamped one", () => {
    // `offsetHeight` reports the already-capped height; feeding it back would make the menu flip
    // sides on the second placement purely because the first had shrunk it.
    for (const f of [
      "screens/app/settings/shared.tsx",
      "screens/app/integrations/shared.tsx",
    ]) {
      expect(src(f)).toMatch(/placeFixedPopover\([\s\S]{0,80}naturalSize\(/);
    }
  });

  it("RerunMenu stays in flow and corrects with a transform", () => {
    const s = src("screens/app/RerunMenu.tsx");
    // Deliberately NOT position:fixed — it tracks its row in a scrolling list for free, and a fixed
    // popover would need the scroll listener whose close-on-scroll is the other bug in this pass.
    expect(s).toMatch(/position: "absolute"/);
    expect(s).toMatch(/translateX\(\$\{shift\}px\)/);
    expect(s).toMatch(/shiftIntoView\(/);
  });
});

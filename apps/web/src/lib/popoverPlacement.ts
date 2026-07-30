/**
 * Viewport-aware popover placement (#511).
 *
 * ## Why this exists
 *
 * Three row-action menus each anchored themselves by hand, and each got the same thing wrong: they
 * computed a position from the anchor alone and never asked whether the result was on the screen.
 * Measured at 390×844, the harness's own default phone viewport:
 *
 *  - `settings/shared.tsx` `RowMenu` — `top: anchor.bottom + 4`, `position: fixed`. On the last row
 *    of a 16-secret list the menu opened at top **811**, bottom **885 / 844**: "Update value…" 4px
 *    below the fold, **"Delete" 36px below and wholly offscreen**. A fixed box does not move with
 *    page scroll, and `RowMenu` closes on any scroll, so the recovery gesture *destroys the menu*.
 *    The row's only actions, one of them destructive, could not be reached at all.
 *  - `integrations/shared.tsx` `KebabMenu` — same geometry. It re-anchors on scroll instead of
 *    closing, so it is recoverable *if* there is scroll room below; on the last row there is none.
 *  - `RerunMenu` — `position: absolute; right: 0` at `minWidth: 272`. On a FAILED run the extra
 *    "Resume" button wraps the action row, leaving the anchor short of the right edge, and the menu
 *    grew leftwards to **left: −121**. `styles/global.css` clamps the root with
 *    `overflow-x: hidden`, so that 121px is not scrollable-to; it is gone. Every item lost its left
 *    third, including the "v4 / latest / this run" labels that say which version you are re-running.
 *
 * "Off the bottom" and "off the left" are not cramped-target problems, which is why three sweeps of
 * #511 missed them: nothing was overlapping and nothing was 30px. The control simply was not there.
 *
 * ## Why pure functions
 *
 * `apps/web`'s vitest environment is `node`, so a component cannot be rendered and measured in a
 * unit test (see `test/settings-touch-targets.spec.ts`, which resorts to scanning source). Geometry
 * extracted to a pure function CAN be tested directly, at every edge — short viewport, tall menu,
 * anchor at the top, anchor at the bottom — instead of being asserted about in a comment.
 */

/** The parts of a DOMRect placement needs. Matches DOMRect structurally. */
export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface PlacementOptions {
  /** Minimum clearance kept from every viewport edge. */
  gutter?: number;
  /** Space between the anchor and the popover. */
  offset?: number;
}

export interface FixedPlacement {
  /** `position: fixed` coordinates, both guaranteed >= gutter. */
  top: number;
  left: number;
  /** Cap so a popover taller than the room available scrolls internally instead of overflowing. */
  maxHeight: number;
  /** Cap for a popover wider than the viewport (a phone with a 272px-wide menu). */
  maxWidth: number;
  /** Which side of the anchor it ended up on — for the caller's arrow/animation, and for tests. */
  side: "below" | "above";
}

const DEFAULTS = { gutter: 8, offset: 4 };

/**
 * Place a `position: fixed` popover of `size` against `anchor`, inside `vp`.
 *
 * Preference order: below the anchor → above it → whichever side has more room, capped. The result
 * is always fully inside the viewport, because a fixed popover the page cannot scroll to is
 * equivalent to one that never opened.
 */
export function placeFixedPopover(
  anchor: Box,
  size: { width: number; height: number },
  vp: Viewport,
  options: PlacementOptions = {},
): FixedPlacement {
  const gutter = options.gutter ?? DEFAULTS.gutter;
  const offset = options.offset ?? DEFAULTS.offset;

  const roomBelow = vp.height - gutter - (anchor.bottom + offset);
  const roomAbove = anchor.top - offset - gutter;

  let side: "below" | "above";
  if (size.height <= roomBelow) side = "below";
  else if (size.height <= roomAbove) side = "above";
  // Neither side fits the menu whole: take the roomier one and let it scroll internally. Below is
  // preferred on a tie so the menu keeps its usual direction.
  else side = roomAbove > roomBelow ? "above" : "below";

  const room = side === "below" ? roomBelow : roomAbove;
  const maxHeight = Math.max(0, room);
  const height = Math.min(size.height, maxHeight);

  const top =
    side === "below"
      ? // Clamped even when it fits: an anchor already below the fold (a row scrolled past) would
        // otherwise place the menu off the bottom too.
        clamp(
          anchor.bottom + offset,
          gutter,
          Math.max(gutter, vp.height - gutter - height),
        )
      : clamp(
          anchor.top - offset - height,
          gutter,
          Math.max(gutter, vp.height - gutter - height),
        );

  const maxWidth = Math.max(0, vp.width - gutter * 2);
  const width = Math.min(size.width, maxWidth);
  // Right-aligned to the anchor (the established look), then clamped to both edges.
  const left = clamp(
    anchor.right - width,
    gutter,
    Math.max(gutter, vp.width - gutter - width),
  );

  return { top, left, maxHeight, maxWidth, side };
}

/**
 * How far to shift an ALREADY-LAID-OUT in-flow popover horizontally so it stops crossing a viewport
 * edge. Returns px to add to `translateX` — positive to move right, negative to move left, 0 when
 * it is already inside.
 *
 * Used where converting to `position: fixed` would be a downgrade: `RerunMenu` sits in a scrolling
 * list, and an in-flow popover tracks its row for free, where a fixed one would need a scroll
 * listener (and closing on scroll is the very bug being fixed one file over).
 *
 * The left edge wins if the popover is wider than the viewport: reading starts there.
 */
export function shiftIntoView(
  box: { left: number; right: number },
  vp: { width: number },
  options: PlacementOptions = {},
): number {
  const gutter = options.gutter ?? DEFAULTS.gutter;
  const overLeft = gutter - box.left;
  if (overLeft > 0) return Math.round(overLeft);
  const overRight = box.right - (vp.width - gutter);
  if (overRight > 0) return -Math.round(overRight);
  return 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * The size a popover WANTS, ignoring any `max-height`/`max-width` a previous placement imposed.
 *
 * The one DOM-touching function here, and it exists to break a feedback loop: `KebabMenu`
 * re-places on every scroll, and `offsetHeight` reports the already-CLAMPED height. Feeding that
 * back in makes "does it fit below?" answer yes on the second pass purely because pass one had
 * shrunk it — the menu would flip sides while you scrolled. `scrollHeight` is the content height and
 * is unaffected by the cap; the `offset* - client*` term adds the borders it omits.
 *
 * Two limits to know before widening a menu into them:
 *
 *  - `scrollHeight` is immune to `max-height` but NOT to `max-width`. If the width cap ever bit, the
 *    text would wrap, the measured height would inflate, and the flip could oscillate. It cannot bite
 *    today: both menus set `min-width` (150 / 170) far below the 374px cap a 390px viewport gives.
 *  - `offset* - client*` is borders PLUS any classic scrollbar, so on a platform that reserves
 *    scrollbar space a capped, scrolling menu measures ~15px wider than it wants, and `KebabMenu`'s
 *    re-place can nudge `left` once by that much. Cosmetic and one-shot; zero with overlay scrollbars.
 */
export function naturalSize(el: HTMLElement): {
  width: number;
  height: number;
} {
  return {
    width: el.scrollWidth + (el.offsetWidth - el.clientWidth),
    height: el.scrollHeight + (el.offsetHeight - el.clientHeight),
  };
}

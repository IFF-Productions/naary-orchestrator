/**
 * The canvas AI drawer's resize arithmetic (#1090).
 *
 * apps/web's vitest environment is `node` — no jsdom, so nothing here renders the hook or dispatches
 * a pointer event (same constraint canvas-top-bar-responsive.spec.ts works under). What it pins is
 * the part that is pure and the part that is easy to get backwards: the SIGN of a drag, which
 * differs between the desktop drawer and the phone sheet, and the clamping that keeps the pane from
 * eating the canvas it exists to reveal.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampSize,
  readStoredSize,
  resizeFrom,
} from "../src/screens/canvas/useResizablePane";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resizeFrom", () => {
  const bounds = { min: 320, max: 700 };

  it("a left-docked drawer grows when the handle is dragged RIGHT", () => {
    // Handle on the pane's end (right edge) → sign +1.
    expect(
      resizeFrom({
        startSize: 400,
        startPos: 400,
        pos: 460,
        sign: 1,
        ...bounds,
      }),
    ).toBe(460);
    expect(
      resizeFrom({
        startSize: 400,
        startPos: 400,
        pos: 340,
        sign: 1,
        ...bounds,
      }),
    ).toBe(340);
  });

  it("a bottom sheet grows when the handle is dragged UP — the opposite sign", () => {
    // Handle on the pane's start (top edge) and y grows DOWNWARD, so dragging to a smaller
    // clientY must make the sheet taller. Getting this backwards is invisible in a type check and
    // obvious the instant anyone touches it.
    expect(
      resizeFrom({
        startSize: 400,
        startPos: 500,
        pos: 400,
        sign: -1,
        min: 220,
        max: 800,
      }),
    ).toBe(500);
    expect(
      resizeFrom({
        startSize: 400,
        startPos: 500,
        pos: 600,
        sign: -1,
        min: 220,
        max: 800,
      }),
    ).toBe(300);
  });

  it("clamps at both ends, so a drag past the edge parks rather than inverting", () => {
    expect(
      resizeFrom({ startSize: 400, startPos: 400, pos: 0, sign: 1, ...bounds }),
    ).toBe(320);
    expect(
      resizeFrom({
        startSize: 400,
        startPos: 400,
        pos: 5000,
        sign: 1,
        ...bounds,
      }),
    ).toBe(700);
  });

  it("measures from the START of the drag, not the previous event", () => {
    // Two moves from one origin: the second is absolute, so a dropped/coalesced event in between
    // cannot leave the pane drifting behind the cursor.
    const first = resizeFrom({
      startSize: 400,
      startPos: 400,
      pos: 450,
      sign: 1,
      ...bounds,
    });
    const second = resizeFrom({
      startSize: 400,
      startPos: 400,
      pos: 500,
      sign: 1,
      ...bounds,
    });
    expect(first).toBe(450);
    expect(second).toBe(500);
  });
});

describe("clampSize", () => {
  it("re-reads a lazily-computed max, so a shrinking window re-bounds the pane", () => {
    let viewport = 1600;
    const max = () => Math.round(viewport * 0.55);
    expect(clampSize(700, 320, max)).toBe(700);
    viewport = 900; // the user resized the browser
    expect(clampSize(700, 320, max)).toBe(495);
  });

  it("the MINIMUM wins a crossed pair — a tiny viewport leaves a usable pane, not a sliver", () => {
    // max < min happens on a very narrow window. Clamping high-then-low would collapse the pane to
    // the max and make the panel unreadable; the floor is the one that has to hold.
    expect(clampSize(400, 320, 200)).toBe(320);
  });
});

describe("readStoredSize", () => {
  it("answers null when storage throws — Safari private mode must not fail the render", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem() {
          throw new Error("SecurityError");
        },
      },
    });
    expect(readStoredSize("k")).toBeNull();
  });

  it("answers null for junk rather than NaN, which would propagate into a style", () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: () => "not-a-number" },
    });
    expect(readStoredSize("k")).toBeNull();
  });

  it("reads a stored number back", () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => "512" } });
    expect(readStoredSize("k")).toBe(512);
  });

  it("survives having no window at all", () => {
    // The spec's own environment: `node`. The hook falls back to its default rather than throwing
    // during a render.
    expect(readStoredSize("k")).toBeNull();
  });
});

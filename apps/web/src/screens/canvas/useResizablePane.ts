/**
 * A pane the user can drag to resize, with the size remembered between visits.
 *
 * Written for the canvas's AI drawer, but deliberately knows nothing about it: a size, a drag
 * handle, and a `localStorage` key. Anything else on the canvas that wants a draggable edge (the
 * inspector dock is the obvious next one) can take this rather than growing a second
 * pointer-capture implementation with its own off-by-one bugs.
 *
 * WHY POINTER CAPTURE AND NOT WINDOW LISTENERS. The handle sits directly against React Flow, which
 * has its own pointer handlers for panning. Without `setPointerCapture` the first pixel that
 * crosses the boundary hands the drag to the canvas — the pane stops following the cursor and the
 * graph pans instead. Capture keeps every move event on the handle until the pointer is released,
 * so the drag is unaffected by whatever it is dragged over.
 *
 * KEYBOARD IS NOT OPTIONAL. A drag handle reachable only by pointer means the pane's size is not
 * adjustable at all for someone using a keyboard, and this pane can cover most of the canvas. It is
 * a `separator` with `aria-valuenow`, arrow keys, and Home/End — the ARIA window-splitter pattern,
 * which is what this is.
 */
import { useCallback, useRef, useState } from "react";

/** Arrow-key step, and the coarse step for shift+arrow. */
const STEP = 16;
const STEP_COARSE = 64;

export interface ResizablePaneOptions {
  /** `localStorage` key the size persists under. Namespaced by the caller. */
  storageKey: string;
  /** Which dimension the pane owns: `x` = width, `y` = height. */
  axis: "x" | "y";
  /**
   * Where the handle sits relative to the pane, which is what decides the drag's SIGN.
   *
   * `end` — the handle is on the pane's right/bottom edge, so moving away from the pane's origin
   * grows it (a left-docked drawer).
   * `start` — the handle is on the pane's left/top edge, so the pane grows towards the origin (a
   * bottom sheet, dragged upward).
   */
  edge: "start" | "end";
  /** Size before the user has ever dragged, and what a double-click restores. */
  initial: number;
  min: number;
  /** Upper bound. A function is re-read on every clamp, for viewport-relative caps. */
  max: number | (() => number);
  /** Accessible name for the separator (e.g. "Resize the AI panel"). */
  label: string;
  /**
   * The drag ENDED (or a keyboard adjustment landed) at this size.
   *
   * Deliberately not fired per move: the canvas's reaction to a new width is a `fitView`, and one
   * of those per pointer event would be an animation fighting the drag.
   */
  onCommit?: (size: number) => void;
}

export interface ResizablePane {
  /** The current size, already clamped to [min, max]. */
  size: number;
  /** True while a drag is in flight — for a hover/active style, and to suppress transitions. */
  dragging: boolean;
  /** Restore `initial` (double-click, and the Home/End keys' sibling). */
  reset: () => void;
  /** Spread onto the handle element. Includes the ARIA separator role and its value. */
  separatorProps: {
    role: "separator";
    tabIndex: 0;
    "aria-orientation": "vertical" | "horizontal";
    "aria-label": string;
    "aria-valuenow": number;
    "aria-valuemin": number;
    "aria-valuemax": number;
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
    onDoubleClick: () => void;
    style: React.CSSProperties;
  };
}

/** Read the remembered size. Storage can throw (Safari private mode) or hold junk — either way the
 *  pane opens at its default rather than failing to render. */
export function readStoredSize(storageKey: string): number | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeStoredSize(storageKey: string, size: number): void {
  try {
    window.localStorage.setItem(storageKey, String(Math.round(size)));
  } catch {
    /* private mode / quota — the size is still live for this session */
  }
}

/**
 * The size a drag has reached, measured from where it STARTED.
 *
 * Pure, and exported, because it is the whole arithmetic of a resize and apps/web's vitest
 * environment is `node` — no jsdom, so a spec cannot render the hook and drag it. Everything a
 * test needs to pin (the sign flip between a left-docked drawer and a bottom sheet, clamping at
 * both ends) lives here rather than inside an event handler it cannot reach.
 *
 * Measured from the start rather than accumulated per move on purpose: pointer events are coalesced
 * and occasionally dropped, and an accumulating version drifts away from the cursor over a long
 * drag with no way to recover.
 */
export function resizeFrom(args: {
  /** Size when the pointer went down. */
  startSize: number;
  /** Pointer coordinate (clientX or clientY) when it went down. */
  startPos: number;
  /** Pointer coordinate now. */
  pos: number;
  /** +1 when moving away from the origin grows the pane, -1 when it shrinks it. */
  sign: 1 | -1;
  min: number;
  max: number | (() => number);
}): number {
  const { startSize, startPos, pos, sign, min, max } = args;
  return clampSize(startSize + sign * (pos - startPos), min, max);
}

/** Clamp into [min, max], resolving a lazily-computed max. */
export function clampSize(
  size: number,
  min: number,
  max: number | (() => number),
): number {
  const hi = typeof max === "function" ? max() : max;
  // `min` wins a crossed pair: a viewport smaller than the minimum must still leave the pane
  // usable, and Math.min-then-max in the other order would collapse it to zero-ish.
  return Math.max(min, Math.min(hi, size));
}

export function useResizablePane(opts: ResizablePaneOptions): ResizablePane {
  const { storageKey, axis, edge, initial, min, max, label, onCommit } = opts;
  // Read storage ONCE, lazily — not on every render, and not in an effect that would show the
  // default for a frame and then jump.
  const [raw, setRaw] = useState<number>(
    () => readStoredSize(storageKey) ?? initial,
  );
  const [dragging, setDragging] = useState(false);
  /** Where the drag started, and the size at that moment. Deltas are measured from the START, not
   *  accumulated per move — accumulating drifts when a move event is dropped. */
  const origin = useRef<{ pos: number; size: number } | null>(null);

  const size = clampSize(raw, min, max);
  const sign = edge === "end" ? 1 : -1;

  const apply = useCallback(
    (next: number) => {
      const clamped = clampSize(next, min, max);
      setRaw(clamped);
      return clamped;
    },
    [min, max],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      // Primary button / touch only — a right-click on the handle must not start a drag.
      if (e.button !== 0) return;
      e.preventDefault();
      origin.current = {
        pos: axis === "x" ? e.clientX : e.clientY,
        size,
      };
      setDragging(true);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [axis, size],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const start = origin.current;
      if (!start) return;
      setRaw(
        resizeFrom({
          startSize: start.size,
          startPos: start.pos,
          pos: axis === "x" ? e.clientX : e.clientY,
          sign,
          min,
          max,
        }),
      );
    },
    [axis, sign, min, max],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!origin.current) return;
      origin.current = null;
      setDragging(false);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* capture already lost (element unmounted mid-drag) */
      }
      // Persist on RELEASE, not per move: a drag is ~100 pointer events and each one would be a
      // synchronous localStorage write.
      const settled = clampSize(size, min, max);
      writeStoredSize(storageKey, settled);
      onCommit?.(settled);
    },
    [size, min, max, storageKey, onCommit],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      const grow = axis === "x" ? "ArrowRight" : "ArrowDown";
      const shrink = axis === "x" ? "ArrowLeft" : "ArrowUp";
      let next: number | null = null;
      const step = e.shiftKey ? STEP_COARSE : STEP;
      if (e.key === grow) next = size + sign * step;
      else if (e.key === shrink) next = size - sign * step;
      else if (e.key === "Home") next = min;
      else if (e.key === "End") next = typeof max === "function" ? max() : max;
      if (next === null) return;
      e.preventDefault();
      const settled = apply(next);
      writeStoredSize(storageKey, settled);
      onCommit?.(settled);
    },
    [apply, axis, sign, size, min, max, storageKey, onCommit],
  );

  const reset = useCallback(() => {
    const settled = apply(initial);
    writeStoredSize(storageKey, settled);
    onCommit?.(settled);
  }, [apply, initial, storageKey, onCommit]);

  return {
    size,
    dragging,
    reset,
    separatorProps: {
      role: "separator",
      tabIndex: 0,
      // A separator between two panes side by side is a VERTICAL divider, even though the drag
      // moves horizontally — the ARIA orientation describes the separator, not the motion.
      "aria-orientation": axis === "x" ? "vertical" : "horizontal",
      "aria-label": label,
      "aria-valuenow": Math.round(size),
      "aria-valuemin": min,
      // Floored at `min` for the same reason `clampSize` lets the minimum win a crossed pair: on a
      // viewport narrow enough that the cap falls below the floor, the raw max would publish
      // valuemin > valuemax, which is invalid and leaves a screen reader announcing a range that
      // cannot contain the current value.
      "aria-valuemax": Math.max(
        min,
        Math.round(typeof max === "function" ? max() : max),
      ),
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onKeyDown,
      onDoubleClick: reset,
      style: {
        cursor: axis === "x" ? "col-resize" : "row-resize",
        // Without this a touch drag scrolls the page instead of resizing the pane.
        touchAction: "none",
        // The handle is the only thing being dragged; selecting text while resizing is never
        // what was meant.
        userSelect: "none",
      },
    },
  };
}

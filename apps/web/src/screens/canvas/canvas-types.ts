// Client-side authoring state types + layout constant for the canvas editor
// (extracted verbatim from CanvasPage).

/** Client-side record of a single-node test run (the EXISTING test machinery's result
 *  + a measured wall-clock). `stale` marks outputs invalidated by later edits. */
export interface NodeTestRun {
  status: "running" | "done" | "error";
  output?: unknown;
  message?: string;
  /** Measured wall-clock of the test call (real, client-side). */
  ms?: number;
  stale?: boolean;
  /** Client timestamp the test started — the dock's live elapsed readout. */
  startedAt?: number;
}

/** Bottom-right toast (offset left of the dock so it never hides under it). */
export interface CanvasToast {
  id: number;
  text: string;
  meta?: string;
  tone: "ok" | "warn";
}

/** Breakpoint where the docked 492px inspector overlays instead of squeezing the canvas. */
export const NARROW_QUERY = "(max-width: 1080px)";

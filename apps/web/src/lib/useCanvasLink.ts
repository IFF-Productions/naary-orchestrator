/**
 * Build a canvas URL that remembers the screen the user is leaving, so the canvas's back
 * control returns THERE instead of dumping them on the Overview.
 *
 *   const canvasLink = useCanvasLink();
 *   navigate(canvasLink(`/app/canvas?key=${encodeURIComponent(key)}`));
 *
 * Kept apart from lib/canvas-return.ts so that module stays pure (and unit-testable without
 * a router). Callers that don't use this still work — the canvas falls back to /app, which is
 * the behaviour every entry point had before.
 */
import { useLocation } from "react-router-dom";
import { canvasTo } from "./canvas-return";

export function useCanvasLink(): (to: string) => string {
  const location = useLocation();
  // Include the search string: returning to "/app/runs?status=failed" should keep the filter.
  const from = `${location.pathname}${location.search}`;
  return (to: string) => canvasTo(to, from);
}

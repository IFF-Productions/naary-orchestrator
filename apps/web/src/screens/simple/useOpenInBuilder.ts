/**
 * "Open in Builder" — the one door out of Simple mode.
 *
 * IT WAS A DEAD END. Every call site navigated to `/app/canvas?key=…`, and `RequireBuilder`
 * immediately sent Simple users back to `/app/automations`. So the button appeared to do nothing
 * except return you to the list you came from — reported exactly that way. The guard is right to
 * exist (a Simple user shouldn't reach the canvas by typing a URL); what was missing is that this
 * button is not a stray URL, it is a deliberate request to leave Simple mode.
 *
 * So it SWITCHES THE MODE, then navigates. That is what the label promises and what Settings
 * already tells people: "open it in Builder anytime to grow up." Switching is the feature, not a
 * side effect.
 *
 * Deliberately not asking first. `setMode` is reversible from the same control that set it
 * (Settings → Experience, and the mode toggle), the destination makes the change self-evident,
 * and a confirm dialog on "show me the advanced editor" would be a speed bump on the one path
 * we want people to find. A prompt would be right if this destroyed something; it doesn't.
 *
 * Ordering matters: set the mode BEFORE navigating. `RequireBuilder` reads `useMode()` during the
 * render triggered by that navigation, so switching afterwards would still bounce once and land
 * the user on the list — the same bug, harder to see.
 */
import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useCanvasLink } from "../../lib/useCanvasLink";
import { useMode } from "../../mode";

export function useOpenInBuilder(): (workflowKey?: string) => void {
  const navigate = useNavigate();
  const canvasLink = useCanvasLink();
  const { setMode } = useMode();

  return useCallback(
    (workflowKey?: string) => {
      setMode("builder");
      const key = workflowKey?.trim();
      navigate(
        canvasLink(
          key ? `/app/canvas?key=${encodeURIComponent(key)}` : "/app/canvas",
        ),
      );
    },
    [navigate, canvasLink, setMode],
  );
}

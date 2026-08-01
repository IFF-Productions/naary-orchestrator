/**
 * The ONE rotator for the playful "we're working on it" copy.
 *
 * `progress-messages.ts` owns the list and the no-repeat pick; this owns the ~2.5s timer that
 * drives it. Kept out of that file deliberately — its docblock advertises purity and its spec
 * (test/progress-messages.spec.ts) depends on it, so React does not belong there.
 *
 * There is one home for this because there were three surfaces wanting it and, for a while, two
 * byte-identical copies of the effect (the canvas hook and Simple mode's generate screen). That is
 * the shape of the drift bug this repo keeps re-landing (#982, #984, #1005): the list gets a new
 * line in one place and the others quietly keep the old one. Anything that needs rotating status
 * copy calls this — it must never grow a second implementation.
 */
import { useEffect, useState } from "react";
import { nextProgressMessage, PROGRESS_MESSAGES } from "./progress-messages";

/**
 * The current status line, rotating every ~2.5s while `active`.
 *
 * The timer only exists while `active` is true: it is cleared when the work resolves (the effect
 * re-runs with `active` false) and on unmount, so it can never tick against a gone component.
 * Returns a stable first line while inactive, so a caller may render it without a null check.
 */
export function useRotatingProgressMessage(active: boolean): string {
  const [message, setMessage] = useState<string>(PROGRESS_MESSAGES[0]);

  useEffect(() => {
    if (!active) return;
    // Move off the last turn's line immediately, so the same string isn't sitting there from
    // whenever the previous piece of work stopped.
    setMessage((prev) => nextProgressMessage(prev));
    const id = setInterval(
      () => setMessage((prev) => nextProgressMessage(prev)),
      2500,
    );
    return () => clearInterval(id);
  }, [active]);

  return message;
}

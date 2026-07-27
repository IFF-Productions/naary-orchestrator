// "Resume from failed node" on the run detail (docs/design/RESUME-FROM-FAILED-NODE.md §6).
//
// Sits beside Re-run and is the answer to a specific problem with it: a re-run replays the flow from
// its trigger, so any side effect an earlier node already had (an email sent, a row written) happens
// AGAIN. This restarts at the node that failed using the run's saved state, so nothing upstream
// executes twice.
//
// Eligibility is fetched up front rather than discovered on click: most failed runs are NOT
// resumable (a per-item region, a loop node, a real parallel fan-out, no snapshot), and a button
// that only tells you on click is the same trap as a retry checkbox that isn't wired.
import { useEffect, useState } from "react";
import { Button } from "../../../components";
import { api } from "../../../lib/api";
import {
  type ResumeEligibility,
  resumeButtonState,
} from "./resume-state";

export function ResumeButton({
  runId,
  onResumed,
  onError,
}: {
  runId: string;
  onResumed: (newRunId: string) => void;
  onError?: (message: string) => void;
}) {
  // undefined = loading, null = the check itself failed (see resumeButtonState).
  const [eligibility, setEligibility] = useState<
    ResumeEligibility | null | undefined
  >(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setEligibility(undefined);
    api
      .resumeEligibility(runId)
      .then(
        (e) => !cancelled && setEligibility(e),
        () => !cancelled && setEligibility(null),
      );
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const state = resumeButtonState(eligibility, busy);

  async function go(): Promise<void> {
    // The failing node may already have taken effect; the API refuses without the acknowledgement,
    // so ask here rather than letting that 400 surface as an error.
    if (state.needsConfirm && !window.confirm(state.confirmText ?? "")) return;
    setBusy(true);
    try {
      const { workflowId } = await api.resume(runId, {
        ...(state.needsConfirm ? { acknowledgeSideEffects: true } : {}),
      });
      onResumed(workflowId);
    } catch (e) {
      onError?.(e instanceof Error ? e.message : "Could not resume this run.");
    } finally {
      setBusy(false);
    }
  }

  if (!state.visible) return null;
  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={state.disabled}
      title={state.title}
      onClick={() => void go()}
    >
      Resume from failed node
    </Button>
  );
}

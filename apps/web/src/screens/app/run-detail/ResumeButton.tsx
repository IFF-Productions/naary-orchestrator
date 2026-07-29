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
import { Button, useConfirm } from "../../../components";
import { api } from "../../../lib/api";
import { type ResumeEligibility, resumeButtonState } from "./resume-state";

export function ResumeButton({
  runId,
  onResumed,
  onError,
  stacked = false,
}: {
  runId: string;
  onResumed: (newRunId: string) => void;
  onError?: (message: string) => void;
  /** Narrow layout — the sibling actions take a 44px min-height there for a real touch
   *  target, and this button sitting between them has to do the same or the row is ragged. */
  stacked?: boolean;
}) {
  // undefined = loading, null = the check itself failed (see resumeButtonState).
  const [eligibility, setEligibility] = useState<
    ResumeEligibility | null | undefined
  >(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setEligibility(undefined);
    api.resumeEligibility(runId).then(
      (e) => !cancelled && setEligibility(e),
      () => !cancelled && setEligibility(null),
    );
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const state = resumeButtonState(eligibility, busy);
  const confirm = useConfirm();

  async function go(): Promise<void> {
    // The failing node may already have taken effect; the API refuses without the acknowledgement,
    // so ask here rather than letting that 400 surface as an error.
    //
    // Our dialog, not window.confirm: the browser's is unstyled, unbrandable, names the ORIGIN
    // rather than the action, and — the reason it matters here — offers only "OK"/"Cancel". This
    // question is "a node may already have taken effect; run it again anyway?", and "OK" is a
    // terrible label for a button that can re-send a real side effect.
    if (
      state.needsConfirm &&
      !(await confirm({
        title: "Resume from the failed node?",
        body: state.confirmBody,
        confirmLabel: "Resume anyway",
        danger: true,
      }))
    ) {
      return;
    }
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
      // "md" to match Cancel run / Re-run beside it — this sat a size smaller and broke the row.
      size="md"
      variant="secondary"
      disabled={state.disabled}
      title={state.title}
      onClick={() => void go()}
      style={stacked ? { minHeight: 44 } : undefined}
    >
      Resume from failed node
    </Button>
  );
}

/**
 * "Check flow" (#832) — the canvas half of the dry run.
 *
 * Asked for as: "try a dry run without destructive changes, maybe provide user an option to do
 * that?" The option is this button; the point is that a flow's problems stop being discoverable
 * only by running it, one failure per run.
 *
 * IT NEEDS A SAVED GRAPH: the endpoint checks the SAVED workflow, so checking with unsaved edits
 * on the canvas would report a verdict about a version that is not the one on screen — the single
 * most confusing thing this feature could do. This hook does not decide what to do about that.
 * The injected `save` does, and on the canvas it ASKS the user (the canvas never auto-saves) and
 * resolves null when they decline — so a "no" here is simply "no check", not a failure.
 */
import { useCallback, useState } from "react";
import { api } from "../../lib/api";
import { summarizeDryRun, type DryRunSummary } from "../../lib/dry-run-issues";

export function useDryRun({
  save,
  onOpenIssues,
}: {
  /**
   * Resolves the key the dry run should check: persisting the canvas first if it has to (and if
   * the user agrees to that). Null when there is nothing to check against — a failed save, or a
   * user who declined to save — in which case it has already explained why.
   */
  save: () => Promise<string | null>;
  onOpenIssues: () => void;
}) {
  const [checking, setChecking] = useState(false);
  const [summary, setSummary] = useState<DryRunSummary | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const key = await save();
      // No key ⇒ nothing to check: the save failed, or the user declined to save. Either way it
      // has already said so on the status line; a second message here would just be noise.
      if (!key) return;
      const result = await api.dryRunGraph(key);
      const next = summarizeDryRun(result);
      setSummary(next);
      // Open the panel unconditionally — including on a clean result. The user pressed a button
      // and is owed an answer; silence on success reads as "nothing happened" (the same mistake
      // that hid the generator's issues until #831).
      onOpenIssues();
    } catch (e) {
      setSummary({
        // NOT ok: the check did not run. Without this the pill reads "✓ checked" on a failed
        // check, because there are zero issues to count — a green tick for an answer we never got.
        ok: false,
        issues: [],
        probed: 0,
        unprobeable: 0,
        message:
          e instanceof Error
            ? `The check itself failed: ${e.message}`
            : "The check itself failed.",
      });
      onOpenIssues();
    } finally {
      setChecking(false);
    }
  }, [save, onOpenIssues]);

  /** Drop a stale verdict — the graph changed, so the previous answer is about a different flow. */
  const clear = useCallback(() => setSummary(null), []);

  return { checking, summary, check, clear };
}

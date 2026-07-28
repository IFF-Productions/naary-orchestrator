/**
 * The decisions behind ./WorkflowSelect, split out so they're testable — apps/web has no
 * React test renderer, so anything that could be *wrong* rather than merely ugly lives here.
 *
 * The one that matters: a `workflowKey` the list doesn't contain must stay visible and stay set.
 * It happens routinely — a key from another environment, a workflow deleted since, or one typed
 * before it was saved — and a <select> that silently drops an unrecognised value would rewrite the
 * node's target to "" the moment someone opened the panel to look at it.
 */

/** Sentinel option value meaning "let me type a key" — never a real workflow key. */
export const MANUAL_OPTION = "__manual__";

export interface WorkflowSelectView {
  /**
   * The current key isn't among the listed workflows, so the control must render an extra
   * option carrying it — otherwise the <select> has no option matching its own value, and the
   * browser displays the FIRST option ("Select a workflow…"), which reads as "nothing is set"
   * for a node that is in fact targeting something.
   */
  unknownValue: boolean;
  /** Copy for the empty option. */
  placeholder: string;
}

export function workflowSelectView(
  value: string,
  workflows: readonly { workflowKey: string }[],
): WorkflowSelectView {
  return {
    unknownValue:
      Boolean(value) && !workflows.some((w) => w.workflowKey === value),
    placeholder: workflows.length
      ? "Select a workflow…"
      : "No other workflows saved yet",
  };
}

/**
 * What picking an option means.
 *
 * The manual sentinel switches the control into text entry — it must NEVER be handed to the
 * caller as a key, or `__manual__` would be written into the graph as a real (and permanently
 * unresolvable) sub-workflow target.
 */
export function workflowSelectChoice(
  option: string,
): { key: string } | { manual: true } {
  return option === MANUAL_OPTION ? { manual: true } : { key: option };
}

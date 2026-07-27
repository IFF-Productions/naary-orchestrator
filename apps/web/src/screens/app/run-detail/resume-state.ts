// Pure view logic for the "Resume from failed node" action, kept out of the component so the
// copy and the enable/disable rules are unit-tested (node-env suite) rather than only ever seen
// on a failed run. See docs/design/RESUME-FROM-FAILED-NODE.md §6.

/** The eligibility shape the API returns (mirrors ResumeEligibilityResponse). */
export interface ResumeEligibility {
  resumable: boolean;
  reason?: string;
  detail?: string;
  warnings?: string[];
  failedNodeId?: string;
  warningText?: string;
}

export interface ResumeButtonState {
  /** Render the action at all? Hidden for non-failed runs, which have nothing to resume. */
  visible: boolean;
  disabled: boolean;
  /** Hover text — always the REASON when disabled, never a bare "unavailable". */
  title: string;
  /** Ask for confirmation first: the failing node may already have taken effect. */
  needsConfirm: boolean;
  /** Shown in the confirm prompt. */
  confirmText?: string;
}

const LOADING: ResumeButtonState = {
  visible: true,
  disabled: true,
  title: "Checking whether this run can be resumed…",
  needsConfirm: false,
};

/**
 * `eligibility === undefined` = still loading; `null` = the check itself failed.
 *
 * A failed check disables rather than hides: the run IS failed, so silently dropping the action
 * would look like the feature doesn't exist rather than like a request that didn't land.
 */
export function resumeButtonState(
  eligibility: ResumeEligibility | null | undefined,
  busy = false,
): ResumeButtonState {
  if (eligibility === undefined) return LOADING;
  if (eligibility === null) {
    return {
      visible: true,
      disabled: true,
      title: "Couldn't check whether this run can be resumed. Reload to try again.",
      needsConfirm: false,
    };
  }
  if (busy) {
    return {
      visible: true,
      disabled: true,
      title: "Resuming…",
      needsConfirm: false,
    };
  }
  if (!eligibility.resumable) {
    return {
      visible: true,
      disabled: true,
      // The API's `detail` is written for a user and is always preferred; `reason` is the
      // machine-readable fallback so a new refusal added server-side still says something.
      title:
        eligibility.detail ??
        `This run can't be resumed${eligibility.reason ? ` (${eligibility.reason})` : ""}.`,
      needsConfirm: false,
    };
  }
  const needsConfirm = (eligibility.warnings ?? []).includes(
    "at_most_once_node",
  );
  return {
    visible: true,
    disabled: false,
    title: needsConfirm
      ? (eligibility.warningText ??
        "The failing node may already have taken effect.")
      : `Re-runs from "${eligibility.failedNodeId ?? "the failed node"}" using this run's saved state — nothing earlier runs again.`,
    needsConfirm,
    ...(needsConfirm
      ? {
          confirmText:
            (eligibility.warningText ??
              "The failing node may already have taken effect.") +
            "\n\nResume anyway?",
        }
      : {}),
  };
}

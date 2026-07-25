/**
 * Live "N approvals waiting" count for the shell (context-bar pill + nav badges).
 * One poll per shell instance — consumers receive the count via props, so the
 * endpoint isn't hit once per badge. Re-resolves on workspace/env switch.
 *
 * The count itself lives in the shared api-layer store (lib/api/approvals-count),
 * so deciding an approval on ANY screen updates these badges immediately instead
 * of leaving them stale until the next poll (or a page reload). This hook owns the
 * FETCHING (auth/workspace/env scoped); the store owns the derivation.
 */
import { useEffect, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import {
  approvalsCountSnapshot,
  reconcileAwaitingApprovals,
  resetApprovalsCount,
  subscribeApprovalsCount,
  subscribeApprovalsRevalidate,
} from "../lib/api/approvals-count";
import { useActiveEnvironment } from "../lib/useActiveEnvironment";
import { useWorkspace } from "../workspace/WorkspaceProvider";

const POLL_MS = 45_000;

export function useApprovalsCount(): number {
  const { activeId } = useWorkspace();
  const activeEnv = useActiveEnvironment();
  const count = useSyncExternalStore(
    subscribeApprovalsCount,
    approvalsCountSnapshot,
    () => 0, // SSR/first snapshot
  );

  useEffect(() => {
    // Awaiting ids are scoped to one workspace+environment — never carry them (or
    // an optimistic mask) across a switch.
    resetApprovalsCount();
    if (!activeId) return;
    let live = true;
    const load = () =>
      api
        .listAwaitingApprovals()
        .then((list) => {
          // Only a SUCCESSFUL fetch reconciles; a transient failure keeps the last count.
          if (live) reconcileAwaitingApprovals(list.map((x) => x.workflowId));
        })
        .catch(() => {
          /* transient — keep the last count */
        });
    void load();
    const timer = setInterval(load, POLL_MS);
    // A decision anywhere in the app (single or batch) → refetch now rather than
    // waiting out the poll. The store has already masked the decided ids, so the
    // badge has moved by the time this round-trip lands; this call is what makes
    // the number authoritative again (and catches decisions made in another tab).
    const stopRevalidate = subscribeApprovalsRevalidate(() => void load());
    return () => {
      live = false;
      clearInterval(timer);
      stopRevalidate();
    };
  }, [activeId, activeEnv]);

  return count;
}

/**
 * Live "N approvals waiting" count for the shell (context-bar pill + nav badges).
 * One poll per shell instance — consumers receive the count via props, so the
 * endpoint isn't hit once per badge. Re-resolves on workspace/env switch.
 */
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useActiveEnvironment } from "../lib/useActiveEnvironment";
import { useWorkspace } from "../workspace/WorkspaceProvider";

const POLL_MS = 45_000;

export function useApprovalsCount(): number {
  const { activeId } = useWorkspace();
  const activeEnv = useActiveEnvironment();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!activeId) return;
    let live = true;
    const load = () =>
      api
        .listAwaitingApprovals()
        .then((list) => {
          if (live) setCount(list.length);
        })
        .catch(() => {
          /* transient — keep the last count */
        });
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [activeId, activeEnv]);

  return count;
}

/**
 * The shell's approvals-count store (src/lib/api/approvals-count.ts) — the seam that
 * makes the nav-rail badges + context-bar pill update right after a decision instead
 * of staying stale until the next 45s poll.
 *
 * These assert the CORRECTNESS constraints, not just the happy path: a batch where
 * some ids slip, a decision that failed, a server that hasn't processed the Temporal
 * signal yet, and a workspace switch must all leave the RIGHT number.
 *
 * Note on scope: apps/web's vitest environment is `node` (no jsdom / testing-library
 * in the repo), and the typed api client's baseUrl is the relative "/api", which
 * node's Request constructor rejects — so neither the React hook nor a real
 * `api.approve()` round-trip is unit-testable here. The store is the whole of the
 * decision logic; the hook around it is a useSyncExternalStore + fetch wrapper.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  approvalsCountSnapshot,
  decidedApprovalIdsForTest,
  markApprovalsDecided,
  reconcileAwaitingApprovals,
  resetApprovalsCount,
  subscribeApprovalsCount,
  subscribeApprovalsRevalidate,
} from "../src/lib/api/approvals-count";

beforeEach(() => {
  resetApprovalsCount();
});

describe("approvals count — server truth", () => {
  it("reports the size of the fetched awaiting list", () => {
    reconcileAwaitingApprovals(["a", "b", "c"]);
    expect(approvalsCountSnapshot()).toBe(3);
    reconcileAwaitingApprovals(["a"]);
    expect(approvalsCountSnapshot()).toBe(1);
    reconcileAwaitingApprovals([]);
    expect(approvalsCountSnapshot()).toBe(0);
  });

  it("notifies subscribers only when the derived count actually changes", () => {
    const onChange = vi.fn();
    const off = subscribeApprovalsCount(onChange);
    reconcileAwaitingApprovals(["a", "b"]);
    expect(onChange).toHaveBeenCalledTimes(1);
    // Same count, different-but-equal list → no spurious re-render.
    reconcileAwaitingApprovals(["a", "b"]);
    expect(onChange).toHaveBeenCalledTimes(1);
    reconcileAwaitingApprovals(["a"]);
    expect(onChange).toHaveBeenCalledTimes(2);
    off();
    reconcileAwaitingApprovals([]);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe("single decision", () => {
  it("decrements the count immediately (before any refetch lands)", () => {
    reconcileAwaitingApprovals(["a", "b", "c"]);
    markApprovalsDecided(["a"]);
    expect(approvalsCountSnapshot()).toBe(2);
  });

  it("asks the shell to revalidate", () => {
    const revalidate = vi.fn();
    const off = subscribeApprovalsRevalidate(revalidate);
    reconcileAwaitingApprovals(["a"]);
    expect(revalidate).not.toHaveBeenCalled(); // a fetch is not a decision
    markApprovalsDecided(["a"]);
    expect(revalidate).toHaveBeenCalledTimes(1);
    off();
  });

  it("does NOT move the count when the decision failed (409 / network error)", () => {
    const revalidate = vi.fn();
    const off = subscribeApprovalsRevalidate(revalidate);
    reconcileAwaitingApprovals(["a", "b", "c"]);
    // api.approve's catch path marks nothing but still requests a revalidate.
    markApprovalsDecided([]);
    expect(approvalsCountSnapshot()).toBe(3);
    expect(decidedApprovalIdsForTest()).toEqual([]);
    expect(revalidate).toHaveBeenCalledTimes(1);
    off();
  });
});

describe("batch decision", () => {
  it("counts only the runs the server confirmed — ids that slipped stay counted", () => {
    reconcileAwaitingApprovals(["a", "b", "c", "d"]);
    // approveBatch(["a","b","c"]) where "c" was already decided elsewhere (ok:false).
    markApprovalsDecided(["a", "b"]);
    expect(approvalsCountSnapshot()).toBe(2); // c + d
  });

  it("a batch where every id slipped leaves the count untouched", () => {
    reconcileAwaitingApprovals(["a", "b"]);
    markApprovalsDecided([]);
    expect(approvalsCountSnapshot()).toBe(2);
  });

  it("never double-counts a repeated id", () => {
    reconcileAwaitingApprovals(["a", "b"]);
    markApprovalsDecided(["a"]);
    markApprovalsDecided(["a"]);
    expect(approvalsCountSnapshot()).toBe(1);
  });
});

describe("reconciling the optimistic mask with the server", () => {
  it("holds the mask while the server still lists a just-decided run (signal race)", () => {
    reconcileAwaitingApprovals(["a", "b"]);
    markApprovalsDecided(["a"]);
    expect(approvalsCountSnapshot()).toBe(1);
    // The immediate refetch can still see "a": approve is a fire-and-forget Temporal
    // signal, so the workflow may not have processed it yet. The badge must not bounce.
    reconcileAwaitingApprovals(["a", "b"]);
    expect(approvalsCountSnapshot()).toBe(1);
    expect(decidedApprovalIdsForTest()).toEqual(["a"]);
  });

  it("forgets the mask once the server stops listing the run", () => {
    reconcileAwaitingApprovals(["a", "b"]);
    markApprovalsDecided(["a"]);
    reconcileAwaitingApprovals(["b"]); // server caught up
    expect(approvalsCountSnapshot()).toBe(1);
    expect(decidedApprovalIdsForTest()).toEqual([]);
    // Proof the mask is really gone: were "a" to legitimately await again, it counts.
    reconcileAwaitingApprovals(["a", "b"]);
    expect(approvalsCountSnapshot()).toBe(2);
  });

  it("picks up approvals decided in another tab (the list simply shrinks)", () => {
    reconcileAwaitingApprovals(["a", "b", "c"]);
    reconcileAwaitingApprovals(["c"]);
    expect(approvalsCountSnapshot()).toBe(1);
  });

  it("keeps the last count when a fetch fails (the hook never reconciles on error)", () => {
    reconcileAwaitingApprovals(["a", "b", "c"]);
    markApprovalsDecided(["a"]);
    expect(approvalsCountSnapshot()).toBe(2);
    // No reconcile call happens on a failed fetch — the count holds, mask intact.
    expect(decidedApprovalIdsForTest()).toEqual(["a"]);
    expect(approvalsCountSnapshot()).toBe(2);
  });
});

describe("workspace / environment switch", () => {
  it("drops the list and the mask so ids cannot leak across scopes", () => {
    reconcileAwaitingApprovals(["a", "b"]);
    markApprovalsDecided(["a"]);
    resetApprovalsCount();
    expect(approvalsCountSnapshot()).toBe(0);
    expect(decidedApprovalIdsForTest()).toEqual([]);
    // A same-named id in the new scope is counted, not masked away.
    reconcileAwaitingApprovals(["a"]);
    expect(approvalsCountSnapshot()).toBe(1);
  });

  it("a switch landing MID-DECISION still converges on the new scope's truth", () => {
    // The nasty interleaving: a batch decision is masked, its revalidate fetch is still
    // in flight, and the user switches environment. The hook resets (wiping the mask and
    // the old scope's list) and then immediately issues its own load() for the new scope
    // — so the badge must land on the new scope's real count, not 0 and not the old one.
    reconcileAwaitingApprovals(["a", "b", "c"]);
    markApprovalsDecided(["a", "b"]);
    expect(approvalsCountSnapshot()).toBe(1);
    resetApprovalsCount(); // effect re-run on the env change
    expect(approvalsCountSnapshot()).toBe(0); // honest blank, not another env's number
    reconcileAwaitingApprovals(["x", "y"]); // the new effect's immediate load()
    expect(approvalsCountSnapshot()).toBe(2);
    // The stale in-flight fetch from the OLD scope is gated by the hook's `live` flag and
    // never reconciles — but even if it did, it must not resurrect the dropped mask.
    expect(decidedApprovalIdsForTest()).toEqual([]);
  });
});

// "Clear all" on the notifications bell must never become a mute switch.
//
// The bell has no server-side inbox: `NotificationsBell.tsx` re-derives its list every 45s from
// the awaiting-approvals query and the recent-runs query. So clearing can only mean "remember the
// ids I have already seen and filter them out" — and the moment that memory is anything coarser
// than a per-id set (a timestamp watermark, a "hide everything" flag), a user who clears once
// stops being told about the next failed run. That is a silent, indefinite loss of the one signal
// this component exists to give.
//
// These tests pin the user-visible contract:
//   · a cleared item stays cleared across polls;
//   · a NEW approval / a NEW failure still appears after Clear all;
//   · clearing in one workspace does not clear another's;
//   · the stored set is pruned so it cannot grow forever — but NOT on a fetch that failed, since
//     "the query errored" is not the same fact as "the item is gone";
//   · the panel can still say how many cleared items are genuinely still open.
import { beforeEach, describe, expect, it } from "vitest";
import {
  type DismissalStore,
  NO_TRUST,
  approvalKey,
  dismissAll,
  dismissedKey,
  readDismissed,
  reconcileDismissed,
  reconcilePoll,
  runKey,
  sameIds,
  sourceOf,
  writeDismissed,
} from "../src/app/notifications-dismissed";

/** An in-memory stand-in for localStorage (apps/web's vitest environment is node — there isn't one). */
function fakeStore(): DismissalStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/** A store that throws on every operation — private mode, sandboxed iframe, storage disabled. */
const hostileStore: DismissalStore = {
  getItem() {
    throw new Error("SecurityError");
  },
  setItem() {
    throw new Error("SecurityError");
  },
  removeItem() {
    throw new Error("SecurityError");
  },
};

const ALL_READ = { approvals: true, runs: true };

/** The shape the bell reconciles: an id plus whatever it renders. */
const approval = (wf: string, node: string) => ({ key: approvalKey(wf, node) });
const failure = (wf: string) => ({ key: runKey(wf) });

let store: ReturnType<typeof fakeStore>;
beforeEach(() => {
  store = fakeStore();
});

describe("Clear all — what it hides, and what it must not", () => {
  it("hides exactly the items that were cleared, and keeps hiding them on later polls", () => {
    const items = [approval("run-1", "gate"), failure("run-2")];
    const dismissed = dismissAll([], [items[0].key, items[1].key]);
    writeDismissed(store, "ws-a", dismissed);

    // The next poll returns the same two items (the approval is still pending, the run still failed).
    const after = reconcileDismissed(
      items,
      readDismissed(store, "ws-a"),
      ALL_READ,
    );
    expect(after.visible).toEqual([]);
    // And the poll after that, from storage again — this is the "it stuck" property.
    const later = reconcileDismissed(
      items,
      readDismissed(store, "ws-a"),
      ALL_READ,
    );
    expect(later.visible).toEqual([]);
  });

  it("STILL SHOWS a new approval and a new failed run after Clear all", () => {
    // The whole correctness requirement. Dismissal is per id, so anything with an id nobody has
    // dismissed gets through — however recently the user hit Clear all.
    const seen = [approval("run-1", "gate"), failure("run-2")];
    writeDismissed(
      store,
      "ws-a",
      dismissAll(
        [],
        seen.map((i) => i.key),
      ),
    );

    const nextPoll = [
      ...seen,
      approval("run-9", "gate"), // a different run reached its approval node
      approval("run-1", "second-gate"), // the SAME run, a different node, waiting now
      failure("run-77"), // a brand-new failure
    ];
    const { visible } = reconcileDismissed(
      nextPoll,
      readDismissed(store, "ws-a"),
      ALL_READ,
    );
    expect(visible.map((i) => i.key)).toEqual([
      approvalKey("run-9", "gate"),
      approvalKey("run-1", "second-gate"),
      runKey("run-77"),
    ]);
  });

  it("reconciles against every fetched item, not just the ones on screen", () => {
    // The panel caps at 8 rows. If dismissals were reconciled against that slice, every cleared id
    // outside the window would be pruned as "gone" and pop back as the window moved.
    const many = Array.from({ length: 30 }, (_, i) => failure(`run-${i}`));
    const dismissed = dismissAll(
      [],
      many.map((i) => i.key),
    );
    const { visible, persist } = reconcileDismissed(many, dismissed, ALL_READ);
    expect(visible).toEqual([]);
    expect(persist).toHaveLength(30);
  });
});

describe("a poll landing AFTER Clear all must not undo it", () => {
  // Clearing can only dismiss what the app has already seen — the last COMPLETED poll's ids. The
  // 45s poll (and the refetch on open) means a fetch is often already in flight when the button is
  // clicked, and that fetch can carry an item the previous poll did not have. Rendering it a
  // heartbeat after the click is indistinguishable from "Clear all didn't work".
  it("does not resurrect cleared items, nor surface ones fetched before the click", () => {
    const seen = [approval("run-1", "gate"), failure("run-2")];
    // A poll is in flight; it has already fetched a third item the user has never seen.
    const inFlight = [...seen, approval("run-3", "gate")];

    // The user clicks Clear all — which can only know about `seen`.
    writeDismissed(
      store,
      "ws-a",
      dismissAll(
        [],
        seen.map((i) => i.key),
      ),
    );

    // …then the in-flight poll resolves. Everything it fetched existed at the moment of the click.
    const landed = reconcilePoll(
      inFlight,
      readDismissed(store, "ws-a"),
      ALL_READ,
      true,
    );
    expect(landed.visible).toEqual([]);
    // …and the widened clear is persisted, so the next poll doesn't show them either.
    writeDismissed(store, "ws-a", landed.persist);
    expect(
      reconcilePoll(inFlight, readDismissed(store, "ws-a"), ALL_READ, false)
        .visible,
    ).toEqual([]);
  });

  it("still shows what arrives after the click — this is not a mute window", () => {
    // The bound that keeps the widened clear honest: only a poll ALREADY IN FLIGHT at the moment
    // of the click is covered. The next poll starts afterwards, so its new items get through.
    const seen = [approval("run-1", "gate")];
    writeDismissed(
      store,
      "ws-a",
      dismissAll(
        [],
        seen.map((i) => i.key),
      ),
    );
    const nextPoll = [...seen, failure("run-99")];

    const { visible } = reconcilePoll(
      nextPoll,
      readDismissed(store, "ws-a"),
      ALL_READ,
      false,
    );
    expect(visible.map((i) => i.key)).toEqual([runKey("run-99")]);
  });
});

describe("per-workspace keying", () => {
  it("clearing in one workspace leaves another workspace's bell alone", () => {
    // The bell's data is workspace-scoped (X-Workspace-Id), so a shared bucket would hide a
    // colleague-facing approval in a workspace the user never even opened.
    const item = approval("run-1", "gate");
    writeDismissed(store, "ws-a", [item.key]);

    expect(
      reconcileDismissed([item], readDismissed(store, "ws-a"), ALL_READ)
        .visible,
    ).toEqual([]);
    expect(
      reconcileDismissed([item], readDismissed(store, "ws-b"), ALL_READ)
        .visible,
    ).toEqual([item]);
  });

  it("gives 'no workspace resolved yet' its own bucket rather than borrowing one", () => {
    expect(dismissedKey(null)).not.toBe(dismissedKey("ws-a"));
    writeDismissed(store, null, ["ap-x-y"]);
    expect(readDismissed(store, "ws-a")).toEqual([]);
    expect(readDismissed(store, null)).toEqual(["ap-x-y"]);
  });
});

describe("pruning — bounded storage, without resurrecting cleared items", () => {
  it("drops ids the server no longer reports, so the set cannot grow forever", () => {
    const stored = [
      approvalKey("run-1", "gate"), // approved since — no longer awaiting
      runKey("run-2"), // aged out of the recent-runs window
      runKey("run-3"), // still there
    ];
    const { persist } = reconcileDismissed(
      [failure("run-3")],
      stored,
      ALL_READ,
    );
    expect(persist).toEqual([runKey("run-3")]);
  });

  it("lets a genuinely recurring item speak again once it has been pruned", () => {
    // Same workflow, a NEW approval later. It was pruned when it went away, so nothing stale
    // suppresses it — the reason pruning is a correctness rule and not just housekeeping.
    const id = approvalKey("run-1", "gate");
    const { persist } = reconcileDismissed([], [id], ALL_READ);
    expect(persist).toEqual([]);
    expect(
      reconcileDismissed([{ key: id }], persist, ALL_READ).visible,
    ).toEqual([{ key: id }]);
  });

  it("does NOT prune a source whose fetch FAILED — an error is not an absence", () => {
    // Each of the bell's two queries degrades to "no data" independently. Treating that as "the
    // server says these are gone" would drop the dismissals and resurrect every cleared item of
    // that kind on the next successful poll: intermittent, silent, and exactly the bug the button
    // is supposed to prevent.
    const stored = [approvalKey("run-1", "gate"), runKey("run-2")];

    // Approvals query errored; runs query answered and no longer lists run-2.
    const approvalsDown = reconcileDismissed([], stored, {
      approvals: false,
      runs: true,
    });
    expect(approvalsDown.persist).toEqual([approvalKey("run-1", "gate")]);

    // Runs query errored; approvals answered and no longer lists the gate.
    const runsDown = reconcileDismissed([], stored, {
      approvals: true,
      runs: false,
    });
    expect(runsDown.persist).toEqual([runKey("run-2")]);

    // Both down (offline) — nothing is pruned at all.
    expect(reconcileDismissed([], stored, NO_TRUST).persist).toEqual(stored);
  });

  it("keeps an id it cannot classify until both sources have been read", () => {
    // An id written by a different build. With a complete picture it is stale; without one,
    // dropping it would be guessing.
    const alien = "legacy-42";
    expect(sourceOf(alien)).toBeNull();
    expect(reconcileDismissed([], [alien], NO_TRUST).persist).toEqual([alien]);
    expect(reconcileDismissed([], [alien], ALL_READ).persist).toEqual([]);
  });
});

describe("the panel stays honest about what it hid", () => {
  it("counts cleared items that are still live, so 0 unread never means 'nothing is happening'", () => {
    // A cleared approval is still a pending obligation; the Approvals inbox remains the record.
    const items = [approval("run-1", "gate"), failure("run-2")];
    const stored = dismissAll(
      [],
      items.map((i) => i.key),
    );
    const { visible, liveHiddenCount } = reconcileDismissed(
      items,
      stored,
      ALL_READ,
    );
    expect(visible).toEqual([]);
    expect(liveHiddenCount).toBe(2);
  });

  it("counts only what it can actually see — a failed fetch claims nothing", () => {
    const stored = [approvalKey("run-1", "gate")];
    expect(reconcileDismissed([], stored, NO_TRUST).liveHiddenCount).toBe(0);
  });
});

describe("storage handling — a preference must never break the bell", () => {
  it("treats unreadable storage as 'nothing dismissed' instead of throwing", () => {
    expect(readDismissed(null, "ws-a")).toEqual([]);
    expect(readDismissed(hostileStore, "ws-a")).toEqual([]);
    expect(() =>
      writeDismissed(hostileStore, "ws-a", ["ap-x-y"]),
    ).not.toThrow();
    expect(() => writeDismissed(null, "ws-a", ["ap-x-y"])).not.toThrow();
  });

  it("ignores malformed or non-string entries", () => {
    store.map.set(dismissedKey("ws-a"), "not json");
    expect(readDismissed(store, "ws-a")).toEqual([]);
    store.map.set(dismissedKey("ws-a"), JSON.stringify({ ids: ["a"] }));
    expect(readDismissed(store, "ws-a")).toEqual([]);
    store.map.set(
      dismissedKey("ws-a"),
      JSON.stringify(["a", 7, null, "", "a", "b"]),
    );
    expect(readDismissed(store, "ws-a")).toEqual(["a", "b"]);
  });

  it("removes the key once nothing is dismissed, leaving no residue", () => {
    writeDismissed(store, "ws-a", ["ap-x-y"]);
    expect(store.map.has(dismissedKey("ws-a"))).toBe(true);
    writeDismissed(store, "ws-a", []);
    expect(store.map.has(dismissedKey("ws-a"))).toBe(false);
  });

  it("dismissAll is idempotent, so re-clearing does not duplicate ids", () => {
    const first = dismissAll([], ["a", "b"]);
    expect(dismissAll(first, ["b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("sameIds tells the caller when a rewrite is unnecessary", () => {
    // The poll only writes when the set actually changed — otherwise it would touch storage
    // every 45 seconds forever.
    expect(sameIds(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameIds(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameIds(["a"], ["a", "b"])).toBe(false);
  });
});

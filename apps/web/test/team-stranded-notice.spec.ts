import { describe, expect, it } from "vitest";
import type { StrandedApprovals } from "../src/lib/api/types";
import { strandedNotice } from "../src/screens/app/team/model";

/**
 * #1053 — the Team screen's post-removal banner, tested as the pure derivation it is
 * (apps/web vitest runs `environment: "node"` — no DOM here by design).
 *
 * The behaviour under test is a product decision, not a formatting one: removing a member
 * never auto-decides the gates they were the approver on, so the screen has to say what is
 * now stuck and who can unstick it. The interesting cases are the ones where it must STAY
 * QUIET, because a banner that fires on every removal is one nobody reads.
 */
const held = (over: Partial<StrandedApprovals> = {}): StrandedApprovals => ({
  total: 0,
  needsOwnerOrAdmin: 0,
  partial: false,
  runs: [],
  ...over,
});

describe("strandedNotice", () => {
  it("says nothing when the removal stranded nothing", () => {
    expect(strandedNotice(held(), "Kim Ray")).toBeNull();
  });

  it("says nothing when they were listed but a live approver remains", () => {
    // The asymmetry that matters: a group-routed gate resolves membership LIVE, so it is
    // decidable while anyone else is in the group. Leading with `total` here would fire the
    // banner on nearly every removal in a group-routed workspace.
    expect(strandedNotice(held({ total: 4 }), "Kim Ray")).toBeNull();
  });

  it("names the count and the resolution when gates have nobody left", () => {
    const n = strandedNotice(
      held({ total: 3, needsOwnerOrAdmin: 2 }),
      "Kim Ray",
    );
    expect(n?.tone).toBe("warn");
    expect(n?.text).toContain("Kim Ray");
    expect(n?.text).toContain("2 paused runs");
    expect(n?.text).toContain("owner or admin");
    // The decision, stated on the screen: nothing was decided on the departed user's behalf.
    expect(n?.text).toContain("nothing was auto-approved or auto-rejected");
  });

  it("singularises one run", () => {
    const n = strandedNotice(
      held({ total: 1, needsOwnerOrAdmin: 1 }),
      "Kim Ray",
    );
    expect(n?.text).toContain("1 paused run.");
    expect(n?.text).not.toContain("1 paused runs");
  });

  it("a partial count is stated as a LOWER BOUND, never as exact", () => {
    const n = strandedNotice(
      held({ total: 9, needsOwnerOrAdmin: 9, partial: true }),
      "Kim Ray",
    );
    expect(n?.text).toContain("at least 9 paused runs");
  });

  it("partial with nothing found says 'couldn't check', not 'nothing stranded'", () => {
    // A lookup that failed must not be reported as a clean removal — that is the one
    // answer worse than saying nothing.
    const n = strandedNotice(held({ partial: true }), "Kim Ray");
    expect(n?.tone).toBe("info");
    expect(n?.text).toContain("couldn't finish checking");
  });
});

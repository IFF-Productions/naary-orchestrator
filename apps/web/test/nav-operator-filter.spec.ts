import { describe, expect, it } from "vitest";
import {
  BUILDER_MODES,
  operatorFilteredModes,
  SIMPLE_MODES,
} from "../src/app/nav-model";

/**
 * Operator-only nav items (the Workers fleet view).
 *
 * Workers is INFRA telemetry spanning every tenant — hostnames, PIDs, worker versions, live slot usage
 * — so it's shown only to a platform operator (`/me.isOperator`, the PLATFORM_OPERATORS allowlist).
 * Hiding it is presentation; the endpoint re-checks server-side. But offering a link that 403s is its
 * own kind of broken, hence the filter.
 */
const itemPaths = (modes: ReturnType<typeof operatorFilteredModes>) =>
  modes.flatMap((m) => m.items.map((i) => i.to));

describe("non-operators", () => {
  it("does not see Workers in the builder nav", () => {
    expect(
      itemPaths(operatorFilteredModes(BUILDER_MODES, false)),
    ).not.toContain("/app/workers");
  });

  /** Everything else must survive — a filter that quietly drops other items would be worse than none. */
  it("keeps every non-operator item", () => {
    const before = itemPaths(BUILDER_MODES).filter((p) => p !== "/app/workers");
    expect(itemPaths(operatorFilteredModes(BUILDER_MODES, false))).toEqual(
      before,
    );
  });

  it("keeps the mode structure intact (labels, order, ids)", () => {
    const filtered = operatorFilteredModes(BUILDER_MODES, false);
    expect(filtered.map((m) => m.id)).toEqual(BUILDER_MODES.map((m) => m.id));
  });

  /** Simple mode never had Workers, so filtering must be a no-op there. */
  it("leaves the simple nav untouched", () => {
    expect(operatorFilteredModes(SIMPLE_MODES, false)).toEqual(SIMPLE_MODES);
  });
});

describe("operators", () => {
  it("see Workers", () => {
    expect(itemPaths(operatorFilteredModes(BUILDER_MODES, true))).toContain(
      "/app/workers",
    );
  });

  /** Returns the input unchanged — no copying, so nothing can drift for the operator case. */
  it("get the nav back identically", () => {
    expect(operatorFilteredModes(BUILDER_MODES, true)).toBe(BUILDER_MODES);
  });
});

describe("empty sections", () => {
  /** A mode left with no items is dropped: an empty section in the rail reads as broken, not as empty. */
  it("drops a mode whose only item was operator-only", () => {
    const modes = [
      {
        id: "infra",
        label: "Infra",
        icon: "grid" as const,
        color: "var(--mode-admin)",
        tagline: "fleet",
        items: [
          {
            to: "/app/workers",
            label: "Workers",
            icon: "grid" as const,
            operatorOnly: true,
          },
        ],
      },
    ];
    expect(operatorFilteredModes(modes, false)).toEqual([]);
    expect(operatorFilteredModes(modes, true)).toBe(modes);
  });
});

describe("the marking itself", () => {
  /**
   * Pins WHICH items are operator-only. If a future infra screen is added to the nav without the flag,
   * this fails and asks the question — better than shipping a tenant-visible fleet view again.
   */
  it("marks exactly the Workers item", () => {
    const flagged = BUILDER_MODES.flatMap((m) =>
      m.items.filter((i) => i.operatorOnly).map((i) => i.to),
    );
    expect(flagged).toEqual(["/app/workers"]);
  });
});

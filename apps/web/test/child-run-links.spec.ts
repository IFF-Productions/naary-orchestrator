/**
 * Parent → child run links on a Run Detail step (#960).
 *
 * The link is only as good as the id it points at, so the invariants here are all about NOT
 * offering one: a run recorded before the worker returned `childRunId` must show no link at all
 * (a dead `/app/runs/undefined` would be a worse regression than the missing link this fixes),
 * and a `childRunId` on a node that never spawned a child is data, not a run we own.
 */
import { describe, expect, it } from "vitest";
import {
  childRunLinks,
  MAX_CHILD_RUN_LINKS,
} from "../src/screens/app/run-detail/ChildRunLinks";

describe("childRunLinks — executeSubWorkflow", () => {
  it("offers the child run the worker named", () => {
    expect(
      childRunLinks(
        { status: "completed", output: { a: 1 }, childRunId: "run-1-sub-s-3" },
        "executeSubWorkflow",
      ),
    ).toEqual([
      { childRunId: "run-1-sub-s-3", status: "completed", label: "Child run" },
    ]);
  });

  it("offers NOTHING for a run recorded before childRunId existed", () => {
    // The degradation case. Historical runs have only {status, output} — no link, no empty
    // section, and above all no link to an undefined id.
    expect(
      childRunLinks(
        { status: "completed", output: { a: 1 } },
        "executeSubWorkflow",
      ),
    ).toEqual([]);
    // …same for a step that hasn't produced an output at all.
    expect(childRunLinks(undefined, "executeSubWorkflow")).toEqual([]);
  });
});

describe("childRunLinks — forEach", () => {
  const entries = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      status: "completed",
      output: {},
      childRunId: `p-foreach-loop-1-${i}`,
    }));

  it("offers one link per item, labelled and ordered by item", () => {
    const links = childRunLinks(entries(3), "forEach");
    expect(links.map((l) => l.label)).toEqual(["Item 1", "Item 2", "Item 3"]);
    expect(links.map((l) => l.childRunId)).toEqual([
      "p-foreach-loop-1-0",
      "p-foreach-loop-1-1",
      "p-foreach-loop-1-2",
    ]);
  });

  it("keeps the FAILED item's link — that's the run the user is chasing", () => {
    const links = childRunLinks(
      [{ status: "failed", output: {}, childRunId: "p-foreach-loop-1-0" }],
      "forEach",
    );
    expect(links).toEqual([
      { childRunId: "p-foreach-loop-1-0", status: "failed", label: "Item 1" },
    ]);
  });

  it("drops only the entries that carry no id (partial/old data), keeping their neighbours", () => {
    const links = childRunLinks(
      [
        { status: "completed", output: {} }, // pre-#960 shape
        { status: "failed", output: {}, childRunId: "p-foreach-loop-1-1" },
      ],
      "forEach",
    );
    expect(links).toHaveLength(1);
    expect(links[0].childRunId).toBe("p-foreach-loop-1-1");
    // Labels are item ORDINALS, so a dropped row must not renumber the ones that remain.
    expect(links[0].label).toBe("Item 2");
  });

  it("still enumerates every child past the render cap (the component collapses the tail)", () => {
    // forEach fans out to hundreds; the cap is a RENDER decision, so the model keeps the
    // full list and the component reports "+N more" from it.
    const links = childRunLinks(entries(MAX_CHILD_RUN_LINKS + 12), "forEach");
    expect(links).toHaveLength(MAX_CHILD_RUN_LINKS + 12);
    expect(links.length).toBeGreaterThan(MAX_CHILD_RUN_LINKS);
  });

  it("offers nothing for an empty or non-array forEach output", () => {
    expect(childRunLinks([], "forEach")).toEqual([]);
    expect(childRunLinks({ childRunId: "x" }, "forEach")).toEqual([]);
  });
});

describe("childRunLinks — the nodeType gate", () => {
  it("does NOT link a childRunId that belongs to some other node's data", () => {
    // An httpRequest whose response body happens to carry that key is not a run we own;
    // linking it would send the user to a 404 dressed up as a child run.
    const body = { status: 200, childRunId: "not-a-run" };
    expect(childRunLinks(body, "httpRequest")).toEqual([]);
    expect(childRunLinks(body, undefined)).toEqual([]);
  });
});

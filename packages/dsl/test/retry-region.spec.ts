// Retry regions: what may be repeated, and what must be refused at save.
//
// The refusal is the whole safety story. A retry region repeats everything inside it, so a
// `sendEmail` in there sends twice and an integration WRITE performs twice — neither is
// recoverable. `RETRYABLE_NODE_KINDS` already drew this line for per-node retry ("whose retry
// would risk a double-effect"); these tests hold the region to the same line and prove the two
// cannot drift apart.
import { describe, expect, it } from "vitest";
import {
  computeRetryRegions,
  retryBackoffMs,
  unsafeNodeReason,
} from "../src/retry-region";
import { RETRYABLE_NODE_KINDS } from "../src/types/core";
import { isPureNode } from "../src/pure-node";
import { NODE_TYPES } from "../src/node-catalog";
import type { GraphDef, NodeDef, NodeType } from "../src/types";

const node = (id: string, type: string, config?: NodeDef["config"]): NodeDef =>
  ({ id, type, config }) as NodeDef;

/** trigger → retry → [body…] → retryEnd → end */
function graphWith(body: NodeDef[], retryConfig?: NodeDef["config"]): GraphDef {
  const ids = ["r", ...body.map((b) => b.id), "rend"];
  return {
    startNodeId: "trigger",
    nodes: [
      node("trigger", "webhookTrigger"),
      node("r", "retry", retryConfig),
      ...body,
      node("rend", "retryEnd"),
      node("end", "end"),
    ],
    edges: [
      { from: "trigger", to: "r" },
      ...ids.slice(0, -1).map((from, i) => ({ from, to: ids[i + 1] })),
      { from: "rend", to: "end" },
    ],
  } as GraphDef;
}

describe("computeRetryRegions — the shape", () => {
  it("brackets the nodes between retry and retryEnd", () => {
    const res = computeRetryRegions(
      graphWith([node("fetch", "httpRequest"), node("parse", "json")]),
    );
    expect(res.error).toBeUndefined();
    expect(res.regions).toHaveLength(1);
    expect(res.regions[0]).toMatchObject({
      retryId: "r",
      retryEndId: "rend",
      regionNodeIds: ["fetch", "parse"],
    });
  });

  it("applies the documented defaults when nothing is configured", () => {
    const res = computeRetryRegions(graphWith([node("fetch", "httpRequest")]));
    expect(res.regions[0].policy).toEqual({
      maxAttempts: 3,
      initialIntervalSeconds: 1,
      backoffCoefficient: 2,
    });
  });

  it("clamps a runaway maxAttempts", () => {
    // A typo'd 100000 would park a run on a durable timer for months.
    const res = computeRetryRegions(
      graphWith([node("fetch", "httpRequest")], { maxAttempts: 100_000 }),
    );
    expect(res.regions[0].policy.maxAttempts).toBe(25);
  });

  it("rejects an unclosed region", () => {
    const g: GraphDef = {
      startNodeId: "trigger",
      nodes: [
        node("trigger", "webhookTrigger"),
        node("r", "retry"),
        node("fetch", "httpRequest"),
        node("end", "end"),
      ],
      edges: [
        { from: "trigger", to: "r" },
        { from: "r", to: "fetch" },
        { from: "fetch", to: "end" },
      ],
    } as GraphDef;
    expect(computeRetryRegions(g).error).toMatch(/no matching retryEnd/);
  });

  it("rejects a retryEnd nobody opened", () => {
    // It would silently do nothing at run time, which is worse than a save error.
    const g: GraphDef = {
      startNodeId: "trigger",
      nodes: [
        node("trigger", "webhookTrigger"),
        node("rend", "retryEnd"),
        node("end", "end"),
      ],
      edges: [
        { from: "trigger", to: "rend" },
        { from: "rend", to: "end" },
      ],
    } as GraphDef;
    expect(computeRetryRegions(g).error).toMatch(/no matching retry/);
  });

  it("rejects nesting", () => {
    const res = computeRetryRegions(
      graphWith([node("inner", "retry"), node("fetch", "httpRequest")]),
    );
    expect(res.error).toMatch(/nested retry/);
  });

  it("rejects a conditional edge out of the retry node", () => {
    // An attempt could otherwise skip the very nodes it is meant to repeat.
    const g = graphWith([node("fetch", "httpRequest")]);
    g.edges = g.edges.map((e) =>
      e.from === "r"
        ? { ...e, condition: { path: "x.y", op: "eq" as const, value: true } }
        : e,
    );
    expect(computeRetryRegions(g).error).toMatch(/unconditional/);
  });
});

describe("computeRetryRegions — what must be REFUSED, by name", () => {
  // Each of these performs an effect that a second attempt would repeat, and none is recoverable.
  const unsafe: [string, NodeDef][] = [
    ["sendEmail", node("notify-ops", "sendEmail")],
    ["sqlExec", node("write-row", "sqlExec")],
    ["code", node("run-js", "code")],
    ["codeAgent", node("claude", "codeAgent")],
  ];

  for (const [label, n] of unsafe) {
    it(`refuses ${label}, and names the node`, () => {
      const res = computeRetryRegions(graphWith([n]));
      expect(res.error).toContain(n.id);
      expect(res.error).toMatch(/can't be safely repeated/);
    });
  }

  it("refuses an integration WRITE but allows a READ", () => {
    // The one type that can't be judged by kind alone — `isIntegrationWriteAction` already makes
    // this distinction for the interpreter's at-most-once handling.
    const write = computeRetryRegions(
      graphWith([
        node("create", "integration", {
          provider: "github",
          action: "create_issue",
        }),
      ]),
    );
    expect(write.error).toContain("create");
    expect(write.error).toMatch(/WRITES/);

    const read = computeRetryRegions(
      graphWith([
        node("list", "integration", {
          provider: "github",
          action: "list_issues",
        }),
      ]),
    );
    expect(read.error).toBeUndefined();
  });

  it("refuses an UNCONFIGURED integration — with its OWN reason, not the write one", () => {
    // Fail closed: we can't prove it's a read. But the first version reported it as a node that
    // "WRITES (undefined/undefined)", which is inaccurate and tells the author to move a node when
    // what they need to do is finish configuring it. Review caught the wording.
    const res = computeRetryRegions(graphWith([node("todo", "integration")]));
    expect(res.error).toContain("todo");
    expect(res.error).toMatch(/no provider\/action set/);
    expect(res.error).not.toMatch(/WRITES/);
    expect(res.error).not.toContain("undefined");
  });

  it("refuses a CONDITIONAL edge inside the region", () => {
    // The interpreter walks the region's precomputed node list linearly and never evaluates
    // conditions inside it — so a conditional edge here would be silently IGNORED. A graph that
    // says "only continue if X" and then continues regardless is worse than one that won't save.
    const g = graphWith([
      node("fetch", "httpRequest"),
      node("parse", "json"),
    ]);
    g.edges = g.edges.map((e) =>
      e.from === "fetch"
        ? { ...e, condition: { path: "fetch.status", op: "eq" as const, value: 200 } }
        : e,
    );
    const res = computeRetryRegions(g);
    expect(res.error).toContain("fetch");
    expect(res.error).toMatch(/not evaluated/);
  });

  it("refuses a durable/control node with a reason of its own", () => {
    for (const t of [
      "humanApproval",
      "wait",
      "executeSubWorkflow",
      "forEach",
    ]) {
      const res = computeRetryRegions(graphWith([node(`n-${t}`, t)]));
      expect(res.error, t).toContain(`n-${t}`);
      expect(res.error, t).toMatch(/can't be repeated/);
    }
  });
});

// ── The drift guard ───────────────────────────────────────────────────────────────────────────
//
// The region's allow-list is DERIVED from `RETRYABLE_NODE_KINDS` rather than restated. If someone
// teaches one of them about a new node kind and not the other, the two features would disagree
// about what is safe to run twice — with the per-node policy permitting what the region refuses,
// or worse, the reverse.
describe("drift: the region agrees with RETRYABLE_NODE_KINDS", () => {
  it("allows every retryable kind", () => {
    for (const t of RETRYABLE_NODE_KINDS) {
      expect(unsafeNodeReason(node("n", t)), t).toBeUndefined();
    }
  });

  it("allows exactly: retryable kinds, pure nodes, noOp, and integration reads", () => {
    for (const t of NODE_TYPES as readonly NodeType[]) {
      // Bracket + terminal types are structural, never region BODY nodes — the walk handles them.
      if (t === "retry" || t === "retryEnd") continue;
      const expectedAllowed =
        (RETRYABLE_NODE_KINDS as readonly string[]).includes(t) ||
        isPureNode(t) ||
        t === "noOp";
      // `integration` is the deliberate exception: allowed or not per its ACTION, so it is
      // asserted by the read/write test above rather than by kind here.
      if (t === "integration") continue;
      expect(
        unsafeNodeReason(node("n", t)) === undefined,
        `${t} should be ${expectedAllowed ? "allowed" : "refused"}`,
      ).toBe(expectedAllowed);
    }
  });
});

describe("retryBackoffMs", () => {
  const policy = {
    maxAttempts: 5,
    initialIntervalSeconds: 1,
    backoffCoefficient: 2,
  };

  it("does not wait before the first attempt", () => {
    expect(retryBackoffMs(policy, 1)).toBe(0);
  });

  it("grows exponentially from the initial interval", () => {
    expect(retryBackoffMs(policy, 2)).toBe(1_000);
    expect(retryBackoffMs(policy, 3)).toBe(2_000);
    expect(retryBackoffMs(policy, 4)).toBe(4_000);
  });

  it("respects the cap", () => {
    expect(retryBackoffMs({ ...policy, maxIntervalSeconds: 3 }, 4)).toBe(3_000);
  });

  it("handles a coefficient of 1 as a fixed delay", () => {
    expect(retryBackoffMs({ ...policy, backoffCoefficient: 1 }, 4)).toBe(1_000);
  });
});

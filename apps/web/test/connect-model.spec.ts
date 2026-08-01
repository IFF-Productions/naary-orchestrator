/**
 * Connecting nodes from the config panel (#1026).
 *
 * The whole point of these is ORDER. The interpreter takes every outgoing edge whose condition
 * passes IN DECLARED ARRAY ORDER, and that order decides fan-out order and which terminal branch
 * wins — so a panel that listed edges in any other order would show one precedence and execute
 * another. Everything below asserts the model reports and edits the REAL order.
 */
import { describe, expect, it } from "vitest";
import type { NodeType } from "@naary/dsl";
import {
  appendConnection,
  canHaveIncoming,
  canHaveOutgoing,
  conditionSummary,
  type ConnectEdge,
  type ConnectNode,
  connectableTargets,
  hasConnection,
  incomingConnections,
  moveConnection,
  outgoingConnections,
} from "../src/screens/canvas/connect-model";

const NODES: ConnectNode[] = [
  { id: "start", kind: "start", label: "Start" },
  { id: "route", kind: "switch", label: "Route by value" },
  { id: "approve", kind: "humanApproval", label: "Human approval" },
  { id: "log", kind: "httpRequest", label: "Auto-log deal" },
  { id: "notify", kind: "sendEmail", label: "Email the team" },
  { id: "end", kind: "end", label: "End" },
];

/** Deliberately NOT alphabetical by target, and interleaved with another node's edges — so a
 *  display that sorted, or that filtered without keeping array positions, would show a
 *  different sequence from this one. */
const EDGES: ConnectEdge[] = [
  { id: "e-start", source: "start", target: "route" },
  {
    id: "e-approve",
    source: "route",
    target: "approve",
    data: { condition: { path: "route.matched", op: "eq", value: "high" } },
  },
  { id: "e-approve-end", source: "approve", target: "end" },
  { id: "e-notify", source: "route", target: "notify" },
  {
    id: "e-log",
    source: "route",
    target: "log",
    data: { condition: { path: "route.matched", op: "eq", value: "low" } },
  },
];

describe("outgoingConnections", () => {
  it("lists a node's outgoing edges in execution order, with their global index", () => {
    const outs = outgoingConnections("route", EDGES);
    expect(outs.map((o) => o.edge.id)).toEqual([
      "e-approve",
      "e-notify",
      "e-log",
    ]);
    // Numbered 1..n for display, but the INDEX is the array slot the interpreter reads.
    expect(outs.map((o) => o.position)).toEqual([1, 2, 3]);
    expect(outs.map((o) => o.index)).toEqual([1, 3, 4]);
  });

  it("keeps declared order even when it disagrees with target-name order", () => {
    // approve, notify, log — alphabetical would be approve, log, notify.
    const targets = outgoingConnections("route", EDGES).map(
      (o) => o.edge.target,
    );
    expect(targets).toEqual(["approve", "notify", "log"]);
    expect(targets).not.toEqual([...targets].sort());
  });

  it("is empty for a node with no outgoing edges", () => {
    expect(outgoingConnections("end", EDGES)).toEqual([]);
  });
});

describe("incomingConnections", () => {
  it("lists the edges arriving at a node, in declared order", () => {
    expect(incomingConnections("end", EDGES).map((e) => e.id)).toEqual([
      "e-approve-end",
    ]);
    expect(incomingConnections("route", EDGES).map((e) => e.id)).toEqual([
      "e-start",
    ]);
  });
});

describe("moveConnection", () => {
  it("swaps two SIBLING edges in the full array, so the run order changes", () => {
    const next = moveConnection(EDGES, "e-log", -1);
    expect(outgoingConnections("route", next).map((o) => o.edge.id)).toEqual([
      "e-approve",
      "e-log",
      "e-notify",
    ]);
  });

  it("moves an edge later too", () => {
    const next = moveConnection(EDGES, "e-approve", 1);
    expect(outgoingConnections("route", next).map((o) => o.edge.id)).toEqual([
      "e-notify",
      "e-approve",
      "e-log",
    ]);
  });

  it("leaves every unrelated edge exactly where it was", () => {
    const next = moveConnection(EDGES, "e-log", -1);
    // `e-start` and `e-approve-end` belong to other nodes: their slots must not move, or the
    // saved diff would claim a reorder the author never asked for.
    expect(next.indexOf(EDGES[0])).toBe(0);
    expect(next.indexOf(EDGES[2])).toBe(2);
    expect(next).toHaveLength(EDGES.length);
  });

  it("does not mutate the input array", () => {
    const before = EDGES.map((e) => e.id);
    moveConnection(EDGES, "e-log", -1);
    expect(EDGES.map((e) => e.id)).toEqual(before);
  });

  it("is a no-op (same array identity) at either end of the sibling list", () => {
    expect(moveConnection(EDGES, "e-approve", -1)).toBe(EDGES);
    expect(moveConnection(EDGES, "e-log", 1)).toBe(EDGES);
    expect(moveConnection(EDGES, "nope", -1)).toBe(EDGES);
  });

  it("ignores edges of OTHER nodes sitting between two siblings", () => {
    // e-notify (index 3) and e-log (index 4) are adjacent siblings; e-approve (index 1) is a
    // sibling separated from them by another node's edge at index 2.
    const next = moveConnection(EDGES, "e-notify", -1);
    expect(next.map((e) => e.id)).toEqual([
      "e-start",
      "e-notify",
      "e-approve-end",
      "e-approve",
      "e-log",
    ]);
  });
});

describe("appendConnection", () => {
  it("appends a new edge LAST, so existing precedence is untouched", () => {
    const next = appendConnection(EDGES, {
      id: "e-new",
      source: "route",
      target: "end",
    });
    expect(outgoingConnections("route", next).map((o) => o.edge.id)).toEqual([
      "e-approve",
      "e-notify",
      "e-log",
      "e-new",
    ]);
  });

  it("refuses a duplicate connection — the same one React Flow's addEdge would drop", () => {
    const next = appendConnection(EDGES, {
      id: "e-dupe",
      source: "route",
      target: "log",
    });
    expect(next).toBe(EDGES);
  });
});

describe("hasConnection", () => {
  it("answers per direction — an edge A→B is not an edge B→A", () => {
    expect(hasConnection(EDGES, "route", "log")).toBe(true);
    expect(hasConnection(EDGES, "log", "route")).toBe(false);
  });
});

describe("connectableTargets", () => {
  it("offers only nodes that can take an incoming edge and aren't already connected", () => {
    expect(connectableTargets("route", NODES, EDGES).map((n) => n.id)).toEqual([
      "end",
    ]);
  });

  it("never offers an entry/trigger node — it has no inbound handle on the canvas", () => {
    const ids = connectableTargets("log", NODES, EDGES).map((n) => n.id);
    expect(ids).not.toContain("start");
    expect(ids).toEqual(["route", "approve", "notify", "end"]);
  });

  it("never offers the node itself", () => {
    expect(
      connectableTargets("log", NODES, EDGES).map((n) => n.id),
    ).not.toContain("log");
  });

  it("offers an UPSTREAM node — a back-edge is a legal loop", () => {
    expect(
      connectableTargets("notify", NODES, EDGES).map((n) => n.id),
    ).toContain("route");
  });

  it("offers nothing from a terminal `end` node — it has no source handle", () => {
    expect(connectableTargets("end", NODES, EDGES)).toEqual([]);
  });

  it("offers nothing for a node that isn't on the canvas", () => {
    expect(connectableTargets("ghost", NODES, EDGES)).toEqual([]);
  });
});

describe("canHaveOutgoing / canHaveIncoming", () => {
  const ENTRY: NodeType[] = [
    "start",
    "webhookTrigger",
    "scheduleTrigger",
    "formTrigger",
    "chatTrigger",
    "pollTrigger",
    "errorTrigger",
  ];

  it("matches the canvas handle rules: only `end` has no outgoing", () => {
    expect(canHaveOutgoing("end")).toBe(false);
    for (const k of [
      "agent",
      "switch",
      "stopAndError",
      "start",
    ] as NodeType[]) {
      expect(canHaveOutgoing(k), k).toBe(true);
    }
  });

  it("matches the compiler's entry list: no entry node takes an incoming edge", () => {
    for (const k of ENTRY) expect(canHaveIncoming(k), k).toBe(false);
    for (const k of ["agent", "end", "switch"] as NodeType[]) {
      expect(canHaveIncoming(k), k).toBe(true);
    }
  });
});

describe("conditionSummary", () => {
  it("says `always` for an unconditional edge — it fires every time, wherever it sits", () => {
    expect(conditionSummary(undefined)).toBe("always");
    expect(conditionSummary({ path: "  ", op: "eq", value: "x" })).toBe(
      "always",
    );
  });

  it("drops the value for a valueless operator", () => {
    expect(
      conditionSummary({ path: "agent.error", op: "exists", value: "" }),
    ).toBe("agent.error exists");
  });

  it("reads back the real predicate", () => {
    expect(
      conditionSummary({ path: "route.matched", op: "eq", value: "high" }),
    ).toBe("route.matched eq high");
  });
});

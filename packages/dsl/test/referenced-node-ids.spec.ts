// Which node ids a node's config READS FROM — and the drift guard that keeps that enumeration
// honest against `renameNode`'s.
//
// The risk is entirely in the enumeration, exactly as rename-node's own header says. Here it cuts
// the other way: `referencedNodeIds` decides which upstream outputs get sent to a model in the run
// diagnosis, so a MISS ships an incomplete diagnosis and an OVER-REACH ships data that had no
// reason to leave the tenant.
import { describe, expect, it } from "vitest";
import { canonicalize } from "../src/canonical";
import { referencedNodeIds, renameNode } from "../src/rename-node";
import type { GraphDef, NodeDef } from "../src/types";

const node = (id: string, config?: NodeDef["config"]): NodeDef =>
  ({ id, type: "set", config }) as NodeDef;

describe("referencedNodeIds", () => {
  it("finds ArgBindings anywhere in a nested config", () => {
    const n = node("shape", {
      fieldBindings: {
        ticket: { from: "start", path: "ticketId" },
        who: { from: "lookup", path: "user.name" },
      },
      nested: { deeper: [{ arg: { from: "http", path: "body" } }] },
    });
    expect(referencedNodeIds(n).sort()).toEqual(["http", "lookup", "start"]);
  });

  it("finds {{ }} template references, including inside nested strings and arrays", () => {
    const n = node("mail", {
      subject: "Incident {{ pagerduty.body.incidents[0].id }} is open",
      lines: ["Hi {{ start.user }}", "cc {{ agent.text }}"],
    });
    expect(referencedNodeIds(n).sort()).toEqual([
      "agent",
      "pagerduty",
      "start",
    ]);
  });

  it("skips an ESCAPED template — it never resolves, so nothing was read", () => {
    // templateTokens is the runtime's own parser, so this falls out for free rather than being
    // a rule this function re-implements.
    const n = node("doc", { body: String.raw`literal \{{ notanode.x }} here` });
    expect(referencedNodeIds(n)).toEqual([]);
  });

  it("does not count a node referring to ITSELF as an input", () => {
    const n = node("loop", { a: "{{ loop.x }}", b: { from: "loop" } });
    expect(referencedNodeIds(n)).toEqual([]);
  });

  it("does NOT report a handoff target — that is where control goes, not data read", () => {
    const n = node("supervisor", {
      handoff: { targets: [{ to: "billing" }, { to: "refunds" }] },
      prompt: "{{ intake.message }}",
    });
    // `renameNode` DOES rewrite handoff targets; this function deliberately doesn't report them.
    expect(referencedNodeIds(n)).toEqual(["intake"]);
  });

  it("returns each id once, in first-seen order", () => {
    const n = node("x", {
      a: "{{ up.one }} {{ up.two }}",
      b: { from: "other" },
      c: { from: "up" },
    });
    expect(referencedNodeIds(n)).toEqual(["up", "other"]);
  });

  it("handles a node with no config at all", () => {
    expect(referencedNodeIds(node("bare"))).toEqual([]);
  });

  it("does NOT report reserved ctx keys — they are runtime-seeded, not node ids", () => {
    // `{{ $vars.K }}` is an ordinary reference whose head is `$vars`, so without this filter the
    // function would return something that is not a node id and every caller would have to know
    // to drop it. Filtered once, here, so the name stays true.
    const n = node("call", {
      region: "{{ $vars.REGION }}",
      token: "{{ $secrets.PD_TOKEN }}",
      echo: "{{ __input.ticketId }}",
      cost: "{{ __costUsd }}",
      real: "{{ upstream.value }}",
    });
    expect(referencedNodeIds(n)).toEqual(["upstream"]);
  });
});

// ── The drift guard ───────────────────────────────────────────────────────────────────────────
//
// `referencedNodeIds` and `renameNode`'s `rewriteConfig` walk the same two reference kinds. If
// someone teaches one about a new kind (the next binding-shaped field, a new template syntax) and
// not the other, this fails — which is the entire reason the two live in one file.
//
// Scoped to node CONFIGS on purpose: renameNode also moves edges, startNodeId, edge conditions and
// handoff targets, none of which are things a node read.
describe("drift: renameNode rewrites a config IFF referencedNodeIds names that id", () => {
  const graph: GraphDef = {
    startNodeId: "start",
    nodes: [
      node("start", { sampleInput: { ticketId: "NAARY-1" } }),
      node("http", { url: "https://x/{{ start.ticketId }}" }),
      node("shape", {
        fieldBindings: { id: { from: "http", path: "body.id" } },
        note: "from {{ start.ticketId }}",
      }),
      node("supervisor", {
        handoff: { targets: [{ to: "shape" }] },
        prompt: "{{ http.body }}",
      }),
      node("lonely", { text: "no references at all" }),
    ],
    edges: [
      { from: "start", to: "http" },
      { from: "http", to: "shape" },
      { from: "shape", to: "supervisor" },
    ],
  };

  for (const target of graph.nodes.map((n) => n.id)) {
    it(`agrees for "${target}"`, () => {
      const res = renameNode(graph, target, `${target}-renamed`);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      for (const before of graph.nodes) {
        // The renamed node itself is excluded: its own id moved, which is not a reference.
        if (before.id === target) continue;
        const after = res.graph.nodes.find((n) => n.id === before.id);
        expect(after, `node ${before.id} survived the rename`).toBeDefined();

        const configChanged =
          canonicalize(before.config ?? null) !==
          canonicalize(after?.config ?? null);
        const namesTarget = referencedNodeIds(before).includes(target);

        // The one sanctioned disagreement, asserted structurally rather than waved past:
        // renameNode rewrites `handoff.targets[].to`, which referencedNodeIds deliberately omits
        // (control flow, not data). So a config may change without naming the target — but ONLY
        // when that node hands off to it.
        const handsOffToTarget = (
          (before.config as { handoff?: { targets?: { to?: unknown }[] } })
            ?.handoff?.targets ?? []
        ).some((t) => t?.to === target);

        // Direction 1 — no misses. If we say it reads the target, the rename must have touched it.
        if (namesTarget) {
          expect(
            configChanged,
            `referencedNodeIds says "${before.id}" reads "${target}", but renameNode did not ` +
              `rewrite its config — the two walks have drifted`,
          ).toBe(true);
        }

        // Direction 2 — no blind spots. If the rename touched it, we must have named it (or it is
        // the known handoff exception).
        if (configChanged) {
          expect(
            namesTarget || handsOffToTarget,
            `renameNode rewrote "${before.id}" config for "${target}", but referencedNodeIds did ` +
              `not name it and it is not a handoff target — the two walks have drifted`,
          ).toBe(true);
        }
      }
    });
  }
});

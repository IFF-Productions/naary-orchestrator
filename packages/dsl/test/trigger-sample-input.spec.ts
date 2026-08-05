import { describe, expect, it } from "vitest";
import {
  hasConcreteConfig,
  nodeConfigKeys,
  validateGraphConfigs,
} from "../src/registry";
import {
  acceptsSampleInput,
  NODE_CATALOG,
  NODE_TYPES,
} from "../src/node-catalog";
import { deriveSampleInput } from "../src/trigger-sample";
import { webhookSampleGraph } from "../src/sample-graph";
import type { NodeType } from "../src/types";

/**
 * #983 — `sampleInput` was declared on the `start` node ONLY, so a webhook/form/chat graph had no
 * way to say what its real trigger sends. #982 had just removed the hardcoded demo payload manual
 * runs fell back to (right — it was data no real trigger ever sent, #979), which left those graphs
 * with `{}` on "Run now" and nothing better to declare.
 *
 * The API side never needed a change: `startSampleInput` already reads `graph.startNodeId`'s config
 * regardless of node type. What was missing was the SCHEMA (you couldn't declare one) and the CANVAS
 * GATE (the field only rendered for `start`) — so those are what these assertions pin.
 */
describe("trigger sample input (#983)", () => {
  const ACCEPTING: NodeType[] = [
    "start",
    "webhookTrigger",
    "errorTrigger",
    "formTrigger",
    "chatTrigger",
    "mcpServerTrigger",
    // kafkaTrigger accepts one for the same reason webhook/form do, and NOT for the reason
    // schedule/poll are excluded below: a real firing carries a real Kafka message, so there is
    // something for a manual run to be faithful TO. (#1086 slice 2.)
    "kafkaTrigger",
    // mqttTrigger, for the identical reason (#1086 slice 3b): a real firing carries a real MQTT
    // message, so a manual run has something meaningful to stand in for.
    "mqttTrigger",
  ];

  it("every entry node that accepts a sample declares it in its registry schema", () => {
    for (const t of ACCEPTING) {
      expect(hasConcreteConfig(t), t).toBe(true);
      expect(nodeConfigKeys(t), t).toContain("sampleInput");
    }
  });

  it("schedule/poll triggers deliberately do NOT accept one", () => {
    // Their real trigger passes `{}`, so there is nothing to be faithful to — a sample could only
    // make "Run now" unlike every real firing. NOTE the reason narrowed in #991: the exclusion is
    // no longer load-bearing (it used to be the only thing keeping a sample from being honored by
    // one of a graph's two schedules and ignored by the other). Every schedule now starts its run
    // with `{}` regardless of what the graph declares — pinned in
    // apps/api/test/schedules.poll.spec.ts — so this assertion is a product judgment, not a guard.
    for (const t of ["scheduleTrigger", "pollTrigger"] as NodeType[]) {
      expect(acceptsSampleInput(t), t).toBe(false);
      expect(nodeConfigKeys(t), t).not.toContain("sampleInput");
    }
  });

  it("the catalog flag the canvas gates on matches the schema exactly (no drift)", () => {
    // The canvas can't ask ./registry (zod would land in the browser bundle), so it asks
    // `acceptsSampleInput`. If the two ever disagree, a trigger silently loses its field.
    const byFlag = NODE_TYPES.filter((t) => acceptsSampleInput(t)).sort();
    const bySchema = NODE_TYPES.filter((t) =>
      nodeConfigKeys(t).includes("sampleInput"),
    ).sort();
    expect(byFlag).toEqual(bySchema);
    expect(byFlag).toEqual([...ACCEPTING].sort());
  });

  it("only ENTRY nodes may accept a sample input", () => {
    for (const t of NODE_TYPES) {
      if (acceptsSampleInput(t)) expect(NODE_CATALOG[t].entry, t).toBe(true);
    }
  });

  it("is not fooled by a hostile deserialized node type", () => {
    for (const evil of ["__proto__", "constructor", "toString"] as unknown as NodeType[]) {
      expect(acceptsSampleInput(evil), evil).toBe(false);
    }
  });

  it("rejects a non-object sampleInput on a webhook trigger at save time", () => {
    // Under the permissive fallback this node type accepted ANY config, so a string sample saved
    // fine and then failed to be an input at run time.
    const errors = validateGraphConfigs({
      nodes: [
        {
          id: "trigger",
          type: "webhookTrigger",
          config: { sampleInput: "no" },
        },
      ],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].nodeId).toBe("trigger");
    expect(errors[0].issues[0].path).toBe("sampleInput");
  });

  it("accepts a real sampleInput on every entry node that takes one", () => {
    const errors = validateGraphConfigs({
      nodes: ACCEPTING.map((type) => ({
        id: type,
        type,
        config: { sampleInput: { hello: "world" } },
      })),
    });
    expect(errors).toEqual([]);
  });

  it("the shipped webhook sample graph declares one (it got {} on Run now before)", () => {
    const trigger = webhookSampleGraph.nodes.find(
      (n) => n.id === webhookSampleGraph.startNodeId,
    );
    expect(trigger?.type).toBe("webhookTrigger");
    expect(trigger?.config?.sampleInput).toMatchObject({
      event: "ticket.created",
    });
  });
});

/**
 * The derive is offered in the EDITOR (a one-click fill that writes the object into the node's
 * config), never on the server — a service-side derive would be the same invisible injection #982
 * removed. These pin the shape it produces.
 */
describe("deriveSampleInput (#983)", () => {
  it("derives a form's sample from its declared fields, one key per field", () => {
    const derived = deriveSampleInput("formTrigger", {
      fields: [
        { key: "name", label: "Name", type: "text" },
        { key: "email", label: "Email", type: "email" },
        { key: "count", label: "How many", type: "number" },
        {
          key: "plan",
          label: "Plan",
          type: "select",
          options: ["pro", "free"],
        },
        { key: "notes", label: "Notes", type: "textarea" },
      ],
    });
    expect(derived).toEqual({
      name: "",
      email: "user@example.com",
      count: 0,
      plan: "pro",
      notes: "",
    });
  });

  it("skips a polluting field key rather than emitting a sample missing it silently", () => {
    // `out["__proto__"] = v` is a no-op (#761): the key would vanish with no error, so the JSON
    // handed to the author would not match the form it was derived from.
    const derived = deriveSampleInput("formTrigger", {
      fields: [
        { key: "__proto__", label: "x", type: "text" },
        { key: "ok", label: "OK", type: "text" },
      ],
    });
    expect(derived).toEqual({ ok: "" });
    expect(Object.keys(derived ?? {})).toEqual(["ok"]);
  });

  it("derives nothing for a form with no inline fields (a templateId form)", () => {
    // Its inputs live in a content template the canvas doesn't hold — deriving `{}` would claim
    // the form has no fields. Nothing derived ⇒ the field stays hand-written, which is honest.
    expect(
      deriveSampleInput("formTrigger", { templateId: "t1" }),
    ).toBeUndefined();
    expect(deriveSampleInput("formTrigger", { fields: [] })).toBeUndefined();
  });

  it("derives the chat payload the real ingress passes", () => {
    expect(deriveSampleInput("chatTrigger", {})).toEqual({
      message: "Hello",
      sessionId: "sample-session",
    });
  });

  it("derives nothing where the graph cannot know the shape", () => {
    // A webhook body, an MCP tool's arguments and a `start`'s caller payload are all unknowable
    // from the graph, so those stay hand-written.
    for (const t of [
      "start",
      "webhookTrigger",
      "errorTrigger",
      "mcpServerTrigger",
      "scheduleTrigger",
    ] as NodeType[]) {
      expect(deriveSampleInput(t, {}), t).toBeUndefined();
    }
  });
});

/**
 * `POST /graphs/import/n8n` (#579) — the route contract.
 *
 * The translation itself is covered exhaustively by the corpus test in
 * `packages/dsl/test/n8n-import.spec.ts` (6 checked-in real-shaped exports, both save gates). What
 * this spec pins is the route's own behaviour: it persists nothing, it needs no tenant/env/provider
 * key, a non-n8n payload is a 400 rather than a 500, and the response carries the report.
 */
import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { validateGraph } from "@naary/dsl";
import { GraphsController } from "../src/graphs/graphs.controller";

// The route is pure, so every collaborator can be a null object — that IS the assertion that it
// touches no service. If it ever starts reading the DB or a provider key, this throws.
const forbidden = new Proxy(
  {},
  {
    get() {
      throw new Error("the n8n import route must not use any service");
    },
  },
) as never;
const controller = new GraphsController(
  forbidden,
  forbidden,
  forbidden,
  forbidden,
);

const WORKFLOW = {
  name: "Ping then respond",
  nodes: [
    {
      name: "Webhook",
      type: "n8n-nodes-base.webhook",
      parameters: { httpMethod: "POST", path: "ping" },
      credentials: { httpHeaderAuth: { id: "3", name: "My header auth" } },
    },
    {
      name: "Call API",
      type: "n8n-nodes-base.httpRequest",
      parameters: {
        method: "GET",
        url: "=https://x.example.com/{{ $json.body.id }}",
      },
    },
    {
      name: "Exotic thing",
      type: "n8n-nodes-base.someFutureNode",
      parameters: { magic: true },
    },
  ],
  connections: {
    Webhook: { main: [[{ node: "Call API", type: "main", index: 0 }]] },
    "Call API": { main: [[{ node: "Exotic thing", type: "main", index: 0 }]] },
  },
};

describe("POST /graphs/import/n8n", () => {
  it("returns an unsaved draft graph plus the report, touching no service", () => {
    const out = controller.importN8n({ workflow: WORKFLOW });

    expect(out.name).toBe("Ping then respond");
    expect(validateGraph(out.graph).valid).toBe(true);
    expect(out.graph.nodes.map((n) => n.type)).toEqual([
      "webhookTrigger",
      "httpRequest",
      "noOp",
    ]);
    expect(out.nodes).toHaveLength(3);
    expect(out.counts.unmapped).toBe(1);
  });

  it("reports the credential TYPE and never puts the credential in the graph", () => {
    const out = controller.importN8n({ workflow: WORKFLOW });

    expect(out.credentials).toEqual([
      {
        n8nType: "httpHeaderAuth",
        usedBy: ["Webhook"],
        suggestedConnectionType: "custom",
      },
    ]);
    const json = JSON.stringify(out.graph);
    expect(json).not.toContain("My header auth");
    expect(json).not.toContain("httpHeaderAuth");
  });

  it("keeps the unmapped node's original config on the placeholder", () => {
    const out = controller.importN8n({ workflow: WORKFLOW });
    const placeholder = out.graph.nodes.find((n) => n.type === "noOp")!;
    expect(placeholder.config?.__n8n).toEqual({
      type: "n8n-nodes-base.someFutureNode",
      typeVersion: null,
      parameters: { magic: true },
    });
  });

  it("400s on a payload that is not an n8n workflow", () => {
    expect(() =>
      controller.importN8n({ workflow: { hello: "world" } }),
    ).toThrow(BadRequestException);
    expect(() => controller.importN8n({ workflow: { nodes: [] } })).toThrow(
      /no nodes/,
    );
  });
});

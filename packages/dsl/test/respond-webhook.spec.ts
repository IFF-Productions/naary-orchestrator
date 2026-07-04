import { describe, expect, it } from "vitest";
import { resolveWebhookResponse } from "../src/respond-webhook";
import type { RespondToWebhookNodeConfig } from "../src/types";

const ctx = { agent: { output: { id: 7, ok: true } } };

describe("resolveWebhookResponse", () => {
  it("defaults status to 200 and clones the static body", () => {
    const body = { ok: true, nested: { a: 1 } };
    const config: RespondToWebhookNodeConfig = { body };
    const r = resolveWebhookResponse(config, ctx);
    expect(r).toEqual({
      statusCode: 200,
      body: { ok: true, nested: { a: 1 } },
    });
    // deep-cloned — mutating the result must not touch the graph config
    (r.body as { nested: { a: number } }).nested.a = 99;
    expect(body.nested.a).toBe(1);
  });

  it("honors a custom status + headers", () => {
    const r = resolveWebhookResponse(
      { statusCode: 201, body: "created", headers: { "x-trace": "1" } },
      ctx,
    );
    expect(r).toEqual({
      statusCode: 201,
      body: "created",
      headers: { "x-trace": "1" },
    });
  });

  it("bodyBinding overrides the static body from an upstream output", () => {
    const config: RespondToWebhookNodeConfig = {
      statusCode: 200,
      body: { static: true },
      bodyBinding: { from: "agent", path: "output" },
    };
    expect(resolveWebhookResponse(config, ctx).body).toEqual({
      id: 7,
      ok: true,
    });
  });
});

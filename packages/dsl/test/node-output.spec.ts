import { describe, expect, it } from "vitest";
import { getNodeOutput } from "../src/node-output";

/**
 * getNodeOutput is a type-level narrowing over the run ctx bag; these tests lock the
 * *runtime* contract (read by id, undefined when absent). The compile-time guarantee —
 * that ctx.codeAgent.output.result is typed and ".result" fails to compile — is enforced
 * by tsc against NodeOutputMap and can't be asserted at runtime, so it's exercised via
 * the type annotations below (this file failing to compile IS the failing test).
 */
describe("getNodeOutput", () => {
  it("returns the node's output keyed by its id", () => {
    const ctx: Record<string, unknown> = {
      codeAgent: {
        status: "ok",
        output: { result: "OK", tool: "claude" },
        costUsd: 0.01,
      },
    };
    const out = getNodeOutput(ctx, "codeAgent", "codeAgent");
    // `.output.result` is the real path; `.result` would be a compile error.
    expect(out?.output.result).toBe("OK");
    expect(out?.output.tool).toBe("claude");
  });

  it("returns undefined when the node hasn't run (absent from ctx)", () => {
    expect(getNodeOutput({}, "codeAgent", "codeAgent")).toBeUndefined();
  });

  it("reads by the given id, not by the node kind", () => {
    // A node's id need not equal its type; getNodeOutput keys on the id.
    const ctx: Record<string, unknown> = {
      myHttp: { status: 200, headers: {}, body: { ok: true } },
    };
    const out = getNodeOutput(ctx, "myHttp", "httpRequest");
    expect(out?.status).toBe(200);
  });

  it("narrows dynamic (pure-transform) outputs to unknown, not a made-up shape", () => {
    const ctx: Record<string, unknown> = { setNode: { anything: 1 } };
    const out = getNodeOutput(ctx, "setNode", "set");
    // `set` maps to `unknown` — a consumer must narrow it deliberately.
    expect(out).toEqual({ anything: 1 });
  });
});

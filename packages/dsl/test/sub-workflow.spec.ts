import { describe, expect, it } from "vitest";
import { resolveSubWorkflowInput } from "../src/sub-workflow";
import type { ExecuteSubWorkflowNodeConfig } from "../src/types";

const ctx = {
  trigger: { userId: "u-7", nested: { count: 3 } },
  agent: { output: { category: "billing" } },
};

describe("resolveSubWorkflowInput", () => {
  it("returns undefined when neither input nor bindings are set (forward trigger input)", () => {
    const config: ExecuteSubWorkflowNodeConfig = { workflowKey: "child" };
    expect(resolveSubWorkflowInput(config, ctx)).toBeUndefined();
  });

  it("returns the static input verbatim when there are no bindings", () => {
    const config: ExecuteSubWorkflowNodeConfig = {
      workflowKey: "child",
      input: { message: "hi", n: 1 },
    };
    expect(resolveSubWorkflowInput(config, ctx)).toEqual({
      message: "hi",
      n: 1,
    });
  });

  it("builds input purely from bindings when there is no static input", () => {
    const config: ExecuteSubWorkflowNodeConfig = {
      workflowKey: "child",
      inputBindings: { userId: { from: "trigger", path: "userId" } },
    };
    expect(resolveSubWorkflowInput(config, ctx)).toEqual({ userId: "u-7" });
  });

  it("a binding fills/overrides the static value at its dotted path", () => {
    const config: ExecuteSubWorkflowNodeConfig = {
      workflowKey: "child",
      input: { userId: "STATIC", keep: true },
      inputBindings: {
        userId: { from: "trigger", path: "userId" },
        "meta.count": { from: "trigger", path: "nested.count" },
      },
    };
    expect(resolveSubWorkflowInput(config, ctx)).toEqual({
      userId: "u-7",
      keep: true,
      meta: { count: 3 },
    });
  });

  it("a missing upstream path resolves to undefined (never throws)", () => {
    const config: ExecuteSubWorkflowNodeConfig = {
      workflowKey: "child",
      inputBindings: { x: { from: "trigger", path: "does.not.exist" } },
    };
    expect(resolveSubWorkflowInput(config, ctx)).toEqual({ x: undefined });
  });

  it("does not mutate the source config.input (deep clone)", () => {
    const input = { nested: { keep: 1 } };
    const config: ExecuteSubWorkflowNodeConfig = {
      workflowKey: "child",
      input,
      inputBindings: { "nested.added": { from: "trigger", path: "userId" } },
    };
    resolveSubWorkflowInput(config, ctx);
    expect(input).toEqual({ nested: { keep: 1 } });
  });
});

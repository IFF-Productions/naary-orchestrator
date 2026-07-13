import { describe, expect, it } from "vitest";
import { ancestorsOf, buildExpressionRefs } from "../src/lib/expression-refs";

// hook → agent → comment ; approve is a separate leaf off agent
const edges = [
  { source: "hook", target: "agent" },
  { source: "agent", target: "comment" },
  { source: "agent", target: "approve" },
];

describe("ancestorsOf", () => {
  it("returns transitive predecessors, not descendants or self", () => {
    expect(ancestorsOf("comment", edges).sort()).toEqual(["agent", "hook"]);
    expect(ancestorsOf("agent", edges)).toEqual(["hook"]);
    expect(ancestorsOf("hook", edges)).toEqual([]); // trigger has no ancestors
  });

  it("terminates on a cycle", () => {
    const cyclic = [
      { source: "a", target: "b" },
      { source: "b", target: "a" },
    ];
    expect(ancestorsOf("a", cyclic)).toEqual(["b"]);
  });
});

describe("buildExpressionRefs", () => {
  const pins = {
    hook: { body: { repository: { name: "repo", owner: { login: "me" } } } },
  };

  it("nodeIds = ancestors + __input", () => {
    const refs = buildExpressionRefs("comment", edges, pins);
    expect(refs.nodeIds).toContain("hook");
    expect(refs.nodeIds).toContain("agent");
    expect(refs.nodeIds).toContain("__input");
    expect(refs.nodeIds).not.toContain("comment");
  });

  it("keysAt navigates the pinned sample by dotted base", () => {
    const refs = buildExpressionRefs("comment", edges, pins);
    expect(refs.keysAt("hook").sort()).toEqual(["body"]);
    expect(refs.keysAt("hook.body").sort()).toEqual(["repository"]);
    expect(refs.keysAt("hook.body.repository").sort()).toEqual([
      "name",
      "owner",
    ]);
  });

  it("keysAt returns [] for a leaf, a missing node, or no pin", () => {
    const refs = buildExpressionRefs("comment", edges, pins);
    expect(refs.keysAt("hook.body.repository.name")).toEqual([]); // string leaf
    expect(refs.keysAt("nope")).toEqual([]); // no pin
    expect(refs.keysAt("__input")).toEqual([]); // reserved, unpinned
  });
});

import { describe, expect, it } from "vitest";
import { toImport, type WorkflowExport } from "../src/workflow-doc";

const doc: WorkflowExport = {
  workflowKey: "my-flow",
  name: "My Flow",
  version: 7,
  graph: { nodes: [{ id: "n1" }], edges: [] },
};

describe("toImport (export doc → import body)", () => {
  it("round-trips key + name + graph, dropping the version", () => {
    const { key, body } = toImport(doc);
    expect(key).toBe("my-flow");
    expect(body).toEqual({ name: "My Flow", graph: doc.graph });
    expect(body).not.toHaveProperty("version");
  });

  it("lets --key and --name override the doc", () => {
    const { key, body } = toImport(doc, { key: "copy", name: "Copy" });
    expect(key).toBe("copy");
    expect(body.name).toBe("Copy");
    expect(body.graph).toEqual(doc.graph);
  });

  it("falls back name → key when neither doc.name nor override is present", () => {
    const { body } = toImport({ workflowKey: "k", graph: {} });
    expect(body.name).toBe("k");
  });

  it("throws when no key can be determined", () => {
    expect(() => toImport({ graph: {} })).toThrow(/key/i);
  });

  it("uses --key when the doc itself has no workflowKey", () => {
    const { key } = toImport({ name: "N", graph: {} }, { key: "provided" });
    expect(key).toBe("provided");
  });
});

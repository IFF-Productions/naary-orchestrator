import "reflect-metadata";
import { NotFoundException } from "@nestjs/common";
import { validateGraph } from "@naary/dsl";
import { describe, expect, it } from "vitest";
import { TemplatesController } from "../src/templates/templates.controller";

const c = new TemplatesController();

describe("TemplatesController", () => {
  it("lists templates with a name, description, and node count", () => {
    const list = c.list();
    expect(list.length).toBeGreaterThanOrEqual(8); // 3 original + 5 new
    for (const t of list) {
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.nodeCount).toBeGreaterThan(0);
    }
    // keys are unique (the canvas opens a template by key)
    const keys = list.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every listed template resolves to a STRUCTURALLY VALID graph", () => {
    // A registered key with a broken/missing graph would fail to open on the
    // canvas — assert each get() returns a graph validateGraph accepts.
    for (const { key } of c.list()) {
      const detail = c.get(key);
      expect(detail.key).toBe(key);
      expect(detail.graph.nodes.length).toBe(detail.nodeCount);
      expect(validateGraph(detail.graph)).toEqual({ valid: true });
    }
  });

  it("404s an unknown template key", () => {
    expect(() => c.get("does-not-exist")).toThrow(NotFoundException);
  });
});

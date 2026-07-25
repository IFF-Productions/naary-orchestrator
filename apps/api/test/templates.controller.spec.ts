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

  // --- #574: server-owned taxonomy (the SPA used to INFER a category from node types) ---

  // The SPA maps each id to a label/icon/accent; a typo'd or invented id would silently
  // ship an unstyled chip, so the set is closed and asserted here.
  const CATEGORY_IDS = ["agents", "api", "database", "email", "github", "jira"];

  it("gives every template a category from the closed set and non-empty tags", () => {
    for (const t of c.list()) {
      expect(CATEGORY_IDS).toContain(t.category);
      expect(Array.isArray(t.tags)).toBe(true);
      expect(t.tags.length).toBeGreaterThan(0);
      // Tags feed a lowercase search haystack, and duplicates would double-count.
      for (const tag of t.tags) expect(tag).toBe(tag.toLowerCase().trim());
      expect(new Set(t.tags).size).toBe(t.tags.length);
    }
  });

  it("serves the SAME category/tags from GET /templates and GET /templates/:key", () => {
    // Two hand-written projections — an addition applied to only one would make the
    // gallery's chips disagree with the preview's.
    for (const summary of c.list()) {
      const detail = c.get(summary.key);
      expect(detail.category).toBe(summary.category);
      expect(detail.tags).toEqual(summary.tags);
    }
  });

  it("BACKWARDS COMPATIBLE: the pre-#574 response shape is unchanged", () => {
    // AC: "Existing GET /templates consumers keep working." The new fields are ADDED;
    // every legacy field must still be present, same name, same type, same meaning.
    for (const t of c.list()) {
      expect(typeof t.key).toBe("string");
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
      expect(typeof t.nodeCount).toBe("number");
      // nodeCount still means "the graph's node count", not a filtered subset.
      expect(t.nodeCount).toBe(c.get(t.key).graph.nodes.length);
    }
    // …and GET /templates/:key still returns the graph alongside the summary fields.
    const one = c.get("default");
    expect(one).toMatchObject({
      key: "default",
      name: expect.any(String),
      description: expect.any(String),
      nodeCount: expect.any(Number),
    });
    expect(one.graph.nodes.length).toBeGreaterThan(0);
  });

  it("returns tag arrays a caller cannot mutate into the catalog", () => {
    // The projections copy `tags`, so a consumer that sorts/pushes in place can't
    // corrupt the module-level catalog for every later request.
    const before = c.get("default").tags;
    before.push("injected");
    expect(c.get("default").tags).not.toContain("injected");
  });
});

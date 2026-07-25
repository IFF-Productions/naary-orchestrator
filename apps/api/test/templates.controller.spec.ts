import "reflect-metadata";
import { NotFoundException } from "@nestjs/common";
import { validateGraph } from "@naary/dsl";
// Deep dist import, exactly as graphs.service.ts does it: the zod config registry is
// deliberately NOT on the DSL barrel (zod must stay out of the deterministic worker
// bundle). Importing it here means the corpus is checked by the SAME gate a save is.
import { validateGraphConfigs } from "@naary/dsl/dist/registry";
import { MODEL_PRICING } from "@naary/usage";
import { describe, expect, it } from "vitest";
import { TemplatesController } from "../src/templates/templates.controller";

const c = new TemplatesController();

describe("TemplatesController", () => {
  it("lists templates with a name, description, and node count", () => {
    const list = c.list();
    // #574 asks for 15–25 real use-case templates; 10 shipped in wave 1, 8 more in wave 2.
    expect(list.length).toBeGreaterThanOrEqual(15);
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

  // --- #574: the corpus must pass THE SAME save-gate a user's graph does ---

  it("every template passes the FULL save gate (structure + per-node config)", () => {
    // GraphsService.upsert runs validateGraph THEN validateGraphConfigs and 400s on
    // either. A template that only clears the first one installs and then can never be
    // re-saved from the canvas — worse than not shipping it. Both gates, every template.
    for (const { key } of c.list()) {
      const { graph } = c.get(key);
      expect(
        validateGraph(graph),
        `${key} failed structural validation`,
      ).toEqual({ valid: true });
      expect(
        validateGraphConfigs(graph),
        `${key} has invalid node config`,
      ).toEqual([]);
    }
  });

  it("every model a template names is PRICED (so a run can't die on the ledger write)", () => {
    // A model missing from MODEL_PRICING throws UnknownModelPricingError in recordUsage
    // AFTER the provider call already succeeded — the user pays for a run that then fails,
    // and Tier-1 rule 6 says we must never silently record zero either. `validateGraph`
    // cannot catch this (any string is a valid model id), so the corpus is checked here.
    const seen: string[] = [];
    for (const { key } of c.list()) {
      for (const node of c.get(key).graph.nodes) {
        const cfg = (node.config ?? {}) as {
          provider?: string;
          model?: string;
          tool?: string;
        };
        if (node.type !== "agent" && node.type !== "codeAgent") continue;
        if (!cfg.model) continue; // unset ⇒ the activity's own priced default
        // codeAgent bills under its CLI provider slot ("claude" ⇒ claude-code), not `provider`.
        const provider =
          node.type === "codeAgent"
            ? cfg.tool === "claude" || cfg.tool === undefined
              ? "claude-code"
              : cfg.tool
            : (cfg.provider ?? "anthropic");
        const table = MODEL_PRICING[provider];
        expect(
          table,
          `${key}/${node.id}: unpriced provider '${provider}'`,
        ).toBeTruthy();
        expect(
          // Object.prototype.hasOwnProperty (not Object.hasOwn — the api tsconfig's lib
          // predates it) and prototype-safe against a model named e.g. "toString".
          Object.prototype.hasOwnProperty.call(table, cfg.model),
          `${key}/${node.id}: model '${cfg.model}' is not in MODEL_PRICING['${provider}']`,
        ).toBe(true);
        seen.push(`${provider}/${cfg.model}`);
      }
    }
    // Guard against the assertion silently passing on an empty corpus.
    expect(seen.length).toBeGreaterThan(10);
  });

  it("404s an unknown template key", () => {
    expect(() => c.get("does-not-exist")).toThrow(NotFoundException);
  });

  // --- ?include=graph: one request instead of a per-key fan-out ---

  it("serves every graph in ONE response for ?include=graph", () => {
    // The gallery needs all the graphs. Fetching them per key was a 19-request fan-out
    // against the API's 120-req/min per-IP throttle, and a throttled request made that
    // template silently vanish from the gallery (Promise.allSettled dropped it). One
    // response cannot partially fail.
    const all = c.list("graph") as ReturnType<typeof c.get>[];
    expect(all).toHaveLength(c.list().length);
    for (const t of all) {
      expect(t.graph?.nodes.length).toBe(t.nodeCount);
      // Identical to what GET /templates/:key would have returned for that key.
      expect(t).toEqual(c.get(t.key));
    }
  });

  it("returns the UNCHANGED summary shape without the param", () => {
    // The param is opt-in precisely so an existing GET /templates consumer is untouched.
    for (const anything of [undefined, "", "graphs", "GRAPH", "1"]) {
      const rows = c.list(anything);
      expect(rows).toEqual(c.list());
      for (const r of rows) {
        expect(Object.prototype.hasOwnProperty.call(r, "graph")).toBe(false);
      }
    }
  });

  // --- #574: server-owned taxonomy (the SPA used to INFER a category from node types) ---

  // The SPA maps each id to a label/icon/accent; a typo'd or invented id would silently
  // ship an unstyled chip, so the set is closed and asserted here.
  const CATEGORY_IDS = [
    "agents",
    "api",
    "code",
    "database",
    "email",
    "github",
    "jira",
    "rag",
  ];

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

import { describe, expect, it } from "vitest";
import { INTEGRATION_CATALOG, NODE_TYPES } from "@naary/dsl";
import { CATALOG, CATEGORIES } from "../src/screens/app/catalog/catalog-data";

/**
 * Palette reachability guard (#688). CATALOG is what the canvas actually renders — the
 * CategoryRail popover ("Integrations") and the searchable CatalogModal both list its
 * entries, and /app/catalog's grid is the same data. It derives its integration tiles from
 * NODE_KINDS, which USED to hand-list four providers; that hand-list silently gated ~30
 * shipped providers out of the palette. These assertions fail if that ever comes back.
 */
describe("catalog derivation: every shipped node/provider is reachable from the palette", () => {
  it("has an integration entry per INTEGRATION_CATALOG provider", () => {
    const providers = CATALOG.filter((e) => e.nodeType === "integration").map(
      (e) => e.provider,
    );
    expect(providers.length).toBe(Object.keys(INTEGRATION_CATALOG).length);
    expect([...providers].sort()).toEqual(
      Object.keys(INTEGRATION_CATALOG).sort(),
    );
    // Stable, unique ids — the ?add=integration&provider=… deep link keys on them.
    const ids = CATALOG.filter((e) => e.nodeType === "integration").map(
      (e) => e.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("integration:stripe");
  });

  it("integration entries carry the provider's own name/description/actions", () => {
    for (const e of CATALOG.filter((e) => e.nodeType === "integration")) {
      const p = INTEGRATION_CATALOG[e.provider as string];
      expect(p, e.provider).toBeTruthy();
      expect(e.name).toBe(p.label);
      expect(e.desc.length, e.provider).toBeGreaterThan(10);
      expect(e.auth).toBe(p.auth);
      expect(e.cfg).toEqual(p.actions.map((a) => a.label));
      expect(e.category).toBe("integration");
    }
  });

  it("every entry has a real category and every DSL node type appears exactly once", () => {
    const catIds = new Set(CATEGORIES.map((c) => c.id));
    for (const e of CATALOG) expect(catIds.has(e.category), e.id).toBe(true);
    // Non-integration types: one entry each, and all of NODE_TYPES is covered.
    const nonIntegration = CATALOG.filter(
      (e) => e.nodeType !== "integration",
    ).map((e) => e.nodeType);
    expect(new Set(nonIntegration).size).toBe(nonIntegration.length);
    for (const t of NODE_TYPES) {
      expect(
        CATALOG.some((e) => e.nodeType === t),
        t,
      ).toBe(true);
    }
  });
});

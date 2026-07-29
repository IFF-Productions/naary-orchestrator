/**
 * The MANDATORY drift test for #910.
 *
 * `handleIntegration` no longer asks the catalog whether an action is a write — it asks
 * `isIntegrationWriteAction`, a flat literal set, because the catalog lookup dragged 161KB into the
 * deterministic Temporal workflow bundle to answer one boolean.
 *
 * That trade is only safe while the literal is EXACTLY the catalog. This is not a size or lint
 * concern: a WRITE mis-classified as a READ is routed to `callIntegrationRead`
 * (`retry: { maximumAttempts: 3 }`) instead of `callIntegrationWrite`
 * (`retry: { maximumAttempts: 1 }`), so a lost response re-runs a non-idempotent call — a
 * double-posted incident, a duplicate email, a second row. The failure mode is silent and in
 * production, not in CI. Hence this test, in both directions:
 *
 *   1. NOTHING MISSING / WRONG POLARITY — every action in the catalog (writes AND reads)
 *      classifies to its own `write` flag.
 *   2. NOTHING EXTRA — the set holds no key the catalog doesn't have. Iterating the catalog can
 *      never see a stale entry left behind for a deleted action, so this direction needs its own
 *      assertion.
 *   3. The `provider/action` join is UNAMBIGUOUS — no key contains the `/` delimiter.
 *
 * Adding a catalog action therefore fails CI until `integration-write.ts` is updated.
 */
import { describe, expect, it } from "vitest";
import {
  INTEGRATION_CATALOG,
  INTEGRATION_WRITE_ACTIONS,
  getIntegrationAction,
  isIntegrationWriteAction,
} from "../src/index";

/** The write keys the catalog itself implies. Keyed off the RECORD key (what a node's
 *  `config.provider` indexes and what `getIntegrationAction` looks up), not `provider.key`. */
function catalogWriteKeys(): string[] {
  const out: string[] = [];
  for (const [providerKey, provider] of Object.entries(INTEGRATION_CATALOG)) {
    for (const action of provider.actions) {
      if (action.write) out.push(`${providerKey}/${action.key}`);
    }
  }
  return out.sort();
}

describe("integration write-set drift (#910)", () => {
  it("classifies EVERY catalog action exactly as its own `write` flag", () => {
    const mismatches: string[] = [];
    let seen = 0;
    for (const [providerKey, provider] of Object.entries(INTEGRATION_CATALOG)) {
      for (const action of provider.actions) {
        seen++;
        const expected = action.write === true;
        const actual = isIntegrationWriteAction(providerKey, action.key);
        if (actual !== expected) {
          mismatches.push(
            `${providerKey}/${action.key}: catalog write=${expected}, write-set says ${actual}`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
    // Guard the guard: if the catalog were ever empty/unloaded, the loop above would pass
    // vacuously and this test would protect nothing.
    expect(seen).toBeGreaterThan(100);
    expect(Object.keys(INTEGRATION_CATALOG).length).toBeGreaterThan(30);
  });

  it("holds no key the catalog does not have (catches a stale/deleted action)", () => {
    expect([...INTEGRATION_WRITE_ACTIONS].sort()).toEqual(catalogWriteKeys());
  });

  it("agrees with the catalog lookup it replaced, for every action", () => {
    // The literal pre-change expression, asserted against the new one. If someone reverts
    // handleIntegration to the catalog lookup, or changes either side, this pins them together.
    for (const [providerKey, provider] of Object.entries(INTEGRATION_CATALOG)) {
      for (const action of provider.actions) {
        const viaCatalog = !!getIntegrationAction(providerKey, action.key)
          ?.write;
        expect(isIntegrationWriteAction(providerKey, action.key)).toBe(
          viaCatalog,
        );
      }
    }
  });

  it("keeps the `provider/action` join unambiguous", () => {
    for (const [providerKey, provider] of Object.entries(INTEGRATION_CATALOG)) {
      expect(providerKey).not.toContain("/");
      for (const action of provider.actions) {
        expect(action.key).not.toContain("/");
      }
    }
  });

  it("falls to READ (retryable) for an unknown provider/action, as the catalog lookup did", () => {
    // Unchanged semantics: `getIntegrationAction(...)?.write` was `undefined` → falsy for these.
    // The save gate (`validateGraph`) is what rejects unknown pairs; the interpreter must not throw.
    expect(isIntegrationWriteAction("nope", "create_thing")).toBe(false);
    expect(isIntegrationWriteAction("github", "no_such_action")).toBe(false);
    expect(isIntegrationWriteAction("", "")).toBe(false);
    // A `Set` has no prototype surface — the reason this is not a nested Record, where
    // `WRITES["constructor"].includes` would be a TypeError inside workflow code (#591/#766).
    expect(isIntegrationWriteAction("constructor", "toString")).toBe(false);
    expect(isIntegrationWriteAction("__proto__", "valueOf")).toBe(false);
    expect(isIntegrationWriteAction("toString", "constructor")).toBe(false);
  });
});

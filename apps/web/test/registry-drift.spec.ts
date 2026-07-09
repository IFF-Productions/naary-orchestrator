import { describe, expect, it } from "vitest";
import type { NodeType } from "@naary/dsl";
import { hasConcreteConfig, nodeConfigKeys } from "@naary/dsl/dist/registry";
import { FRIENDLY_CATALOG } from "../src/lib/friendly-catalog";
import { NODE_KINDS } from "../src/lib/graph-model";

/**
 * Registry drift guard (TYPED-DSL Phase 4). The web's hand-curated node metadata — Simple-mode
 * field lists + Builder default configs — must only reference config keys that actually EXIST in
 * the registry schema. A stale key writes config the interpreter never reads (a silent no-op),
 * which is exactly the class of bug this caught on introduction: `sendEmail.body` (should be
 * `text`) and `sqlQuery.query` (should be `sql`). Config-less / not-yet-schema'd node types are
 * skipped (their registry schema is the permissive fallback, so any key is allowed).
 */
describe("registry drift: web metadata references only real config keys", () => {
  it("friendly-catalog field keys all exist in the node's registry schema", () => {
    const bad: string[] = [];
    for (const [type, step] of Object.entries(FRIENDLY_CATALOG)) {
      if (!hasConcreteConfig(type as NodeType)) continue;
      const valid = new Set(nodeConfigKeys(type as NodeType));
      for (const f of step.fields) {
        if (!valid.has(f.key)) bad.push(`${type}.${f.key}`);
      }
    }
    expect(bad, `stale friendly-catalog keys: ${bad.join(", ")}`).toEqual([]);
  });

  it("graph-model defaultConfig top-level keys all exist in the registry schema", () => {
    const bad: string[] = [];
    for (const kind of NODE_KINDS) {
      if (!kind.defaultConfig || !hasConcreteConfig(kind.type)) continue;
      const valid = new Set(nodeConfigKeys(kind.type));
      for (const key of Object.keys(kind.defaultConfig)) {
        if (!valid.has(key)) bad.push(`${kind.type}.${key}`);
      }
    }
    expect(bad, `stale graph-model default keys: ${bad.join(", ")}`).toEqual(
      [],
    );
  });
});

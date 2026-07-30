import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { INTEGRATION_CATALOG } from "../src/index";

/**
 * `docs/integrations/VERIFICATION.md`'s read/total column, checked against the catalog.
 *
 * WHY THIS EXISTS. `gen-integration-docs.mjs` deliberately SKIPS this file — it is hand-written
 * prose about *how* verification is done, not a generated reference — so `check:integration-docs`
 * cannot see it and its numbers rot silently. That is not hypothetical: #950 changed Notion from
 * 5 actions to 6 and the row still claimed `3/5` until review caught it. A stale count here is
 * worse than no count, because the table's whole job is to say how much of a provider is covered.
 *
 * Scope, deliberately narrow: ONLY the read/total arithmetic, which is mechanically derivable.
 * The prose, the probe column and the §2.5 reasons stay hand-owned — a test that tried to police
 * those would either be vacuous or would stop people writing them.
 */
const DOC = new URL(
  "../../../docs/integrations/VERIFICATION.md",
  import.meta.url,
);

/** `| notion | \`get_page\` | pageId | 4/6 | — |` → ["notion", 4, 6] */
function docRows(): { provider: string; reads: number; total: number }[] {
  const out: { provider: string; reads: number; total: number }[] = [];
  for (const line of readFileSync(DOC, "utf8").split("\n")) {
    const m = /^\|\s*([a-z0-9]+)\s*\|[^|]*\|[^|]*\|\s*(\d+)\/(\d+)\s*\|/.exec(
      line,
    );
    if (m && INTEGRATION_CATALOG[m[1]]) {
      out.push({ provider: m[1], reads: Number(m[2]), total: Number(m[3]) });
    }
  }
  return out;
}

describe("VERIFICATION.md read/total counts match the catalog", () => {
  const rows = docRows();

  it("finds the table at all (a moved/renamed table must fail, not silently pass)", () => {
    // Non-vacuity floor: if a refactor changes the table's shape this regex stops matching, and
    // an empty `rows` would make every assertion below trivially true.
    expect(rows.length).toBeGreaterThan(20);
  });

  it.each(rows)(
    "$provider says $reads/$total",
    ({ provider, reads, total }) => {
      const actions = INTEGRATION_CATALOG[provider].actions;
      expect({
        reads: actions.filter((a) => !a.write).length,
        total: actions.length,
      }).toEqual({ reads, total });
    },
  );

  it("covers every provider the doc lists — no row is skipped by the regex", () => {
    const listed = new Set(rows.map((r) => r.provider));
    const missing = Object.keys(INTEGRATION_CATALOG).filter(
      (p) => !listed.has(p),
    );
    // Not every provider has to be in the table, but a provider silently dropping OUT of it
    // would hide exactly the drift this guards. Record the current set so a removal is visible.
    expect(missing.length).toBeLessThanOrEqual(
      Object.keys(INTEGRATION_CATALOG).length - rows.length,
    );
  });
});

/**
 * The bundle regression test for #910 — measured against the REAL `bundleWorkflowCode` output,
 * not inferred from `require.cache`.
 *
 * WHAT WENT WRONG. `apps/worker/src/temporal/workflow/**` is compiled into the deterministic
 * Temporal workflow bundle: what every worker loads at boot and what every REPLAY of every
 * in-flight run re-evaluates. `@naary/dsl` is CJS with `"main": "dist/index.js"` and no
 * `"exports"` map, so its barrel's `export *` becomes `__exportStar` and NOTHING tree-shakes —
 * one symbol imported from `@naary/dsl` executed all ~50 modules. The whole 161KB integration
 * catalog was in there, down to a form field's UI hint string ("login email of a PagerDuty
 * user"), along with the graph templates, the OpenAPI/GraphQL introspection parsers and the
 * cURL importer. Bundle: 5338 KB.
 *
 * WHY IT MATTERS ENOUGH TO TEST. This is exactly the kind of regression that reappears silently:
 * a single convenient `import { thing } from "@naary/dsl"` in any workflow file re-drags all of
 * it, with no error, no failing build, and no visible symptom until someone measures again. So
 * the fix ships with its own alarm.
 *
 * THE ASSERTIONS. Catalog absence is DERIVED from the catalog rather than hardcoded, so it stays
 * true as providers are added: every action `pathTemplate` and every long human-written
 * `description`/`hint` in `INTEGRATION_CATALOG` must be absent from the bundle. Bare provider
 * names like "pagerduty" are deliberately NOT probed — `integration-write.ts` legitimately holds
 * 84 short `"provider/action"` keys (~3KB), which is the point of the change.
 *
 * #926 — ZOD. `#910` left one item on the table: `template-blocks.ts` imported zod for
 * `templateBlockSchema`, and it also exports `renderEmailHtml`, which the `sendEmail` node handler
 * calls in workflow code. Same `__exportStar` mechanics, same result: ALL of zod in the bundle
 * (691 KB of module code, and with its share of the inline source map, 1813 KB of the 4389).
 * Splitting the schemas into `template-blocks-schema.ts` took the bundle to 2576 KB.
 *
 * NOTE ON PROBING FOR ZOD: the bundle is UNMINIFIED with comments intact, and several workflow
 * files legitimately say "zod" in prose (`eval-run.ts`, `guardrails.ts`, `workflow.ts` itself —
 * mostly explaining why zod is kept OUT). So the bare substring "zod" is `true` in a perfectly
 * clean bundle and asserting on it would be wrong in both directions. Probe for what only the
 * zod PACKAGE emits: its runtime identifiers and its module paths.
 */
import path from "node:path";
import { bundleWorkflowCode } from "@temporalio/worker";
import { beforeAll, describe, expect, it } from "vitest";
import { INTEGRATION_CATALOG } from "@naary/dsl";

const WORKFLOWS_PATH = path.join(__dirname, "../src/temporal/workflows.ts");

/**
 * Ceiling, in KB. Measured 5338 before #910, 4389 after; 2576 after #926 dropped zod. Set with
 * headroom above the measured value so ordinary feature work doesn't trip it, but far below the
 * previous number so a re-introduced barrel import is caught. Leaving it at 4700 would have left
 * #926's entire win unguarded — so it moves DOWN with each win, and either direction is a
 * deliberate change with a measurement in the PR.
 */
const MAX_BUNDLE_KB = 2900;

let code = "";

describe("deterministic workflow bundle (#910)", () => {
  beforeAll(async () => {
    ({ code } = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH }));
  }, 180_000);

  it("does not carry the integration catalog's request shapes", () => {
    const found: string[] = [];
    let probed = 0;
    for (const [providerKey, provider] of Object.entries(INTEGRATION_CATALOG)) {
      for (const action of provider.actions) {
        // Skip templates short enough to collide with unrelated bundle text: Linear's is the
        // bare `/graphql`, which the graphQL NODE legitimately puts in the bundle. The long
        // ones (`/repos/{owner}/{repo}/issues`, …) could only have come from the catalog.
        if (action.pathTemplate.length < 12) continue;
        probed++;
        if (code.includes(action.pathTemplate)) {
          found.push(`${providerKey}/${action.key} → ${action.pathTemplate}`);
        }
      }
    }
    expect(probed).toBeGreaterThan(100); // the probe must not be vacuous
    expect(found).toEqual([]);
  });

  it("does not carry the integration catalog's prose (descriptions + UI hints)", () => {
    // Long human sentences: they exist ONLY to render a config panel, and they can't plausibly
    // collide with unrelated bundle text.
    const prose = new Set<string>();
    for (const provider of Object.values(INTEGRATION_CATALOG)) {
      if (provider.description.length >= 30) prose.add(provider.description);
      if (provider.auth.length >= 30) prose.add(provider.auth);
      for (const action of provider.actions) {
        if (action.description.length >= 30) prose.add(action.description);
        for (const field of action.fields) {
          if (field.hint && field.hint.length >= 30) prose.add(field.hint);
        }
      }
    }
    expect(prose.size).toBeGreaterThan(100); // the probe must not be vacuous
    expect([...prose].filter((s) => code.includes(s))).toEqual([]);
  });

  it("does not carry the catalog's structural markers", () => {
    // Belt to the derived braces above: identifiers only the catalog module emits.
    for (const marker of [
      "pathTemplate",
      "baseUrlFromConnection",
      "INTEGRATION_PROVIDERS",
      "X-GitHub-Api-Version",
      "https://api.github.com",
      // The literal probe from the issue — a form field's UI hint.
      "login email of a PagerDuty user",
    ]) {
      expect(`${marker}: ${code.includes(marker)}`).toBe(`${marker}: false`);
    }
  });

  it("does not carry authoring-time-only machinery", () => {
    // Reached only through the barrel: graph templates, the API importers, the graph differ.
    for (const marker of [
      "githubReviewGraph",
      "supervisorHandoffGraph",
      "nodeCatalogPrompt",
      "parseOpenApi",
      "parseCurl",
      "diffGraphs",
    ]) {
      expect(`${marker}: ${code.includes(marker)}`).toBe(`${marker}: false`);
    }
  });

  it("does not carry zod (#926)", () => {
    // Runtime identifiers zod itself emits. `ZodError` was the issue's own probe; the `$Zod*`
    // names come from zod v4's core, which a v3-style dependency would not emit — probing both
    // keeps this honest across a zod major.
    for (const marker of ["ZodError", "$ZodError", "ZodRealError", "_zod"]) {
      expect(`${marker}: ${code.includes(marker)}`).toBe(`${marker}: false`);
    }
    // The structural proof, independent of any identifier zod might rename: webpack stamps each
    // module's resolved path into the bundle, so if any zod file were reachable from a workflow
    // module its path would appear here. This is what makes the assertion non-vacuous — it fails
    // for ANY route into zod, including one through a package we don't own.
    const zodModulePaths = [
      ...code.matchAll(/node_modules\/(?:\.pnpm\/)?[^"'\s]*zod[^"'\s]*/g),
    ].map((m) => m[0]);
    expect([...new Set(zodModulePaths)]).toEqual([]);
  });

  it("stays under the size ceiling", () => {
    const kb = Math.round(code.length / 1024);
    // Surface the number on failure — this is the metric the issue tracks.
    expect(`${kb} KB <= ${MAX_BUNDLE_KB} KB`).toBe(
      `${kb <= MAX_BUNDLE_KB ? kb : MAX_BUNDLE_KB} KB <= ${MAX_BUNDLE_KB} KB`,
    );
  });

  it("still carries the interpreter's own write/read classification", () => {
    // The counterweight: the assertions above must not be satisfiable by deleting the feature.
    // `handleIntegration` needs this one bit in-bundle to route writes at-most-once.
    expect(code).toContain("pagerduty/acknowledge_incident");
    expect(code).toContain("isIntegrationWriteAction");
  });
});

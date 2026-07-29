/**
 * The EAGER browser-bundle regression test for #928 — measured against a REAL `vite build` of
 * `apps/web`, not inferred from imports.
 *
 * WHAT WENT WRONG. `components/TemplateContentBlock.tsx` imported `renderEmailHtml` from the
 * `@naary/dsl` BARREL. It is re-exported by `components/index.ts`, which `AppShell` pulls, so it
 * sits in the chunk `index.html` MODULEPRELOADS — the bytes every visitor downloads before the
 * first screen paints, including the public form/chat pages. That one import put the 161KB
 * integration catalog AND all of zod on the critical path for a 2KB pure function.
 *
 * THE MECHANISM IS NOT THE WORKER'S. #910/#926 are about CJS `__exportStar` defeating
 * tree-shaking. That does NOT apply here: `vite.config.ts` aliases `@naary/dsl` to its TS SOURCE,
 * and rollup tree-shakes per module fine (`registry.ts`, `curl-import.ts` and friends already land
 * in lazy route chunks). What leaks is CHUNK COLOURING: chunk assignment follows the barrel's
 * dependency edges, so a barrel import from an eagerly-loaded module colours every module the
 * barrel touches into the eager chunk. The catalog is therefore not *removed* from the bundle by
 * the fix — the canvas/integrations screens genuinely need it — it is moved off the critical path
 * into the lazy route chunks that use it. That is exactly what this test asserts: absent from the
 * eager set, still present SOMEWHERE.
 *
 * WHY TEST IT. Same reason as `apps/worker/test/workflow-bundle.spec.ts`: `import { x } from
 * "@naary/dsl"` in any eagerly-reachable file silently re-drags it all, with no error, no failing
 * build and no visible symptom until someone measures again. The two catalog-free deep imports
 * (`@naary/dsl/dist/template-blocks`) that keep this true are a comment in a file, and comments
 * do not fail CI.
 *
 * NOTE ON PROBING. Every marker is asserted in BOTH directions — absent from the eager set, and
 * present somewhere in the build. A one-sided absence check would silently go vacuous the moment
 * a minifier renames the thing (`INTEGRATION_PROVIDERS` is a top-level const and survives
 * nowhere, which is precisely why it is not probed here); the paired form can only pass while the
 * probe still has something to find.
 */
import path from "node:path";
import { INTEGRATION_CATALOG } from "@naary/dsl";
import { build } from "vite";
import { beforeAll, describe, expect, it } from "vitest";

const WEB_ROOT = path.join(__dirname, "..");

/**
 * Ceiling for the eager set, in KB (raw, pre-gzip). Measured 762 before this change, 590 after.
 * Set with headroom so ordinary feature work doesn't trip it, but far below the old number so a
 * re-introduced barrel import is caught. This is the only assertion that catches a DIFFERENT
 * heavy import sneaking onto the critical path — the probes below only know about the catalog.
 * Moves down with each win; either direction is a deliberate change with a measurement in the PR.
 */
const MAX_EAGER_KB = 660;

/** Chunks the browser must download before the first paint: the entry plus its transitive STATIC
 *  imports — the exact set vite emits `<link rel="modulepreload">` for. Dynamic imports (the lazy
 *  route chunks) are deliberately excluded; that is where the catalog is supposed to be. */
type Chunk = {
  fileName: string;
  code: string;
  imports: string[];
  isEntry: boolean;
};

let eager: Chunk[] = [];
let all: Chunk[] = [];

const inEager = (s: string) => eager.some((c) => c.code.includes(s));
const inBuild = (s: string) => all.some((c) => c.code.includes(s));

/** Absent from the critical path, still present in the build. Both halves matter — see header. */
function expectMovedOffCriticalPath(marker: string) {
  expect(`${marker}: eager=${inEager(marker)} inBuild=${inBuild(marker)}`).toBe(
    `${marker}: eager=false inBuild=true`,
  );
}

describe("eager web bundle (#928)", () => {
  beforeAll(async () => {
    // `write: false` keeps the real `apps/web/dist` (the deploy artifact) untouched. The app's own
    // vite.config.ts is loaded explicitly so the `@naary/dsl*` source aliases apply — resolving
    // through the package's CJS dist instead would measure a bundle we never ship.
    //
    // NODE_ENV is forced to production for the duration: vitest sets it to "test", and
    // @vitejs/plugin-react reads it, so the default build here swaps in React's DEV jsx runtime
    // and measures 807 KB eager instead of the 590 KB we actually ship. Restored in `finally` so
    // nothing else in this worker sees the change.
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    let result: unknown;
    try {
      result = await build({
        root: WEB_ROOT,
        configFile: path.join(WEB_ROOT, "vite.config.ts"),
        logLevel: "silent",
        mode: "production",
        build: { write: false },
      });
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }
    const outputs = (Array.isArray(result) ? result : [result]) as {
      output: unknown[];
    }[];
    all = outputs
      .flatMap((o) => o.output)
      .filter((o): o is Chunk => (o as { type?: string }).type === "chunk");

    const entry = all.find((c) => c.isEntry);
    if (!entry) throw new Error("no entry chunk in the vite build output");
    const seen = new Map<string, Chunk>();
    const walk = (c: Chunk) => {
      if (seen.has(c.fileName)) return;
      seen.set(c.fileName, c);
      for (const f of c.imports) {
        const dep = all.find((x) => x.fileName === f);
        if (dep) walk(dep);
      }
    };
    walk(entry);
    eager = [...seen.values()];
  }, 180_000);

  it("built something worth asserting on", () => {
    // Non-vacuity for every test below: a build that emitted one chunk, or an eager set that
    // somehow lost the app, would make absence checks trivially true.
    expect(all.length).toBeGreaterThan(20);
    expect(eager.length).toBeGreaterThan(3);
    // And it is the PRODUCTION build, not vitest's NODE_ENV=test one — React's dev jsx runtime
    // gets its own chunk, which is the visible symptom if the env override above ever stops
    // working. Measuring the dev build would inflate the ceiling by ~200 KB.
    expect(
      eager.map((c) => c.fileName).filter((f) => f.includes("jsx-dev")),
    ).toEqual([]);
  });

  it("keeps the integration catalog's request shapes off the critical path", () => {
    const found: string[] = [];
    let probed = 0;
    for (const [providerKey, provider] of Object.entries(INTEGRATION_CATALOG)) {
      for (const action of provider.actions) {
        // Skip templates short enough to collide with unrelated bundle text (Linear's is the bare
        // `/graphql`). The long ones could only have come from the catalog.
        if (action.pathTemplate.length < 12) continue;
        probed++;
        if (inEager(action.pathTemplate)) {
          found.push(`${providerKey}/${action.key} → ${action.pathTemplate}`);
        }
      }
    }
    expect(probed).toBeGreaterThan(100); // the probe must not be vacuous
    expect(found).toEqual([]);
  });

  it("keeps the integration catalog's prose (descriptions + UI hints) off the critical path", () => {
    // Long human sentences: they exist ONLY to render a config panel, and can't plausibly collide
    // with unrelated bundle text.
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
    expect([...prose].filter((s) => inEager(s))).toEqual([]);
  });

  it("keeps the catalog's structural markers off the critical path", () => {
    // Object KEYS and data strings, not top-level identifiers — the build is minified, so only
    // these survive at all. Each is asserted absent-here / present-somewhere.
    for (const marker of [
      "pathTemplate",
      "baseUrlFromConnection",
      "authScheme",
      "X-GitHub-Api-Version",
      // The literal probe from #910 — a form field's UI hint.
      "login email of a PagerDuty user",
      "acknowledge_incident",
    ]) {
      expectMovedOffCriticalPath(marker);
    }
  });

  it("keeps zod off the critical path", () => {
    // The `$Zod*` names come from zod v4's core; `_zod` is the brand it stamps on every schema.
    // Both reach the browser only through `template-blocks-schema.ts`/the registry, which are
    // save-gate machinery no eagerly-loaded screen needs.
    for (const marker of ["$ZodError", "_zod"]) {
      expectMovedOffCriticalPath(marker);
    }
  });

  it("stays under the eager size ceiling", () => {
    const kb = Math.round(
      eager.reduce((n, c) => n + Buffer.byteLength(c.code), 0) / 1024,
    );
    // Surface the number on failure — this is the metric #928 tracks.
    expect(`${kb} KB <= ${MAX_EAGER_KB} KB`).toBe(
      `${kb <= MAX_EAGER_KB ? kb : MAX_EAGER_KB} KB <= ${MAX_EAGER_KB} KB`,
    );
  });

  it("still ships the template renderer eagerly", () => {
    // The counterweight: the assertions above must not be satisfiable by deleting the feature or
    // lazy-loading TemplateContentBlock. This is `renderEmailHtml`'s own image-block markup, which
    // reaches the eager set only via components/index.ts → TemplateContentBlock.
    expect(inEager('max-width:100%" />')).toBe(true);
  });
});

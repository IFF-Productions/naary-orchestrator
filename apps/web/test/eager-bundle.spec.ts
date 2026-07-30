/**
 * The EAGER browser-bundle regression test for #928 (catalog + zod) and its follow-up (the
 * Firebase auth SDK) — measured against a REAL `vite build` of `apps/web`, not inferred from
 * imports.
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
 * probe still has something to find. `signInWithPopup` is deliberately NOT probed for the same
 * reason: it is minified away entirely (`inBuild=false`), so asserting its absence proves nothing.
 *
 * THE SECOND SUBJECT: FIREBASE. `firebase` was 138 KB raw / 41.5 KB gzip of the eager set,
 * because `auth/AuthProvider` (mounted above the router, so on every page) and `lib/api/*`
 * (`getBearerToken`) both imported `lib/firebase` statically. `lib/firebase-lazy.ts` is now the
 * async boundary: nothing eager may have a STATIC edge to `lib/firebase`. Same colouring
 * mechanism, same failure mode — one `import { getBearerToken } from "./firebase"` in an eagerly
 * reachable file puts all of it back with no error and no failing build.
 *
 * Those tests probe rollup's MODULE IDS as well as chunk text. Module ids are the direct
 * statement of the invariant ("no eager chunk contains a module from @firebase") and, unlike
 * minified text, they cannot go vacuous by renaming.
 */
import path from "node:path";
import { INTEGRATION_CATALOG } from "@naary/dsl";
import { build } from "vite";
import { beforeAll, describe, expect, it } from "vitest";

const WEB_ROOT = path.join(__dirname, "..");

/**
 * Ceiling for the eager set, in KB (raw, pre-gzip). Measured 765 before #928, 590 after it, and
 * 455 after the Firebase boundary. Set with headroom so ordinary feature work doesn't trip it,
 * but far below the previous number so a re-introduced static import is caught. This is the only
 * assertion that catches a DIFFERENT heavy import sneaking onto the critical path — the probes
 * below only know about the catalog and Firebase. Moves down with each win; either direction is a
 * deliberate change with a measurement in the PR.
 */
const MAX_EAGER_KB = 500;

/** Chunks the browser must download before the first paint: the entry plus its transitive STATIC
 *  imports — the exact set vite emits `<link rel="modulepreload">` for. Dynamic imports (the lazy
 *  route chunks) are deliberately excluded; that is where the catalog is supposed to be. */
type Chunk = {
  fileName: string;
  code: string;
  imports: string[];
  dynamicImports: string[];
  /** Rollup's per-chunk source-module map, keyed by absolute module id. */
  modules?: Record<string, unknown>;
  isEntry: boolean;
};

let eager: Chunk[] = [];
let all: Chunk[] = [];
/**
 * Per public route: eager + that route chunk's own static deps — what an anonymous visitor
 * actually loads. All three anonymous surfaces, not just the form: each is a separate chunk graph,
 * so a static firebase import added to ChatPage alone would slip past a FormPage-only check.
 */
let publicSets: { route: string; chunks: Chunk[] }[] = [];

const inEager = (s: string) => eager.some((c) => c.code.includes(s));
const inBuild = (s: string) => all.some((c) => c.code.includes(s));

/** Module ids (absolute source paths) held by a set of chunks. */
const moduleIds = (chunks: Chunk[]): string[] =>
  chunks.flatMap((c) => Object.keys(c.modules ?? {}));

/** Walk a chunk's transitive STATIC imports, seeding from `from`. */
function staticClosure(seed: Chunk[], from: Chunk): Chunk[] {
  const seen = new Map(seed.map((c) => [c.fileName, c]));
  const walk = (c: Chunk) => {
    if (seen.has(c.fileName)) return;
    seen.set(c.fileName, c);
    for (const f of c.imports) {
      const dep = all.find((x) => x.fileName === f);
      if (dep) walk(dep);
    }
  };
  walk(from);
  return [...seen.values()];
}

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

    // The public hosted pages (/f/:formId, /c/:chatId, /approve/:workflowId) are the visitors
    // #928's follow-up is about: anonymous, never sign in. What they download is the eager set
    // plus their route chunk's own static deps — the bot gate's Firebase import is DYNAMIC and
    // deliberately excluded here.
    publicSets = ["FormPage", "ChatPage", "ApprovePage"].map((route) => {
      const chunk = all.find((c) => c.fileName.includes(route));
      if (!chunk) throw new Error(`no ${route} chunk in the vite build output`);
      return { route, chunks: staticClosure(eager, chunk) };
    });
  }, 180_000);

  it("built something worth asserting on", () => {
    // Non-vacuity for every test below: a build that emitted one chunk, or an eager set that
    // somehow lost the app, would make absence checks trivially true.
    expect(all.length).toBeGreaterThan(20);
    expect(eager.length).toBeGreaterThan(3);
    // ONE entry, so `all.find(c => c.isEntry)` above is unambiguous. A second html/js entry
    // (an embed bundle, say) would make the walk measure whichever came first.
    expect(all.filter((c) => c.isEntry).map((c) => c.fileName)).toHaveLength(1);
    // The module-id probes below are only meaningful if rollup reported module ids at all.
    expect(moduleIds(eager).length).toBeGreaterThan(50);
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

  it("keeps the Firebase SDK off the critical path", () => {
    // Text markers that survive minification because they are string literals or wire constants
    // inside the SDK. Each asserted absent-eager AND present-in-build, so the probe cannot go
    // vacuous. `identitytoolkit` is the auth REST host; `recaptcha`/`_getAppCheckToken` are the
    // App Check half; `FirebaseError` is the shared core.
    for (const marker of [
      "identitytoolkit",
      "@firebase/auth",
      "recaptcha",
      "_getAppCheckToken",
      "firebase-app-check",
      "FirebaseError",
    ]) {
      expectMovedOffCriticalPath(marker);
    }
  });

  it("has no eager module from the Firebase SDK or the modules behind the boundary", () => {
    // The invariant stated directly, in module ids rather than minified text: nothing the entry
    // can reach STATICALLY may be a @firebase package, `lib/firebase.ts` (auth), `firebase-app.ts`
    // (initializeApp + App Check) or `lib/app-check.ts`. `lib/firebase-lazy.ts` and
    // `lib/firebase-env.ts` are the boundary itself and are SUPPOSED to be eager — hence matching
    // on the exact suffixes, not on the word "firebase".
    const behindBoundary = (id: string) =>
      /[\\/]@firebase[\\/]/.test(id) ||
      /[\\/]node_modules[\\/](\.pnpm[\\/])?firebase(@|[\\/])/.test(id) ||
      /[\\/]src[\\/]lib[\\/](firebase|firebase-app|app-check)\.ts$/.test(id);

    // Non-vacuity: those modules must exist somewhere, or "none are eager" proves nothing.
    expect(moduleIds(all).filter(behindBoundary).length).toBeGreaterThan(10);
    expect(moduleIds(eager).filter(behindBoundary)).toEqual([]);
  });

  it("serves every public hosted page without any Firebase module", () => {
    // The headline claim, as a test: an anonymous visitor of /f/:formId, /c/:chatId or
    // /approve/:workflowId downloads the eager set plus that route chunk's static deps — and no
    // part of that may be Firebase. (An `app_check` bot gate still mints an attestation token, but
    // reaches firebase-app through a DYNAMIC import, so it is not in this set and costs
    // firebase/app + firebase/app-check only, never the auth SDK.)
    //
    // Each route separately, because each is its own chunk graph: a static firebase import added
    // to ChatPage alone would pass a FormPage-only check.
    const offenders: string[] = [];
    for (const { route, chunks } of publicSets) {
      for (const id of moduleIds(chunks)) {
        if (
          /[\\/]@firebase[\\/]/.test(id) ||
          /[\\/]src[\\/]lib[\\/](firebase|firebase-app|app-check)\.ts$/.test(id)
        )
          offenders.push(`${route}: ${id}`);
      }
      // Non-vacuity: it really is that page's chunk set, not an empty one.
      expect(chunks.length).toBeGreaterThan(eager.length);
    }
    expect(offenders).toEqual([]);
  });

  it("still wires sign-in up — the boundary, not a deletion", () => {
    // The counterweight. Every assertion above is satisfiable by ripping Firebase out of the app
    // altogether; these three say the auth path is intact and merely moved:
    //   1. the boundary module itself is on the critical path (it is what defers the load);
    //   2. something in the build DYNAMICALLY imports the auth chunk (i.e. the seam is connected);
    //   3. the auth SDK is still shipped.
    const boundary = moduleIds(eager).filter((id) =>
      /[\\/]src[\\/]lib[\\/]firebase-lazy\.ts$/.test(id),
    );
    expect(boundary).toHaveLength(1);

    const authChunks = all.filter((c) =>
      Object.keys(c.modules ?? {}).some((id) =>
        /[\\/]src[\\/]lib[\\/]firebase\.ts$/.test(id),
      ),
    );
    expect(authChunks).toHaveLength(1);
    const authChunkName = authChunks[0].fileName;
    expect(all.some((c) => c.dynamicImports.includes(authChunkName))).toBe(
      true,
    );

    expect(inBuild("identitytoolkit")).toBe(true);
  });

  it("still ships the template renderer eagerly", () => {
    // The counterweight: the assertions above must not be satisfiable by deleting the feature or
    // lazy-loading TemplateContentBlock. This is `renderEmailHtml`'s own image-block markup, which
    // reaches the eager set only via components/index.ts → TemplateContentBlock.
    expect(inEager('max-width:100%" />')).toBe(true);
  });
});

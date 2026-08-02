/**
 * What lands at the DOC ROOT of the shipped web bundle — asserted against a REAL `vite build`,
 * not against `apps/web/public/`'s listing.
 *
 * WHAT WENT WRONG (#1049). `apps/web/public/mockServiceWorker.js` was MSW's request-interception
 * service worker, committed to `public/` because that is where `npx msw init` puts it by default.
 * Vite copies `public/` VERBATIM into `dist/`, and `apps/web/Dockerfile`'s runtime stage is a bare
 * `COPY --from=build /app/apps/web/dist /usr/share/nginx/html` — so it shipped, and was served from
 * the authenticated origin at `https://app.naar-y.com/mockServiceWorker.js`.
 *
 * It was inert (a service worker does nothing until something calls
 * `navigator.serviceWorker.register()`, and the production entry never does), but a registered
 * worker is scoped to the ORIGIN and PERSISTS ACROSS SESSIONS — it outlives the tab, the page and
 * the build that registered it. Anything that registered it once would silently intercept every
 * subsequent request for that user until explicitly unregistered. The fix moved the worker to
 * `.storybook/public/`, which Storybook serves via `staticDirs` and Vite never looks at.
 *
 * WHY THE TEST BUILDS. Regenerating the worker is a routine MSW operation — `npx msw init ./public`
 * or a `msw.workerDirectory` edit puts it straight back, with no error and no failing build. A test
 * that read `apps/web/public/` would be the same class of evidence as the config comment it is
 * meant to outlive; the artifact is what ships, so the artifact is what is asserted. Same standard
 * as `eager-bundle.spec.ts` and the nginx header script.
 *
 * NOTE ON THE BUILD CALL. `eager-bundle.spec.ts` uses `build: { write: false }` and reads rollup's
 * output objects. Neither works here: public/ files are copied by Vite's own fs logic during the
 * WRITE phase, so they are never rollup outputs, and `write: false` skips the copy altogether — an
 * absence check against that build would pass vacuously. Hence a real write to a scratch outDir
 * (`emptyOutDir` because it sits outside `root`), and `readdir` of what actually landed.
 *
 * IT IS AN ALLOWLIST, NOT A `mockServiceWorker.js` CHECK. A single-filename check says nothing
 * about the NEXT dev-only file to appear at the doc root, and each entry here is a claim that the
 * file is meant to be publicly served from the app's origin. Adding one is a decision; making it
 * here is how that decision gets made rather than defaulted into.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const WEB_ROOT = path.join(__dirname, "..");

/**
 * Every file the production bundle may serve outside the content-addressed `assets/` directory.
 * `assets/*` is rollup's own hashed output and is checked by `eager-bundle.spec.ts` instead.
 *
 *   index.html        the SPA shell.
 *   embed.js          the PUBLIC embed loader (docs/design/EMBEDDED-PUBLIC-PAGES.md) — tenants
 *                     paste `<script src="…/embed.js">` into their own sites, so it is required
 *                     to be here, at this exact unhashed url.
 *   naary-mark.svg    the favicon (`<link rel="icon">` in index.html).
 *   naary-flame.svg   the brand flame mark, shipped with the design system (#9).
 *
 * The IMAGE's doc root has one more: nginx:alpine ships its own `/usr/share/nginx/html/50x.html`,
 * and the Dockerfile's `COPY --from=build … /usr/share/nginx/html` MERGES into that directory
 * rather than replacing it (our index.html overwrites theirs; 50x.html survives). That is base
 * image behaviour, outside what a `vite build` can see — hence this list is 4 and the image is 5.
 */
const ALLOWED_ROOT_FILES = [
  "embed.js",
  "index.html",
  "naary-flame.svg",
  "naary-mark.svg",
];

/** Dev-only tooling that must never reach the production origin, by shape rather than by name. */
const DEV_ONLY = /mock|msw|service[-_.]?worker|\.stories\.|storybook/i;

/** Every file under `dir`, as paths relative to it, POSIX-separated. */
function listFiles(dir: string, prefix = ""): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? listFiles(path.join(dir, e.name), `${prefix}${e.name}/`)
        : [`${prefix}${e.name}`],
    );
}

let outDir = "";
let files: string[] = [];

describe("shipped web bundle: doc-root assets (#1049)", () => {
  beforeAll(async () => {
    // A scratch outDir keeps the real `apps/web/dist` (the deploy artifact) untouched. It sits
    // outside `root`, which is exactly when vite demands an explicit `emptyOutDir`.
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "naary-web-dist-"));
    await build({
      root: WEB_ROOT,
      configFile: path.join(WEB_ROOT, "vite.config.ts"),
      logLevel: "silent",
      mode: "production",
      build: { outDir, emptyOutDir: true },
    });
    files = listFiles(outDir);
  }, 180_000);

  afterAll(() => {
    if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("built something worth asserting on", () => {
    // Non-vacuity: every assertion below is an absence check, and an empty (or failed) build would
    // satisfy all of them. A real build emits the shell plus a hashed chunk graph.
    expect(files).toContain("index.html");
    expect(files.filter((f) => f.startsWith("assets/")).length).toBeGreaterThan(
      20,
    );
    // And the public/ copy really ran — otherwise "no dev-only file was copied" proves nothing.
    expect(files).toContain("embed.js");
    expect(fs.statSync(path.join(outDir, "embed.js")).size).toBeGreaterThan(
      100,
    );
  });

  it("serves nothing at the doc root but the allowlist", () => {
    const root = files.filter((f) => !f.includes("/")).sort();
    expect(root).toEqual(ALLOWED_ROOT_FILES);
  });

  it("copies no dev-only file out of public/, under any name", () => {
    // The headline claim of #1049, stated by SHAPE rather than by filename so a regenerate under a
    // different name, or in a subdirectory of public/, is caught too.
    //
    // Scoped to the COPIED files (everything outside `assets/`) on purpose. Rollup's names carry
    // an 8-char base64url hash, so an unscoped case-insensitive /msw/ has a ~1-in-30 chance per
    // build of matching inside one — a guard that fails builds at random gets deleted, which is
    // the outcome this test exists to prevent. Nothing is lost: `assets/` is rollup's own output,
    // and a regenerated worker can only reach the bundle via `public/`.
    const copied = files.filter((f) => !f.startsWith("assets/"));
    expect(copied.filter((f) => DEV_ONLY.test(f))).toEqual([]);
  });

  it("still keeps MSW's worker where Storybook serves it from", () => {
    // The counterweight. Everything above is satisfiable by deleting the worker outright, which
    // would silently break every story that mocks `/api`. Storybook's second staticDir
    // (`.storybook/public`, see .storybook/main.ts) is what makes the file reachable at
    // `/mockServiceWorker.js` — the url `worker.start()` fetches.
    const worker = path.join(
      WEB_ROOT,
      ".storybook",
      "public",
      "mockServiceWorker.js",
    );
    expect(fs.existsSync(worker)).toBe(true);
    // NOT in publicDir — that is the whole point, and where `npx msw init` would put it back.
    expect(
      fs.existsSync(path.join(WEB_ROOT, "public", "mockServiceWorker.js")),
    ).toBe(false);
  });
});

#!/usr/bin/env node
/**
 * Writes `docs/integrations/{provider}.md` for every provider in the catalog.
 *
 * Run: `pnpm gen:integration-docs` (builds @naary/dsl first, then runs this).
 * Enforced by: `packages/dsl/test/integration-docs.spec.ts`, which re-renders and diffs against
 * disk — same belt-and-braces as `check:api-types` does for `openapi.json`.
 *
 * Reads the BUILT dist deliberately: the catalog is TypeScript, and a stale dist has produced both
 * a false green and a false error in this repo before, so the wrapper script rebuilds first rather
 * than letting this file guess.
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const outDir = join(repoRoot, "docs", "integrations");

const { INTEGRATION_PROVIDERS } = await import(
  join(here, "..", "dist", "integrations.js")
);
const { INTEGRATION_PROSE } = await import(
  join(here, "..", "dist", "docs", "integration-prose.js")
);
const {
  renderIntegrationDoc,
  LIVE_VERIFIED,
  needsServerUrl: needsServerUrlFn,
} = await import(join(here, "..", "dist", "docs", "render.js"));

mkdirSync(outDir, { recursive: true });

const missingProse = INTEGRATION_PROVIDERS.filter(
  (p) => !INTEGRATION_PROSE[p.key],
).map((p) => p.key);
if (missingProse.length) {
  console.error(
    `No prose for: ${missingProse.join(", ")}\n` +
      `Add an entry to packages/dsl/src/docs/integration-prose.ts — a provider without setup ` +
      `instructions is a provider nobody can use.`,
  );
  process.exit(1);
}

let written = 0;
for (const provider of INTEGRATION_PROVIDERS) {
  const md = renderIntegrationDoc(provider, INTEGRATION_PROSE[provider.key], {
    liveVerified: LIVE_VERIFIED.has(provider.key),
  });
  writeFileSync(join(outDir, `${provider.key}.md`), md, "utf8");
  written++;
}

// The README's provider index, regenerated between markers so it can't fall behind the catalog
// either — an index that silently omits a provider is how a shipped integration stays invisible.
const BEGIN = "<!-- BEGIN GENERATED PROVIDER INDEX (pnpm gen:integration-docs) -->";
const END = "<!-- END GENERATED PROVIDER INDEX -->";
const readmePath = join(outDir, "README.md");
const readme = readFileSync(readmePath, "utf8");
const from = readme.indexOf(BEGIN);
const to = readme.indexOf(END);
if (from === -1 || to === -1) {
  console.error(
    `docs/integrations/README.md is missing the provider-index markers — restore:\n${BEGIN}\n${END}`,
  );
  process.exit(1);
}

const byCategory = new Map();
for (const p of INTEGRATION_PROVIDERS) {
  const prose = INTEGRATION_PROSE[p.key];
  if (!byCategory.has(prose.category)) byCategory.set(prose.category, []);
  byCategory.get(prose.category).push({ p, prose });
}

const index = [BEGIN, ""];
for (const category of [...byCategory.keys()].sort()) {
  index.push(`### ${category}`);
  index.push("");
  for (const { p, prose } of byCategory
    .get(category)
    .sort((a, b) => (a.p.label < b.p.label ? -1 : 1))) {
    const flags = [];
    if (needsServerUrlFn(p)) flags.push("needs a Server URL");
    if (!LIVE_VERIFIED.has(p.key)) flags.push("not live-verified");
    index.push(
      `- **[${p.label}](./${p.key}.md)** — ${prose.tagline}${
        flags.length ? ` <sub>(${flags.join(", ")})</sub>` : ""
      }`,
    );
  }
  index.push("");
}
index.push(END);

writeFileSync(
  readmePath,
  readme.slice(0, from) + index.join("\n") + readme.slice(to + END.length),
  "utf8",
);

// Flag orphans rather than deleting: a page whose provider was removed from the catalog is a
// judgement call (rename? deprecation?), not something a generator should silently bin.
const known = new Set(INTEGRATION_PROVIDERS.map((p) => `${p.key}.md`));
const orphans = readdirSync(outDir).filter(
  (f) =>
    f.endsWith(".md") &&
    !f.startsWith("_") &&
    !["README.md", "VERIFICATION.md"].includes(f) &&
    !known.has(f),
);

console.log(`wrote ${written} provider pages to docs/integrations/`);
if (orphans.length) {
  console.log(
    `note: ${orphans.length} page(s) have no catalog provider — delete or rename by hand: ${orphans.join(", ")}`,
  );
}

#!/usr/bin/env node
/**
 * Fail if a tracked `.mjs` file does not PARSE. Syntax only — nothing is executed.
 *
 * WHY THIS IS WORTH A CHECK: `.mjs` here is manual tooling, and CI validates each script's
 * committed OUTPUT rather than the script. `packages/dsl/scripts/extract-openapi-fixtures.mjs`
 * was a `SyntaxError` for over a day and across a release (#950 left an object literal unclosed,
 * fixed in #984) and nothing reported it: the drift spec that depends on it reads the committed
 * fixture JSON, so the script itself was never loaded. The first person to find out would have
 * been whoever next tried to add a provider. See #985.
 *
 * WHY A LOOP AND NOT `node --check $(git ls-files '*.mjs')`: **`node --check` only ever checks
 * its FIRST argument.** The rest are passed through as script argv and silently ignored, so the
 * one-liner exits 0 no matter how broken files 2..n are. On this repo it is actively misleading:
 * `apps/web/scripts/responsive-audit.mjs` sorts first and parses fine, so the one-liner would
 * have exited 0 on the very tree that carried the #950 break. Do not "simplify" this back.
 *
 * `--check` parses without evaluating, which is what makes this safe to run over scripts that
 * fetch, write files, or sit under a top-level await.
 *
 * Run: node scripts/check-mjs-syntax.mjs   (pnpm check:mjs-syntax)
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/** git ls-files rather than a directory walk: it already excludes gitignored output (dist,
 *  node_modules, coverage) and can't drift from what is actually committed. */
const tracked = execFileSync("git", ["ls-files", "-z", "*.mjs"], {
  // utf8, NOT latin1 — see scripts/check-control-bytes.mjs for why a latin1 decode would turn a
  // non-ASCII path into mojibake and silently drop it from the scan.
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\0")
  .filter(Boolean);

// Zero matches means the pathspec or `git ls-files` malfunctioned, not a legitimate state — there
// are tracked .mjs files, including this one. Passing here would be silence indistinguishable from
// a pass, which is the exact failure this check exists to prevent.
if (tracked.length === 0) {
  console.error(
    "No tracked .mjs files found. This repo has some (including this script), so the pathspec\n" +
      "or `git ls-files` is broken — refusing to report a pass on an empty scan.",
  );
  process.exit(1);
}

const offenders = [];
let checked = 0;
for (const file of tracked) {
  // Tracked but not on disk is normal in a dirty tree (a staged deletion). Skipping it here keeps
  // `node --check` from reporting a missing module as if it were a syntax error.
  if (!existsSync(file)) continue;
  try {
    // process.execPath, not a shell: no quoting hazard on a path with spaces, and one file per
    // invocation because --check ignores every argument after the first.
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe", encoding: "utf8" });
    checked += 1;
  } catch (err) {
    const stderr = String(err?.stderr ?? "");
    // node prints `path:line`, the offending source line, a caret, then `SyntaxError: …`. Take only
    // the line number off that first line: node resolves to an ABSOLUTE path whatever you pass it,
    // which in CI is a useless /home/runner/work/… prefix. Reprint against the repo-relative path.
    const line = stderr.split("\n")[0]?.match(/:(\d+)\s*$/)?.[1];
    const message = stderr.match(/^\w*Error:.*$/m)?.[0]?.trim();
    offenders.push({
      file,
      where: line ? `${file}:${line}` : file,
      message: message ?? (stderr.trim() || String(err)),
    });
    checked += 1;
  }
}

// Same reasoning as the empty-pathspec guard: if every tracked .mjs was skipped as absent (a tree
// of staged deletions), "All 0 files parse" would be a pass reporting on nothing.
if (checked === 0) {
  console.error(
    `All ${tracked.length} tracked .mjs file(s) were missing from the working tree, so nothing was\n` +
      "parsed — refusing to report a pass on a scan that looked at no files.",
  );
  process.exit(1);
}

if (offenders.length > 0) {
  console.error(`Syntax error(s) in ${offenders.length} tracked .mjs file(s):\n`);
  for (const o of offenders) {
    console.error(`  ${o.where || o.file}`);
    console.error(`    ${o.message}\n`);
  }
  console.error(
    [
      "These scripts are run by hand, and CI checks their committed OUTPUT rather than the script,",
      "so a parse error here can sit unnoticed for days (#985). Fix the file or delete it.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(`All ${checked} tracked .mjs files parse.`);

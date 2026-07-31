import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INTEGRATION_CATALOG } from "../src/integrations";

/**
 * Guards `scripts/extract-openapi-fixtures.mjs` — the refresh script — rather than its output.
 *
 * The drift spec reads the COMMITTED fixture JSON, so it stays green no matter what state the
 * script that produced those fixtures is in. That gap was not theoretical: #950 left the script
 * with an unclosed object literal (`zoom`'s closing brace), which nested the `notion` entry inside
 * `zoom` and made the whole file a SyntaxError. It parsed on no machine for over a day, across a
 * release, and nothing said so — `pnpm refresh:openapi-fixtures` is manual, so the first person to
 * find out would have been whoever next tried to add a provider.
 *
 * These are cheap, and each one is aimed at a failure the drift spec structurally cannot see.
 */
const SCRIPT = join(
  import.meta.dirname,
  "..",
  "scripts",
  "extract-openapi-fixtures.mjs",
);
const FIXTURE_DIR = join(import.meta.dirname, "fixtures", "openapi");

/** The script does network I/O under a top-level await, so it cannot simply be imported. Parsing it
 *  is the part worth asserting, and `node --check` does exactly that and nothing else. */
function syntaxError(): string | null {
  try {
    execFileSync(process.execPath, ["--check", SCRIPT], { stdio: "pipe" });
    return null;
  } catch (e) {
    return String((e as { stderr?: Buffer }).stderr ?? e);
  }
}

/**
 * SOURCES, read out of the script's TEXT.
 *
 * Deliberately not imported: importing runs the fetches. A regex over the top-level keys is enough
 * for the two questions below, and it fails loudly (empty set → the assertions below fail) if the
 * block is ever reshaped, rather than quietly matching nothing.
 */
function sourceKeys(): string[] {
  const src = readFileSync(SCRIPT, "utf8");
  const start = src.indexOf("const SOURCES = {");
  const end = src.indexOf("\n};", start);
  expect(
    start,
    "SOURCES block not found — has the script been reshaped?",
  ).toBeGreaterThan(-1);
  const block = src.slice(start, end);
  // Top-level keys only: two-space indent. A nested entry (the #950 bug) is indented four.
  return [...block.matchAll(/^ {2}(\w+): \{$/gm)].map((m) => m[1]);
}

describe("openapi fixture refresh script (#946)", () => {
  it("parses", () => {
    expect(syntaxError()).toBeNull();
  });

  // The #950 bug's actual signature. A missing closing brace does not remove a provider from the
  // file — it moves it INSIDE its neighbour, where it is invisible to the refresh and to a reader
  // skimming for the key. Every fixture we ship must be re-derivable, so every fixture needs a
  // top-level source.
  it("has a top-level SOURCES entry for every committed fixture", () => {
    const keys = new Set(sourceKeys());
    const fixtures = readdirSync(FIXTURE_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
    expect(fixtures.length).toBeGreaterThan(0);
    expect(fixtures.filter((f) => !keys.has(f))).toEqual([]);
  });

  // A SOURCES key the catalog does not have would fetch a spec nothing is checked against.
  it("names only providers the catalog actually has", () => {
    const known = new Set(Object.keys(INTEGRATION_CATALOG));
    expect(sourceKeys().filter((k) => !known.has(k))).toEqual([]);
  });
});

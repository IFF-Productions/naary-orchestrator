import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CLAUDE.md Tier-1 §2: workflow code is deterministic. Reading the environment is I/O, and worse
 * than most I/O here — a replay on a differently-configured worker would take a DIFFERENT branch
 * from the same history, which surfaces as a nondeterminism error at best and a silently wrong run
 * at worst.
 *
 * The property held before config centralization (docs/design/CONFIG-CENTRALIZATION.md verified it
 * by grep) and the slice-2 accessor module makes it easier to break by accident: `config.ts` is a
 * plain, innocuous-looking import that any file could pick up. So it is asserted, not grepped.
 */
const WORKFLOW_DIR = resolve(__dirname, "../src/temporal/workflow");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("workflow code reads no configuration", () => {
  const files = walk(WORKFLOW_DIR);

  /** Guards the guard: a moved/renamed directory must fail loudly, not pass vacuously. */
  it("is looking at the real workflow sources", () => {
    expect(files.length).toBeGreaterThan(3);
    expect(files.some((f) => f.endsWith("run-graph.ts"))).toBe(true);
  });

  /**
   * Matched against the RAW source — no comment stripping. A stripper is the tempting move here
   * and it's the wrong one: `\/\/[^\n]*` also eats everything after the `//` in a URL string, so
   * `const u = "https://x"; const e = process.env.FOO;` would be silently truncated to nothing and
   * sail past the assertion. A guard that can be fooled by an ordinary string literal isn't one.
   *
   * The cost is that even a COMMENT mentioning the pattern fails. That's fine, and no workflow
   * source does today — write it as "process env" in prose if you need to discuss it.
   */
  it.each(files.map((f) => [f.slice(WORKFLOW_DIR.length + 1), f]))(
    "%s touches neither process.env nor the config module",
    (_name, file) => {
      const src = readFileSync(file, "utf8");
      // Config belongs to boot (worker.ts) and to activities. If a workflow needs a configured
      // value, pass it in as a workflow argument or read it in an activity — both are recorded in
      // history, so a replay sees what the original run saw.
      expect(src).not.toMatch(/process\s*\.\s*env/);
      // Any string literal naming a config module, not just `... from "…/config"` — a
      // side-effect `import "../config"`, a `require("../config")` and a dynamic
      // `import("../config")` all reach the same module and all name it the same way.
      expect(src).not.toMatch(/["'][^"']*\/config(\.[jt]s)?["']/);
    },
  );
});

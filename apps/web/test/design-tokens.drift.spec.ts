import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A CSS custom property that doesn't exist falls back SILENTLY — and if the fallback is another
 * token, the element is painted with a different MEANING and nothing anywhere complains.
 *
 * That is not hypothetical. `ConnectionTestControl` rendered a successful connection test as:
 *
 *     color: "var(--ok, var(--brand))"
 *
 * `--ok` was never defined, so every "this connection works." message came out in the BRAND
 * ORANGE — reported by a user as "we should make this message green instead of red". The same
 * mistake had been copied into `ImportN8n`, an error message was falling back to `--ink-2` (grey),
 * and a warning to `--ink-3` (grey).
 *
 * WHAT THIS FORBIDS, precisely: referencing an undefined token whose fallback is another `var()`.
 *
 * A LITERAL fallback is fine and stays allowed — `var(--node-filter, #3f9e8f)` is a deliberate
 * override hook: the colour is right whether or not the token is ever defined, which is the
 * opposite of the failure above. ~40 node-palette accents use that shape intentionally.
 */

const SRC = resolve(__dirname, "../src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory())
      return name === "node_modules" ? [] : walk(p);
    return /\.(ts|tsx|css)$/.test(name) ? [p] : [];
  });
}

const files = walk(SRC);

/** Every token the stylesheets actually define, in any theme block. */
const defined = new Set(
  files
    .filter((f) => f.endsWith(".css"))
    .flatMap((f) => [
      ...readFileSync(f, "utf8").matchAll(/(--[a-z0-9-]+)\s*:/g),
    ])
    .map((m) => m[1]),
);

describe("design tokens referenced from code", () => {
  /** Guards the guard: a mis-resolved path would make everything below pass vacuously. */
  it("found the stylesheets and the sources", () => {
    expect(defined.size).toBeGreaterThan(50);
    expect(defined.has("--state-done")).toBe(true);
    expect(defined.has("--state-error")).toBe(true);
    expect(files.filter((f) => f.endsWith(".tsx")).length).toBeGreaterThan(50);
  });

  it("never falls back from an undefined token to another token", () => {
    const offenders: string[] = [];
    for (const file of files.filter((f) => !f.endsWith(".css"))) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const m of line.matchAll(/var\(\s*(--[a-z0-9-]+)\s*,\s*var\(/g)) {
          if (!defined.has(m[1])) {
            offenders.push(`${relative(SRC, file)}:${i + 1} → ${m[1]}`);
          }
        }
      });
    }
    // Named in the failure so the fix is obvious: define the token, or reference the one you mean.
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  /**
   * The status colours specifically. These carry MEANING — green means it worked — so a missing one
   * is worse than a missing decorative colour, and they're cheap to assert by name.
   */
  it.each([
    "--state-done",
    "--state-error",
    "--state-paused",
    "--state-idle",
    "--state-info",
    "--error-soft",
    "--paused-soft",
    "--done-soft",
  ])("%s is defined", (token) => {
    expect(defined.has(token)).toBe(true);
  });

  /**
   * Both themes must define every status colour, or one theme silently inherits the other's. The
   * stylesheet has a dark default plus a light override block; a status token present in only one
   * of them is a bug waiting for a theme toggle.
   */
  it("defines every status colour in both theme blocks", () => {
    const tokensCss = readFileSync(join(SRC, "styles/tokens.css"), "utf8");
    for (const token of ["--state-done", "--state-error", "--state-paused"]) {
      const count = [...tokensCss.matchAll(new RegExp(`${token}\\s*:`, "g"))]
        .length;
      expect(count, `${token} should be defined in both themes`).toBe(2);
    }
  });
});

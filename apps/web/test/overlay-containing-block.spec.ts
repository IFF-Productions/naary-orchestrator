/**
 * Regression guard for issue #694 ("Blur covers entire window, not partial box").
 *
 * The shared modal/drawer scrim is `.overlay { position: fixed; inset: 0;
 * backdrop-filter: blur(2px) }` (components/components.css) and every Dialog/Drawer
 * renders it INLINE inside the AppShell's routed-content wrapper — there is no portal.
 * `position: fixed` therefore only resolves against the viewport while no ancestor
 * creates a containing block for fixed descendants.
 *
 * `naaryFadeUp` (styles/tokens.css) animates `transform`. Giving it a fill-mode of
 * `both`/`forwards` RETAINS the final `translateY(0)`, and a retained transform is not
 * `none` — so the wrapper becomes that containing block, the scrim shrinks to the
 * content column, and `main`'s `overflow-y: auto` clips it. Measured before the fix:
 * a 1280x800 viewport gave a 1044x271 scrim at (236, 96). That is the reported bug.
 *
 * The fill-mode is also unnecessary: naaryFadeUp's `to` keyframe (opacity 1,
 * translateY(0)) is already the element's resting style, so nothing needs retaining.
 * This test is a source scan because apps/web's vitest environment is `node` — there
 * is no jsdom/testing-library here to render the shell and measure a rect. The
 * measurement itself was done with Playwright against a `vite preview` build.
 */
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../src");

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (/\.(tsx?|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("issue #694: nothing may retain a transform around the fixed .overlay scrim", () => {
  it("no naaryFadeUp usage carries a `both`/`forwards` fill-mode", async () => {
    const offenders: string[] = [];
    for (const file of await walk(SRC)) {
      const text = readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => {
        // Only the shorthand `animation:` form is used in this codebase; a fill-mode
        // keyword after the name is what makes the transform stick.
        if (
          /naaryFadeUp/.test(line) &&
          /\b(both|forwards)\b/.test(line) &&
          !line.trimStart().startsWith("//") &&
          !line.trimStart().startsWith("*")
        ) {
          offenders.push(
            `${path.relative(SRC, file)}:${i + 1} — ${line.trim()}`,
          );
        }
      });
    }
    expect(
      offenders,
      `A retained transform re-parents the fixed .overlay scrim to the content column ` +
        `(issue #694). Drop the fill-mode — naaryFadeUp's end state is already the ` +
        `resting style.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the .overlay scrim is still a viewport-fixed, blurred, inset-0 backdrop", () => {
    const css = readFileSync(
      path.join(SRC, "components/components.css"),
      "utf8",
    );
    const rule = css.match(/\.overlay\s*\{[^}]*\}/)?.[0] ?? "";
    // Guards the premise of the test above: if the scrim ever stops being
    // position:fixed (e.g. it gets portaled and made absolute), revisit this file.
    expect(rule).toMatch(/position:\s*fixed/);
    expect(rule).toMatch(/inset:\s*0/);
    expect(rule).toMatch(/backdrop-filter:\s*blur/);
  });
});

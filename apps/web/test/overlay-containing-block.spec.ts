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

/**
 * The innermost `{ … }` block containing `index` — a React style object, or a CSS rule body.
 *
 * Line-based matching is not enough here: see the test below for the reformatting that defeated
 * it. A declaration's fill-mode can sit several lines away from the animation name and still apply
 * to the same element, so the unit of inspection has to be the block, not the line.
 */
function enclosingBlock(text: string, index: number): string {
  let depth = 0;
  let start = -1;
  for (let i = index; i >= 0; i--) {
    if (text[i] === "}") depth++;
    else if (text[i] === "{") {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start === -1) return "";
  depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

/** Every `naaryFadeUp` occurrence in src that is an actual usage, not prose in a comment. */
async function fadeUpUsages(): Promise<{ file: string; block: string }[]> {
  const out: { file: string; block: string }[] = [];
  for (const file of await walk(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/naaryFadeUp/g)) {
      const block = enclosingBlock(text, m.index);
      // `animation:`/`animation-name:` in the same block ⇒ this is a usage, not the long
      // explanatory comment in AppShell (which names naaryFadeUp four times).
      if (/animation(?:-name)?\s*:/.test(block)) {
        out.push({ file: path.relative(SRC, file), block });
      }
    }
  }
  return out;
}

describe("issue #694: nothing may retain a transform around the fixed .overlay scrim", () => {
  it("the scan actually sees the naaryFadeUp call sites, including AppShell's", async () => {
    // The positive control this file was missing. Every assertion below is "no usage looks
    // wrong", which a scan that finds NO usages satisfies perfectly — so renaming the keyframe,
    // moving the sources, or a walk() that quietly stops matching would all leave this file
    // green forever. (#816's design-token guard asserts it found its stylesheets for exactly
    // this reason.) Pin both the volume and the ONE call site the bug was actually about.
    const usages = await fadeUpUsages();
    expect(usages.length).toBeGreaterThan(10);
    expect(
      usages.map((u) => u.file),
      "AppShell's routed-content wrapper IS the element that re-parented the scrim — if it no " +
        "longer animates naaryFadeUp, this whole file is guarding nothing",
    ).toContain("app/AppShell.tsx");
  });

  it("no naaryFadeUp usage carries a `both`/`forwards` fill-mode", async () => {
    // WHY THE BLOCK AND NOT THE LINE. This used to require `naaryFadeUp` and the fill-mode
    // keyword on the SAME LINE, and 20 of the 21 call sites are React inline styles — where the
    // natural way to add one is a SEPARATE property:
    //
    //     style={{ animation: "naaryFadeUp .28s ease", animationFillMode: "forwards" }}
    //
    // Verified: adding exactly that to AppShell.tsx — the one element whose retained transform
    // caused #694 — left this file GREEN. The guard was defeated by the very edit it exists to
    // catch. So match the enclosing declaration block, and both spellings of the property.
    const offenders: string[] = [];
    for (const { file, block } of await fadeUpUsages()) {
      const shorthand = /naaryFadeUp[^;"'`}\n]*\b(?:both|forwards)\b/.test(
        block,
      );
      const property =
        /animation-fill-mode\s*:\s*["']?\s*(?:both|forwards)/.test(block) ||
        /animationFillMode\s*:\s*["'](?:both|forwards)/.test(block);
      if (shorthand || property) {
        offenders.push(`${file} — ${block.replace(/\s+/g, " ").slice(0, 120)}`);
      }
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

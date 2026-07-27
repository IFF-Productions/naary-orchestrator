import { expect, test } from "@playwright/test";

/**
 * THE FIRST-RUN AUTHORING PATH (#830).
 *
 * Three defects were reported in one breath — an invisible caret, `{{` not opening the
 * autocomplete, and Build-with-AI inventing connection ids — and all three shared a signature:
 * the product LOOKED like it worked and failed later or silently. None was catchable by a suite
 * asking "does the code do what it says", and two had already been "fixed" once, targeting the
 * wrong element and the wrong layer.
 *
 * So this file asserts the SYMPTOM a user would report, not the mechanism:
 *
 *   - the caret is a colour you can SEE on the app's own dark surface (computed style), not
 *     "the theme has a cm-cursor rule";
 *   - typing `{{` OPENS the completion list, not "a completion source is registered".
 *
 * A mechanism test passes while the user still can't see their cursor. That is precisely how
 * the caret bug survived its first fix.
 */

/** Parse a CSS colour into rgb; null when it isn't one we can read. */
function rgb(v: string): [number, number, number] | null {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** WCAG relative luminance — how light a colour reads, 0 (black) to 1 (white). */
function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

test("authoring: the caret is visible and `{{` opens the reference list", async ({
  page,
}) => {
  await page.goto("/app/canvas");

  // The Agent node's prompt is an ExpressionField — the same CodeMirror editor the integration
  // node's string fields use, and the surface both reports came from ("text areas").
  await page.getByRole("button", { name: "Browse all nodes" }).click();
  await page.getByLabel("Search nodes").fill("Agent");
  await page
    .getByRole("button", { name: "Add Agent to canvas", exact: true })
    .click();
  await page
    .locator(".react-flow__node", { hasText: "Agent" })
    .first()
    .click();
  await expect(page.getByText("Parameters", { exact: true })).toBeVisible();

  const editor = page.locator(".cm-content").first();
  await expect(editor).toBeVisible();
  await editor.click();

  // ---- the caret ----------------------------------------------------------------------
  // `basicSetup` leaves drawSelection ON, which HIDES the native caret and draws `.cm-cursor`
  // as a border-left. The first fix set `caretColor` on `.cm-content` — styling the element
  // that is no longer drawn — so the cursor stayed CodeMirror's default black on a dark panel.
  const cursor = page.locator(".cm-cursor").first();
  await expect(cursor).toBeAttached();

  const { caret, surface } = await page.evaluate(() => {
    const c = document.querySelector(".cm-cursor") as HTMLElement | null;
    const content = document.querySelector(".cm-content") as HTMLElement | null;
    // `.cm-content` is TRANSPARENT, so its own background-color is rgba(0,0,0,0) — reading it
    // directly would compare the caret against BLACK regardless of the real theme, and would be
    // accidentally right on a dark UI and plainly wrong on a light one. Walk up to whatever
    // actually paints behind the caret.
    const painted = (el: HTMLElement | null): string => {
      for (let n: HTMLElement | null = el; n; n = n.parentElement) {
        const bg = getComputedStyle(n).backgroundColor;
        const alpha = /rgba?\([^)]*,\s*([\d.]+)\s*\)/.exec(bg);
        if (bg && bg !== "transparent" && (!alpha || Number(alpha[1]) > 0)) return bg;
      }
      return getComputedStyle(document.body).backgroundColor;
    };
    return {
      caret: c ? getComputedStyle(c).borderLeftColor : "",
      surface: painted(content),
    };
  });

  const caretRgb = rgb(caret);
  expect(caretRgb, `caret border-left-color was "${caret}"`).not.toBeNull();

  // The real complaint was "I can't see it", so measure CONTRAST against what it sits on —
  // asserting a specific hex would pass on a theme change that made it invisible again.
  const surfaceRgb = rgb(surface);
  expect(surfaceRgb, `could not read the surface behind the caret ("${surface}")`).not.toBeNull();
  const lc = luminance(caretRgb as [number, number, number]);
  const ls = luminance(surfaceRgb as [number, number, number]);
  const contrast = (Math.max(lc, ls) + 0.05) / (Math.min(lc, ls) + 0.05);
  expect(
    contrast,
    `caret ${caret} on ${surface} — only ${contrast.toFixed(1)}:1, that's the "no caret" report`,
  ).toBeGreaterThan(3);

  // ---- `{{` opens the reference list --------------------------------------------------
  // CodeMirror's `activateOnTyping` only fires on WORD characters, and `{` is not one — so the
  // completion source was correct and nothing ever opened it. Assert the list APPEARS.
  await page.keyboard.type("{{");
  await expect(page.locator(".cm-tooltip-autocomplete")).toBeVisible({
    timeout: 4000,
  });
});

/**
 * Regression guard for the canvas top bar at phone width (#964).
 *
 * apps/web's vitest environment is `node` — no jsdom/testing-library, so nothing here can render
 * a bar and measure a rect (same constraint as settings-touch-targets.spec.ts). The numbers below
 * were taken with Playwright against a built Storybook at 390×844; what this file guards is that
 * the SOURCE shapes they depend on don't quietly come back.
 *
 *                       name width      "Save & run" right edge (viewport 390)
 *   PhoneQuiet ........... 14px  ->  118      412  ->  364
 *   PhoneWithIssues ...... 14px  ->   68      462  ->  364
 *   PhoneCrowded ......... 14px  ->   32      499  ->  364
 *
 * 14px is the input's own padding — the name of the workflow being edited was not on screen in ANY
 * phone state, quiet included. It is `flex: 1 1 auto; minWidth: 0` against a `flex: none` cluster,
 * so it absorbed every pixel of shortfall while the cluster overflowed: the primary CTA sat
 * 22–109px past the right edge, under a root that is `overflow-x: hidden`, so it could not even be
 * scrolled to (#511's trap). Desktop (1440) and tablet (834) rects are byte-identical before and
 * after — the whole change is behind `phone`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const topBar = readFileSync(
  path.resolve(__dirname, "../src/screens/canvas/TopBar.tsx"),
  "utf8",
);

/** The right-hand action cluster, from its `marginLeft: auto` to the end of the header. */
const cluster = topBar.slice(
  topBar.indexOf('marginLeft: "auto"'),
  topBar.lastIndexOf("</header>"),
);

/** The "…" menu's items array — everything the map renders as a `role="menuitem"` row. */
const menuItems = topBar.slice(
  // From inside the popover, not from the file — the cluster's own `...(phone ? …)` flex rule
  // comes first in source order.
  topBar.indexOf("...(phone", topBar.indexOf('aria-label="Canvas actions"')),
  topBar.indexOf("satisfies MenuItem[]"),
);

describe("canvas top bar — phone row (#964)", () => {
  it("Save and Check flow are not buttons in the phone bar", () => {
    // The bar cannot hold three buttons plus a readable name at 390px. BOTH have to be gated —
    // either one coming back on its own is ~60-95px, enough to push the CTA off-screen again.
    expect(cluster).toMatch(
      /\{!phone && \(\s*<Button[\s\S]{0,300}?>\s*Save\s*<\/Button>/,
    );
    expect(cluster).toMatch(
      /\{!phone && \(\s*<Button[\s\S]{0,500}?\{checking \? "Checking…" : "Check flow"\}/,
    );
  });

  it("Save & run is NOT gated — the primary CTA keeps its place in the bar", () => {
    // Option three in the issue was to shrink the CTA to an icon on a phone. It stays a full,
    // labelled button; what moved is the two actions around it.
    // The LABEL expression, not the first mention of the string — "Save & run" also appears in
    // the comment above the menu's debug row, which sits inside this same cluster.
    const label = cluster.indexOf(`{busy ? "Running…" : "Save & run"}`);
    expect(label, "no Save & run button").toBeGreaterThan(-1);
    const run = cluster.slice(cluster.lastIndexOf("<Button", label), label);
    expect(run).toContain('variant="primary"');
    expect(run).not.toContain("phone");
  });

  it("both moved actions are rows in the existing ⋮ menu, not a second menu", () => {
    expect(menuItems).toContain('label: "Save"');
    expect(menuItems).toContain(`label: checking ? "Checking…" : "Check flow"`);
    // …and only at phone width, so the desktop menu is unchanged.
    expect(menuItems).toMatch(/\.\.\.\(phone\s*\?/);
    // ONE menu. A second overflow control would split where the same action lives by viewport.
    expect(topBar.match(/aria-label="More actions"/g)?.length).toBe(1);
  });

  it("the menu rows carry what a hover title cannot", () => {
    // A menu row has no `title` to hover, and on a touch screen a hover tooltip is nothing — so
    // `saveDeniedTitle` (the RBAC reason a save is refused) has to ride along as the hint, or it
    // disappears on exactly the layout that hides the button. The "Checking…" label swap is the
    // same argument: the bar's `status` text is desktop-only.
    expect(menuItems).toContain("hint: maySave ? undefined : saveDeniedTitle");
    expect(menuItems.match(/saveDeniedTitle/g)?.length).toBe(2);
    expect(menuItems).toContain('checking ? "Checking…"');
    // Gated exactly like the buttons they replace — moving an action must not widen who can run it.
    expect(menuItems).toContain("disabled: busy || !graphValid || !maySave");
    expect(menuItems).toContain(
      "disabled: busy || checking || !graphValid || !maySave",
    );
  });

  it("nothing else joins the phone cluster ungated", () => {
    // `flex: none` is only safe while the phone cluster is two controls: it cannot shrink, so
    // whatever it holds it takes, and the overflow leaves the right edge of an `overflow-x: hidden`
    // root — invisible AND unreachable. Everything else in there is already `!phone`; counting them
    // makes an ungated addition trip this instead of a phone.
    expect(cluster).toContain('{ flex: "none" }');
    expect(cluster).toContain("!phone && status &&");
    expect(cluster).toContain("!phone && runCapUsd != null");
    expect(cluster).toContain("!phone && <CanvasFeedbackButton");
    expect(cluster).toMatch(/\{!phone && \([\s\S]{0,300}?Build with AI/);
  });
});

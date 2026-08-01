/**
 * Regression guard for the canvas top bar BELOW DESKTOP — both narrow tiers, in one file because
 * they are one bar and their rules only make sense against each other.
 *
 *   `compact`  ≤1024px (tablet and down) — gives up LABELS AND REFERENCE TEXT, never controls
 *              (#989). Every action that is a button at 1440 is still a button at 834.
 *   `phone`    ≤640px — ~440px less to work with, so it also moves ACTIONS: Save and "Check flow"
 *              become rows in the "…" menu (#964).
 *
 * `compact` is a superset of `phone`, so a compact rule reaches a phone too. The phone tier's own
 * `it()` blocks below started life as `canvas-top-bar-phone.spec.ts` (PR #988) and were folded in
 * when #989 landed on top of them — one bar, one guard, rather than two files racing to describe
 * the same 56px row.
 *
 * apps/web's vitest environment is `node` — no jsdom/testing-library, so nothing here can render
 * a bar and measure a rect (same constraint as settings-touch-targets.spec.ts). The numbers below
 * were taken with Playwright against a built Storybook; what this file guards is that the SOURCE
 * shapes they depend on don't quietly come back.
 *
 * 390×844, "Save & run" right edge · name input width (#964):
 *
 *   PhoneQuiet ............ 412  ->  364      14  ->  118
 *   PhoneWithIssues ....... 462  ->  364      14  ->   68
 *   PhoneCrowded .......... 499  ->  364      14  ->   32
 *
 * 834×844, same two measures (#989):
 *
 *   Tablet ............... 1114 (+280 out)  ->  806 (ok)     60  ->  142
 *   TabletAiOpen ......... 1074 (+240 out)  ->  806 (ok)     60  ->  142
 *   TabletInvalid ........ 1215 (+381 out)  ->  806 (ok)     60  ->  142
 *   TabletQuiet ..........  923  (+89 out)  ->  806 (ok)     80  ->  197
 *   WithIssues ...........  974 (+140 out)  ->  806 (ok)     60  ->  197
 *
 * 14px and 60px are the name input's floors on the two branches (its own padding; its `minWidth`)
 * — the workflow being edited was not readably on screen in EITHER tier. The root is
 * `overflow-x: hidden` (styles/global.css), so the overflow was not clipped-but-scrollable: the
 * primary CTA did not exist for the user (#511's trap). Over the whole `Canvas/TopBar` set the
 * responsive audit goes 28 clipped elements / 19 unreachable controls -> 0 / 0 at 834.
 *
 * DESKTOP (1440) is byte-identical across both changes, every story — including the one that was
 * already 48px over there (`TabletInvalid`: the desktop bar's own unbounded `graphError`, a
 * pre-existing defect neither tier reaches — #997).
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

/** Source with `//` and `/* *\/` comments stripped — assertions must not pass on prose. */
const code = topBar
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const clusterCode = code.slice(
  code.indexOf('marginLeft: "auto"'),
  code.lastIndexOf("</header>"),
);

describe("canvas top bar — phone row (#964)", () => {
  it("Save and Check flow are not buttons in the phone bar", () => {
    // The bar cannot hold three buttons plus a readable name at 390px. BOTH have to be gated —
    // either one coming back on its own is ~60-95px, enough to push the CTA off-screen again.
    expect(cluster).toMatch(
      /\{!phone && \(\s*<Button[\s\S]{0,300}?>\s*Save\s*<\/Button>/,
    );
    // The LABEL expression is `compact`-aware as of #989 ("Check" from tablet down), so this
    // anchors on the gate and the `checking` swap, not on the words after it.
    expect(cluster).toMatch(
      /\{!phone && \(\s*<Button[\s\S]{0,900}?\{checking \? "Checking…"/,
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
    // RUN CAP widened from `!phone` to `!compact` in #989 — hidden for the whole compact range now.
    expect(cluster).toContain("!compact && runCapUsd != null");
    expect(cluster).toContain("!phone && <CanvasFeedbackButton");
    // Whitespace-tolerant: prettier wraps this as `{!phone &&\n  (compact ? (` since #989.
    expect(cluster).toMatch(/\{!phone &&\s*\([\s\S]{0,300}?Build with AI/);
  });
});

describe("canvas top bar — compact/tablet tier (#989)", () => {
  it("`compact` is the drawer threshold, and a SUPERSET of `phone`", () => {
    // ≤1024px — the same query the shell collapses its nav at. A bespoke number here would be a
    // fourth breakpoint to keep in step with three others; a `min-width: 641px` lower bound would
    // be worse still, because then no rule could be written once for "narrow" and every phone
    // decision would need a compact twin.
    expect(code).toContain("BELOW_RAIL_QUERY");
    expect(code).toMatch(/const compact = useMediaQuery\(BELOW_RAIL_QUERY\)/);
    expect(code).not.toMatch(/compact\s*=\s*[^;]*!\s*phone/);
  });

  it("the cluster can neither over-shrink nor be pinned by an auto margin", () => {
    // THE BUG. `minWidth: 0` let the cluster shrink past buttons that cannot shrink, so the
    // difference left the right edge of an `overflow-x: hidden` root: 276px of cluster around
    // 447px of buttons at 834, "Save & run" ending at 974. The compact branch must keep the
    // automatic min-content floor (no `minWidth: 0`) AND drop `marginLeft: auto`, because an auto
    // margin eats all positive free space before flex-grow is considered — with it the status
    // text measured 0 at every compact width instead of growing back.
    expect(clusterCode).toMatch(
      /compact\s*\?\s*\{\s*marginLeft: 0,\s*flex: "1 1 auto",\s*justifyContent: "flex-end"\s*\}/,
    );
    // …and desktop keeps the original, so 1440 is untouched.
    expect(clusterCode).toMatch(/:\s*\{\s*minWidth: 0\s*\}/);
  });

  it("status keeps its place, and a width that cannot hold the row open", () => {
    // `status` is the ONLY channel for "Save failed." / "Run failed." / an import error — none is
    // toasted — so it is not droppable. `width: 0` is what keeps it out of the cluster's
    // min-content floor (a zero flex-basis is NOT enough; the contribution is computed from the
    // clamped text), and the 150px basis is what grows it back when the row has room.
    expect(clusterCode).toContain("status &&");
    expect(clusterCode).not.toMatch(/!compact && status/);
    expect(clusterCode).toMatch(/maxWidth: compact \? 150 : 260/);
    expect(clusterCode).toMatch(
      /compact\s*\?\s*\{ width: 0, flex: "1 1 150px", minWidth: 0 \}/,
    );
  });

  it("what compact drops is reference text, never a control", () => {
    // The mono `key · vN` meta (~210px, nowrap) and the RUN CAP chip (~69px): the only two things
    // in the bar that are neither a control nor a state of THIS workflow. Everything else stays.
    expect(code).toMatch(/\{!compact && \(/); // the key · version meta
    expect(code).toMatch(/!compact && runCapUsd != null && runCapUsd > 0/);
  });

  it("every action that survives to a tablet keeps its button there", () => {
    // Save and "Check flow" ARE gated — but on `phone`, not on `compact` (#964). A tablet has the
    // room once the labels are paid for, and splitting where an action lives across three
    // viewports is worse than a short label. So: no `compact` in any button's gate.
    const buttons = [...clusterCode.matchAll(/<Button\b[\s\S]*?<\/Button>/g)];
    const gateOf = (needle: RegExp) => {
      const i = buttons.findIndex((m) => needle.test(m[0]));
      expect(i, `the action cluster lost ${needle}`).toBeGreaterThan(-1);
      // Everything between the PREVIOUS button and this one: the gate, if there is one. Slicing a
      // fixed window instead would drag in the neighbour's own JSX and read its `compact`.
      const prev = buttons[i - 1];
      const from = prev ? prev.index + prev[0].length : 0;
      return clusterCode.slice(from, buttons[i].index);
    };
    expect(gateOf(/>\s*Save\s*<\/Button>/)).not.toContain("compact");
    expect(gateOf(/\{checking \? "Checking…"/)).not.toContain("compact");
    expect(gateOf(/\{busy \? "Running…"/)).not.toContain("compact");
    // "Build with AI" loses its LABEL at compact, not its place — it is the differentiating
    // feature of this screen and #964's lesson was that a control with no other surface must not
    // simply disappear. An icon button with no accessible name would be the same disappearance
    // for a screen reader, so the name is asserted too.
    expect(clusterCode).toMatch(/\{!phone &&\s*\(compact \? \(/);
    expect(clusterCode).toMatch(
      /aria-label=\{showAi \? "Close AI" : "Build with AI"\}/,
    );
    // Send feedback stays: the canvas is a SIBLING route of /app, so the nav drawer's own
    // feedback button — the fallback the phone branch relies on — is not on screen here.
    expect(clusterCode).toContain("!phone && <CanvasFeedbackButton");
  });

  it("labels shorten at `compact`, not at `phone`", () => {
    // The short forms already existed for the phone tier; #989 is mostly the discovery that the
    // gate was one breakpoint too narrow. If any of these regresses to `phone` the tablet bar
    // silently grows ~200px again. Whitespace-tolerant on purpose: pinning prettier's current
    // indentation would make a reindent read as a regression.
    expect(code).toMatch(/\?\s*compact\s*\?\s*`⚠ \$\{issuesCount\}`/);
    expect(code).toContain('{compact ? "±" : "± changes "}');
    expect(code).toContain(
      '{checking ? "Checking…" : compact ? "Check" : "Check flow"}',
    );
    expect(code).toMatch(/\{!compact && \(showIssues \? "▲" : "▼"\)\}/);
    expect(code).toMatch(/\{!compact && \(showReview \? "▲" : "▼"\)\}/);
  });

  it("the validity pill survives compact, but its label is bounded", () => {
    // It is NOT dropped: it is the only visible answer to "why is Save disabled", and the
    // fallback is closed — `save()` would put the same text into `status`, but Save is itself
    // disabled while the graph is invalid. `graphError` is the one unbounded string left in the
    // bar though, and a pill cannot shrink: 202px of it put the row 17px over at 768.
    expect(code).toMatch(
      /\{!phone && \(\s*<span\s*title=\{!graphValid && graphError/,
    );
    expect(code).toMatch(
      /: compact\s*\? "invalid"\s*: \(graphError \?\? "invalid"\)/,
    );
  });

  it("touch spacing is not what pays for the row", () => {
    // The header's 12px gap tightens to 8; the CLUSTER's does not. Those are 34px icon buttons,
    // and 10px is the clearance that keeps a 44px touch target growable without overlapping its
    // neighbour (the responsive-audit `safe` rule). Buying width by crowding touch targets turns
    // a near-miss into a WRONG action.
    expect(code).toContain("gap: compact ? 8 : 12");
    expect(clusterCode).toContain("gap: phone ? 6 : 10");
  });
});

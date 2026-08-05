/**
 * Regression guard for the canvas top bar at EVERY width — all three tiers, in one file because
 * they are one bar and their rules only make sense against each other.
 *
 *   `compact`  ≤1024px (tablet and down) — gives up LABELS AND REFERENCE TEXT, never controls
 *              (#989). Every action that is a button at 1440 is still a button at 834.
 *   `phone`    ≤640px — ~440px less to work with, so it also moves ACTIONS: Save and "Check flow"
 *              become rows in the "…" menu (#964).
 *   desktop    >1024px — gives up nothing, so instead every piece of TEXT in it is elastic and
 *              every control is not (#997). No fourth breakpoint: shrink factors, not a query.
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
 * primary CTA did not exist for the user (#511's trap).
 *
 * 1025×844 — the FIRST desktop pixel, where the bar puts its full dress back on and #989's tier
 * therefore cannot help. Same two measures (#997):
 *
 *   Tablet ............... 1181 (+156 out)  ->  993 (ok)     60  ->   60
 *   TabletAiOpen ......... 1143 (+118 out)  ->  993 (ok)     60  ->   74
 *   TabletInvalid ........ 1301 (+276 out)  ->  993 (ok)     60  ->   60
 *   WithIssues ........... 1067  (+42 out)  ->  993 (ok)    125  ->  187
 *   TabletQuiet ..........       1017 (ok)  ->  993 (ok)    174  ->  194
 *
 * …and 1440×844, where only the unbounded label overflowed:
 *
 *   TabletInvalid ........ 1488  (+48 out)  -> 1408 (ok)    131  ->  189
 *   InvalidLongError ..... (new story)         1408 (ok)           176
 *
 * The name gets WIDER at both widths, which is the tell that this was never a "not enough room"
 * problem: the row's own reference text (a ~215px mono `key · vN`) and a 260px status sentence
 * were outranking it, and an action cluster that could shrink past its buttons was paying for
 * both by pushing the CTA off screen.
 *
 * `apps/web/scripts/responsive-audit.mjs --filter canvas-topbar`, all 11 stories, #989 measured
 * against a tree that already had #964's fix:
 *
 *              clipped elements   unreachable controls
 *    390            0  ->  0            0  ->  0        (identical: #964 owns this width)
 *    834           32  ->  0           23  ->  0        (14 were WHOLLY offscreen)
 *   1440            1  ->  1            0  ->  0        (identical)
 *
 * 390 and 1440 are byte-identical per story, not merely equal in the totals. The one 1440 clip was
 * `TabletInvalid` before AND after: the desktop bar's own unbounded `graphError`, a defect neither
 * narrow tier reaches. That, and the 1025–~1200 band where the fully dressed bar simply does not
 * fit, is #997 — same harness, 12 stories now (`InvalidLongError` joined them), and this time both
 * builds, because the production-only "Send feedback" button changes the numbers (#1002):
 *
 *              clipped elements   unreachable controls        no DSN         with a dummy DSN
 *    390            0  ->  0            0  ->  0          byte-identical per story, both builds
 *    834            0  ->  0            0  ->  0          byte-identical per story, both builds
 *   1024            0  ->  0            0  ->  0          byte-identical per story, both builds
 *   1025           15  ->  0           12  ->  0          23 -> 0 clipped, 15 -> 0 unreachable
 *   1440            1  ->  0            0  ->  0           1 -> 0 clipped
 *
 * "Byte-identical per story" is the load-bearing half of that table: every desktop rule is gated
 * `!compact`, so the three narrow widths must not move AT ALL, and the audit's per-story records
 * were diffed rather than its totals compared.
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

/** The shared pill (#997 gave it the opt-in truncation the top bar's validity pill needs). */
const dataDisplay = readFileSync(
  path.resolve(__dirname, "../src/components/data-display.tsx"),
  "utf8",
);
const statusPill = dataDisplay.slice(
  dataDisplay.indexOf("export function StatusPill"),
  dataDisplay.indexOf("/* ---------------- Avatar"),
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
      /\{\s*marginLeft: 0,\s*flex: "1 1 auto",\s*justifyContent: "flex-end"\s*\}/,
    );
    // …and it is now the rule for everything that is not a phone: desktop kept `minWidth: 0` +
    // `marginLeft: auto` until #997, which is exactly how the same defect survived one breakpoint
    // up. What is left here is a two-arm split, phone against the rest.
    expect(clusterCode).toMatch(
      /\.\.\.\(phone\s*\?\s*\{ flex: "none" \}\s*:\s*\{ marginLeft: 0,/,
    );
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

  it("every label shortened at compact still says what it means non-visually", () => {
    // The tier's whole trade is "shorten the label, keep the control". That trade is only honest
    // if the MEANING survives the truncation for someone who isn't reading the pixels — otherwise
    // it is the same disappearance #964 was about, just for a different set of users. `title` is
    // not the answer anywhere here: it needs a hover, and compact IS the touch tier.
    //
    // Element by element, all four things this tier shortens:
    //
    //  1. validity pill — `graphError` -> "invalid". A plain <span> (role `generic`), which ARIA
    //     PROHIBITS naming, so an `aria-label` on it is unreliable and axe-flagged. Off-screen
    //     text instead: in the accessibility tree at zero layout cost.
    expect(code).toMatch(
      /\{compact && !generating && !graphValid && graphError/,
    );
    expect(code).toMatch(/<span style=\{srOnly\}>\{graphError\}<\/span>/);
    expect(code).toMatch(/const srOnly: React\.CSSProperties/);
    //  2. issues pill — "⚠ 3 issues ▼" -> "⚠ 3", and a VERDICT shrinks to a bare "✓" / "✗" that
    //  3. review pill — "± changes ▼" -> "±", which names nothing at all.
    //     Both are real <button>s, where `aria-label` IS authoritative — and a button that HAS
    //     content never falls back to `title` for its name, so the name must be stated. Given at
    //     every width, so there is one name to keep true rather than two.
    //     The "<n> issue(s)" SHAPE is load-bearing beyond this file: giving a button an
    //     `aria-label` replaces its accessible name outright, and `e2e/session-fixes.spec.ts`
    //     finds this pill with `getByRole("button", { name: /\d+ issue/i })`. That ran against
    //     the old content name ("⚠ 3 issues ▼") and matches the new one too — but only because
    //     the digits and the word "issue" survived, so they are asserted rather than assumed.
    expect(code).toMatch(
      /aria-label=\{\s*issuesCount > 0\s*\?\s*`\$\{issuesCount\} issue\$\{issuesCount > 1 \? "s" : ""\} found`/,
    );
    expect(
      /\d+ issue/i.test("3 issues found"),
      "e2e selector still matches",
    ).toBe(true);
    expect(code).toContain('aria-label="Review changes"');
    //     …and both are disclosure controls, so they say so.
    expect(code).toContain("aria-expanded={showIssues}");
    expect(code).toContain("aria-expanded={showReview}");
    //  4. "Check flow" -> "Check" needs NOTHING, and that is a verdict, not an oversight: the
    //     accessible name of a <button> is its text, and "Check" is a real word that still names
    //     the action — a shorter synonym, not a symbol. Contrast the pills, where what was left
    //     behind was punctuation. Asserted so that shortening it FURTHER (to an icon, say) has to
    //     come back through here.
    const check = code.slice(code.indexOf('{checking ? "Checking…" : compact'));
    expect(check.slice(0, 80)).toContain('compact ? "Check" : "Check flow"');
    // The one control this tier turns into a pure icon carries its name explicitly.
    expect(clusterCode).toMatch(
      /aria-label=\{showAi \? "Close AI" : "Build with AI"\}/,
    );
  });

  it("compact does NOT adopt the desktop tier's elastic pieces", () => {
    // #997 made the desktop bar degrade text before it moves a control, using the same mechanism
    // #989 used here. None of those rules may leak DOWN: at compact the mono meta is not rendered
    // at all, the validity pill's label is the fixed word "invalid" (so a shrinkable pill could
    // only truncate THAT), and the name box relies on `minWidth: 0` for #964's phone behaviour.
    // Every one of them is therefore gated the other way round, and 390/834/1024 measured
    // byte-identical per story across the change because of it.
    expect(code).toMatch(/compact\s*\?\s*\{ flex: "none" \}/);
    expect(code).toContain("truncate={!compact}");
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

describe("canvas top bar — desktop tier (#997)", () => {
  it("the cluster's min-content floor is at EVERY tier, not only compact", () => {
    // The same defect as #989's, one breakpoint up and therefore missed by it: `DESKTOP_QUERY` is
    // `> 1024px`, but the fully dressed bar (mono meta, RUN CAP, "✨ Build with AI", 260px status)
    // wants ~1200. With `minWidth: 0` the cluster answered by shrinking past its own buttons and
    // the primary CTA left the right edge of an `overflow-x: hidden` root — measured at 1025,
    // "Save & run" ended at 1219 in `Tablet` and at 1337 in `TabletInvalid`.
    //
    // There is no desktop-only arm left to get this wrong in: the tier split is phone vs. the
    // rest. Half-fixing it — taking the floor but keeping `marginLeft: auto` — was measured too,
    // and pinned the status text at 0 even at 1440, where the row has room to spare: an auto
    // margin eats the free space that the `width: 0` status below has to GROW back into.
    // The cluster's OWN style object only — the children below have `minWidth: 0`s of their own.
    const clusterStyle = clusterCode.slice(0, clusterCode.indexOf("}}"));
    expect(clusterStyle).not.toContain("minWidth");
    expect(clusterStyle).not.toContain("compact");
    // `marginLeft` survives twice: the base `auto` (the phone rule) and the 0 that overrides it.
    expect(clusterStyle.match(/marginLeft/g)?.length).toBe(2);
  });

  it("the fixed-width chips cannot under-report that floor", () => {
    // A floor is only as honest as the children it is computed from, and min-content is computed
    // from the longest WORD of anything that may wrap. "$2.5 / run" may: the RUN CAP chip
    // occupies 69px and contributed 29, so the cluster's floor came out 40px below the buttons it
    // exists to protect, the cluster was handed a box narrower than its own contents, and
    // "Save & run" sat 9px past the right edge of a 1440px viewport with the workflow name and
    // the error pill both still holding slack. Neither chip shrinks, so neither may wrap.
    const runCap = clusterCode.slice(
      clusterCode.indexOf("runCapUsd != null"),
      clusterCode.indexOf("Run cap"),
    );
    expect(runCap).toContain('whiteSpace: "nowrap"');
    const envFrom = code.indexOf("title={`Active environment:");
    const envChip = code.slice(
      envFrom,
      code.indexOf("borderRadius: 999", envFrom),
    );
    expect(envChip).toContain('whiteSpace: "nowrap"');
  });

  it("the status text is outside that floor at BOTH tiers", () => {
    // #989's finding, re-applied: `overflow: hidden` does NOT zero a flex item's contribution to
    // its parent's min-content — the contribution is the text clamped to `maxWidth`. Without the
    // definite `width: 0` the new floor would bake in a full 260px sentence, and the shortfall
    // would land on the workflow name instead (measured at 834 in #989: the name at its 60px
    // floor while the sentence kept its full width). The basis mirrors the `maxWidth` per tier so
    // it grows back to readable the moment the row has room.
    expect(clusterCode).toMatch(/maxWidth: compact \? 150 : 260/);
    expect(clusterCode).toMatch(
      /compact\s*\?\s*\{ width: 0, flex: "1 1 150px", minWidth: 0 \}\s*:\s*\{ width: 0, flex: "1 1 260px", minWidth: 0 \}/,
    );
  });

  it("the mono key · vN meta can give, and its tooltip still names the key", () => {
    // ~215px of `nowrap` reference text with no way to shrink was the single biggest thing
    // between the workflow name and the CTA in the 1025–~1200 band. `overflow: hidden` alone is
    // not enough for the same reason as the status text above — `minWidth: 0` is what actually
    // drops its min-content contribution to zero — and the ellipsis is what makes a truncated key
    // read as truncated rather than as a DIFFERENT key.
    const meta = code.slice(
      code.indexOf('<span\n              className="mono"'),
      code.indexOf("{activeKey} · {version"),
    );
    expect(meta, "the key · version meta moved").toContain("whiteSpace");
    expect(meta).toContain('overflow: "hidden"');
    expect(meta).toContain('textOverflow: "ellipsis"');
    expect(meta).toContain("minWidth: 0");
    // …and it is the box's DONOR: shrink is shared out in proportion to base × factor, so at the
    // default 1 the name shrank in step with it (108px of name next to 111px of key, at 1280).
    // A bias, not a sequence — flexbox shrinks both at once — and expressed by raising the donor
    // rather than lowering the name, so the unfrozen factors cannot sum to under 1 and trip
    // §9.7 3b the way the pill's own factor did.
    // Capture once and fail on the MATCH, not on what a missing match degrades into: `?.[1]`
    // would hand `Number(undefined)` → NaN to the comparison below, so "the metadata line
    // changed shape" would have surfaced as "NaN is not greater than 1" three lines later.
    const shrink = meta.match(/flexShrink: (\d+)/);
    if (!shrink)
      throw new Error(`no \`flexShrink: <n>\` in the metadata line: ${meta}`);
    expect(Number(shrink[1])).toBeGreaterThan(1);
    // A tooltip that omits the very string that got truncated is not a fallback, so BOTH branches
    // name the key now — the draft one used not to.
    expect(meta.match(/Workflow key: \$\{activeKey\}/g)?.length).toBe(2);
  });

  it("the name box keeps `minWidth: 0`; its floor lives on the CHILDREN", () => {
    // The tempting symmetry — "give the name box the min-content floor the cluster now has" — was
    // tried and measured backwards: an <input>'s min-content contribution is its intrinsic `size`
    // width (197px for the stories' 25-character name), and the mono meta contributes its whole
    // string despite `overflow: hidden`, so the automatic floor is ~412px on the one box that is
    // meant to yield FIRST. At 1025 `Tablet` went from 194px over to 420. The floor that matters
    // is the input's own `minWidth: 60` (#964's), which applies to the input as a flex item and
    // is unaffected by any of this.
    const nameBox = code.slice(
      code.indexOf('alignItems: "baseline"'),
      code.indexOf('placeholder="Workflow name"'),
    );
    expect(nameBox).toMatch(/minWidth: 0,/);
    expect(nameBox).not.toMatch(/minWidth: (compact|!phone|!compact)/);
    expect(code).toMatch(/minWidth: phone \? 0 : 60/);
  });

  it("the validity pill shrinks last, and never at compact", () => {
    // `graphError` is unbounded and a pill is `white-space: nowrap`, so it could not shrink at
    // all: 31 characters of "Start node has no outgoing edge" is a 202px pill and put "Save & run"
    // 76px past the right edge of a 1440px viewport. Desktop keeps the message (compact swaps in
    // "invalid" instead — see the block above) and makes the pill a normal elastic item.
    //
    // The factor must stay >= 1. Expressing "yield this one last" as a fraction is the obvious
    // move and a trap: flexbox §9.7 3b scales the free space by the sum of the flex factors when
    // that sum is under 1, so a 0.05 absorbs 5% of the deficit and overflows the other 95% —
    // measured, `InvalidLongError` gave up 53px of 958 at 1025.
    // The wrapper span and the pill it holds — up to the compact-only off-screen copy that ends
    // the block, so nothing after it can satisfy these on the pill's behalf.
    const pill = code.slice(
      code.indexOf("title={!graphValid && graphError"),
      code.indexOf("{compact && !generating && !graphValid && graphError"),
    );
    expect(pill).toMatch(
      /\.\.\.\(compact \? \{ flex: "none" \} : \{ flex: "0 1 auto", minWidth: 0 \}\)/,
    );
    // …and the shrink is only useful if the LABEL ellipsizes inside the pill, which is a prop on
    // the shared component, not something the top bar can do from outside.
    expect(pill).toContain("truncate={!compact}");
    expect(statusPill).toMatch(/truncate\?: boolean/);
    expect(statusPill).toMatch(/truncate \? \{ minWidth: 0 \}/);
    expect(statusPill).toMatch(/textOverflow: "ellipsis"/);
  });

  it("truncating the error costs pixels, not meaning", () => {
    // The compact tier had to add an `srOnly` twin because it SUBSTITUTES a shorter label. Desktop
    // does not substitute anything: the label expression is unchanged and CSS ellipsis leaves the
    // whole string in the DOM, so the accessibility tree and the `title` both still carry it. If
    // this ever becomes a substitution, it needs the same off-screen copy #989 added.
    expect(code).toMatch(
      /: compact\s*\? "invalid"\s*: \(graphError \?\? "invalid"\)/,
    );
    expect(statusPill).not.toMatch(/slice\(|substring\(/);
  });
});

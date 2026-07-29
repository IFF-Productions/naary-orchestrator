/**
 * Regression guard for the Settings phone touch targets fixed under #511.
 *
 * apps/web's vitest environment is `node` — there is no jsdom/testing-library here to render a
 * screen and measure a rect (see overlay-containing-block.spec.ts for the same constraint). The
 * measurements below were taken with Playwright against a built Storybook at 390x844
 * (`apps/web/scripts/responsive-audit.mjs`, committed alongside this); what this file guards is
 * that the SOURCE shapes those numbers depend on don't quietly come back.
 *
 * ── Notifications ────────────────────────────────────────────────────────────────────────────
 * The phone card (#847) put each event toggle on its own line as `[22px tile][plain <span> label]`
 * inside `.naary-set-row`, which is itself `role="button"` and expands the card. Measured before
 * the fix, on `screens-settings--notifications` at 390px:
 *
 *   toggle box .................. 22 x 22   (484 px², the label a 128px dead zone beside it)
 *   tap on the event NAME ....... aria-expanded false -> true, aria-checked UNCHANGED
 *
 * i.e. tapping the obvious target did not miss harmlessly, it performed a DIFFERENT action —
 * the same property that justified the node-catalog fix in #857. After: 328 x 44 (14 432 px²,
 * 30x the area) and the tap toggles. The label had to move INSIDE the control, which is why the
 * 22px tile must stay presentational — a nested button would restore both halves of the bug.
 *
 * ── Variables ────────────────────────────────────────────────────────────────────────────────
 * Every cell measured 258 x 30 at 12px type. 30px is under the 44px touch minimum the app already
 * holds to (the `.btn-icon` rule in components.css), and iOS Safari zooms the page in on focusing
 * an input under 16px — the very zoom global.css's layout-viewport clamp exists to prevent.
 * After: 258 x 44 at 16px. Desktop (1440px) is untouched in both cases: tile 22x22, cell 163x30.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../src");
const notifications = readFileSync(
  path.join(SRC, "screens/app/settings/NotificationsSection.tsx"),
  "utf8",
);
const settings = readFileSync(
  path.join(SRC, "screens/app/Settings.tsx"),
  "utf8",
);

/** The body of a top-level `function <name>(...) { ... }`, matched by brace balance. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const open = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0)
      return source.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

describe("Settings — phone touch targets (#511)", () => {
  it("the phone event toggle is a >= 44px control", () => {
    const body = functionBody(notifications, "EventRow");
    expect(body).toMatch(/minHeight:\s*44/);
    expect(body).toMatch(/width:\s*"100%"/);
  });

  it("the phone event toggle carries the event NAME inside the control", () => {
    // The label being a sibling of the control (rather than its content) is what made a tap on
    // the event name fall through to the row's expand handler.
    const body = functionBody(notifications, "EventRow");
    expect(body).toMatch(/role="checkbox"/);
    expect(body).toMatch(/\{title\}/);
    // ...and it must not re-propagate to `.naary-set-row`'s expand handler.
    expect(body).toMatch(/stopPropagation/);
  });

  it("the 22px tile stays presentational so the phone control is not nested", () => {
    const glyph = functionBody(notifications, "EventGlyph");
    expect(glyph).toMatch(/aria-hidden/);
    expect(glyph).not.toMatch(/<button/);
    expect(glyph).not.toMatch(/onClick/);
    // The phone branch renders EventRow; the desktop matrix cell keeps the 22px button.
    expect(notifications).toMatch(/<EventRow/);
    expect(notifications).toMatch(/<EventTile/);
  });

  it("variable cells get a 44px / 16px phone rule, and desktop keeps 30px / 12px", () => {
    expect(settings).toMatch(
      /\.naary-var-cell\{[^}]*height:30px;[^}]*font-size:12px/,
    );
    const phoneBlock = settings.match(
      /@media \(max-width: 640px\)\{\s*\.naary-var-cell\{([^}]*)\}/,
    );
    expect(phoneBlock, "no phone rule for .naary-var-cell").not.toBeNull();
    expect(phoneBlock![1]).toMatch(/height:44px/);
    // Under 16px, iOS Safari zooms the page on focus.
    expect(phoneBlock![1]).toMatch(/font-size:16px/);
  });
});

import { describe, expect, it } from "vitest";
import {
  accentButton,
  accentVars,
  cardMaxWidth,
  fieldGridStyle,
  readableInkOn,
  redirectMode,
  safeAccent,
  spansFullRow,
} from "../src/screens/public/form-branding";

/**
 * Presentation rules for a branded hosted form. Two classes of thing are worth testing here:
 *
 *  - the accent is interpolated into CSS custom properties, and `var()` substitution can land inside
 *    `url()` — so "only a literal #rrggbb ever reaches a style" is a security property, not a
 *    formatting preference;
 *  - every "absent branding ⇒ `{}`" case, because a stray default would silently restyle every form
 *    that never asked to be branded.
 */

describe("safeAccent only admits a literal #rrggbb", () => {
  it.each(["#d4562a", "#FFFFFF", "#000000", "#AbCdEf"])("accepts %s", (v) => {
    expect(safeAccent(v)).toBe(v);
  });

  /**
   * The rejections that matter are the CSS-injection shapes: a closing paren escapes the
   * `color-mix(...)` we place the value inside, and `url(...)` is how a custom property turns into a
   * network request. Shorthand (#fff) and named colours are refused too — not because they're
   * dangerous but because accepting a second syntax means two things to validate forever.
   */
  it.each([
    undefined,
    "",
    "#fff",
    "#gggggg",
    "red",
    "rgb(1,2,3)",
    "#d4562a; background: url(https://evil.example/x)",
    "#d4562a) url(https://evil.example/x",
    "var(--something)",
    "#d4562a00",
    " #d4562a",
    "#d4562a ",
  ])("rejects %s", (v) => {
    expect(safeAccent(v as string | undefined)).toBeUndefined();
  });
});

describe("accentVars", () => {
  it("returns nothing without a valid accent, so an unbranded form is untouched", () => {
    expect(accentVars(undefined)).toEqual({});
    expect(accentVars("not-a-colour")).toEqual({});
  });

  it("repoints every brand token from the one authored colour", () => {
    const vars = accentVars("#3355ff") as Record<string, string>;
    expect(vars["--brand"]).toBe("#3355ff");
    // Derived, not separately authored — one input can't be internally inconsistent.
    for (const key of [
      "--brand-deep",
      "--brand-2",
      "--brand-gradient",
      "--brand-soft",
    ]) {
      expect(vars[key], `${key} missing`).toContain("#3355ff");
    }
  });

  /** Nothing but the validated hex may appear in the emitted values. */
  it("never emits a value containing anything but the checked colour", () => {
    const values = Object.values(
      accentVars("#3355ff") as Record<string, string>,
    );
    for (const v of values) {
      expect(v).not.toMatch(/url\(/i);
      expect(v).not.toContain(";");
      // Every hex literal present must be the one we validated.
      for (const hex of v.match(/#[0-9a-fA-F]{3,8}/g) ?? []) {
        expect(hex).toBe("#3355ff");
      }
    }
  });
});

describe("accentButton keeps the submit button readable", () => {
  it("does nothing without a valid accent (the ember face stands)", () => {
    expect(accentButton(undefined)).toEqual({});
    expect(accentButton("#fff")).toEqual({});
  });

  it("overrides the hardcoded ember gradient", () => {
    // The reason this function exists: EMBER_BUTTON's gradient is a literal, not var(--brand), so
    // accentVars alone would leave the most prominent control orange.
    const face = accentButton("#3355ff");
    expect(String(face.background)).toContain("#3355ff");
    expect(String(face.background)).not.toContain("#f2622e");
  });

  /**
   * The failure this prevents: a pale accent with the stock light ink renders white-on-near-white,
   * making the primary action of the page invisible.
   */
  it("picks dark ink on a pale accent and light ink on a dark one", () => {
    expect(accentButton("#ffe066").color).toBe("#161a20");
    expect(accentButton("#1a1f2b").color).toBe("#ffffff");
  });

  it.each([
    ["#ffffff", "#161a20"],
    ["#000000", "#ffffff"],
    ["#ffff00", "#161a20"], // high-luminance yellow
    ["#0000ff", "#ffffff"], // low-luminance blue despite being fully saturated
  ])("readableInkOn(%s) → %s", (bg, ink) => {
    expect(readableInkOn(bg)).toBe(ink);
  });

  it("falls back to the stock ink for an invalid colour rather than computing on garbage", () => {
    expect(readableInkOn("nope")).toBe("var(--brand-ink)");
  });
});

describe("layout", () => {
  it("defaults to the 460px design width", () => {
    expect(cardMaxWidth(undefined)).toBe(460);
    expect(cardMaxWidth("narrow")).toBe(460);
    expect(cardMaxWidth("wide")).toBe(640);
  });

  /** The whole desktop/mobile story: two columns exist only where there's width for them. */
  it("collapses a 2-column layout to one on phone", () => {
    expect(fieldGridStyle(2, false).gridTemplateColumns).toBe(
      "repeat(2, minmax(0, 1fr))",
    );
    expect(fieldGridStyle(2, true)).toEqual({});
  });

  it("never grids a 1-column (or unset) form, even on desktop", () => {
    expect(fieldGridStyle(1, false)).toEqual({});
    expect(fieldGridStyle(undefined, false)).toEqual({});
  });

  /** A textarea or chip-row select in half a row is worse than no columns at all. */
  it("spans textarea and select across both columns, pairs the scalar inputs", () => {
    expect(spansFullRow("textarea")).toBe(true);
    expect(spansFullRow("select")).toBe(true);
    for (const t of ["text", "email", "number"]) {
      expect(spansFullRow(t), t).toBe(false);
    }
  });
});

describe("redirectMode", () => {
  it("is 'none' with no redirect configured", () => {
    expect(redirectMode(undefined, false)).toBe("none");
    expect(redirectMode(undefined, true)).toBe("none");
    expect(redirectMode("", false)).toBe("none");
  });

  it("navigates a top-level page", () => {
    expect(redirectMode("https://acme.test/thanks", false)).toBe("navigate");
  });

  /**
   * The important one. Auto-navigating inside a tenant's iframe either strands the visitor in a frame
   * with no URL bar or back affordance, or performs a frame-busting cross-origin navigation on the
   * host page's behalf. Offering a link keeps the visitor in control and shows where they're going.
   */
  it("offers a link instead of navigating when embedded", () => {
    expect(redirectMode("https://acme.test/thanks", true)).toBe("link");
  });
});

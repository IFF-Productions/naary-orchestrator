import { describe, expect, it } from "vitest";
import { nodeConfigSchema } from "../src/registry";

/**
 * Save-gate rules for a formTrigger's `branding` block — the FIRST of the two gates protecting the
 * hosted public page (the second is `projectBranding` on read, in apps/api).
 *
 * Two of these fields are not cosmetic:
 *
 *  - `accentColor` is interpolated into a **CSS custom property**, and `var()` substitution can land
 *    inside `url()`. A value that escapes the `color-mix(…)` it sits in is CSS injection on a page
 *    served to anonymous visitors, so only a fixed-shape `#rrggbb` literal is admissible.
 *  - `redirectUrl` **navigates the visitor**. A `javascript:`/`data:` URL here would be stored XSS on
 *    our own origin, triggerable by anyone holding the public form link.
 *
 * Both are therefore tested as adversarial input, not as formatting.
 */
const schema = nodeConfigSchema("formTrigger");

/** Parse a formTrigger config carrying only this branding block. */
const parse = (branding: unknown) => schema.safeParse({ fields: [], branding });

describe("branding is optional and additive", () => {
  it("accepts a formTrigger with no branding at all (nothing changes on upgrade)", () => {
    expect(schema.safeParse({ fields: [] }).success).toBe(true);
  });

  it("accepts an empty branding block", () => {
    expect(parse({}).success).toBe(true);
  });

  it("accepts a fully-specified block", () => {
    expect(
      parse({
        successTitle: "Thanks!",
        successMessage: "We'll reply within a day.",
        redirectUrl: "https://acme.test/thanks",
        accentColor: "#3355ff",
        theme: "light",
        desktopColumns: 2,
        width: "wide",
      }).success,
    ).toBe(true);
  });
});

describe("accentColor admits only a literal #rrggbb", () => {
  it.each(["#f2622e", "#FFFFFF", "#000000", "#AbCdEf"])("accepts %s", (v) => {
    expect(parse({ accentColor: v }).success).toBe(true);
  });

  /**
   * The first two are the injection shapes that motivate the constraint: a stray `)` escapes the
   * `color-mix(...)` wrapper, and `url(...)` turns a custom property into a network request. The rest
   * are refused so there is exactly ONE accepted syntax to reason about, forever.
   */
  it.each([
    "#f2622e) url(https://evil.example/x",
    "#f2622e; background: url(https://evil.example/x)",
    "url(https://evil.example/x)",
    "var(--brand)",
    "expression(alert(1))",
    "#fff",
    "#f2622",
    "#gggggg",
    "red",
    "rgb(1,2,3)",
    "#f2622e00",
    " #f2622e",
    "#f2622e ",
    "",
  ])("rejects %s", (v) => {
    expect(parse({ accentColor: v }).success).toBe(false);
  });
});

describe("redirectUrl admits only a plain https URL", () => {
  it.each([
    "https://acme.test",
    "https://acme.test/thanks",
    "https://acme.test/thanks?ref=form#top",
    "https://sub.acme.test:8443/thanks",
  ])("accepts %s", (v) => {
    expect(parse({ redirectUrl: v }).success).toBe(true);
  });

  /** Stored XSS on our own origin, and the scheme-confusion shapes a regex would have let through. */
  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "  javascript:alert(1)",
    "javascript:https://acme.test",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
  ])("rejects the script/data URL %s", (v) => {
    expect(parse({ redirectUrl: v }).success).toBe(false);
  });

  /** Downgrading a visitor who just submitted over TLS is our fault, not theirs. */
  it.each(["http://acme.test/thanks", "ftp://acme.test/x", "//acme.test/x"])(
    "rejects the non-https URL %s",
    (v) => {
      expect(parse({ redirectUrl: v }).success).toBe(false);
    },
  );

  it.each(["/thanks", "thanks", "", "not a url"])(
    "rejects the non-absolute URL %s",
    (v) => {
      expect(parse({ redirectUrl: v }).success).toBe(false);
    },
  );

  /**
   * `https://trusted.test@evil.example/` reads as `trusted.test` to a person while resolving to
   * `evil.example`. We SHOW this target (canvas hint, and the "Continue" link on an embedded form), so
   * accepting it would mean displaying something untrue.
   */
  it.each([
    "https://trusted.test@evil.example/",
    "https://user:pass@evil.example/",
    "https://user@evil.example/path?a=1",
  ])("rejects the credential-bearing URL %s", (v) => {
    expect(parse({ redirectUrl: v }).success).toBe(false);
  });

  it("rejects an over-long URL", () => {
    expect(
      parse({ redirectUrl: `https://acme.test/${"x".repeat(2_100)}` }).success,
    ).toBe(false);
  });
});

describe("the enumerated fields are closed", () => {
  it.each(["auto", "light", "dark"])("accepts theme %s", (v) => {
    expect(parse({ theme: v }).success).toBe(true);
  });

  it.each(["solarized", "Light", "", "system"])("rejects theme %s", (v) => {
    expect(parse({ theme: v }).success).toBe(false);
  });

  it("accepts only 1 or 2 desktop columns", () => {
    expect(parse({ desktopColumns: 1 }).success).toBe(true);
    expect(parse({ desktopColumns: 2 }).success).toBe(true);
    for (const bad of [0, 3, 12, 2.5, "2", null]) {
      expect(parse({ desktopColumns: bad }).success, String(bad)).toBe(false);
    }
  });

  it("accepts only the two widths", () => {
    expect(parse({ width: "narrow" }).success).toBe(true);
    expect(parse({ width: "wide" }).success).toBe(true);
    expect(parse({ width: "full" }).success).toBe(false);
  });
});

describe("copy is length-capped", () => {
  it("accepts ordinary copy", () => {
    expect(
      parse({ successTitle: "Thanks!", successMessage: "A".repeat(500) })
        .success,
    ).toBe(true);
  });

  it("rejects copy past the cap (it reaches an anonymous page)", () => {
    expect(parse({ successTitle: "A".repeat(201) }).success).toBe(false);
    expect(parse({ successMessage: "A".repeat(2_001) }).success).toBe(false);
  });
});

describe("logoAssetId is an id we issued, never a URL", () => {
  it("accepts a uuid", () => {
    expect(
      parse({ logoAssetId: "9f3a1c2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b" }).success,
    ).toBe(true);
  });

  /**
   * A URL here would mean every visitor's browser fetching a tenant-controlled address from our page:
   * egress we don't control, a tracking pixel we'd be laundering, and a logo that breaks whenever
   * their host does. `javascript:`/`data:` would be worse still. Only an id we minted is accepted, and
   * ownership of that id is checked against the tenant+env at save time.
   */
  it.each([
    "https://evil.example/logo.png",
    "http://acme.test/logo.png",
    "//acme.test/logo.png",
    "/relative/logo.png",
    "data:image/png;base64,iVBORw0KGgo=",
    "javascript:alert(1)",
    "not-a-uuid",
    "9f3a1c2e-4b5d-4e6f-8a9b",
    "9f3a1c2e4b5d4e6f8a9b0c1d2e3f4a5b",
    "",
  ])("rejects %s", (v) => {
    expect(parse({ logoAssetId: v }).success).toBe(false);
  });

  it("caps the alt text", () => {
    expect(parse({ logoAlt: "Acme logo" }).success).toBe(true);
    expect(parse({ logoAlt: "A".repeat(121) }).success).toBe(false);
  });
});

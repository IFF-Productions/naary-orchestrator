import type { FormBrandingConfig } from "@naary/dsl";
import type { CSSProperties } from "react";

/**
 * Pure presentation helpers for a branded hosted form. Kept out of FormPage.tsx so the derivation
 * rules are unit-testable (apps/web/test/form-branding.spec.ts) — every one of them is a place where
 * being wrong is either an injection or a silently broken page.
 *
 * The branding values arrive from `GET /forms/:formId`, already validated at save time AND
 * re-projected server-side (`projectBranding`). These functions re-check the accent anyway: it is
 * interpolated into a CSS custom property, and `var()` substitution can land inside `url()`, so the
 * value must be a fixed-shape hex literal at the point of use and not merely somewhere upstream.
 */

/** The branding shape, taken straight from the DSL rather than re-declared — a second copy of this
 *  interface is exactly how a field gets added on one side and silently ignored on the other. */
export type FormBranding = FormBrandingConfig;

/** Exactly `#rrggbb` — the same shape the save gate and the server projection enforce. */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** The accent, or undefined if it isn't a literal 6-digit hex colour. Third and last check. */
export function safeAccent(raw: string | undefined): string | undefined {
  return raw && HEX_COLOR_RE.test(raw) ? raw : undefined;
}

/**
 * Custom-property overrides that repoint the page's brand tokens at the tenant's accent.
 *
 * `--brand-gradient` and the two tints are DERIVED with `color-mix` rather than asking the author for
 * four colours: one input that can't be internally inconsistent beats four that can. Returns `{}` for
 * an absent/invalid accent, so the stock ember tokens simply apply.
 */
export function accentVars(accent: string | undefined): CSSProperties {
  const c = safeAccent(accent);
  if (!c) return {};
  return {
    "--brand": c,
    // A darker stop for borders/pressed states, and a lighter one for the gradient's top.
    "--brand-deep": `color-mix(in srgb, ${c} 78%, black)`,
    "--brand-2": `color-mix(in srgb, ${c} 82%, white)`,
    "--brand-gradient": `linear-gradient(90deg, color-mix(in srgb, ${c} 84%, white), ${c})`,
    "--brand-soft": `color-mix(in srgb, ${c} 12%, transparent)`,
  } as CSSProperties;
}

/**
 * The submit button face for a given accent.
 *
 * `EMBER_BUTTON` hardcodes its gradient (`linear-gradient(180deg, #ff8a4c, #f2622e)`) rather than
 * reading `var(--brand)`, so `accentVars` alone would recolour the top strip and focus rings but
 * leave the most prominent element stubbornly orange. This returns the overriding half; spread it
 * AFTER `EMBER_BUTTON`. Returns `{}` without a valid accent so the ember face is untouched.
 */
export function accentButton(accent: string | undefined): CSSProperties {
  const c = safeAccent(accent);
  if (!c) return {};
  return {
    background: `linear-gradient(180deg, color-mix(in srgb, ${c} 80%, white), ${c})`,
    border: `1px solid color-mix(in srgb, ${c} 55%, transparent)`,
    boxShadow: `0 4px 14px -5px color-mix(in srgb, ${c} 60%, transparent)`,
    // The stock face uses --brand-ink (a fixed light ink for ember). A tenant accent can be pale, so
    // pick the readable ink from the accent's own luminance instead of assuming a dark background.
    color: readableInkOn(c),
  };
}

/**
 * Black or white text for a background, by relative luminance (WCAG-style sRGB weighting).
 *
 * Without this a pale accent (`#ffe066`) gets white text on near-white and the submit button becomes
 * unreadable — the single most important control on the page. The 0.6 threshold is deliberately above
 * the naive 0.5 because the gradient's top stop is *lighter* than the input colour, so the effective
 * background is brighter than `c` alone.
 */
export function readableInkOn(hex: string): string {
  const c = safeAccent(hex);
  if (!c) return "var(--brand-ink)";
  const [r, g, b] = [1, 3, 5].map(
    (i) => Number.parseInt(c.slice(i, i + 2), 16) / 255,
  );
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.6 ? "#161a20" : "#ffffff";
}

/** Card width: `wide` (640) gives a 2-column layout room; `narrow` (460) is the design default. */
export function cardMaxWidth(width: FormBranding["width"]): number {
  return width === "wide" ? 640 : 460;
}

/**
 * The field-container style for the requested desktop column count.
 *
 * Two columns apply ONLY above the phone breakpoint; below it the grid collapses to one, because the
 * thing that actually differs between desktop and mobile is available width — expressing it that way
 * keeps one authored form instead of two layouts to hold in sync.
 */
export function fieldGridStyle(
  columns: FormBranding["desktopColumns"],
  phone: boolean,
): CSSProperties {
  if (columns !== 2 || phone) return {};
  return {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    columnGap: 14,
    // `start` so a row with a tall control doesn't stretch its neighbour's input to match.
    alignItems: "start",
  };
}

/**
 * Whether a field should span the full width inside a 2-column grid.
 *
 * A `textarea` in a half-width column is unusable for the paragraph it's asking for, and a `select`
 * renders as a wrapping chip row that reflows badly when squeezed. Both get the full row; short
 * scalar inputs pair up, which is the entire point of the two-column option.
 */
export function spansFullRow(type: string): boolean {
  return type === "textarea" || type === "select";
}

/**
 * How to honour `redirectUrl` after a successful submit.
 *
 * - `"navigate"`: replace the current location (top-level page).
 * - `"link"`: show the success card with the destination as a link the visitor clicks.
 * - `"none"`: no redirect configured — render the normal success card.
 *
 * EMBEDDED forms never auto-navigate. The page is running in a tenant's iframe, and navigating would
 * either replace the iframe's content (leaving the visitor stranded inside a frame on someone else's
 * page, with no visible URL bar or back affordance) or, if the author intended a top-level jump, be a
 * cross-origin frame-busting navigation that we should not perform on the host page's behalf. Showing
 * the target as a link keeps the visitor in control and makes where they're going legible — which is
 * also why the redirect URL is barred from embedding credentials.
 */
export function redirectMode(
  redirectUrl: string | undefined,
  embed: boolean,
): "navigate" | "link" | "none" {
  if (!redirectUrl) return "none";
  return embed ? "link" : "navigate";
}

import type { FormBrandingConfig } from "@naary/dsl";
import { useState } from "react";
import { inputStyle, Labeled } from "./fields";

/**
 * The formTrigger's "Hosted page" editor — success copy, redirect, accent, theme and layout.
 *
 * Extracted from config-triggers.tsx rather than inlined: the form section is already the longest in
 * the inspector, and this block owns two things worth keeping in one place — the **client-side
 * mirrors of the save-gate rules** (so an author sees why a value is refused while typing instead of
 * as a save failure), and the **precedence warning** for `redirectUrl`, which makes the success copy
 * dead. Nothing here is a security boundary: the real gates are `CONFIG_SCHEMAS.formTrigger` on save
 * and `projectBranding` on read.
 */

/** Same shape the save gate and the server projection require: exactly `#rrggbb`. */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** A few defaults worth one click, so the common case isn't "go find your brand hex". */
const SWATCHES = [
  "#f2622e",
  "#3355ff",
  "#12a594",
  "#8b5cf6",
  "#e11d48",
  "#0f172a",
];

/**
 * Why a redirect is refused, or null when it's acceptable (or empty). Mirrors the zod rules — https
 * only, no embedded credentials — so the message appears while typing rather than on save.
 */
export function redirectProblem(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^https:\/\/[^/?#]*@/i.test(value)) {
    return "Remove the user:pass@ part — a URL like that reads as one site but resolves to another.";
  }
  if (!/^https:\/\//i.test(value)) {
    return value.includes("://")
      ? "Must start with https:// — other schemes are refused (an http:// redirect would downgrade a visitor who submitted over TLS)."
      : "Must be a full URL starting with https://";
  }
  if (value.length > 2_000) return "Too long (max 2000 characters).";
  return null;
}

export function FormBrandingSection({
  branding,
  onChange,
}: {
  branding: FormBrandingConfig;
  /** Merge a patch into the node's `branding` object. */
  onChange: (patch: Partial<FormBrandingConfig>) => void;
}) {
  const [open, setOpen] = useState(
    // Start expanded when anything is already set, so existing branding isn't hidden behind a
    // collapsed section the author has to remember to look inside.
    () => Object.keys(branding).length > 0,
  );
  const accent = branding.accentColor ?? "";
  const accentValid = !accent || HEX_COLOR_RE.test(accent);
  const redirect = branding.redirectUrl ?? "";
  const redirectIssue = redirectProblem(redirect);
  const hasRedirect = Boolean(redirect.trim()) && !redirectIssue;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          alignSelf: "flex-start",
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          fontSize: "var(--text-xs)",
          color: "var(--brand)",
          fontFamily: "var(--font-sans)",
        }}
      >
        + Customise the hosted page
      </button>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          fontSize: "var(--text-xs)",
          fontWeight: "var(--weight-semibold)",
          color: "var(--ink-2)",
        }}
      >
        Hosted page
      </div>

      <Labeled label="Redirect after submit (optional)">
        <input
          value={redirect}
          onChange={(e) => onChange({ redirectUrl: e.target.value })}
          style={{
            ...inputStyle,
            ...(redirectIssue ? { borderColor: "var(--state-error)" } : {}),
          }}
          placeholder="https://example.com/thank-you"
        />
      </Labeled>
      {redirectIssue && (
        <div
          style={{ fontSize: "var(--text-xs)", color: "var(--state-error)" }}
        >
          {redirectIssue}
        </div>
      )}
      {hasRedirect && (
        // Precedence, said out loud. Without this an author writes success copy that can never
        // render on a top-level page and has no way to find out why.
        <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
          Visitors go straight here after submitting, so the success message
          below won't be shown — except on an embedded form, where they get a
          "Continue" link instead (we never navigate someone else's iframe).
        </div>
      )}

      <Labeled label="Success heading (optional)">
        <input
          value={branding.successTitle ?? ""}
          onChange={(e) => onChange({ successTitle: e.target.value })}
          style={inputStyle}
          placeholder="Request received"
        />
      </Labeled>
      <Labeled label="Success message (optional)">
        <textarea
          value={branding.successMessage ?? ""}
          onChange={(e) => onChange({ successMessage: e.target.value })}
          style={{ ...inputStyle, height: 64, padding: "8px 10px" }}
          placeholder="Your response was submitted and the workflow has started."
        />
      </Labeled>

      <Labeled label="Accent colour (optional)">
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {/* A native colour picker guarantees a valid #rrggbb; the text field stays editable for
              pasting an exact brand hex, which is how anyone with a brand guide will do it. */}
          <input
            type="color"
            value={HEX_COLOR_RE.test(accent) ? accent : "#f2622e"}
            onChange={(e) => onChange({ accentColor: e.target.value })}
            aria-label="Accent colour"
            style={{
              width: 34,
              height: 32,
              padding: 2,
              background: "var(--card)",
              border: "1px solid var(--line-2)",
              borderRadius: 8,
              cursor: "pointer",
            }}
          />
          <input
            value={accent}
            onChange={(e) => onChange({ accentColor: e.target.value })}
            style={{
              ...inputStyle,
              fontFamily: "var(--font-mono)",
              ...(accentValid ? {} : { borderColor: "var(--state-error)" }),
            }}
            placeholder="#f2622e"
          />
        </div>
      </Labeled>
      {!accentValid && (
        <div
          style={{ fontSize: "var(--text-xs)", color: "var(--state-error)" }}
        >
          Use a 6-digit hex colour like #f2622e (shorthand and named colours
          aren't accepted).
        </div>
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {SWATCHES.map((hex) => (
          <button
            key={hex}
            type="button"
            aria-label={`Use ${hex}`}
            onClick={() => onChange({ accentColor: hex })}
            style={{
              width: 20,
              height: 20,
              borderRadius: 5,
              background: hex,
              cursor: "pointer",
              border:
                accent.toLowerCase() === hex
                  ? "2px solid var(--ink)"
                  : "1px solid var(--line-2)",
            }}
          />
        ))}
      </div>

      <Labeled label="Theme">
        <select
          value={branding.theme ?? "auto"}
          onChange={(e) =>
            onChange({
              theme: e.target.value as FormBrandingConfig["theme"],
            })
          }
          style={inputStyle}
        >
          <option value="auto">Follow the visitor's setting</option>
          <option value="light">Always light</option>
          <option value="dark">Always dark</option>
        </select>
      </Labeled>

      <Labeled label="Desktop layout">
        <select
          value={String(branding.desktopColumns ?? 1)}
          onChange={(e) =>
            onChange({
              desktopColumns: e.target.value === "2" ? 2 : 1,
            })
          }
          style={inputStyle}
        >
          <option value="1">One column</option>
          <option value="2">Two columns (side by side)</option>
        </select>
      </Labeled>
      {branding.desktopColumns === 2 && (
        // Set expectations for the two things the 2-column layout deliberately does NOT do.
        <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
          Phones always get a single column. Long-answer and choice fields keep
          a full row — a paragraph box in half a row is worse than no columns.
        </div>
      )}

      <Labeled label="Card width">
        <select
          value={branding.width ?? "narrow"}
          onChange={(e) =>
            onChange({ width: e.target.value === "wide" ? "wide" : "narrow" })
          }
          style={inputStyle}
        >
          <option value="narrow">Narrow (460px)</option>
          <option value="wide">Wide (640px)</option>
        </select>
      </Labeled>
    </div>
  );
}

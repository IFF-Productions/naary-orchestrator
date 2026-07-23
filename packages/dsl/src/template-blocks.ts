/**
 * Template blocks — the shared authoring primitive for the Form/Email editor (see
 * docs/design/TEMPLATE-EDITOR.md). `Template.body` is an ordered `TemplateBlock[]`: the SAME array
 * renders to an email (content blocks) and drives a form (`field` blocks). This module is the pure
 * foundation (Slice 1): the block union + `renderEmailHtml`. No I/O, no DB, no DnD.
 *
 * SECURITY — the load-bearing part: `{{ node.path }}` values come from ctx, which holds
 * EXTERNALLY-CONTROLLED data (webhook payloads, LLM output, HTTP response bodies). They MUST be
 * escaped for the position they land in, or a value like `<script>…` / `"><img onerror=…>` becomes
 * live markup in the email (and, later, in the in-browser preview + the public form page). So this
 * does NOT reuse `resolveTemplates` (raw string replacement) for the HTML path — it interpolates
 * with context-aware escaping: HTML-escape in text/rich positions, and scheme-check +
 * attribute-escape for `href`/`src`.
 */
import { z } from "zod";
import { getByPath } from "./mcp-args";
import { isSecretRef } from "./template";

/** One block in a template body. Content blocks render to email + form layout; `field` is FORM-only
 *  (skipped when rendering an email). Every block carries a stable `id` for editor keys/reorder —
 *  minted in the editor/API, never in the workflow (Tier-1 §2). */
export type TemplateBlock =
  | { id: string; type: "heading"; level: 1 | 2 | 3; text: string }
  | { id: string; type: "text"; html: string }
  | { id: string; type: "image"; src: string; alt?: string }
  | { id: string; type: "button"; label: string; href: string }
  | { id: string; type: "divider" }
  | { id: string; type: "spacer"; size: number }
  | {
      id: string;
      type: "field";
      key: string;
      label: string;
      fieldType: "text" | "textarea" | "number" | "email" | "select";
      required: boolean;
      options?: string[];
    };

/** Runtime validator for a block — the API validates `Template.blocks` on save against this, so a
 *  stored template can never carry a malformed block the renderer would choke on. */
export const templateBlockSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string(),
    type: z.literal("heading"),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    text: z.string(),
  }),
  z.object({ id: z.string(), type: z.literal("text"), html: z.string() }),
  z.object({
    id: z.string(),
    type: z.literal("image"),
    src: z.string(),
    alt: z.string().optional(),
  }),
  z.object({
    id: z.string(),
    type: z.literal("button"),
    label: z.string(),
    href: z.string(),
  }),
  z.object({ id: z.string(), type: z.literal("divider") }),
  z.object({ id: z.string(), type: z.literal("spacer"), size: z.number() }),
  z.object({
    id: z.string(),
    type: z.literal("field"),
    key: z.string(),
    label: z.string(),
    fieldType: z.enum(["text", "textarea", "number", "email", "select"]),
    required: z.boolean(),
    options: z.array(z.string()).optional(),
  }),
]);

/** `Template.blocks` — an ordered array of validated blocks. */
export const templateBlocksSchema = z.array(templateBlockSchema);

/** `{{ path }}` token OR an escaped literal `\{{` — the SAME shape the runtime resolves with, so a
 *  template can't render differently than it authors. Fresh instance per use (owns its lastIndex). */
const EMBED_RE = /\\\{\{|\{\{\s*([^{}]+?)\s*\}\}/g;

/** HTML-escape text and double-quoted attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Coerce a resolved ctx value to a string (null/undefined → "", object → JSON). */
function toStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Replace each `{{ node.path }}` with `escapeValue(resolvedString)`. The surrounding characters are
 * left untouched — so for a rich-HTML position the author's markup survives while the substituted
 * value is escaped. A `{{ $secrets.NAME }}` token is PRESERVED verbatim (only the activity may
 * resolve a secret, after render); `\{{` emits a literal `{{`.
 */
function interpolate(
  s: string,
  ctx: Record<string, unknown>,
  escapeValue: (v: string) => string,
): string {
  if (!s.includes("{{")) return s;
  return s.replace(new RegExp(EMBED_RE.source, "g"), (match, path?: string) => {
    if (match === "\\{{") return "{{";
    const ref = (path ?? "").trim();
    if (isSecretRef(ref)) return match; // resolved in-activity, never here
    return escapeValue(toStr(getByPath(ctx, ref)));
  });
}

/** Plain-text position (heading, button label, alt): escape the author literal AND the values, so
 *  NO markup — author's or interpolated — can render. Escape the literal first; `{{ }}` braces and
 *  ref chars survive escaping, then the tokens resolve to escaped values. */
function renderPlainText(s: string, ctx: Record<string, unknown>): string {
  return interpolate(escapeHtml(s), ctx, escapeHtml);
}

/** Rich-HTML position (the `text` block): the author's markup is PRESERVED (it's authored in the
 *  WYSIWYG block, sanitized on write in the editor slice); only the interpolated ctx values are
 *  HTML-escaped. */
function renderRichHtml(html: string, ctx: Record<string, unknown>): string {
  return interpolate(html, ctx, escapeHtml);
}

/** A URL position (`href`/`src`): resolve, reject dangerous schemes (`javascript:`/`data:`/
 *  `vbscript:`), then attribute-escape. Returns "" for a rejected/empty URL so the caller can drop
 *  the element. Relative URLs and http(s)/mailto pass. */
function renderUrl(s: string, ctx: Record<string, unknown>): string {
  const raw = interpolate(s, ctx, (v) => v).trim();
  if (raw === "") return "";
  if (/^[a-z0-9.+-]*\s*:/i.test(raw)) {
    // has a scheme — allow only a safe set (case/space-insensitive at the start)
    if (!/^\s*(https?|mailto):/i.test(raw)) return "";
  }
  return escapeHtml(raw);
}

/** Clamp a spacer height to a sane pixel range (author number, but keep the markup bounded). */
function clampPx(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(200, Math.round(n)));
}

function renderBlock(b: TemplateBlock, ctx: Record<string, unknown>): string {
  switch (b.type) {
    case "heading": {
      const level = b.level >= 1 && b.level <= 3 ? b.level : 2;
      return `<h${level}>${renderPlainText(b.text, ctx)}</h${level}>`;
    }
    case "text":
      return `<div>${renderRichHtml(b.html, ctx)}</div>`;
    case "image": {
      const src = renderUrl(b.src, ctx);
      if (src === "") return "";
      return `<img src="${src}" alt="${renderPlainText(b.alt ?? "", ctx)}" style="max-width:100%" />`;
    }
    case "button": {
      const href = renderUrl(b.href, ctx);
      const label = renderPlainText(b.label, ctx);
      return href === ""
        ? `<span>${label}</span>`
        : `<a href="${href}">${label}</a>`;
    }
    case "divider":
      return "<hr />";
    case "spacer":
      return `<div style="height:${clampPx(b.size)}px"></div>`;
    case "field":
      return ""; // FORM-only — an email skips input fields
  }
}

/**
 * Render a template's blocks to email-safe HTML, interpolating `{{ node.path }}` from `ctx` with
 * position-aware escaping (see the module header). Pure + deterministic — safe to call in-activity
 * (the `sendEmail` activity does, in Slice 2). `field` blocks are skipped. `{{ $secrets.X }}` is
 * left verbatim for the activity's in-memory secret resolution.
 */
export function renderEmailHtml(
  blocks: TemplateBlock[],
  ctx: Record<string, unknown>,
): string {
  return blocks
    .map((b) => renderBlock(b, ctx))
    .filter((h) => h !== "")
    .join("\n");
}

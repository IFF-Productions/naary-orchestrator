// Secure-by-default rich-HTML renderer. The template block editor (and, later, the public form
// page) render a `text` block's author-authored HTML via `dangerouslySetInnerHTML`. That HTML is
// NOT trusted: content templates are env-scoped and shared across every user in a workspace, so one
// author's `text` block runs in a co-worker's browser the moment they open the template. The DSL's
// `renderEmailHtml` only ESCAPES interpolated `{{ }}` values — it does not sanitize the author's own
// markup (and it runs in the Temporal workflow context, where there's no DOM to sanitize against).
// So we sanitize here, at the browser sink, with DOMPurify — the one place a real DOM exists.
import DOMPurify from "dompurify";
import { useMemo } from "react";

/**
 * Sanitize untrusted HTML to a safe subset (drops `<script>`, event handlers like `onerror`/
 * `onload`, `javascript:`/`data:` URLs, `<iframe>`/`<object>`, etc.) using DOMPurify's secure
 * defaults. Exported for unit tests; components should use {@link SafeHtml}. Requires a DOM — this
 * is browser-only code (the app is a pure SPA, so `window` always exists at render).
 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html);
}

/**
 * Render untrusted rich HTML safely. Drop-in for `<div dangerouslySetInnerHTML>` — sanitizes the
 * html first so an authored `<img onerror=…>` / `<script>` can never execute in the viewer's
 * browser. Reuse this at EVERY sink that renders template/author HTML so no sink is forgotten.
 */
export function SafeHtml({
  html,
  ...rest
}: { html: string } & React.HTMLAttributes<HTMLDivElement>) {
  const clean = useMemo(() => sanitizeHtml(html), [html]);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized above by DOMPurify.
  return <div {...rest} dangerouslySetInnerHTML={{ __html: clean }} />;
}

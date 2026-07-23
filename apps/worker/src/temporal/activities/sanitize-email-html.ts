import sanitizeHtml from "sanitize-html";

/**
 * Belt-and-suspenders sanitizer for outbound email HTML, applied at the SMTP egress sink
 * (`callSendEmail`). A `sendEmail` node's body — whether rendered from a content template's `text`
 * block or written inline — is authored HTML: `renderEmailHtml` escapes interpolated `{{ }}` values
 * but passes the author's OWN markup through verbatim, so a tenant author could put `<script>` /
 * `onerror` in it. Every in-app RENDER of that HTML is already sanitized at its React sink (SafeHtml,
 * DOMPurify); the one remaining consumer is the sent email. Mail clients strip active content from
 * HTML mail themselves, so this is defense-in-depth — NOT a vuln fix (the recipient is the tenant's
 * own chosen address, no cross-origin/cross-tenant escalation).
 *
 * By the time HTML reaches this sink every `{{ }}` token is already resolved (email has no
 * in-activity `$secrets` step), so there is no token to preserve — plain sanitize. The allowlist is
 * exactly what `renderEmailHtml` emits (headings, the text `<div>`, `<img style="max-width…">`, an
 * `<a href>` button, `<hr>`, the spacer `<div style="height:Npx">`) plus the safe rich-text tags the
 * editor's toolbar produces; the two inline styles it emits are preserved via `allowedStyles`.
 * Parser-based (sanitize-html), not a hand-rolled regex.
 */
export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      "h1",
      "h2",
      "h3",
      "p",
      "br",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "s",
      "a",
      "ul",
      "ol",
      "li",
      "span",
      "div",
      "blockquote",
      "hr",
      "code",
      "pre",
      "img",
    ],
    allowedAttributes: {
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "style"],
      div: ["style"],
      span: ["style"],
    },
    // Only the two properties renderEmailHtml emits — everything else in a style attr is dropped.
    allowedStyles: {
      "*": {
        "max-width": [/^\d+(px|%)$/],
        height: [/^\d+px$/],
      },
    },
    // Match renderEmailHtml's URL scheme gate (relative URLs still allowed by default).
    allowedSchemes: ["http", "https", "mailto"],
    // <script>/<style> content is discarded (default nonTextTags); on* handlers are dropped by the
    // attribute allowlist above.
  });
}

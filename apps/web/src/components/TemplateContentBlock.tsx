// Shared renderer for a template's CONTENT blocks (heading/text/image/button/divider/spacer). Used
// by BOTH the block editor's form preview AND the public form page, so the two can never silently
// diverge — the exact bug Slice 4c fixes. Content is rendered through the SAME `renderEmailHtml` the
// worker sends and the email preview shows, then sanitized by SafeHtml (DOMPurify) at the browser
// sink — so the author's markup can't run in a viewer's browser. `field` blocks are NOT handled here
// (they carry no display markup): each surface renders its own input — a disabled preview control in
// the editor, a live `FormField` on the public page — so this returns null for them.
import { renderEmailHtml, type TemplateBlock } from "@naary/dsl";
import { SafeHtml } from "./SafeHtml";

export function TemplateContentBlock({ block }: { block: TemplateBlock }) {
  // Fields are rendered by the caller (interactive), not as static content.
  if (block.type === "field") return null;
  // renderEmailHtml escapes interpolated {{ }} values (empty here — a form has no run ctx) and
  // scheme-gates href/src; SafeHtml then strips any author-supplied scripts/handlers.
  return <SafeHtml html={renderEmailHtml([block], {})} />;
}

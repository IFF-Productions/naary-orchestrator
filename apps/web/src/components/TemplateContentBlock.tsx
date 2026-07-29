// Shared renderer for a template's CONTENT blocks (heading/text/image/button/divider/spacer). Used
// by BOTH the block editor's form preview AND the public form page, so the two can never silently
// diverge — the exact bug Slice 4c fixes. Content is rendered through the SAME `renderEmailHtml` the
// worker sends and the email preview shows, then sanitized by SafeHtml (DOMPurify) at the browser
// sink — so the author's markup can't run in a viewer's browser. `field` blocks are NOT handled here
// (they carry no display markup): each surface renders its own input — a disabled preview control in
// the editor, a live `FormField` on the public page — so this returns null for them.
// DEEP IMPORT, deliberately (#928) — NOT `from "@naary/dsl"`. This component is reachable from
// the eager entry graph (components/index.ts → AppShell), and one barrel import here colours the
// 161KB integration catalog + zod into the chunk index.html modulepreloads. `template-blocks` is
// catalog-free and zod-free (#926), so this costs `mcp-args` + `template` and nothing else.
// The subpath is aliased to TS source in vite.config.ts AND .storybook/main.ts.
import {
  renderEmailHtml,
  type TemplateBlock,
} from "@naary/dsl/dist/template-blocks";
import { SafeHtml } from "./SafeHtml";

export function TemplateContentBlock({
  block,
  preview,
}: {
  block: TemplateBlock;
  /** In an editor PREVIEW, disable pointer interaction so a `button`/link block (rendered as a live
   *  `<a href>`) can't navigate the author away from the editor. The public form page omits this so
   *  its links work. */
  preview?: boolean;
}) {
  // Fields are rendered by the caller (interactive), not as static content.
  if (block.type === "field") return null;
  // renderEmailHtml escapes interpolated {{ }} values (empty here — a form has no run ctx) and
  // scheme-gates href/src; SafeHtml then strips any author-supplied scripts/handlers.
  const html = <SafeHtml html={renderEmailHtml([block], {})} />;
  return preview ? <div style={{ pointerEvents: "none" }}>{html}</div> : html;
}

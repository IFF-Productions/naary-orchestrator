/**
 * Pure selection-splice helpers for the `text` block's rich-text toolbar (TemplateBlockEditor). The
 * toolbar is a formatting layer OVER a plain `<textarea>` (not a contentEditable WYSIWYG): the
 * textarea keeps `{{ node.field }}` tokens intact as literal text, the live preview already renders
 * the real formatted result (renderEmailHtml + SafeHtml), and these functions just splice HTML tags
 * around / into the current selection. Kept pure (no DOM) so the off-by-one selection math is
 * unit-tested; the component applies the returned caret range back onto the textarea after render.
 */
export interface Splice {
  /** The new textarea value. */
  value: string;
  /** Selection to restore after the value updates (so the caret lands sensibly). */
  selStart: number;
  selEnd: number;
}

/** Wrap the selection with `before`/`after` (bold, italic). The inner text stays selected. */
export function wrap(
  value: string,
  start: number,
  end: number,
  before: string,
  after: string,
): Splice {
  const selected = value.slice(start, end);
  const next =
    value.slice(0, start) + before + selected + after + value.slice(end);
  return {
    value: next,
    selStart: start + before.length,
    selEnd: end + before.length,
  };
}

/**
 * Insert `snippet` over the selection. Without `select`, the caret collapses to just after the
 * snippet; with `select` (a [start,end] range RELATIVE to the snippet), that substring is selected —
 * used to highlight the part the author should replace next (a link URL, a field path).
 */
export function insert(
  value: string,
  start: number,
  end: number,
  snippet: string,
  select?: [number, number],
): Splice {
  const next = value.slice(0, start) + snippet + value.slice(end);
  if (select) {
    return {
      value: next,
      selStart: start + select[0],
      selEnd: start + select[1],
    };
  }
  const caret = start + snippet.length;
  return { value: next, selStart: caret, selEnd: caret };
}

/** Wrap the selection as a `<ul>`/`<ol>` list — one `<li>` per selected line (empty → one item). */
export function wrapList(
  value: string,
  start: number,
  end: number,
  tag: "ul" | "ol",
): Splice {
  const selected = value.slice(start, end) || "item";
  const items = selected
    .split("\n")
    .map((line) => `  <li>${line}</li>`)
    .join("\n");
  const block = `<${tag}>\n${items}\n</${tag}>`;
  const next = value.slice(0, start) + block + value.slice(end);
  return { value: next, selStart: start, selEnd: start + block.length };
}

/** A link over the selection (label = selection or "link"); the `https://example.com` URL is
 *  pre-selected so the author types over it. */
export function link(value: string, start: number, end: number): Splice {
  const label = value.slice(start, end) || "link";
  const pre = '<a href="';
  const url = "https://example.com";
  const snippet = `${pre}${url}">${label}</a>`;
  return insert(value, start, end, snippet, [
    pre.length,
    pre.length + url.length,
  ]);
}

/** A `{{ field }}` token with `field` pre-selected (`{{ ` is 3 chars). */
export function fieldToken(value: string, start: number, end: number): Splice {
  return insert(value, start, end, "{{ field }}", [3, 8]);
}

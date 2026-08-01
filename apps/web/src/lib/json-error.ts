/**
 * What we tell a user when JSON they typed (or pasted, or picked as a file) won't parse.
 *
 * `JSON.parse` hands us a genuinely useful diagnostic — the offending token, a snippet of the
 * surrounding text, and often `at position N (line L column C)`. Every one of our JSON inputs
 * used to throw that away and show two words ("Invalid JSON"), which on a pasted webhook body
 * or a large sample payload means hunting one character by eye (#1027).
 *
 * So: keep OUR sentence, which says what the user should do about it, and append the engine's,
 * which says where. The engine text is passed through VERBATIM — no truncation, no rewording,
 * no regex over it. V8 rewords these between Node versions and already elides long snippets with
 * `...`; anything we did to it would silently stop matching. The position/line/column is inherited
 * for free wherever the parser emits one.
 */
export function jsonErrorText(
  err: unknown,
  lead = "That isn't valid JSON",
): string {
  const detail = (
    err instanceof Error ? err.message : String(err ?? "")
  ).trim();
  return detail ? `${lead} — ${detail}` : `${lead}.`;
}

/** Which top-level shapes a JSON field accepts once the text parses. */
export type JsonFieldShape = "object" | "objectOrArray" | "array";

export type JsonFieldResult =
  { ok: true; value: unknown } | { ok: false; error: string };

/**
 * The canvas JSON fields' validation, as a pure function (apps/web's vitest is `environment:
 * "node"` — no DOM — so the rule lives here and the components stay a textarea around it).
 *
 * Blank ⇒ `{ ok: true, value: undefined }` (clear the setting). A SHAPE mismatch — valid JSON of
 * the wrong type — keeps its own sentence rather than a parser message, because there is no parse
 * error to report and "Must be a JSON object" is the more useful thing to say.
 */
export function parseJsonField(
  text: string,
  shape: JsonFieldShape,
): JsonFieldResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return { ok: false, error: jsonErrorText(e) };
  }
  const isArray = Array.isArray(parsed);
  const isObject = typeof parsed === "object" && parsed !== null && !isArray;
  const ok =
    shape === "array"
      ? isArray
      : shape === "object"
        ? isObject
        : isObject || isArray;
  if (!ok) {
    return {
      ok: false,
      error:
        shape === "array"
          ? "Must be a JSON array"
          : shape === "object"
            ? "Must be a JSON object"
            : "Must be a JSON object or array",
    };
  }
  return { ok: true, value: parsed };
}

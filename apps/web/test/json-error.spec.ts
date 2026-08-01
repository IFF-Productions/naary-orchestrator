import { describe, expect, it } from "vitest";
import { jsonErrorText, parseJsonField } from "../src/lib/json-error";

/**
 * The parser's own message, measured HERE rather than hardcoded. V8 rewords these between Node
 * versions — the reported payload reads `Unexpected token ',', ..."…" is not valid JSON` on Node
 * 24 but read `Unexpected token t in JSON at position 19` on Node 18 — so an exact-match
 * assertion would go stale and get muted. Asserting the surfaced error CONTAINS whatever the
 * engine said proves the diagnostic is neither dropped, truncated nor reworded, and it carries
 * the offending token by construction (#1027).
 */
function engineMessage(text: string): string {
  try {
    JSON.parse(text);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error(`expected ${text} to be invalid JSON`);
}

// The exact input from the bug report: a bare `t` where a value belongs, plus a trailing comma.
const REPORTED = '{\n "data":[1,2,3,4,5,t,7,8,9],\n}';
// A trailing comma on its own — the case where V8 hands us `at position N (line L column C)`.
const TRAILING_COMMA = '{"data":[1,2,3],}';

describe("jsonErrorText", () => {
  it("keeps the parser's whole diagnostic behind our lead", () => {
    const detail = engineMessage(REPORTED);
    const shown = jsonErrorText(new SyntaxError(detail));
    expect(shown).toContain(detail);
    expect(shown.startsWith("That isn't valid JSON")).toBe(true);
    expect(shown).not.toBe("Invalid JSON");
  });

  it("takes a caller's lead and still appends the detail", () => {
    expect(
      jsonErrorText(new SyntaxError("boom"), "Run input is not valid JSON"),
    ).toBe("Run input is not valid JSON — boom");
  });

  it("falls back to the lead alone when there is no message to add", () => {
    expect(jsonErrorText(new SyntaxError(""))).toBe("That isn't valid JSON.");
    expect(jsonErrorText(new SyntaxError("   \n"))).toBe(
      "That isn't valid JSON.",
    );
  });

  it("appends the message verbatim — the emptiness check trims, the output does not", () => {
    // "Verbatim" has to be literally true or the next reader can't build on it: whitespace is the
    // cheapest observable reshape, and if we strip that, nothing stops the next transformation.
    expect(jsonErrorText(new SyntaxError("  boom  "))).toBe(
      "That isn't valid JSON —   boom  ",
    );
  });
});

describe("parseJsonField", () => {
  it("surfaces the parser's message for the reported input", () => {
    const result = parseJsonField(REPORTED, "object");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Not the two words the field used to show.
    expect(result.error).not.toBe("Invalid JSON");
    expect(result.error).toContain(engineMessage(REPORTED));
  });

  it("carries the position/line/column through when the parser gives one", () => {
    const result = parseJsonField(TRAILING_COMMA, "object");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const detail = engineMessage(TRAILING_COMMA);
    expect(result.error).toContain(detail);
    // Guard the *pass-through*, not V8's wording: whatever position the engine reported has to
    // reach the user. If a future Node stops emitting one, this stays true vacuously.
    for (const fragment of detail.match(/position \d+|line \d+ column \d+/g) ??
      [])
      expect(result.error).toContain(fragment);
  });

  it("reports the position in the text the USER typed, not in a trimmed copy", () => {
    // Leading whitespace is insignificant to the parser but not to its position counter. Parsing
    // a trimmed copy pointed at "line 1 column 17" for an error that is on line 3 — a pointer
    // into a string the user never typed.
    const padded = '\n\n  {"data":[1,2,3],}';
    const result = parseJsonField(padded, "object");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(engineMessage(padded));
  });

  it("keeps the shape errors, which are not parse failures", () => {
    expect(parseJsonField("[1,2]", "object")).toEqual({
      ok: false,
      error: "Must be a JSON object",
    });
    expect(parseJsonField('{"a":1}', "array")).toEqual({
      ok: false,
      error: "Must be a JSON array",
    });
    expect(parseJsonField("42", "objectOrArray")).toEqual({
      ok: false,
      error: "Must be a JSON object or array",
    });
  });

  it("accepts the shapes each field allows, and blank clears the value", () => {
    expect(parseJsonField(' {"a":1} ', "object")).toEqual({
      ok: true,
      value: { a: 1 },
    });
    expect(parseJsonField("[1,2]", "objectOrArray")).toEqual({
      ok: true,
      value: [1, 2],
    });
    expect(parseJsonField('{"a":1}', "objectOrArray")).toEqual({
      ok: true,
      value: { a: 1 },
    });
    expect(parseJsonField("[1,2]", "array")).toEqual({
      ok: true,
      value: [1, 2],
    });
    expect(parseJsonField("   ", "object")).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("stays strict about trailing commas (leniency is a separate product call, #1027)", () => {
    expect(parseJsonField(TRAILING_COMMA, "object").ok).toBe(false);
  });
});

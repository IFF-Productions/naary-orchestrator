import { describe, expect, it } from "vitest";
import { exprCompletionSource } from "../src/components/ExpressionEditor";

/**
 * Expression autocomplete inside `{{ … }}`.
 *
 * Reported: "unwrapping fields are not autocompleted (or show options after typing `{{`)". Two
 * separate things had to be true for that to work, and only one was:
 *   - the SOURCE must return options for an empty `{{` (it did — pinned here);
 *   - something must OPEN the list. CodeMirror's `activateOnTyping` only fires on WORD characters,
 *     and `{` isn't one, so nothing opened until you typed a letter — exactly when you least know
 *     what to type. That half is an `inputHandler` in the editor (not unit-testable here).
 */

const REFS = {
  nodeIds: ["agent-1a2b", "http-9f"],
  keysAt: (base: string) =>
    base === "agent-1a2b" ? ["output", "status"] : [],
};

/** The slice of CompletionContext the source actually reads. */
const ctxAt = (doc: string) =>
  ({
    pos: doc.length,
    state: { sliceDoc: (from: number, to: number) => doc.slice(from, to) },
  }) as never;

const complete = (doc: string) => exprCompletionSource(REFS)(ctxAt(doc));

describe("exprCompletionSource", () => {
  /** THE REPORTED CASE: the list must be available the moment `{{` is typed, with nothing after. */
  it("offers every node id immediately after `{{`", () => {
    const res = complete("{{");
    expect(res?.options.map((o) => o.label)).toEqual(["agent-1a2b", "http-9f"]);
    // Replaces nothing yet — the insert point is the cursor.
    expect(res?.from).toBe(2);
  });

  it("still offers them after `{{ ` with a space", () => {
    expect(complete("{{ ")?.options).toHaveLength(2);
  });

  it("filters to keys once a dotted base is typed", () => {
    const res = complete("{{ agent-1a2b.");
    expect(res?.options.map((o) => o.label)).toEqual(["output", "status"]);
  });

  /** Node ids are `${kind}-${uuid}` — a hyphen must not end the completion. */
  it("keeps completing across the hyphen in a node id", () => {
    expect(complete("{{ agent-")?.options).toHaveLength(2);
  });

  it("offers nothing outside a token", () => {
    expect(complete("plain text")).toBe(null);
    expect(complete("{{ a }} then ")).toBe(null);
  });

  /** `\{{` is an escaped literal, not a token — completing there would corrupt the text. */
  it("offers nothing inside an escaped `\\{{`", () => {
    expect(complete("\\{{")).toBe(null);
  });

  it("offers nothing once the token is closed before the cursor", () => {
    expect(complete("{{ agent-1a2b.output }}")).toBe(null);
  });
});

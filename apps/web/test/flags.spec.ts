import { describe, expect, it } from "vitest";
import {
  WEB_FLAG_DEFAULTS,
  resolveFlags,
} from "../src/workspace/FlagsProvider";

/**
 * The fail-safe contract (#491): the flags consumer must reproduce "provider not wired"
 * behavior whenever it has no fetched values — while loading, and on a failed fetch. That is
 * the common case in local dev and any deploy without Flagsmith, so a regression here silently
 * hides shipped features (kill-switches default ON). resolveFlags is the pure core of that.
 */
describe("resolveFlags — feature-flag fail-safe", () => {
  it("null (loading / fetch failed) → every flag is its safe code default", () => {
    expect(resolveFlags(null)).toEqual(WEB_FLAG_DEFAULTS);
    // The kill-switch stays ON so its gated feature is visible without a provider.
    expect(resolveFlags(null)["canvas-import-tools"]).toBe(true);
    expect(resolveFlags(null)["chat-rag"]).toBe(false);
  });

  it("fetched values override the defaults (both directions)", () => {
    const r = resolveFlags({
      "canvas-import-tools": false, // provider flips the kill-switch OFF
      "chat-rag": true,
    });
    expect(r["canvas-import-tools"]).toBe(false);
    expect(r["chat-rag"]).toBe(true);
  });

  it("a known flag ABSENT from the fetched map keeps its default", () => {
    const r = resolveFlags({ "chat-rag": true });
    expect(r["chat-rag"]).toBe(true);
    expect(r["canvas-import-tools"]).toBe(true); // untouched → default
  });

  it("ignores unknown keys and non-boolean values (never trusts junk over a default)", () => {
    const r = resolveFlags({
      "mystery-flag": true,
      // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed provider payload
      "canvas-import-tools": "yes" as any,
    } as Record<string, boolean>);
    expect(r).not.toHaveProperty("mystery-flag");
    // A non-boolean is discarded → the safe default wins, not a truthy string.
    expect(r["canvas-import-tools"]).toBe(true);
  });
});

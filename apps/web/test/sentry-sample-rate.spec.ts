/**
 * REGRESSION (#1034): "no session replays are recorded at all" — and, silently, no traces.
 *
 * The original helper was `Number(raw ?? "")` guarded by `Number.isFinite`. `??` turns an
 * absent value into `""`, `Number("") === 0`, and `0` IS finite — so the guard passed and 0
 * was returned. The `fallback` argument was reachable ONLY for a non-empty, non-numeric
 * string. Production hit it because an unset GitHub secret interpolates to the empty string,
 * so deploy.yml passed the build arg present-and-empty rather than absent.
 *
 * This table is the entire proof, and it must stay a table: a happy-path test over `"0.25"`
 * would have passed against the buggy helper every day it shipped. The rows that were WRONG
 * before the fix are marked; asserting only that Sentry initialises can never catch this,
 * because the defect is in the VALUE.
 */
import { describe, expect, it } from "vitest";
import { sampleRate } from "../src/lib/sentry-sample-rate";

describe("sampleRate", () => {
  const cases: Array<{
    raw: unknown;
    fallback: number;
    expected: number;
    why: string;
  }> = [
    // ── the bug: "no override" must mean the fallback, not 0 ────────────────────────────
    {
      raw: "",
      fallback: 1,
      expected: 1,
      why: "unset GH secret → empty build arg",
    },
    {
      raw: "   ",
      fallback: 1,
      expected: 1,
      why: "whitespace-only is still no value",
    },
    { raw: undefined, fallback: 1, expected: 1, why: "absent → fallback" },
    { raw: null, fallback: 1, expected: 1, why: "null → fallback" },
    {
      raw: "",
      fallback: 0.1,
      expected: 0.1,
      why: "same, for tracesSampleRate",
    },
    // ── explicit values win, including an explicit zero ─────────────────────────────────
    {
      raw: "0",
      fallback: 1,
      expected: 0,
      why: "an explicit 0 is a real override",
    },
    { raw: "0.25", fallback: 1, expected: 0.25, why: "plain rate" },
    {
      raw: " 0.5 ",
      fallback: 1,
      expected: 0.5,
      why: "surrounding whitespace trimmed",
    },
    { raw: "1", fallback: 0, expected: 1, why: "the top of the range" },
    // ── junk → fallback ─────────────────────────────────────────────────────────────────
    { raw: "abc", fallback: 0.1, expected: 0.1, why: "non-numeric typo" },
    { raw: "Infinity", fallback: 0.1, expected: 0.1, why: "non-finite typo" },
    // ── out of range → clamped into [0,1] (Sentry expects a rate) ───────────────────────
    {
      raw: "1.5",
      fallback: 0,
      expected: 1,
      why: "above the range clamps to 1",
    },
    {
      raw: "10",
      fallback: 0,
      expected: 1,
      why: "a typo'd percentage clamps, not sails through",
    },
    { raw: "-1", fallback: 1, expected: 0, why: "below the range clamps to 0" },
  ];

  for (const { raw, fallback, expected, why } of cases) {
    it(`${JSON.stringify(raw)} with fallback ${fallback} → ${expected} (${why})`, () => {
      expect(sampleRate(raw, fallback)).toBe(expected);
    });
  }

  // The concrete production symptom, spelled out: with every rate secret unset, these are the
  // three values instrument.ts hands Sentry.init. Before the fix all three were 0.
  it("restores the documented defaults when nothing is configured", () => {
    expect(sampleRate(undefined, 1)).toBe(1); // replaysOnErrorSampleRate — was 0
    expect(sampleRate("", 1)).toBe(1); // …via an unset secret — was 0
    expect(sampleRate("", 0.1)).toBe(0.1); // tracesSampleRate — was 0
    expect(sampleRate("", 0)).toBe(0); // replaysSessionSampleRate — unchanged
  });
});

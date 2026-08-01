/**
 * Backend sample-rate parsing (#1034 — the browser half is apps/web/test/sentry-sample-rate.spec.ts).
 *
 * The browser bug was that an unset value parsed to 0 and made the documented default
 * unreachable. The backend does NOT share that failure: its intended default IS 0, so
 * `Number(env.X ?? "0")` returning 0 for an unset var was already the right answer, and the
 * deploy `unset`s the empty-string secrets (deploy.yml) on top of a `${…:-0}` compose default.
 * What it DID share is the missing guards: a typo'd value produced `NaN`, and `NaN > 0` is
 * false, so `initSentry` would disable profiling while looking configured; and an
 * out-of-range value was passed to Sentry verbatim.
 *
 * These rows pin both the unchanged defaults (no quota surprise on the backend) and the new
 * guards.
 */
import { describe, expect, it } from "vitest";
import {
  sentryProfilesSampleRate,
  sentryTracesSampleRate,
} from "../src/config";

// Both readers take `env` as a parameter, so pass a literal — no process.env mutation needed.
const env = (v: Record<string, string>): NodeJS.ProcessEnv => v;

describe.each([
  [
    "sentryTracesSampleRate",
    "SENTRY_TRACES_SAMPLE_RATE",
    sentryTracesSampleRate,
  ],
  [
    "sentryProfilesSampleRate",
    "SENTRY_PROFILES_SAMPLE_RATE",
    sentryProfilesSampleRate,
  ],
] as const)("%s", (_name, varName, read) => {
  const cases: Array<{
    raw: string | undefined;
    expected: number;
    why: string;
  }> = [
    // ── unchanged: unconfigured stays OFF on the backend ────────────────────────────────
    {
      raw: undefined,
      expected: 0,
      why: "absent → off (the documented default)",
    },
    {
      raw: "",
      expected: 0,
      why: "compose renders an unset var as empty → off",
    },
    { raw: "   ", expected: 0, why: "whitespace-only → off" },
    // ── explicit values ─────────────────────────────────────────────────────────────────
    { raw: "0", expected: 0, why: "explicit off" },
    { raw: "0.25", expected: 0.25, why: "plain rate" },
    {
      raw: " 0.5 ",
      expected: 0.5,
      why: "trimmed (a .env file keeps trailing spaces)",
    },
    { raw: "1", expected: 1, why: "the top of the range" },
    // ── new guards ──────────────────────────────────────────────────────────────────────
    { raw: "abc", expected: 0, why: "non-numeric typo → fallback, not NaN" },
    { raw: "on", expected: 0, why: "a boolean-ish typo → fallback, not NaN" },
    { raw: "Infinity", expected: 0, why: "non-finite → fallback" },
    { raw: "1.5", expected: 1, why: "above the range clamps to 1" },
    {
      raw: "10",
      expected: 1,
      why: "a typo'd percentage clamps, not sails through",
    },
    { raw: "-1", expected: 0, why: "below the range clamps to 0" },
  ];

  for (const { raw, expected, why } of cases) {
    it(`${varName}=${JSON.stringify(raw)} → ${expected} (${why})`, () => {
      expect(read(env(raw === undefined ? {} : { [varName]: raw }))).toBe(
        expected,
      );
    });
  }

  it("never returns NaN, which reads as 'off' but is not the configured value", () => {
    for (const raw of ["abc", "on", "", "  "]) {
      expect(Number.isNaN(read(env({ [varName]: raw })))).toBe(false);
    }
  });
});

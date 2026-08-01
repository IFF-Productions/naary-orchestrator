/**
 * Backend sample-rate parsing (#1034 — the browser half is apps/web/test/sentry-sample-rate.spec.ts).
 *
 * The browser bug was that an unset value parsed to 0, making every documented default
 * unreachable. The backend does NOT share that failure, for two independent reasons:
 *
 *   1. its intended default IS 0, so `Number(env.X ?? "0")` returning 0 was already right; and
 *   2. it never actually sees the empty string in the deployed path. `docker-compose.yml`
 *      writes `${SENTRY_TRACES_SAMPLE_RATE:-0}`, and `:-` substitutes when the variable is
 *      unset **or empty** (`${VAR-0}`, without the colon, is the unset-only form), so an unset
 *      repo secret — which CI does render as `""` — reaches the container as `"0"`.
 *      `deploy.yml` also `unset`s the empty ones first.
 *
 * What it DID share is the missing guards: a typo'd value produced `NaN`, and `NaN > 0` is
 * false, so `initSentry` disabled profiling while looking configured; and an out-of-range
 * value was passed to Sentry verbatim.
 *
 * The `""` / whitespace rows below are still worth pinning — a caller CAN produce them (any
 * path with no `:-` in front of it, e.g. `pnpm worker` with the var exported-but-empty) —
 * they just aren't how production gets an unset value.
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
// Typed as ProcessEnv (`string | undefined` values), not `Record<string, string>`: pretending
// every key always has a value is the exact assumption this bug came from.
const env = (v: NodeJS.ProcessEnv): NodeJS.ProcessEnv => v;

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
      // NOT how compose delivers an unset var — `${VAR:-0}` already substitutes 0 for an
      // EMPTY one. This is a path with no `:-` in front of it: `pnpm worker` with the var
      // exported-but-empty, which nothing sanitises on the way in.
      why: "explicitly empty (no :- default in front of it) → off",
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

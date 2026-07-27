import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isRetryableStartupFailure } from "./local-test-env";

/**
 * #709 — `verify` went red with no test failure: a suite could not START.
 *
 *   Failed to start ephemeral server: Failed connecting to test server after 5 seconds,
 *     last error: ... tcp connect error, 127.0.0.1:32891, Os { code: 111, kind: ConnectionRefused }
 *
 * 3273 tests passed; the one failure was infrastructure. It costs ~8.5 minutes to re-run, and worse,
 * it trains people to re-run red without reading the log — #702 nearly wrote off a REAL e2e failure
 * as "the known runner flake".
 *
 * Two halves to keeping that fixed, and this file covers both:
 *   1. the classification must actually recognise the failures we've seen (they are real strings
 *      from real CI runs, not invented ones);
 *   2. no spec may create a Temporal environment outside the retrying helper — which is exactly how
 *      the chaos suite came to have no retry at all when #709 fired.
 */

const TEST_DIR = resolve(__dirname);

describe("startup-failure classification", () => {
  /** Verbatim from CI run 29627553035 (the derived-HTTP-port bind race) and #709. */
  it.each([
    [
      "#709 connect timeout",
      'Error: Failed to start ephemeral server: Failed connecting to test server after 5 seconds, last error: tonic::transport::Error(Transport, ConnectError(tcp connect error, 127.0.0.1:32891, Os { code: 111, kind: ConnectionRefused, message: "Connection refused" }))',
    ],
    [
      "windows bind race",
      "Error: Failed to start ephemeral server: bind: Only one usage of each socket address (protocol/network address/port) is normally permitted. (os error 10048)",
    ],
    ["posix bind race", "Error: listen EADDRINUSE: address already in use"],
  ])("retries a %s", (_name, error) => {
    expect(isRetryableStartupFailure(error)).toBe(true);
  });

  /**
   * The other direction matters just as much: retrying a misconfiguration three times only delays
   * an unavoidable red, and would make a genuine break look like flakiness.
   */
  it.each([
    ["a missing CLI", "Error: spawn temporal ENOENT"],
    ["a bad executable", "Error: unknown flag: --nope"],
    ["a real assertion", "AssertionError: expected 'completed' to be 'failed'"],
    ["a workflow bug", "Error: Nondeterminism error: replay diverged"],
  ])("does NOT retry %s", (_name, error) => {
    expect(isRetryableStartupFailure(error)).toBe(false);
  });
});

describe("every spec gets its Temporal from the retrying helper", () => {
  const specs = readdirSync(TEST_DIR).filter((f) => f.endsWith(".spec.ts"));

  /** Guards the guard: an empty or mis-resolved directory must fail, not pass vacuously. */
  it("is looking at the real spec directory", () => {
    expect(specs.length).toBeGreaterThan(20);
    expect(specs).toContain("chaos-durability.e2e.spec.ts");
  });

  /**
   * Constructing an environment directly bypasses both the verified-free `--http-port` and the
   * startup retry. Using the TYPE is fine and common, so this rejects only a CALL.
   *
   * Note the prose here deliberately avoids naming the constructor: the scan covers EVERY spec in
   * this directory including itself, and exempting a file would be a hole in the guard rather than a
   * quirk of it.
   */
  it.each(specs)("%s does not construct one directly", (spec) => {
    const src = readFileSync(join(TEST_DIR, spec), "utf8");
    const direct = src.match(/TestWorkflowEnvironment\s*\.\s*create\w*\s*\(/g);
    expect(
      direct,
      `${spec} must use createLocalTestEnv() / createTimeSkippingTestEnv() from ./local-test-env`,
    ).toBe(null);
  });
});

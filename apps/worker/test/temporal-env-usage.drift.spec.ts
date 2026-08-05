import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import {
  describeServerHealth,
  isRetryableStartupFailure,
  isServerUnreachableFailure,
} from "./local-test-env";

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
  /**
   * The wrapper prefix "Failed to start ephemeral server:" is shared by EVERY startup failure, so
   * matching it would retry a missing binary or a bad flag three times before reporting an
   * unavoidable red. Only the CONNECT symptom is retryable — #709's message carries both, which is
   * why the narrower match still catches it (above).
   */
  it("does NOT retry on the generic wrapper prefix alone", () => {
    expect(
      isRetryableStartupFailure(
        "Error: Failed to start ephemeral server: unknown flag: --nope",
      ),
    ).toBe(false);
  });

  it.each([
    ["a missing CLI", "Error: spawn temporal ENOENT"],
    ["a bad executable", "Error: unknown flag: --nope"],
    ["a real assertion", "AssertionError: expected 'completed' to be 'failed'"],
    ["a workflow bug", "Error: Nondeterminism error: replay diverged"],
  ])("does NOT retry %s", (_name, error) => {
    expect(isRetryableStartupFailure(error)).toBe(false);
  });
});

/**
 * #1101 — the THIRD failure mode, and the one neither retry above can reach: the server starts
 * fine, `beforeAll` returns, and it goes away part-way through the file. Every subsequent
 * `Worker.create` then fails at a line of application code, so all 7 tests in
 * `interpreter-tool-approval.e2e.spec.ts` went red looking exactly like real assertions (CI run
 * 30968861680). Nothing in that log said "infrastructure": there were ZERO `INFRASTRUCTURE:` lines
 * and ZERO retry warnings, which is precisely the proof that startup succeeded.
 *
 * Same contract as the block above, for the same reason — the classification is pinned against the
 * REAL string from the real incident, not an invented one, and pinned in BOTH directions.
 */
describe("mid-run server-unreachable classification", () => {
  /** Verbatim from CI run 30968861680 (`worker-e2e (3)` on PR #1095). */
  const INCIDENT_1101 =
    'TransportError: Namespace default was not found or otherwise could not be described: Status { code: Unavailable, message: "tcp connect error", ConnectError("tcp connect error", 127.0.0.1:36407, Os { code: 111, kind: ConnectionRefused }) }';

  it("classifies the #1101 incident error as an unreachable server", () => {
    expect(isServerUnreachableFailure(INCIDENT_1101)).toBe(true);
  });

  /**
   * The refused-connect symptom on its own, without the namespace-describe wrapper — the same
   * server death surfaced through a different call has to classify the same way.
   */
  it("classifies a bare refused connect as an unreachable server", () => {
    expect(
      isServerUnreachableFailure(
        "Error: tcp connect error, 127.0.0.1:36407, Os { code: 111, kind: ConnectionRefused }",
      ),
    ).toBe(true);
  });

  /**
   * The discriminating negative. #1073's worker-registration overlap is ALSO infrastructure, but it
   * has its own bounded retry in `interpreter-harness.ts` that genuinely works — the core resolves
   * it on its own within a few hundred ms. Classifying it as "server gone" would throw terminally
   * instead of retrying, turning a self-healing race back into a red build.
   */
  it("does NOT classify the #1073 registration overlap as an unreachable server", () => {
    expect(
      isServerUnreachableFailure(
        'Registration of multiple workers with overlapping worker task types on the same namespace, task queue, and deployment build ID not allowed: SlotKey { namespace: "default", task_queue: "orchestrator" }',
      ),
    ).toBe(false);
  });

  /**
   * `Status { code: Unavailable }` is NOT sufficient on its own: the server sends it for legitimate
   * conditions (a shutting-down frontend, a resource-exhausted namespace) that a test may be
   * asserting on. Matching bare `Unavailable` would relabel real failures as infrastructure, which
   * is the expensive direction of this mistake.
   */
  it.each([
    [
      "a plain Unavailable status",
      'Status { code: Unavailable, message: "service is shutting down" }',
    ],
    ["a real assertion", "AssertionError: expected 'completed' to be 'failed'"],
    ["a workflow bug", "Error: Nondeterminism error: replay diverged"],
    [
      "a node failure the interpreter reports",
      "ApplicationFailure: Provider rate limit exhausted [QUOTA]",
    ],
  ])("does NOT classify %s as an unreachable server", (_name, error) => {
    expect(isServerUnreachableFailure(error)).toBe(false);
  });
});

/**
 * The probe is the other half of #1101, and the half that carries the EVIDENCE. The SDK gives us no
 * pid, no exit code and no stderr for the dev server (see the long note in `local-test-env.ts`), so
 * a TCP connect to `env.address` is the only way to distinguish "the process is gone" from "the
 * process is alive and something above the transport is wrong" — opposite investigations.
 *
 * Tested against real sockets rather than mocks: the value here is entirely in what the OS reports,
 * and a mocked socket would assert our own stub instead.
 */
describe("server health probe", () => {
  async function listenOnFreePort(): Promise<{
    address: string;
    close: () => Promise<void>;
  }> {
    const srv = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const a = srv.address();
        if (a === null || typeof a === "string")
          return reject(new Error("no port"));
        resolve(a.port);
      });
    });
    return {
      address: `127.0.0.1:${port}`,
      close: () => new Promise<void>((r) => srv.close(() => r())),
    };
  }

  it("reports a listening server as reachable", async () => {
    const srv = await listenOnFreePort();
    try {
      expect(await describeServerHealth({ address: srv.address })).toContain(
        "still accepting connections",
      );
    } finally {
      await srv.close();
    }
  });

  /** The #1101 shape: the address the env handed out, with nothing listening on it any more. */
  it("reports a dead server as UNREACHABLE", async () => {
    const srv = await listenOnFreePort();
    await srv.close();
    const health = await describeServerHealth({ address: srv.address });
    expect(health).toContain("UNREACHABLE");
    // The resource reading is what tests the issue's own OOM/pressure hypothesis on the NEXT
    // occurrence, so its absence would quietly gut the diagnostic.
    expect(health).toMatch(/freemem=\d+MB\/\d+MB/);
  });

  /**
   * It only ever runs while reporting ANOTHER failure, so it must never throw — a diagnostic that
   * replaces the failure it was describing is worse than no diagnostic at all.
   */
  it("never throws on a malformed address", async () => {
    await expect(
      describeServerHealth({ address: "not-an-address" }),
    ).resolves.toContain("unparseable");
  });
});

/** RECURSIVE: a spec moved into a subdirectory must still be checked. A flat readdir would have
 *  silently stopped covering it — the drift guard would keep passing while the file it was meant to
 *  watch drifted. */
function specFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return specFiles(p);
    return name.endsWith(".spec.ts") ? [p] : [];
  });
}

describe("every spec gets its Temporal from the retrying helper", () => {
  const specs = specFiles(TEST_DIR).map((p) => relative(TEST_DIR, p));

  /**
   * Guards the guard: a mis-resolved directory must fail rather than pass vacuously. Anchored on a
   * FILE that must exist rather than a count — a count is a hostage to legitimate refactors
   * (renames, consolidation), and the walk is recursive now so moving specs around can't shrink it.
   */
  it("is looking at the real spec directory", () => {
    expect(specs).toContain("chaos-durability.e2e.spec.ts");
    expect(specs).toContain("temporal-env-usage.drift.spec.ts");
    expect(specs.length).toBeGreaterThan(5);
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

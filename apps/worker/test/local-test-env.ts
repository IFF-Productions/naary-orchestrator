/**
 * Shared TestWorkflowEnvironment factories for the worker specs. EVERY spec that needs a Temporal
 * must come through here — test/temporal-env-usage.drift.spec.ts enforces it.
 *
 * Two DIFFERENT infrastructure flakes are handled, and they need different treatment:
 *
 * 1. A DERIVED-PORT BIND RACE (dev server only). The ephemeral dev server picks a free gRPC port
 *    itself, but its companion HTTP API port is DERIVED, not checked — on the shared CI VM, where
 *    several runners execute in parallel (see the per-run-namespaced e2e, #342), that derived port
 *    can land on one another runner already holds and the server dies with "bind: Only one usage of
 *    each socket address…" (WSAEADDRINUSE), killing the whole file in beforeAll. Seen on CI run
 *    29627553035. Fixed by passing an explicitly verified-free `--http-port`.
 *
 * 2. A STARTUP CONNECT TIMEOUT (both servers). "Failed to start ephemeral server: Failed connecting
 *    to test server after 5 seconds … ConnectionRefused" — the process launched but wasn't accepting
 *    connections inside the window. That is #709: 24 default-suite specs each boot a real Temporal,
 *    several PRs' CI run concurrently on a runner co-located with prod, and 5s is not generous under
 *    that load. The window is compiled into the native core bridge and is NOT configurable from
 *    TypeScript, so RETRY is the only lever available at this layer.
 *
 * Both are retried, with a short backoff for (2) — an immediate retry on a loaded box tends to lose
 * the same race. Anything else rethrows on the first attempt: a missing CLI or bad config would fail
 * identically three times, and retrying would only delay the report.
 *
 * When retries are exhausted the failure is rethrown as an explicitly INFRASTRUCTURE error, so a red
 * CI log answers "flake or real?" by itself instead of leaving it to be judged (#709's AC).
 */
import { createServer } from "node:net";
import { TestWorkflowEnvironment } from "@temporalio/testing";

/** Ask the OS for a currently-free port (bind :0, read it back, release). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address === null || typeof address === "string") {
        srv.close();
        return reject(new Error("could not determine a free port"));
      }
      srv.close(() => resolve(address.port));
    });
  });
}

/** A port collision — a retry picks a different port, so it can succeed. */
const BIND_RACE_RE =
  /bind|address (already )?in use|socket address|EADDRINUSE/i;

/**
 * The server launched but wasn't reachable inside the bridge's fixed 5s window (#709). Retrying
 * genuinely helps here: it's contention, not misconfiguration. Matched broadly on purpose — the
 * bridge wraps the underlying cause, so the refused/os-error wording varies by platform.
 */
const STARTUP_TIMEOUT_RE =
  /failed to start ephemeral server|failed connecting to test server|connection ?refused|os error 111|timed? ?out/i;

/**
 * Is this failure one of the two known infrastructure flakes — i.e. worth another attempt?
 *
 * Exported so the classification is pinned by unit test against the REAL error strings from the two
 * CI incidents, rather than only exercised when a runner happens to be saturated. Getting this wrong
 * in either direction is costly: too narrow and #709 keeps failing builds (the original predicate
 * matched only bind races, so the connect timeout fell straight through); too broad and a genuine
 * misconfiguration gets retried three times before reporting.
 */
export function isRetryableStartupFailure(error: unknown): boolean {
  const text = String(error);
  return BIND_RACE_RE.test(text) || STARTUP_TIMEOUT_RE.test(text);
}

const MAX_ATTEMPTS = 3;
/** Wait before attempt N. Index 0 is unused (the first attempt is immediate). */
const BACKOFF_MS = [0, 750, 2000];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `start` with retries for the two known infrastructure flakes. `label` names the server kind
 * in the warning and in the final error, so a CI reader can tell a dev-server flake from a
 * time-skipping one without opening the spec.
 */
async function withStartRetry(
  label: string,
  start: () => Promise<TestWorkflowEnvironment>,
): Promise<TestWorkflowEnvironment> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(BACKOFF_MS[attempt]);
    try {
      return await start();
    } catch (e) {
      if (!isRetryableStartupFailure(e)) throw e;
      const text = String(e);
      lastErr = e;
      // Logged on purpose: a spec that passed on its third attempt still says the runner is
      // saturated, and silent retries would hide exactly the trend #709 is about.
      console.warn(
        `[test-env] ${label} failed to start (attempt ${attempt + 1}/${MAX_ATTEMPTS}), retrying: ${text.slice(0, 200)}`,
      );
    }
  }
  throw new Error(
    `INFRASTRUCTURE: ${label} would not start after ${MAX_ATTEMPTS} attempts — a Temporal test-server startup failure, NOT a test failure (#709). Last error: ${String(lastErr)}`,
  );
}

/** A local dev-server environment: real time, real Temporal. The default choice. */
export async function createLocalTestEnv(): Promise<TestWorkflowEnvironment> {
  return withStartRetry("dev server", async () => {
    // A fresh port PER ATTEMPT — that is the whole point of retrying a bind race.
    const httpPort = await freePort();
    return TestWorkflowEnvironment.createLocal({
      server: { extraArgs: ["--http-port", String(httpPort)] },
    });
  });
}

/**
 * A time-skipping environment, for specs that fast-forward timers (long waits, SLA/reminder
 * schedules, the chaos suite). A DIFFERENT binary from the dev server.
 *
 * No `--http-port`: TimeSkippingServerConfig exposes only `port` and picks a free one itself, with
 * no derived companion port to collide — so flake (1) doesn't apply and only the startup retry
 * does. Routed through the same helper anyway, because `chaos-durability.e2e.spec.ts` calling
 * `createTimeSkipping()` directly is precisely what had NO retry when #709 fired.
 */
export async function createTimeSkippingTestEnv(): Promise<TestWorkflowEnvironment> {
  return withStartRetry("time-skipping server", () =>
    TestWorkflowEnvironment.createTimeSkipping(),
  );
}

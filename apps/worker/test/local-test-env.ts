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
 *
 * A THIRD failure mode is only OBSERVED here, not retried: the server starts fine and then goes away
 * MID-FILE (#1101). Neither retry above can catch that by construction — there was nothing wrong at
 * startup. See `isServerUnreachableFailure` / `describeServerHealth` below, and the note on what the
 * SDK does and does not expose about the child process.
 */
import { createServer, connect } from "node:net";
import { freemem, loadavg, totalmem } from "node:os";
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
 * genuinely helps here: it's contention, not misconfiguration. Matched on the CONNECT symptom, and
 * deliberately NOT on the wrapper's generic "Failed to start ephemeral server:" prefix — that
 * prefix is shared by every startup failure, including a missing CLI or a bad flag, and retrying
 * one of those three times only delays an unavoidable red. #709's own message carries both, so the
 * narrower match still catches it:
 *
 *   Failed to start ephemeral server: Failed connecting to test server after 5 seconds,
 *     last error: … Os { code: 111, kind: ConnectionRefused }
 *                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ matched here, not on the prefix
 *
 * Still several alternatives, because the bridge wraps the underlying cause and the refused/os-error
 * wording varies by platform.
 */
const STARTUP_TIMEOUT_RE =
  /failed connecting to test server|connection ?refused|os error 111|timed? ?out/i;

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

/* ------------------------------------------------------------------------------------------------
 * #1101 — the server dies MID-FILE, and the SDK throws the reason away.
 *
 * WHAT THE SDK ACTUALLY EXPOSES (checked against @temporalio/testing + @temporalio/core-bridge
 * 1.21.1 — this is a finding, not an assumption, and it is why the code below probes instead of
 * asking):
 *
 *   - `TestWorkflowEnvironment.server` is `protected`, and its type is `native.EphemeralServer`,
 *     which is declared as `{ type: 'ephemeral-server' }` — an OPAQUE Neon handle. Casting past
 *     `protected` gains nothing; there is no pid, exit code, or status on the other side.
 *   - The Neon bridge (core-bridge `src/testing.rs`) exports exactly three functions for it:
 *     `newEphemeralServer`, `ephemeralServerGetTarget`, `ephemeralServerShutdown`. Rust's own
 *     `EphemeralServer::child_process_id()` exists in sdk-core but is NOT bridged to JS.
 *   - The child's stdout/stderr ARE forwarded — but by two Rust threads writing to the Node
 *     process's NATIVE fd 1/2, not through `process.stdout.write`. Vitest never sees them, so they
 *     arrive unlabelled and unattributed to any spec, and the dev server's default log level is
 *     `warn`, so a SIGKILL (OOM reaper) prints nothing whatsoever.
 *
 * So: the exit code and stderr the issue hoped for are NOT reachable from TypeScript. What IS
 * reachable is `env.address` (public `readonly`), which is enough to answer the one question the
 * next occurrence needs — "was the server itself gone, or was the client confused?" — plus the
 * host-resource reading that the issue's own OOM/pressure hypothesis turns on.
 * ---------------------------------------------------------------------------------------------- */

/**
 * When each environment's address became reachable, so a failure can report HOW LONG the server
 * survived. "Died 40s into the file" and "died 0.3s after beforeAll returned" are different bugs and
 * the distinction is invisible without this. Keyed by address; entries are tiny and a test process
 * is short-lived, so no eviction.
 */
const startedAt = new Map<string, number>();

/**
 * A single host-resource reading. Portable (node:os only) — no platform tools, works on the Linux
 * and Windows runners alike.
 *
 * HOST-scoped, deliberately. `worker-e2e` runs on a bare GitHub-hosted `ubuntu-latest` with no
 * `container:` key (ci.yml), so these numbers ARE the runner's. If that job is ever moved into a
 * memory-limited container, `freemem`/`totalmem` would report the HOST's numbers instead and a
 * cgroup OOM kill would print as plenty-of-memory — read the cgroup limit here if that day comes.
 */
function resourceSnapshot(): string {
  const free = freemem();
  const total = totalmem();
  const pct = total > 0 ? Math.round((free / total) * 100) : 0;
  const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  // loadavg() is all zeros on Windows; report it anyway rather than branching — a zero triple is
  // itself a readable "this was Windows" signal.
  const load = loadavg()
    .map((n) => n.toFixed(2))
    .join("/");
  return `freemem=${Math.round(free / 1024 / 1024)}MB/${Math.round(total / 1024 / 1024)}MB (${pct}%), rss=${rssMb}MB, load=${load}`;
}

/**
 * Can we still open a TCP connection to the server's gRPC port? This is the whole diagnostic: a
 * refused connect says the PROCESS is gone (nothing is listening), while a successful connect says
 * the process is alive and the failure is above the transport — which are opposite investigations.
 *
 * Short timeout on purpose: this runs on an ALREADY-failing path, and a slow probe would turn one
 * red test into a timed-out one.
 */
function probeAddress(address: string, timeoutMs = 750): Promise<string> {
  const idx = address.lastIndexOf(":");
  const host = idx === -1 ? address : address.slice(0, idx);
  const port = Number(idx === -1 ? NaN : address.slice(idx + 1));
  if (!Number.isFinite(port))
    return Promise.resolve(`unparseable (${address})`);
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (verdict: string): void => {
      socket.destroy();
      resolve(verdict);
    };
    socket.setTimeout(timeoutMs, () => done("UNREACHABLE (probe timed out)"));
    socket.once("connect", () => done("still accepting connections"));
    socket.once("error", (e: NodeJS.ErrnoException) =>
      done(`UNREACHABLE (${e.code ?? e.message})`),
    );
  });
}

/**
 * A one-line verdict on the server behind `env`, for embedding in an INFRASTRUCTURE error message.
 * Never throws — it is only ever called while reporting another failure, and a diagnostic that can
 * replace the failure it was describing is worse than none.
 */
export async function describeServerHealth(env: {
  address: string;
}): Promise<string> {
  try {
    const started = startedAt.get(env.address);
    const alive =
      started === undefined
        ? "unknown"
        : `${((Date.now() - started) / 1000).toFixed(1)}s`;
    const probe = await probeAddress(env.address);
    return `server ${env.address}: ${probe}; ${alive} since it came up; ${resourceSnapshot()}`;
  } catch (e) {
    return `server ${env.address}: health probe itself failed (${String(e)})`;
  }
}

/**
 * The MID-RUN transport failure from #1101 — the server was reachable at `beforeAll` and is not
 * reachable now:
 *
 *   TransportError: Namespace default was not found or otherwise could not be described:
 *     Status { code: Unavailable, message: "tcp connect error",
 *       ConnectError("tcp connect error", 127.0.0.1:36407, Os { code: 111, kind: ConnectionRefused }) }
 *
 * DELIBERATELY NOT `isRetryableStartupFailure`. That predicate's regexes would match this string,
 * but its NAME and contract are about whether STARTUP is worth another attempt; sharing it would
 * mean a future narrowing of the retry policy silently re-classifies mid-run failures, and vice
 * versa. Two questions, two predicates.
 *
 * Anchored on the namespace-describe phrase (what `Worker.create` reports when it cannot reach the
 * server) and on the transport symptoms — NOT on bare `Unavailable`, which `Status { code: … }`
 * also carries for legitimate server-side conditions that are genuine test failures.
 */
const SERVER_UNREACHABLE_RE =
  /namespace .*(was not found|could not be described)|tcp connect error|connection ?refused|os error 111/i;

/**
 * Did this failure happen because the Temporal server is not there any more? Exported so the
 * classification is pinned by unit test against the REAL string from the #1101 incident, exactly as
 * `isRetryableStartupFailure` pins #709 and #342.
 *
 * Must be FALSE for the #1073 worker-registration overlap, which is a different infrastructure
 * failure with its own bounded retry in `interpreter-harness.ts` — classifying it here would steal
 * it from a retry that actually works.
 */
export function isServerUnreachableFailure(error: unknown): boolean {
  return SERVER_UNREACHABLE_RE.test(String(error));
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
      const env = await start();
      // #1101: stamp the moment this address became reachable, so a later mid-file transport
      // failure can report how long the server actually survived.
      startedAt.set(env.address, Date.now());
      return env;
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

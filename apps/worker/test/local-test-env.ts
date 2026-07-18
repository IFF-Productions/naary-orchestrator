/**
 * Shared TestWorkflowEnvironment factory for the worker specs.
 *
 * Why not a bare `TestWorkflowEnvironment.createLocal()`: the ephemeral dev
 * server picks a free gRPC port itself, but its companion HTTP API port is
 * DERIVED (not checked) — on the shared CI VM, where several runners execute
 * in parallel (see docs on the per-run-namespaced e2e, #342), that derived
 * port can land on one already bound by another runner and the server dies
 * with "bind: Only one usage of each socket address…" (WSAEADDRINUSE), killing
 * the whole spec file in beforeAll. Seen on CI run 29627553035.
 *
 * Fix: pass an explicitly verified-free `--http-port`, and retry with a fresh
 * port on a bind race (verify→bind is still TOCTOU on a busy box).
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

const BIND_RACE_RE =
  /bind|address (already )?in use|socket address|EADDRINUSE/i;

export async function createLocalTestEnv(): Promise<TestWorkflowEnvironment> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const httpPort = await freePort();
    try {
      return await TestWorkflowEnvironment.createLocal({
        server: { extraArgs: ["--http-port", String(httpPort)] },
      });
    } catch (e) {
      // Only a port-bind race is worth retrying — anything else (missing CLI,
      // bad config) would fail identically on every attempt.
      if (!BIND_RACE_RE.test(String(e))) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

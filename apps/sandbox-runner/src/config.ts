/** Runner config — all from the environment (server-side; never the request). The request
 *  supplies only the per-run data (runId, agentArgs, the tenant key). */
export interface RunnerConfig {
  /** Bearer token the worker must present. Required — the runner holds Docker (host-root). */
  token: string;
  /** Working-tree dir, one subdir per run. MUST be a host BIND MOUNT at the SAME path in
   *  the runner (not a named volume): the runner shells `docker run -v <path>` via the
   *  host Docker, so the path resolves on the HOST — same-path bind mount keeps them equal. */
  runsDir: string;
  /** The internal, no-gateway network the sandbox joins (Slice 2a). */
  network: string;
  /** The allowlist proxy the sandbox uses to reach Anthropic (and only Anthropic). */
  proxyUrl: string;
  /** The PINNED sandbox image (never workflow-chosen). */
  image: string;
  limits: { cpus: string; memoryMb: number; pids: number };
  /** Hard wall-clock cap for a single sandbox run (ms). */
  defaultTimeoutMs: number;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): RunnerConfig {
  const token = env.SANDBOX_RUNNER_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "SANDBOX_RUNNER_TOKEN is required (the runner holds Docker access).",
    );
  }
  return {
    token,
    runsDir: env.SANDBOX_RUNS_DIR || "/runs",
    network: env.SANDBOX_NETWORK || "naary-sandbox-internal",
    proxyUrl: env.SANDBOX_PROXY_URL || "http://naary-sandbox-proxy:3128",
    image: env.SANDBOX_IMAGE || "naary-claude-sandbox:latest",
    limits: {
      cpus: env.SANDBOX_CPUS || "1.0",
      memoryMb: Number(env.SANDBOX_MEMORY_MB) || 2048,
      pids: Number(env.SANDBOX_PIDS) || 256,
    },
    defaultTimeoutMs: Number(env.SANDBOX_TIMEOUT_MS) || 15 * 60 * 1000,
    port: Number(env.PORT) || 8099,
  };
}

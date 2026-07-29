import {
  DEFAULT_SANDBOX_IMAGES,
  SANDBOX_TOOLS,
  type SandboxTool,
} from "./docker-run";

/** Runner config — all from the environment (server-side; never the request). The request
 *  supplies only the per-run data (runId, tool, agentArgs, the tenant key). */
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
  /**
   * The PINNED sandbox image PER TOOL (never request-chosen). A request names a tool from the
   * closed `SANDBOX_TOOLS` set and the runner looks the image up here — so the only image names
   * that can ever reach `docker run` are ones an operator put in this config.
   */
  images: Record<SandboxTool, string>;
  /** True when `SANDBOX_REQUIRE_DIGEST` forced every image above to be `@sha256:`-pinned. */
  requireDigest: boolean;
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
  const requireDigest = isTruthy(env.SANDBOX_REQUIRE_DIGEST);
  const images = loadImages(env);
  if (requireDigest) assertAllImagesDigestPinned(images);
  return {
    token,
    runsDir: env.SANDBOX_RUNS_DIR || "/runs",
    network: env.SANDBOX_NETWORK || "naary-sandbox-internal",
    proxyUrl: env.SANDBOX_PROXY_URL || "http://naary-sandbox-proxy:3128",
    images,
    requireDigest,
    limits: {
      cpus: env.SANDBOX_CPUS || "1.0",
      memoryMb: posInt(env.SANDBOX_MEMORY_MB, 2048),
      pids: posInt(env.SANDBOX_PIDS, 256),
    },
    defaultTimeoutMs: posInt(env.SANDBOX_TIMEOUT_MS, 15 * 60 * 1000),
    port: posInt(env.PORT, 8099),
  };
}

/**
 * Per-tool image overrides: `SANDBOX_IMAGE_<TOOL>` (e.g. `SANDBOX_IMAGE_CURSOR`), each defaulting
 * to that tool's own conventional tag. `SANDBOX_IMAGE` (the pre-#680 single-image var) still
 * overrides CLAUDE only, so an existing deploy keeps working unchanged.
 *
 * Each tool keeps a DISTINCT default — a missing override must never silently fall back to another
 * tool's image (that is #933's cursor-argv-to-claude-entrypoint bug). If the image simply isn't
 * built on the host, `docker run` fails loudly for that tool alone.
 */
function loadImages(env: NodeJS.ProcessEnv): Record<SandboxTool, string> {
  const images = {} as Record<SandboxTool, string>;
  for (const tool of SANDBOX_TOOLS) {
    const override = env[`SANDBOX_IMAGE_${tool.toUpperCase()}`]?.trim();
    const legacy = tool === "claude" ? env.SANDBOX_IMAGE?.trim() : undefined;
    images[tool] = override || legacy || DEFAULT_SANDBOX_IMAGES[tool];
  }
  return images;
}

/**
 * A ref is digest-pinned when it ends `@sha256:<64 lowercase hex>` — the ONLY form docker resolves
 * without consulting a mutable tag. `:latest` (or any tag) can be re-pushed under the operator's
 * feet, and the image this runner launches gets the host's Docker socket, so in production the
 * bytes must be nailed down, not merely named.
 *
 * Anchored, lowercase-hex, exactly 64: `@sha256:abc` and `@sha256:<64 hex>-suffix` are both
 * rejected rather than treated as "close enough".
 */
const DIGEST_PINNED = /@sha256:[0-9a-f]{64}$/;

export function isDigestPinned(image: string): boolean {
  return DIGEST_PINNED.test(image);
}

/**
 * `SANDBOX_REQUIRE_DIGEST=1` — the production posture, set by CD (deploy.yml exports it alongside
 * the four resolved `SANDBOX_IMAGE_*` digest refs). FAIL-CLOSED at boot, not per run: if CD ever
 * fails to resolve a digest and the var is left empty, `loadImages` falls back to that tool's
 * `:latest` default, this throws, and the runner refuses to start — instead of quietly running
 * whatever `:latest` currently points at. Default OFF so a dev box still works with local builds.
 */
function assertAllImagesDigestPinned(
  images: Record<SandboxTool, string>,
): void {
  const unpinned = SANDBOX_TOOLS.filter((t) => !isDigestPinned(images[t])).map(
    (t) => `${t}=${images[t]}`,
  );
  if (unpinned.length > 0) {
    throw new Error(
      `SANDBOX_REQUIRE_DIGEST is set but these sandbox images are not pinned by digest: ` +
        `${unpinned.join(", ")}. Set SANDBOX_IMAGE_<TOOL> to a ref ending @sha256:<64 hex> ` +
        `(CI publishes them — see .github/workflows/sandbox-images.yml), or unset ` +
        `SANDBOX_REQUIRE_DIGEST for a local/dev host.`,
    );
  }
}

/** `1`/`true`/`yes`/`on` (case-insensitive) enable; anything else — including blank, which is what
 *  compose interpolates for an unset var — leaves the flag OFF. */
function isTruthy(raw: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((raw ?? "").trim().toLowerCase());
}

/** Parse a positive integer env var, falling back to `fallback` for absent/blank/invalid
 *  (non-finite, ≤ 0, non-integer) values — so a stray `-1` or `NaN` can't silently degrade
 *  the runner's limits (unlike `Number(x) || default`, which accepts negatives + eats 0). */
function posInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

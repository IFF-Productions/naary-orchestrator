/**
 * The security-critical `docker run` argv for an ephemeral codeAgent sandbox container
 * (design CLAUDE-CODE-NODE.md §8b.1). Pure + unit-tested so the isolation flags are pinned
 * and reviewable. The runner service (which holds Docker access) execFile's `docker` with
 * this argv — NEVER via a shell, so the workflow-supplied `agentArgs` (prompt/model/…) can't
 * inject `docker`/shell arguments.
 *
 * Guarantees encoded here:
 *  - image + network + limits are RUNNER config, never workflow-controlled (§ runner as a
 *    root-privileged injection surface).
 *  - the credential is forwarded by NAME (`-e <keyEnvVar>`, an allowlisted var — ANTHROPIC_API_KEY
 *    or CLAUDE_CODE_OAUTH_TOKEN), never inline on the argv (which would show in `ps`/`docker
 *    inspect`); the runner sets its value in the exec env.
 *  - the git token is NEVER passed to the sandbox (the two-box split, §2.2).
 *  - egress is the internal no-gateway network + the allowlist proxy (§2.3); HTTPS_PROXY is
 *    how the LEGITIMATE Anthropic call routes, NOT the security boundary (that's the network).
 *  - `--rm`, read-only root + tmpfs, no-new-privileges, cap-drop ALL, cpu/mem/pids caps.
 */

export interface SandboxLimits {
  cpus: string; // e.g. "1.0"
  memoryMb: number; // e.g. 2048
  pids: number; // e.g. 256
}

export interface SandboxRunSpec {
  /** The PINNED sandbox image (runner config). Rejected if not in `allowedImages`. */
  image: string;
  /** The internal, no-gateway Docker network the sandbox joins. */
  network: string;
  /** The allowlist proxy URL the sandbox uses to reach Anthropic (and only Anthropic). */
  proxyUrl: string;
  /** Host path bind-mounted as the working tree at /work. */
  workdir: string;
  /** The coding-CLI argv (e.g. claude -p …). Data only — never shell-interpreted. */
  agentArgs: string[];
  /** The env var NAME the sandbox reads its credential from — must be in ALLOWED_KEY_ENV_VARS.
   *  Forwarded by name (value from the runner's exec env). Lets the caller pick the right var
   *  for the credential kind: an API key → ANTHROPIC_API_KEY, a subscription setup-token →
   *  CLAUDE_CODE_OAUTH_TOKEN (Claude Code reads different vars for each). */
  keyEnvVar: string;
  limits: SandboxLimits;
}

/**
 * The coding CLIs the runner can launch — a CLOSED set. A request names a TOOL from this set; the
 * runner maps tool → image from its OWN config (`RunnerConfig.images`). A request can never name an
 * image: the runner holds the Docker socket (host root), so an attacker-chosen image name is a
 * root-privileged injection surface, while an attacker-chosen member of a fixed enum is not.
 */
export const SANDBOX_TOOLS = ["claude", "cursor", "copilot", "gemini"] as const;
export type SandboxTool = (typeof SANDBOX_TOOLS)[number];

export function isSandboxTool(v: unknown): v is SandboxTool {
  return (
    typeof v === "string" && (SANDBOX_TOOLS as readonly string[]).includes(v)
  );
}

/**
 * The conventional image tag per tool. Each CLI gets its OWN image with its OWN ENTRYPOINT — a
 * single shared image was the latent bug in #933: `ALLOWED_SANDBOX_IMAGES` pinned only the claude
 * image, whose ENTRYPOINT is `claude`, so cursor/copilot argv was handed to the wrong binary.
 * With one image per tool that class of bug is gone BY CONSTRUCTION.
 *
 * Note each default is DISTINCT — there is deliberately no fallback to the claude image, which
 * would re-create exactly that bug behind more machinery. An unbuilt image fails loudly at
 * `docker run` instead.
 */
export const DEFAULT_SANDBOX_IMAGES: Record<SandboxTool, string> = {
  claude: "naary-claude-sandbox:latest",
  cursor: "naary-cursor-sandbox:latest",
  copilot: "naary-copilot-sandbox:latest",
  gemini: "naary-gemini-sandbox:latest",
};

/** Images the runner is willing to launch. The workflow can NEVER choose the image. The
 *  `:latest` entries are for dev; a production deploy should build + tag each sandbox image with a
 *  version/digest and list THAT here (and in SANDBOX_IMAGE_*) so the launched code is immutable. */
export const ALLOWED_SANDBOX_IMAGES = Object.values(
  DEFAULT_SANDBOX_IMAGES,
) as readonly string[];

/**
 * The env var names each tool's sandbox may read its credential from. An allowlist (not a free
 * string) so a caller can never inject an arbitrary env var into the container — and PER TOOL, so
 * a request also can't forward, say, a GitHub token into the Claude container.
 *
 *  - claude  reads an API key from ANTHROPIC_API_KEY, a subscription setup-token from
 *            CLAUDE_CODE_OAUTH_TOKEN (two kinds of credential, two vars).
 *  - cursor  CURSOR_API_KEY. copilot COPILOT_GITHUB_TOKEN. gemini GEMINI_API_KEY.
 *
 * Extend this deliberately — one var per driver — never by relaxing the check.
 */
export const ALLOWED_KEY_ENV_VARS_BY_TOOL: Record<
  SandboxTool,
  readonly string[]
> = {
  claude: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  cursor: ["CURSOR_API_KEY"],
  copilot: ["COPILOT_GITHUB_TOKEN"],
  gemini: ["GEMINI_API_KEY"],
};

/** The union of every tool's allowed key var — the backstop `buildSandboxDockerArgs` enforces
 *  when it is handed an already-resolved image (the per-TOOL check happens at the request layer). */
export const ALLOWED_KEY_ENV_VARS = Object.values(
  ALLOWED_KEY_ENV_VARS_BY_TOOL,
).flat() as readonly string[];

/** Back-compat default when a request omits the var name (a claude API key). */
export const SANDBOX_KEY_ENV = "ANTHROPIC_API_KEY";

export function assertPinnedImage(image: string): void {
  if (!ALLOWED_SANDBOX_IMAGES.includes(image)) {
    throw new Error(
      `sandbox-runner: refusing to launch un-pinned image "${image}"`,
    );
  }
}

export function assertAllowedKeyEnvVar(name: string): void {
  if (!ALLOWED_KEY_ENV_VARS.includes(name)) {
    throw new Error(
      `sandbox-runner: refusing to forward un-allowlisted key env var "${name}"`,
    );
  }
}

/** The per-TOOL tightening: `name` must be one of THIS tool's vars, not merely of some tool's. */
export function assertKeyEnvVarForTool(name: string, tool: SandboxTool): void {
  if (!ALLOWED_KEY_ENV_VARS_BY_TOOL[tool].includes(name)) {
    throw new Error(
      `sandbox-runner: key env var "${name}" is not valid for the "${tool}" sandbox`,
    );
  }
}

/**
 * Build the `docker run …` argv. The returned array is passed to execFile("docker", args)
 * — no shell. The credential is forwarded by name only (`spec.keyEnvVar`); the caller must set
 * its value in the exec environment (`{ [spec.keyEnvVar]: key }`), never inline it here.
 */
export function buildSandboxDockerArgs(spec: SandboxRunSpec): string[] {
  assertPinnedImage(spec.image);
  assertAllowedKeyEnvVar(spec.keyEnvVar);
  if (!spec.network || /\s/.test(spec.network)) {
    throw new Error("sandbox-runner: invalid network name");
  }
  // The workdir is interpolated into a `-v host:container` spec — a `:` or whitespace would
  // change how Docker parses the mount (a different host path, extra options). Require a clean
  // absolute POSIX path so a misconfig/attacker string can't rewrite the mount.
  if (!/^\/[^\s:]*$/.test(spec.workdir)) {
    throw new Error(
      "sandbox-runner: workdir must be an absolute path with no ':' or whitespace",
    );
  }
  const { cpus, memoryMb, pids } = spec.limits;
  return [
    "run",
    "--rm",
    // Isolation: internal network (no gateway) is the egress boundary.
    "--network",
    spec.network,
    // Filesystem: read-only root + a small writable tmpfs; the working tree is the only mount.
    "--read-only",
    "--tmpfs",
    "/tmp:size=256m",
    "-v",
    `${spec.workdir}:/work`,
    "-w",
    "/work",
    // Privilege containment. Explicit `:true` to match the compose config + avoid ambiguity
    // across Docker/Compose versions.
    "--security-opt",
    "no-new-privileges:true",
    "--cap-drop",
    "ALL",
    // Resource caps — bound a runaway/adversarial run.
    "--cpus",
    cpus,
    "--memory",
    `${memoryMb}m`,
    "--pids-limit",
    String(pids),
    // Route the (only-allowed) Anthropic call through the allowlist proxy.
    "-e",
    `HTTPS_PROXY=${spec.proxyUrl}`,
    "-e",
    `HTTP_PROXY=${spec.proxyUrl}`,
    // Forward the credential BY NAME — value comes from the runner's exec env, never the argv.
    "-e",
    spec.keyEnvVar,
    spec.image,
    ...spec.agentArgs,
  ];
}

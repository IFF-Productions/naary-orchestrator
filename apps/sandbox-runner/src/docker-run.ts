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
 *  - the Anthropic key is forwarded by NAME (`-e ANTHROPIC_API_KEY`), never inline on the argv
 *    (which would show in `ps`/`docker inspect`); the runner sets it in the exec env.
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

/** Images the runner is willing to launch. The workflow can NEVER choose the image. The
 *  `:latest` entry is for dev; a production deploy should build + tag the sandbox image with a
 *  version/digest and list THAT here (and in SANDBOX_IMAGE) so the launched code is immutable. */
export const ALLOWED_SANDBOX_IMAGES = ["naary-claude-sandbox:latest"] as const;

/** The env var names the sandbox may read its credential from. An allowlist (not a free string)
 *  so a caller can never inject an arbitrary env var into the container. `claude` reads an API key
 *  from ANTHROPIC_API_KEY and a subscription setup-token from CLAUDE_CODE_OAUTH_TOKEN. */
export const ALLOWED_KEY_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

/** Back-compat default when a request omits the var name (an API key). */
export const SANDBOX_KEY_ENV = "ANTHROPIC_API_KEY";

export function assertPinnedImage(image: string): void {
  if (!(ALLOWED_SANDBOX_IMAGES as readonly string[]).includes(image)) {
    throw new Error(
      `sandbox-runner: refusing to launch un-pinned image "${image}"`,
    );
  }
}

export function assertAllowedKeyEnvVar(name: string): void {
  if (!(ALLOWED_KEY_ENV_VARS as readonly string[]).includes(name)) {
    throw new Error(
      `sandbox-runner: refusing to forward un-allowlisted key env var "${name}"`,
    );
  }
}

/**
 * Build the `docker run …` argv. The returned array is passed to execFile("docker", args)
 * — no shell. The Anthropic key is forwarded by name only; the caller must set it in the
 * exec environment (`{ ANTHROPIC_API_KEY: key }`), never inline it here.
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

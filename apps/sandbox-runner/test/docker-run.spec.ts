import { describe, expect, it } from "vitest";
import {
  ALLOWED_KEY_ENV_VARS_BY_TOOL,
  ALLOWED_SANDBOX_IMAGES,
  assertKeyEnvVarForTool,
  assertPinnedImage,
  buildSandboxDockerArgs,
  DEFAULT_SANDBOX_IMAGES,
  isSandboxTool,
  SANDBOX_TOOLS,
  type SandboxRunSpec,
} from "../src/docker-run";

const SPEC: SandboxRunSpec = {
  image: ALLOWED_SANDBOX_IMAGES[0],
  network: "naary-sandbox-internal",
  proxyUrl: "http://naary-sandbox-proxy:3128",
  workdir: "/srv/runs/abc",
  agentArgs: ["-p", "review the code", "--permission-mode", "acceptEdits"],
  keyEnvVar: "ANTHROPIC_API_KEY",
  limits: { cpus: "1.0", memoryMb: 2048, pids: 256 },
};

describe("buildSandboxDockerArgs", () => {
  const args = buildSandboxDockerArgs(SPEC);
  const joined = args.join(" ");

  it("launches ephemeral + isolation-hardened", () => {
    expect(args[0]).toBe("run");
    expect(args).toContain("--rm");
    // internal no-gateway network is the egress boundary
    expect(args[args.indexOf("--network") + 1]).toBe("naary-sandbox-internal");
    expect(args).toContain("--read-only");
    expect(args[args.indexOf("--security-opt") + 1]).toBe(
      "no-new-privileges:true",
    );
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(args[args.indexOf("--pids-limit") + 1]).toBe("256");
    expect(args[args.indexOf("--memory") + 1]).toBe("2048m");
  });

  it("gives the CLIs a writable tmpfs HOME — with mode=1777, or it is useless", () => {
    // Every image runs as the unprivileged `sandbox` user whose home is on the read-only root, and
    // these CLIs all write there at startup. Proven by deploy/sandbox/smoke-test.sh: without the
    // mount copilot/gemini die with ENOENT, and with a bare `--tmpfs` (root-owned 0755) they die
    // with EACCES instead — so the mode is load-bearing, not decoration.
    const tmpfs = args.filter((_, i) => args[i - 1] === "--tmpfs");
    expect(tmpfs).toContain("/home/sandbox:size=64m,mode=1777");
    expect(tmpfs).toContain("/tmp:size=256m");
    // It must stay a tmpfs (ephemeral RAM), never a bind mount of a host path.
    expect(args).not.toContain("/home/sandbox");
  });

  it("routes egress through the allowlist proxy", () => {
    expect(joined).toContain("HTTPS_PROXY=http://naary-sandbox-proxy:3128");
  });

  it("forwards the credential BY NAME — never inline on the argv (ps/inspect leak)", () => {
    // `-e ANTHROPIC_API_KEY` with NO `=value` — the value comes from the exec env.
    const i = args.lastIndexOf("ANTHROPIC_API_KEY");
    expect(args[i]).toBe("ANTHROPIC_API_KEY");
    expect(joined).not.toContain("ANTHROPIC_API_KEY=");
  });

  it("forwards a subscription setup-token under CLAUDE_CODE_OAUTH_TOKEN when asked", () => {
    const oatArgs = buildSandboxDockerArgs({
      ...SPEC,
      keyEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
    });
    const j = oatArgs.join(" ");
    expect(oatArgs).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(j).not.toContain("CLAUDE_CODE_OAUTH_TOKEN=");
    // The API-key var is NOT also forwarded (exactly one auth var).
    expect(oatArgs).not.toContain("ANTHROPIC_API_KEY");
  });

  it("REFUSES an un-allowlisted key env var (no arbitrary env injection)", () => {
    expect(() =>
      buildSandboxDockerArgs({ ...SPEC, keyEnvVar: "AWS_SECRET_ACCESS_KEY" }),
    ).toThrow(/un-allowlisted key env var/);
  });

  it("passes the agent argv as trailing args (after the image), unshelled", () => {
    const imgIdx = args.indexOf(SPEC.image);
    expect(args.slice(imgIdx + 1)).toEqual(SPEC.agentArgs);
  });

  it("never mounts or forwards a git token into the sandbox", () => {
    expect(joined).not.toMatch(/GIT|GITHUB|x-access-token|token/i);
  });

  it("REFUSES an un-pinned image (workflow can't choose the image)", () => {
    expect(() =>
      buildSandboxDockerArgs({ ...SPEC, image: "evil/pwn:latest" }),
    ).toThrow(/un-pinned image/);
  });

  it("rejects an invalid network name", () => {
    expect(() =>
      buildSandboxDockerArgs({ ...SPEC, network: "bad net" }),
    ).toThrow(/invalid network/);
  });

  it("rejects a workdir with a colon/whitespace/relative path (mount-spec injection)", () => {
    for (const workdir of [
      "/runs/a:b",
      "/runs/a b",
      "relative/x",
      "/runs/x\t",
    ]) {
      expect(() => buildSandboxDockerArgs({ ...SPEC, workdir })).toThrow(
        /workdir must be an absolute path/,
      );
    }
  });

  it("does NOT attach stdin (-i): the CLI must see EOF, not an open empty pipe", () => {
    // The api's old in-process `execFile` left the child's stdin an OPEN pipe, so `claude -p`
    // blocked ~3s waiting for EOF and could exit 1 — that had its own regression suite before
    // #680 moved the run here. `docker run` without `-i` gives the container no stdin at all, so
    // the CLI sees EOF immediately. Adding `-i`/`-t` would silently resurrect that bug.
    expect(args).not.toContain("-i");
    expect(args).not.toContain("-t");
    expect(args).not.toContain("--interactive");
  });
});

/**
 * ONE IMAGE PER TOOL (#680). Before this, `ALLOWED_SANDBOX_IMAGES` pinned only the claude image,
 * so a cursor/copilot argv was dispatched to a `claude` ENTRYPOINT — the latent bug #933 found.
 * These tests pin the two properties that make that impossible now: every tool has a DISTINCT
 * pinned image, and each tool's credential vars are separately allowlisted.
 */
describe("per-tool images + key vars", () => {
  it("every tool has its own DISTINCT pinned image (never a fallback to another tool's)", () => {
    const images = Object.values(DEFAULT_SANDBOX_IMAGES);
    expect(images).toHaveLength(SANDBOX_TOOLS.length);
    expect(new Set(images).size).toBe(images.length); // all distinct
    for (const image of images) expect(ALLOWED_SANDBOX_IMAGES).toContain(image);
  });

  it("assertPinnedImage accepts every tool's image and nothing else", () => {
    for (const tool of SANDBOX_TOOLS) {
      expect(() =>
        assertPinnedImage(DEFAULT_SANDBOX_IMAGES[tool]),
      ).not.toThrow();
    }
    expect(() => assertPinnedImage("naary-claude-sandbox")).toThrow(
      /un-pinned image/,
    ); // untagged ≠ pinned
    expect(() => assertPinnedImage("evil/pwn:latest")).toThrow(
      /un-pinned image/,
    );
  });

  it("isSandboxTool is a CLOSED set — a request can name a tool, never an image", () => {
    for (const tool of SANDBOX_TOOLS) expect(isSandboxTool(tool)).toBe(true);
    for (const bad of [
      "bash",
      "naary-claude-sandbox:latest",
      "",
      null,
      42,
      { tool: "claude" },
    ]) {
      expect(isSandboxTool(bad)).toBe(false);
    }
  });

  it("a tool may forward only ITS OWN credential var, not merely some tool's", () => {
    expect(() =>
      assertKeyEnvVarForTool("ANTHROPIC_API_KEY", "claude"),
    ).not.toThrow();
    expect(() =>
      assertKeyEnvVarForTool("CLAUDE_CODE_OAUTH_TOKEN", "claude"),
    ).not.toThrow();
    expect(() =>
      assertKeyEnvVarForTool("CURSOR_API_KEY", "cursor"),
    ).not.toThrow();
    expect(() =>
      assertKeyEnvVarForTool("COPILOT_GITHUB_TOKEN", "copilot"),
    ).not.toThrow();
    expect(() =>
      assertKeyEnvVarForTool("GEMINI_API_KEY", "gemini"),
    ).not.toThrow();
    // Cross-tool forwarding is refused — a copilot GitHub token must not reach the claude box.
    expect(() =>
      assertKeyEnvVarForTool("COPILOT_GITHUB_TOKEN", "claude"),
    ).toThrow(/not valid for the "claude" sandbox/);
    expect(() => assertKeyEnvVarForTool("ANTHROPIC_API_KEY", "gemini")).toThrow(
      /not valid for the "gemini" sandbox/,
    );
    // …and an arbitrary var is still refused everywhere.
    expect(() =>
      assertKeyEnvVarForTool("AWS_SECRET_ACCESS_KEY", "cursor"),
    ).toThrow(/not valid/);
  });

  it("the isolation argv is IDENTICAL across tools apart from the image + key var name", () => {
    const normalize = (tool: (typeof SANDBOX_TOOLS)[number]) =>
      buildSandboxDockerArgs({
        ...SPEC,
        image: DEFAULT_SANDBOX_IMAGES[tool],
        keyEnvVar: ALLOWED_KEY_ENV_VARS_BY_TOOL[tool][0],
      }).map((a) =>
        a === DEFAULT_SANDBOX_IMAGES[tool]
          ? "<IMAGE>"
          : a === ALLOWED_KEY_ENV_VARS_BY_TOOL[tool][0]
            ? "<KEY_VAR>"
            : a,
      );
    const claude = normalize("claude");
    for (const tool of SANDBOX_TOOLS) {
      // Same --network, --read-only, --tmpfs, no-new-privileges, --cap-drop ALL, cpu/memory/pids
      // caps and proxy vars for every tool: adding a CLI never buys it a weaker sandbox.
      expect(normalize(tool), tool).toEqual(claude);
    }
  });
});

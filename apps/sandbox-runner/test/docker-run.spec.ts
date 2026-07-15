import { describe, expect, it } from "vitest";
import {
  ALLOWED_SANDBOX_IMAGES,
  buildSandboxDockerArgs,
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
});

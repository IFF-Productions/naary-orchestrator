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
    expect(args).toContain("no-new-privileges");
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(args[args.indexOf("--pids-limit") + 1]).toBe("256");
    expect(args[args.indexOf("--memory") + 1]).toBe("2048m");
  });

  it("routes egress through the allowlist proxy", () => {
    expect(joined).toContain("HTTPS_PROXY=http://naary-sandbox-proxy:3128");
  });

  it("forwards the Anthropic key BY NAME — never inline on the argv (ps/inspect leak)", () => {
    // `-e ANTHROPIC_API_KEY` with NO `=value` — the value comes from the exec env.
    const i = args.lastIndexOf("ANTHROPIC_API_KEY");
    expect(args[i]).toBe("ANTHROPIC_API_KEY");
    expect(joined).not.toContain("ANTHROPIC_API_KEY=");
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
});

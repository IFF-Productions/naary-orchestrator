import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerConfig } from "../src/config";
import {
  ALLOWED_KEY_ENV_VARS_BY_TOOL,
  DEFAULT_SANDBOX_IMAGES,
  SANDBOX_KEY_ENV,
  SANDBOX_TOOLS,
} from "../src/docker-run";
import { BadRequestError, type Exec, runSandbox } from "../src/run-sandbox";

// runSandbox stats the run dir before touching docker (repo mode) and mkdir/chmod/rm's its own
// (ephemeral mode). Mock the FS so no real one is needed; default = a directory that exists.
const { statMock, mkdirMock, chmodMock, rmMock } = vi.hoisted(() => ({
  statMock: vi.fn(),
  mkdirMock: vi.fn(),
  chmodMock: vi.fn(),
  rmMock: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({
  stat: statMock,
  mkdir: mkdirMock,
  chmod: chmodMock,
  rm: rmMock,
}));

const CFG: RunnerConfig = {
  token: "t",
  runsDir: "/runs",
  network: "naary-sandbox-internal",
  proxyUrl: "http://naary-sandbox-proxy:3128",
  images: DEFAULT_SANDBOX_IMAGES,
  requireDigest: false,
  limits: { cpus: "1.0", memoryMb: 2048, pids: 256 },
  defaultTimeoutMs: 900_000,
  port: 8099,
};

const REQ = {
  runId: "exec-abc_123",
  agentArgs: ["-p", "fix the bug", "--permission-mode", "acceptEdits"],
  authKey: "sk-ant-secret",
};

let exec: ReturnType<typeof vi.fn>;
beforeEach(() => {
  statMock.mockReset().mockResolvedValue({ isDirectory: () => true });
  mkdirMock.mockReset().mockResolvedValue(undefined);
  chmodMock.mockReset().mockResolvedValue(undefined);
  rmMock.mockReset().mockResolvedValue(undefined);
  exec = vi.fn(async (file: string) =>
    file === "git"
      ? { stdout: "diff --git a/x b/x\n+edited", exitCode: 0 }
      : { stdout: '{"result":"done","is_error":false}', exitCode: 0 },
  );
});

// The sandbox-runner is a Linux-only service: it bind-mounts the working tree into Docker and
// buildSandboxDockerArgs enforces a POSIX absolute workdir (leading '/', no ':') to block
// mount-spec injection. On Windows `path.resolve('/runs')` yields `C:\runs\…`, which correctly
// fails that guard — so these tests can't run there (the runtime never does either). Skip on win32;
// full coverage runs on macOS/Linux dev machines + any Linux CI.
describe.skipIf(process.platform === "win32")("runSandbox", () => {
  it("runs docker (pinned + isolated) then captures the git diff", async () => {
    const out = await runSandbox(REQ, CFG, exec as unknown as Exec);
    expect(out.exitCode).toBe(0);
    expect(out.diff).toContain("+edited");

    const [dockerCall, addCall, diffCall] = exec.mock.calls;
    expect(dockerCall[0]).toBe("docker");
    const dargs: string[] = dockerCall[1];
    expect(dargs).toContain("naary-claude-sandbox:latest"); // pinned image
    expect(dargs[dargs.indexOf("--network") + 1]).toBe(
      "naary-sandbox-internal",
    );
    expect(dargs).toContain("--rm");
    // the working tree is mounted under runsDir
    expect(dargs[dargs.indexOf("-v") + 1]).toBe("/runs/exec-abc_123:/work");
    // Stage ALL edits (so created/untracked files are included) then diff the index.
    expect(addCall[1]).toEqual(["-C", "/runs/exec-abc_123", "add", "-A"]);
    expect(diffCall[1]).toEqual([
      "-C",
      "/runs/exec-abc_123",
      "diff",
      "--cached",
    ]);
  });

  it("forwards the key via the exec ENV (by name), never on the argv", async () => {
    await runSandbox(REQ, CFG, exec as unknown as Exec);
    const dockerCall = exec.mock.calls[0];
    expect(dockerCall[2].env[SANDBOX_KEY_ENV]).toBe("sk-ant-secret");
    // the key VALUE is not an argv element
    expect((dockerCall[1] as string[]).join(" ")).not.toContain(
      "sk-ant-secret",
    );
  });

  it("forwards a setup-token under CLAUDE_CODE_OAUTH_TOKEN when keyEnvVar overrides the default", async () => {
    await runSandbox(
      { ...REQ, keyEnvVar: "CLAUDE_CODE_OAUTH_TOKEN" },
      CFG,
      exec as unknown as Exec,
    );
    const dockerCall = exec.mock.calls[0];
    // The value goes under the CHOSEN var; the API-key var doesn't carry the secret.
    expect(dockerCall[2].env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-secret");
    expect(dockerCall[2].env.ANTHROPIC_API_KEY).not.toBe("sk-ant-secret");
    // and it's on the argv by name (never the value).
    expect(dockerCall[1] as string[]).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("rejects an un-allowlisted keyEnvVar before touching docker (no env injection)", async () => {
    await expect(
      runSandbox(
        { ...REQ, keyEnvVar: "AWS_SECRET_ACCESS_KEY" },
        CFG,
        exec as unknown as Exec,
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(exec).not.toHaveBeenCalled();
  });

  it("rejects a non-string keyEnvVar with a clear (not 'un-allowlisted') error", async () => {
    await expect(
      runSandbox(
        { ...REQ, keyEnvVar: 123 as unknown as string },
        CFG,
        exec as unknown as Exec,
      ),
    ).rejects.toThrow(/must be a string/);
  });

  it("rejects a traversal / bad runId before touching docker", async () => {
    for (const runId of ["../etc", "a/b", "..", "with space", ""]) {
      await expect(
        runSandbox({ ...REQ, runId }, CFG, exec as unknown as Exec),
      ).rejects.toBeInstanceOf(BadRequestError);
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it("redacts the key from stdout + diff (defense in depth if the CLI echoes it)", async () => {
    exec = vi.fn(async (file: string) =>
      file === "git"
        ? { stdout: "+ANTHROPIC_API_KEY=sk-ant-secret", exitCode: 0 }
        : { stdout: "leaked sk-ant-secret in output", exitCode: 0 },
    );
    const out = await runSandbox(REQ, CFG, exec as unknown as Exec);
    expect(out.stdout).not.toContain("sk-ant-secret");
    expect(out.diff).not.toContain("sk-ant-secret");
    expect(out.diff).toContain("[REDACTED]");
  });

  it("rejects when the run dir is missing (Docker must not auto-create it as root)", async () => {
    statMock.mockRejectedValue(new Error("ENOENT"));
    await expect(
      runSandbox(REQ, CFG, exec as unknown as Exec),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(exec).not.toHaveBeenCalled();
  });

  it("throws when git diff fails (workdir isn't a git repo) — no misleading diff", async () => {
    // add succeeds, the diff (--cached) fails → the compute-diff error, not the stage error.
    exec = vi.fn(async (file: string, args: string[]) => {
      if (file !== "git") return { stdout: "{}", exitCode: 0 };
      return args.includes("--cached")
        ? { stdout: "fatal: not a git repository", exitCode: 128 }
        : { stdout: "", exitCode: 0 };
    });
    await expect(runSandbox(REQ, CFG, exec as unknown as Exec)).rejects.toThrow(
      /could not compute the diff/,
    );
  });

  it("validates agentArgs + a required key", async () => {
    await expect(
      runSandbox(
        { ...REQ, agentArgs: [1 as unknown as string] },
        CFG,
        exec as unknown as Exec,
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
    await expect(
      runSandbox({ ...REQ, authKey: "" }, CFG, exec as unknown as Exec),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("returns the CLI's stderr (the only signal when it dies before emitting JSON)", async () => {
    exec = vi.fn(async (file: string) =>
      file === "git"
        ? { stdout: "", stderr: "", exitCode: 0 }
        : {
            stdout: "",
            stderr: "Invalid API key sk-ant-secret · Fix external API key",
            exitCode: 1,
          },
    );
    const out = await runSandbox(REQ, CFG, exec as unknown as Exec);
    expect(out.stderr).toContain("Invalid API key");
    // …and it goes through the SAME redaction as stdout.
    expect(out.stderr).not.toContain("sk-ant-secret");
  });
});

/**
 * Ephemeral workspace (#680) — a prompt-in / JSON-out run with NO repo: the api's `claude-code`
 * AI-generate source and a codeAgent READ node without `repo`. The point of these tests is that
 * moving those callers into the sandbox did not buy them a weaker sandbox.
 */
describe.skipIf(process.platform === "win32")("runSandbox (ephemeral)", () => {
  const EPH = { ...REQ, workspace: "ephemeral" as const };
  /** The `-v <host>:/work` host path out of a docker argv. */
  const mountOf = (args: string[]) =>
    args[args.indexOf("-v") + 1].replace(/:\/work$/, "");

  it("runs the container with the IDENTICAL isolation argv — only the workdir differs", async () => {
    const repo = await runSandbox(REQ, CFG, exec as unknown as Exec);
    expect(repo.exitCode).toBe(0);
    const repoArgs: string[] = exec.mock.calls[0][1];

    exec.mockClear();
    await runSandbox(EPH, CFG, exec as unknown as Exec);
    const ephArgs: string[] = exec.mock.calls[0][1];

    // Normalize the one legitimate difference (the mount source) and require EXACT equality:
    // pinned image, --network, --read-only, --tmpfs, no-new-privileges, --cap-drop ALL, cpu/
    // memory/pids caps, the proxy vars and the by-NAME credential must all be byte-identical.
    const normalize = (a: string[]) =>
      a.map((x) => x.replace(mountOf(a), "<WORKDIR>"));
    expect(normalize(ephArgs)).toEqual(normalize(repoArgs));
    // …and the ephemeral tree is still confined under runsDir.
    expect(mountOf(ephArgs).startsWith("/runs/")).toBe(true);
  });

  it("creates + chmods its own tree, runs docker ONLY, and never touches git", async () => {
    const out = await runSandbox(EPH, CFG, exec as unknown as Exec);
    expect(out.diff).toBe(""); // no repo ⇒ no diff, and no bogus "not a git repository" 500
    expect(exec.mock.calls.map((c) => c[0])).toEqual(["docker"]);
    const dir = mkdirMock.mock.calls[0][0];
    // recursive:false — an id collision must error, never silently reuse a live run's tree.
    expect(mkdirMock.mock.calls[0][1]).toEqual({ recursive: false });
    // The sandbox runs as an unprivileged uid; the runner is root. Widened explicitly because
    // mkdir's mode is masked by umask.
    expect(chmodMock).toHaveBeenCalledWith(dir, 0o777);
    expect(dir).toBe(mountOf(exec.mock.calls[0][1]));
  });

  it("IGNORES a caller-supplied runId (no traversal surface at all in this mode)", async () => {
    await runSandbox(
      { ...EPH, runId: "../../etc" },
      CFG,
      exec as unknown as Exec,
    );
    const dir: string = mountOf(exec.mock.calls[0][1]);
    expect(dir).not.toContain("etc");
    expect(dir).toMatch(/^\/runs\/eph-[0-9a-f]{32}$/);
  });

  it("generates a fresh id per run (never reuses another run's tree)", async () => {
    await runSandbox(EPH, CFG, exec as unknown as Exec);
    const first = mountOf(exec.mock.calls[0][1]);
    exec.mockClear();
    await runSandbox(EPH, CFG, exec as unknown as Exec);
    expect(mountOf(exec.mock.calls[0][1])).not.toBe(first);
  });

  it("removes the tree even when the docker run throws (no accumulation under runsDir)", async () => {
    exec = vi.fn(async () => {
      throw new Error("docker exploded");
    });
    await expect(runSandbox(EPH, CFG, exec as unknown as Exec)).rejects.toThrow(
      /docker exploded/,
    );
    expect(rmMock).toHaveBeenCalledWith(mkdirMock.mock.calls[0][0], {
      recursive: true,
      force: true,
    });
  });

  it("removes the tree on a normal run too", async () => {
    await runSandbox(EPH, CFG, exec as unknown as Exec);
    expect(rmMock).toHaveBeenCalledWith(mkdirMock.mock.calls[0][0], {
      recursive: true,
      force: true,
    });
  });

  it("still enforces the key allowlist + argv typing before creating anything", async () => {
    await expect(
      runSandbox(
        { ...EPH, keyEnvVar: "AWS_SECRET_ACCESS_KEY" },
        CFG,
        exec as unknown as Exec,
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(mkdirMock).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it("rejects an unknown workspace rather than silently defaulting", async () => {
    await expect(
      runSandbox(
        { ...REQ, workspace: "host" as unknown as "repo" },
        CFG,
        exec as unknown as Exec,
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(exec).not.toHaveBeenCalled();
  });

  it("does NOT leave the repo path's mkdir behind (repo trees stay caller-owned)", async () => {
    await runSandbox(REQ, CFG, exec as unknown as Exec);
    expect(mkdirMock).not.toHaveBeenCalled();
    expect(rmMock).not.toHaveBeenCalled();
  });
});

/**
 * TOOL → IMAGE routing (#680). The request names a TOOL from a closed set; the RUNNER resolves the
 * image from its own config. This is the security shape: the runner holds the Docker socket (host
 * root), so a request that could name an image would be a root-privileged injection surface, while
 * a request naming a member of a fixed enum is not.
 */
describe.skipIf(process.platform === "win32")(
  "runSandbox (tool routing)",
  () => {
    /** The image is the arg immediately before the agent argv (`docker run … <image> <args…>`).
     *  NOT a `startsWith("naary-")` scan — that matches the `naary-sandbox-internal` NETWORK
     *  name first, which silently made every one of these assertions compare the wrong string. */
    const imageOf = (args: string[]) =>
      args[args.length - REQ.agentArgs.length - 1];

    it("launches each tool's OWN pinned image", async () => {
      for (const tool of SANDBOX_TOOLS) {
        exec.mockClear();
        await runSandbox(
          {
            ...REQ,
            tool,
            keyEnvVar: ALLOWED_KEY_ENV_VARS_BY_TOOL[tool][0],
          },
          CFG,
          exec as unknown as Exec,
        );
        expect(imageOf(exec.mock.calls[0][1]), tool).toBe(
          DEFAULT_SANDBOX_IMAGES[tool],
        );
      }
    });

    it("defaults to claude when the request names no tool (older callers unaffected)", async () => {
      await runSandbox(REQ, CFG, exec as unknown as Exec);
      expect(imageOf(exec.mock.calls[0][1])).toBe(
        DEFAULT_SANDBOX_IMAGES.claude,
      );
    });

    it("REJECTS an unknown tool rather than coercing it to a default", async () => {
      // Coercion is the dangerous option: it is exactly how a cursor argv reached the claude
      // entrypoint (#933). An unrecognized tool must fail, not silently run something else.
      for (const tool of ["bash", "naary-claude-sandbox:latest", "", 7]) {
        await expect(
          runSandbox(
            { ...REQ, tool: tool as never },
            CFG,
            exec as unknown as Exec,
          ),
        ).rejects.toBeInstanceOf(BadRequestError);
      }
      expect(exec).not.toHaveBeenCalled();
    });

    it("cannot be told to run an IMAGE — only the runner's config maps tool → image", async () => {
      // A request field named `image` is simply not part of the contract; prove it is ignored
      // rather than honoured, so a future refactor that starts reading it fails here.
      await runSandbox(
        { ...REQ, image: "evil/pwn:latest" } as never,
        CFG,
        exec as unknown as Exec,
      );
      expect(exec.mock.calls[0][1].join(" ")).not.toContain("evil/pwn");
      expect(imageOf(exec.mock.calls[0][1])).toBe(
        DEFAULT_SANDBOX_IMAGES.claude,
      );
    });

    it("launches the operator's DIGEST-pinned images (the production config)", async () => {
      // The end-to-end version of the docker-run regression: with the allowlist hardcoded to the
      // four `:latest` tags, this configuration — which is exactly what deploy.yml now ships —
      // threw `refusing to launch un-pinned image` on every run, so nobody could actually pin.
      const digestCfg: RunnerConfig = {
        ...CFG,
        images: {
          claude: `ghcr.io/iff-productions/naary-claude-sandbox:sha-aaaaaaaaaaaa@sha256:${"1".repeat(64)}`,
          cursor: `ghcr.io/iff-productions/naary-cursor-sandbox:sha-bbbbbbbbbbbb@sha256:${"2".repeat(64)}`,
          copilot: `ghcr.io/iff-productions/naary-copilot-sandbox:sha-cccccccccccc@sha256:${"3".repeat(64)}`,
          gemini: `ghcr.io/iff-productions/naary-gemini-sandbox:sha-dddddddddddd@sha256:${"4".repeat(64)}`,
        },
        requireDigest: true,
      };
      for (const tool of SANDBOX_TOOLS) {
        exec.mockClear();
        await runSandbox(
          {
            ...REQ,
            tool,
            keyEnvVar: ALLOWED_KEY_ENV_VARS_BY_TOOL[tool][0],
          },
          digestCfg,
          exec as unknown as Exec,
        );
        expect(imageOf(exec.mock.calls[0][1]), tool).toBe(
          digestCfg.images[tool],
        );
      }
    });

    it("refuses another tool's credential var (no cross-tool key forwarding)", async () => {
      await expect(
        runSandbox(
          { ...REQ, tool: "gemini", keyEnvVar: "ANTHROPIC_API_KEY" },
          CFG,
          exec as unknown as Exec,
        ),
      ).rejects.toThrow(/not valid for the "gemini" sandbox/);
      expect(exec).not.toHaveBeenCalled();
    });

    it("defaults each tool's key var to its own primary (never claude's)", async () => {
      await runSandbox(
        { ...REQ, tool: "cursor" },
        CFG,
        exec as unknown as Exec,
      );
      const [, dargs, opts] = exec.mock.calls[0];
      expect(dargs).toContain("CURSOR_API_KEY");
      expect(dargs).not.toContain("ANTHROPIC_API_KEY");
      // …and the value rides in the exec ENV, never the argv.
      expect(opts.env.CURSOR_API_KEY).toBe("sk-ant-secret");
      expect((dargs as string[]).join(" ")).not.toContain("sk-ant-secret");
    });
  },
);

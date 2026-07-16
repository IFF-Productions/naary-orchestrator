import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerConfig } from "../src/config";
import { SANDBOX_KEY_ENV } from "../src/docker-run";
import { BadRequestError, type Exec, runSandbox } from "../src/run-sandbox";

// runSandbox stats the run dir before touching docker. Mock it so no real FS is needed;
// default = a directory that exists.
const { statMock } = vi.hoisted(() => ({ statMock: vi.fn() }));
vi.mock("node:fs/promises", () => ({ stat: statMock }));

const CFG: RunnerConfig = {
  token: "t",
  runsDir: "/runs",
  network: "naary-sandbox-internal",
  proxyUrl: "http://naary-sandbox-proxy:3128",
  image: "naary-claude-sandbox:latest",
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
});

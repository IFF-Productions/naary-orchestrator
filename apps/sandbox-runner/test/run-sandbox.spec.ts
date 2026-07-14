import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerConfig } from "../src/config";
import { SANDBOX_KEY_ENV } from "../src/docker-run";
import { BadRequestError, type Exec, runSandbox } from "../src/run-sandbox";

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
  anthropicKey: "sk-ant-secret",
};

let exec: ReturnType<typeof vi.fn>;
beforeEach(() => {
  exec = vi.fn(async (file: string) =>
    file === "git"
      ? { stdout: "diff --git a/x b/x\n+edited", exitCode: 0 }
      : { stdout: '{"result":"done","is_error":false}', exitCode: 0 },
  );
});

describe("runSandbox", () => {
  it("runs docker (pinned + isolated) then captures the git diff", async () => {
    const out = await runSandbox(REQ, CFG, exec as unknown as Exec);
    expect(out.exitCode).toBe(0);
    expect(out.diff).toContain("+edited");

    const [dockerCall, gitCall] = exec.mock.calls;
    expect(dockerCall[0]).toBe("docker");
    const dargs: string[] = dockerCall[1];
    expect(dargs).toContain("naary-claude-sandbox:latest"); // pinned image
    expect(dargs[dargs.indexOf("--network") + 1]).toBe(
      "naary-sandbox-internal",
    );
    expect(dargs).toContain("--rm");
    // the working tree is mounted under runsDir
    expect(dargs[dargs.indexOf("-v") + 1]).toBe("/runs/exec-abc_123:/work");
    // git diff runs against the same workdir
    expect(gitCall[1]).toEqual(["-C", "/runs/exec-abc_123", "diff"]);
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

  it("throws when git diff fails (workdir isn't a git repo) — no misleading diff", async () => {
    exec = vi.fn(async (file: string) =>
      file === "git"
        ? { stdout: "fatal: not a git repository", exitCode: 128 }
        : { stdout: "{}", exitCode: 0 },
    );
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
      runSandbox({ ...REQ, anthropicKey: "" }, CFG, exec as unknown as Exec),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});

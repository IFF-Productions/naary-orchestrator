import { beforeEach, describe, expect, it, vi } from "vitest";

// rm is called directly (not via a seam) for cleanup — spy on it so we can assert the working
// tree is always removed and no real FS is touched.
const rm = vi.fn().mockResolvedValue(undefined);
vi.mock("node:fs/promises", () => ({ rm: (...a: unknown[]) => rm(...a) }));

import {
  __codeAgentWriteDeps,
  runCodeAgentWrite,
  sandboxRunId,
} from "../src/temporal/code-agent-write";

const GIT_TOKEN = "fake-install-token-123"; // obviously fake; the leak tests search for this
const ANTHROPIC = "sk-ant-fake"; // the credential that IS allowed to reach the runner

const ENV = {
  runnerUrl: "http://naary-sandbox-runner:8080",
  runnerToken: "runner-bearer",
  runsDir: "/srv/runs",
  writeEnabled: true,
};

const PARAMS = {
  tenantId: "t1",
  executionId: "wf-1",
  nodeId: "codeAgent",
  repo: "acme/widgets",
  branch: "main",
  connectionId: "conn-gh",
  agentArgs: ["-p", "fix the bug", "--permission-mode", "acceptEdits"],
  authKey: ANTHROPIC,
  keyEnvVar: "ANTHROPIC_API_KEY",
  timeoutMs: 60_000,
};

let exec: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let resolveAuthHeader: ReturnType<typeof vi.fn>;

beforeEach(() => {
  rm.mockClear();
  exec = vi.fn().mockResolvedValue({ stdout: "", exitCode: 0 }); // git clone ok
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ exitCode: 0, stdout: "{}", diff: "diff --git a b" }),
  });
  resolveAuthHeader = vi
    .fn()
    .mockResolvedValue({ Authorization: `Bearer ${GIT_TOKEN}` });
  __codeAgentWriteDeps.exec = exec as never;
  __codeAgentWriteDeps.fetch = fetchMock as never;
  __codeAgentWriteDeps.resolveAuthHeader = resolveAuthHeader as never;
});

describe("sandboxRunId", () => {
  it("is deterministic + always runner-safe (RUN_ID_RE), even for a nasty nodeId", () => {
    const re = /^[A-Za-z0-9._-]{1,128}$/;
    const a = sandboxRunId("wf-1", "node/with slash and space");
    const b = sandboxRunId("wf-1", "node/with slash and space");
    expect(a).toBe(b); // deterministic → idempotent re-run
    expect(a).toMatch(re);
    // Different node → different id (no collision).
    expect(sandboxRunId("wf-1", "other")).not.toBe(a);
  });
});

describe("runCodeAgentWrite", () => {
  it("clones then dispatches to the runner and returns the diff", async () => {
    const out = await runCodeAgentWrite(PARAMS, ENV);
    expect(out).toEqual({ exitCode: 0, stdout: "{}", diff: "diff --git a b" });
    // git clone happened with the plain https URL (no token in it).
    expect(exec).toHaveBeenCalledOnce();
    const [bin, args] = exec.mock.calls[0];
    expect(bin).toBe("git");
    expect(args).toContain("https://github.com/acme/widgets.git");
    // runner POST /run with bearer.
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://naary-sandbox-runner:8080/run");
    expect(init.headers.authorization).toBe("Bearer runner-bearer");
  });

  it("SECURITY: the git token never reaches the runner request or the clone argv", async () => {
    await runCodeAgentWrite(PARAMS, ENV);
    // (1) Not in the runner request body/headers.
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).not.toContain(GIT_TOKEN);
    expect(JSON.stringify(init.headers)).not.toContain(GIT_TOKEN);
    // (2) Not anywhere on the clone argv (it's passed via the child env, not the command line).
    const [, cloneArgs] = exec.mock.calls[0];
    expect(cloneArgs.join(" ")).not.toContain(GIT_TOKEN);
    // (3) The token IS provided to git via the env (so the clone can actually auth).
    const [, , opts] = exec.mock.calls[0];
    expect(opts.env.GIT_TOKEN).toBe(GIT_TOKEN);
  });

  it("forwards the ANTHROPIC credential (by value + var name) to the runner — never the git token", async () => {
    await runCodeAgentWrite(PARAMS, ENV);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.authKey).toBe(ANTHROPIC);
    expect(body.keyEnvVar).toBe("ANTHROPIC_API_KEY");
    expect(body.runId).toMatch(/^ca-[a-f0-9]{40}$/);
  });

  it("always removes the working tree (finally), even when the runner errors", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    await expect(runCodeAgentWrite(PARAMS, ENV)).rejects.toMatchObject({
      type: "CODE_AGENT_RUNNER_ERROR",
    });
    expect(rm).toHaveBeenCalledOnce();
  });

  it("is a non-retryable no-op when write mode is disabled (the gate)", async () => {
    await expect(
      runCodeAgentWrite(PARAMS, { ...ENV, writeEnabled: false }),
    ).rejects.toMatchObject({
      type: "CODE_AGENT_WRITE_DISABLED",
      nonRetryable: true,
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it("rejects a malformed repo (no protocol/host/traversal past owner/name)", async () => {
    for (const repo of ["../evil", "https://x/y", "a/b/c", "justone"]) {
      await expect(
        runCodeAgentWrite({ ...PARAMS, repo }, ENV),
      ).rejects.toMatchObject({ type: "CODE_AGENT_BAD_REPO" });
    }
  });

  it("fails non-retryably when git clone exits non-zero (bad repo/branch/access)", async () => {
    exec.mockResolvedValue({ stdout: "fatal: not found", exitCode: 128 });
    await expect(runCodeAgentWrite(PARAMS, ENV)).rejects.toMatchObject({
      type: "CODE_AGENT_CLONE_FAILED",
    });
    // Cleanup still ran.
    expect(rm).toHaveBeenCalledOnce();
    // The runner was never called (no clone → nothing to run).
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

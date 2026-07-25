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
  sandboxReadEnabled: false,
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
let githubFetch: ReturnType<typeof vi.fn>;
let resolveAuthHeader: ReturnType<typeof vi.fn>;

beforeEach(() => {
  rm.mockClear();
  exec = vi.fn().mockResolvedValue({ stdout: "", exitCode: 0 }); // git clone ok
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ exitCode: 0, stdout: "{}", diff: "diff --git a b" }),
  });
  // GitHub REST seam (#444): default = a successful PR creation.
  githubFetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 201,
    json: async () => ({
      number: 42,
      html_url: "https://github.com/acme/widgets/pull/42",
    }),
  });
  resolveAuthHeader = vi
    .fn()
    .mockResolvedValue({ Authorization: `Bearer ${GIT_TOKEN}` });
  __codeAgentWriteDeps.exec = exec as never;
  __codeAgentWriteDeps.fetch = fetchMock as never;
  __codeAgentWriteDeps.githubFetch = githubFetch as never;
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

  // --- READ mode through the same isolated dispatch (#594/#680) ---
  const READ_PARAMS = {
    ...PARAMS,
    mode: "read" as const,
    agentArgs: ["-p", "review the code", "--permission-mode", "plan"],
  };
  const READ_ENV = { ...ENV, writeEnabled: false, sandboxReadEnabled: true };

  it("READ mode: clones + dispatches to the runner (isolated), gated by sandboxReadEnabled", async () => {
    const out = await runCodeAgentWrite(READ_PARAMS, READ_ENV);
    expect(out.exitCode).toBe(0);
    // Same isolated path as write: git clone + runner POST /run.
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0][0]).toBe("git");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://naary-sandbox-runner:8080/run");
    const body = JSON.parse(init.body);
    // Read-only argv is forwarded; the ANTHROPIC key is, the git token is NOT.
    expect(body.agentArgs).toContain("plan");
    expect(body.authKey).toBe(ANTHROPIC);
    expect(init.body).not.toContain(GIT_TOKEN);
    expect(JSON.stringify(init.headers)).not.toContain(GIT_TOKEN);
  });

  it("READ mode: independent gate — disabled unless `sandboxReadEnabled` is set", async () => {
    await expect(
      runCodeAgentWrite(READ_PARAMS, {
        ...READ_ENV,
        sandboxReadEnabled: false,
      }),
    ).rejects.toMatchObject({
      type: "CODE_AGENT_SANDBOX_READ_DISABLED",
      nonRetryable: true,
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it("READ mode: the write gate does NOT block it (read runs with writeEnabled=false)", async () => {
    // READ_ENV has writeEnabled:false — a read run must still proceed.
    await expect(
      runCodeAgentWrite(READ_PARAMS, READ_ENV),
    ).resolves.toBeTruthy();
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

  it("does NOT open a PR by default (openPr off)", async () => {
    const out = await runCodeAgentWrite(PARAMS, ENV);
    expect(out.pr).toBeUndefined();
    expect(githubFetch).not.toHaveBeenCalled();
    // only the clone ran on the git seam
    expect(exec).toHaveBeenCalledOnce();
  });
});

describe("runCodeAgentWrite — open PR (#444)", () => {
  const gitCmds = () =>
    exec.mock.calls.map((c) => (c[1] as string[]).join(" "));
  const expectedBranch = `naary/code-agent/${sandboxRunId("wf-1", "codeAgent")}`;

  it("commits, force-pushes a node-owned branch, and opens a PR", async () => {
    const out = await runCodeAgentWrite(
      { ...PARAMS, openPr: true, prTitle: "Fix bug", prBody: "the body" },
      ENV,
    );
    expect(out.pr).toEqual({
      number: 42,
      url: "https://github.com/acme/widgets/pull/42",
      branch: expectedBranch,
    });
    // git: clone (call 0) + checkout -B + commit + force-push
    const cmds = gitCmds();
    expect(cmds.some((c) => c.includes(`checkout -B ${expectedBranch}`))).toBe(
      true,
    );
    expect(cmds.some((c) => c.includes("commit -m"))).toBe(true);
    expect(
      cmds.some((c) =>
        c.includes(`push --force origin HEAD:refs/heads/${expectedBranch}`),
      ),
    ).toBe(true);
    // PR POST: base = the configured branch (main), head = node branch, GitHub headers set.
    const post = githubFetch.mock.calls.find(
      (c) => c[0].endsWith("/pulls") && c[1].method === "POST",
    );
    expect(post).toBeTruthy();
    const body = JSON.parse(post![1].body);
    expect(body).toMatchObject({
      title: "Fix bug",
      head: expectedBranch,
      base: "main",
      body: "the body",
    });
    expect(post![1].headers["user-agent"]).toBeTruthy();
    expect(post![1].headers.authorization).toBe(`Bearer ${GIT_TOKEN}`);
  });

  it("SECURITY: the git token is passed to push via env, never on the argv or the PR body", async () => {
    await runCodeAgentWrite({ ...PARAMS, openPr: true }, ENV);
    const push = exec.mock.calls.find((c) =>
      (c[1] as string[]).join(" ").includes("push --force"),
    );
    expect(push).toBeTruthy();
    expect((push![1] as string[]).join(" ")).not.toContain(GIT_TOKEN); // not on argv
    expect(push![2].env.GIT_TOKEN).toBe(GIT_TOKEN); // provided via env
    const post = githubFetch.mock.calls.find(
      (c) => c[0].endsWith("/pulls") && c[1].method === "POST",
    );
    expect(post![1].body).not.toContain(GIT_TOKEN); // not in the PR payload
  });

  it("an EMPTY diff is a clean no-op: no branch/commit/push, no PR", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ exitCode: 0, stdout: "{}", diff: "   \n  " }),
    });
    const out = await runCodeAgentWrite({ ...PARAMS, openPr: true }, ENV);
    expect(out.pr).toBeUndefined();
    expect(githubFetch).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledOnce(); // clone only — no checkout/commit/push
  });

  it("skips the PR when the sandbox CLI exited non-zero", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ exitCode: 1, stdout: "{}", diff: "diff --git a b" }),
    });
    const out = await runCodeAgentWrite({ ...PARAMS, openPr: true }, ENV);
    expect(out.pr).toBeUndefined();
    expect(githubFetch).not.toHaveBeenCalled();
  });

  it("resolves the base from the repo's default branch when no branch is configured", async () => {
    githubFetch.mockImplementation((url: string, init: RequestInit) => {
      if (url.endsWith("/repos/acme/widgets") && init.method === "GET") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ default_branch: "trunk" }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({
          number: 9,
          html_url: "https://github.com/acme/widgets/pull/9",
        }),
      });
    });
    const out = await runCodeAgentWrite(
      { ...PARAMS, branch: undefined, openPr: true },
      ENV,
    );
    const post = githubFetch.mock.calls.find(
      (c) => c[0].endsWith("/pulls") && c[1].method === "POST",
    );
    expect(JSON.parse(post![1].body).base).toBe("trunk");
    expect(out.pr?.number).toBe(9);
  });

  it("is idempotent: a 422 (PR already exists) returns the existing PR", async () => {
    githubFetch.mockImplementation((url: string, init: RequestInit) => {
      if (url.includes("/pulls") && init.method === "POST") {
        return Promise.resolve({
          ok: false,
          status: 422,
          json: async () => ({}),
        });
      }
      // GET /pulls?head=... → the existing PR
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [
          { number: 7, html_url: "https://github.com/acme/widgets/pull/7" },
        ],
      });
    });
    const out = await runCodeAgentWrite({ ...PARAMS, openPr: true }, ENV);
    expect(out.pr).toEqual({
      number: 7,
      url: "https://github.com/acme/widgets/pull/7",
      branch: expectedBranch,
    });
  });

  it("fails non-retryably when the push fails (e.g. connection lacks contents:write)", async () => {
    exec.mockImplementation((_bin: string, args: string[]) =>
      Promise.resolve(
        args.join(" ").includes("push")
          ? { stdout: "denied", exitCode: 1 }
          : { stdout: "", exitCode: 0 },
      ),
    );
    await expect(
      runCodeAgentWrite({ ...PARAMS, openPr: true }, ENV),
    ).rejects.toMatchObject({ type: "CODE_AGENT_PR_PUSH_FAILED" });
    expect(rm).toHaveBeenCalledOnce(); // workdir still cleaned up
  });
});

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunnerConfig } from "../src/config";
import { type Exec, runSandbox } from "../src/run-sandbox";

// REAL git (no node:fs/promises mock here) — the ONLY kind of test that catches "git diff omits
// untracked files". Mocked-exec tests structurally can't, since they assert a fixed diff string.
const pExecFile = promisify(execFile);
const realGit: Exec = async (file, args, opts) => {
  try {
    const { stdout } = await pExecFile(file, args, {
      env: opts.env,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout, exitCode: 0 };
  } catch (e) {
    const err = e as { stdout?: string; code?: number };
    return { stdout: String(err.stdout ?? ""), exitCode: err.code ?? 1 };
  }
};

/** Route docker → a no-op stub (we simulate the sandbox's edits by hand); git → real. */
const routedExec: Exec = (file, args, opts) =>
  file === "docker"
    ? Promise.resolve({ stdout: '{"result":"ok"}', exitCode: 0 })
    : realGit(file, args, opts);

let runsDir: string;
const RUN_ID = "exec-realgit_1";

const CFG = (): RunnerConfig => ({
  token: "t",
  runsDir,
  network: "naary-sandbox-internal",
  proxyUrl: "http://naary-sandbox-proxy:3128",
  image: "naary-claude-sandbox:latest",
  limits: { cpus: "1.0", memoryMb: 2048, pids: 256 },
  defaultTimeoutMs: 900_000,
  port: 8099,
});

const REQ = {
  runId: RUN_ID,
  agentArgs: ["-p", "edit"],
  authKey: "sk-ant-fake",
};

async function git(cwd: string, ...args: string[]) {
  await pExecFile("git", ["-C", cwd, ...args]);
}

beforeEach(async () => {
  runsDir = await mkdtemp(path.join(tmpdir(), "naary-runner-"));
  const wd = path.join(runsDir, RUN_ID);
  await mkdir(wd);
  // A repo with ONE committed (tracked) file.
  await git(wd, "init", "-q");
  await git(wd, "config", "user.email", "t@t");
  await git(wd, "config", "user.name", "t");
  await writeFile(path.join(wd, "tracked.txt"), "original\n");
  await git(wd, "add", "-A");
  await git(wd, "commit", "-qm", "base");
  // Simulate the sandbox's edits: MODIFY the tracked file + CREATE a new (untracked) one.
  await writeFile(path.join(wd, "tracked.txt"), "changed\n");
  await writeFile(path.join(wd, "created.txt"), "brand new file\n");
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true }).catch(() => undefined);
});

// Linux-only: runSandbox requires a POSIX absolute workdir (see run-sandbox.spec.ts), which a
// Windows temp dir (`C:\…\Temp\…`) can't satisfy. The service only ever runs on Linux. Skip on win32.
describe.skipIf(process.platform === "win32")(
  "runSandbox diff capture (real git)",
  () => {
    it("includes CREATED (untracked) files, not just tracked edits", async () => {
      const out = await runSandbox(REQ, CFG(), routedExec);
      expect(out.exitCode).toBe(0);
      // The modification to the tracked file...
      expect(out.diff).toContain("tracked.txt");
      expect(out.diff).toContain("changed");
      // ...AND the newly-created file — the whole point (plain `git diff` would omit this).
      expect(out.diff).toContain("created.txt");
      expect(out.diff).toContain("brand new file");
    });
  },
);

import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RunnerConfig } from "../src/config";
import type { Exec } from "../src/run-sandbox";
import { createRunnerServer } from "../src/server";

// The run dir stat check → pretend it exists (the happy-path test isn't about the FS).
vi.mock("node:fs/promises", () => ({
  stat: vi.fn(async () => ({ isDirectory: () => true })),
}));

const CFG: RunnerConfig = {
  token: "secret-token",
  runsDir: "/runs",
  network: "naary-sandbox-internal",
  proxyUrl: "http://naary-sandbox-proxy:3128",
  image: "naary-claude-sandbox:latest",
  limits: { cpus: "1.0", memoryMb: 2048, pids: 256 },
  defaultTimeoutMs: 900_000,
  port: 0,
};

// Mock exec so no docker/git is needed; echoes a diff and the CLI envelope.
const exec = vi.fn(async (file: string) =>
  file === "git"
    ? { stdout: "+edited", exitCode: 0 }
    : { stdout: '{"result":"ok","is_error":false}', exitCode: 0 },
) as unknown as Exec;

const server = createRunnerServer(CFG, exec);
let base = "";
beforeAll(
  () =>
    new Promise<void>((r) =>
      server.listen(0, () => {
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        r();
      }),
    ),
);
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const post = (body: unknown, token = "secret-token") =>
  fetch(`${base}/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const REQ = {
  runId: "run-1",
  agentArgs: ["-p", "go"],
  authKey: "sk-ant-xyz",
};

describe("runner server", () => {
  it("healthz is open", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("401s without / with a wrong bearer token", async () => {
    expect((await post(REQ, "")).status).toBe(401);
    expect((await post(REQ, "nope")).status).toBe(401);
  });

  it("runs and returns the diff — but NEVER the key", async () => {
    const res = await post(REQ);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("+edited");
    expect(text).not.toContain("sk-ant-xyz");
  });

  it("400s a bad request (traversal runId) without a 500", async () => {
    const res = await post({ ...REQ, runId: "../escape" });
    expect(res.status).toBe(400);
  });

  it("404s an unknown route", async () => {
    const res = await fetch(`${base}/nope`, {
      method: "POST",
      headers: { authorization: "Bearer secret-token" },
    });
    expect(res.status).toBe(404);
  });
});

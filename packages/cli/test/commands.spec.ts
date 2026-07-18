import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/client";
import type { CommandContext } from "../src/context";
import { run } from "../src/run";

/** A context that captures output and hands commands a stubbed client. */
function makeCtx(handler: (path: string, opts: any) => unknown) {
  const out: string[] = [];
  const err: string[] = [];
  const requests: Array<{ path: string; opts: any }> = [];
  const client = {
    request: vi.fn(async (path: string, opts: any = {}) => {
      requests.push({ path, opts });
      return handler(path, opts);
    }),
  } as unknown as ApiClient;
  const ctx: CommandContext = {
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    makeClient: (flags) => ({
      client,
      config: { apiUrl: "http://localhost:3000", token: "nry_x", ...flags },
    }),
  };
  return { ctx, out, err, requests };
}

describe("routing", () => {
  it("no args → top-level help, exit 0", async () => {
    const { ctx, out } = makeCtx(() => ({}));
    expect(await run([], ctx, "1.2.3")).toBe(0);
    expect(out.join("\n")).toContain("naary <group> <command>");
  });
  it("--version → prints version", async () => {
    const { ctx, out } = makeCtx(() => ({}));
    expect(await run(["--version"], ctx, "1.2.3")).toBe(0);
    expect(out).toContain("1.2.3");
  });
  it("--version is top-level only: after a group it is not the CLI version", async () => {
    // `--version` is a top-level flag; once a group is selected it belongs to the command
    // (e.g. `runs rerun --version N` = graph version). So `naary runs --version` must NOT print
    // the CLI version — it's an unknown command. Guards the router's global-flag handling.
    const { ctx, out, err } = makeCtx(() => ({}));
    expect(await run(["runs", "--version"], ctx, "1.2.3")).toBe(1);
    expect(err.join("\n")).toContain("Unknown command");
    expect(out).not.toContain("1.2.3");
  });
  it("unknown group → help, exit 1", async () => {
    const { ctx } = makeCtx(() => ({}));
    expect(await run(["bogus"], ctx)).toBe(1);
  });
  it("unknown command in a known group → error, exit 1", async () => {
    const { ctx, err } = makeCtx(() => ({}));
    expect(await run(["runs", "frobnicate"], ctx)).toBe(1);
    expect(err.join("\n")).toContain("Unknown command");
  });
});

describe("runs commands", () => {
  it("runs start posts workflowKey+input and prints the runId", async () => {
    const { ctx, out, requests } = makeCtx(() => ({ runId: "run-123" }));
    const code = await run(
      ["runs", "start", "--workflow", "wf1", "--input", '{"x":1}'],
      ctx,
    );
    expect(code).toBe(0);
    expect(out).toContain("run-123");
    expect(requests[0].path).toBe("/runs");
    expect(requests[0].opts.method).toBe("POST");
    expect(requests[0].opts.body).toEqual({
      workflowKey: "wf1",
      input: { x: 1 },
    });
  });

  it("runs start rejects invalid --input JSON without calling the API", async () => {
    const { ctx, err, requests } = makeCtx(() => ({}));
    const code = await run(["runs", "start", "--input", "not-json"], ctx);
    expect(code).toBe(1);
    expect(requests.length).toBe(0);
    expect(err.join("\n")).toContain("not valid JSON");
  });

  it("runs list renders a table", async () => {
    const { ctx, out } = makeCtx(() => [
      {
        runId: "r1",
        workflowKey: "wf1",
        status: "completed",
        costUsd: 0.02,
        graphVersion: 3,
        startedAt: "2026-07-16T10:00:00.000Z",
      },
    ]);
    expect(await run(["runs", "list", "--limit", "5"], ctx)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("RUN ID");
    expect(text).toContain("r1");
    expect(text).toContain("$0.0200");
  });

  it("runs list passes the limit as a query param", async () => {
    const { ctx, requests } = makeCtx(() => []);
    await run(["runs", "list", "--limit", "7"], ctx);
    expect(requests[0].opts.query).toEqual({ limit: 7 });
  });

  it("runs get requires an id", async () => {
    const { ctx, err } = makeCtx(() => ({}));
    expect(await run(["runs", "get"], ctx)).toBe(1);
    expect(err.join("\n")).toContain("Missing run id");
  });
});

describe("approvals commands", () => {
  it("approve posts {approved:true} with an optional comment", async () => {
    const { ctx, requests } = makeCtx(() => ({ accepted: true }));
    await run(["approvals", "approve", "run-9", "--comment", "lgtm"], ctx);
    expect(requests[0].path).toBe("/runs/run-9/approve");
    expect(requests[0].opts.body).toEqual({ approved: true, comment: "lgtm" });
  });
  it("reject posts {approved:false}", async () => {
    const { ctx, requests } = makeCtx(() => ({ accepted: true }));
    await run(["approvals", "reject", "run-9"], ctx);
    expect(requests[0].opts.body).toEqual({
      approved: false,
      comment: undefined,
    });
  });
});

describe("auth status", () => {
  it("prints a masked token, never the full secret", async () => {
    const { ctx, out } = makeCtx(() => ({}));
    const code = await run(
      ["auth", "status", "--token", "nry_supersecret9999"],
      ctx,
    );
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("nry_…9999");
    expect(text).not.toContain("supersecret");
  });
});

describe("workflows promote", () => {
  it("requires --to", async () => {
    const { ctx, err } = makeCtx(() => ({}));
    expect(await run(["workflows", "promote", "wf1"], ctx)).toBe(1);
    expect(err.join("\n")).toContain("--to");
  });
  it("posts toEnv + fromVersion", async () => {
    const { ctx, requests } = makeCtx(() => ({
      fromVersion: 2,
      toVersion: 3,
      contentHash: "abc",
    }));
    await run(
      ["workflows", "promote", "wf1", "--to", "prod", "--from-version", "2"],
      ctx,
    );
    expect(requests[0].path).toBe("/workflows/wf1/promote");
    expect(requests[0].opts.body).toEqual({ toEnv: "prod", fromVersion: 2 });
  });
});

/**
 * The per-run `debug` flag has to reach the API for ANY of the debug machinery to exist: the
 * worker only seeds `ctx.__debug` when the run was started with it, and RunDetail only renders
 * the per-node debug rows when `ctx.__debug === true`. Before this, the SPA never sent the flag,
 * so a fully built + tested feature was unreachable from the product.
 *
 * These lock the wire contract at the client seam — the flag is sent when asked for, and (just as
 * important) an ordinary run/re-run's body is unchanged, so nobody gets verbose worker logs by
 * accident. The client module is stubbed because the real one has a relative baseUrl ("/api"),
 * which node's Request constructor rejects (see typed-client.spec.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { path: string; init: { body?: unknown; params?: unknown } };
const calls: Call[] = [];

vi.mock("../src/lib/api/client", () => ({
  client: {
    POST: (path: string, init: Call["init"]) => {
      calls.push({ path, init });
      return Promise.resolve({ data: { workflowId: "wf-new" } });
    },
  },
  unwrap: (r: { data: unknown }) => r.data,
}));

import { runsApi } from "../src/lib/api/runs";

const bodyOf = (i = 0) => calls[i].init.body as Record<string, unknown>;

beforeEach(() => {
  calls.length = 0;
});

describe("startExecution — the canvas's 'Save & run with debug'", () => {
  it("sends debug:true when the run opts in", async () => {
    await runsApi.startExecution("canvas", { a: 1 }, { debug: true });
    expect(calls[0].path).toBe("/executions");
    expect(bodyOf()).toEqual({
      workflowKey: "canvas",
      input: { a: 1 },
      debug: true,
    });
  });

  it("omits debug entirely on an ordinary run (no accidental verbose logging)", async () => {
    await runsApi.startExecution("canvas", { a: 1 });
    expect(bodyOf()).toEqual({ workflowKey: "canvas", input: { a: 1 } });
    expect("debug" in bodyOf()).toBe(false);
  });

  it("omits debug when explicitly false", async () => {
    await runsApi.startExecution("canvas", undefined, { debug: false });
    expect("debug" in bodyOf()).toBe(false);
  });
});

describe("rerun — the run detail's 'Re-run with debug'", () => {
  it("sends debug:true with no version (re-run at latest, diagnostics on)", async () => {
    await runsApi.rerun("wf-old", undefined, { debug: true });
    expect(calls[0].path).toBe("/executions/{id}/rerun");
    expect(calls[0].init.params).toEqual({ path: { id: "wf-old" } });
    expect(bodyOf()).toEqual({ debug: true });
  });

  it("combines a pinned graphVersion with debug", async () => {
    await runsApi.rerun("wf-old", 3, { debug: true });
    expect(bodyOf()).toEqual({ graphVersion: 3, debug: true });
  });

  it("leaves an ordinary re-run's body exactly as it was", async () => {
    await runsApi.rerun("wf-old");
    expect(bodyOf()).toEqual({});
    await runsApi.rerun("wf-old", 2);
    expect(bodyOf(1)).toEqual({ graphVersion: 2 });
  });
});

/**
 * The CONSUMER side of #910's safety story.
 *
 * `packages/dsl/test/integration-write-drift.spec.ts` proves the write-set equals the catalog.
 * It says nothing about whether `handleIntegration` USES it the right way round — invert the
 * ternary in `node-handlers/ai.ts` and that test still passes while every write silently routes
 * to `callIntegrationRead` (`retry: { maximumAttempts: 3 }`), which is exactly the double-posted
 * incident the change had to avoid.
 *
 * A happy-path e2e cannot catch that either: `callIntegrationRead` and `callIntegrationWrite` are
 * the SAME activity (`callIntegration`) behind two `proxyActivities` calls that differ only in
 * `maximumAttempts`, so nothing functional distinguishes them unless a test forces a failure and
 * counts attempts. So assert the routing directly, at the proxy seam — the pattern `proxies.ts`
 * already names for the codeAgent heavy queue ("the heavy proxy is asserted in the unit test").
 *
 * Mutation check this is built to fail: swapping the two branches of the ternary must turn both
 * of the first two cases red.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeHandler } from "../src/temporal/workflow/node-handlers/contract";

const callIntegrationRead = vi.fn(async () => ({ status: 200, body: {} }));
const callIntegrationWrite = vi.fn(async () => ({ status: 201, body: {} }));

// The real module calls `wf.proxyActivities` at import time, which needs a workflow context.
// Mock the whole seam; `handleIntegration` only picks between two of its exports.
vi.mock("../src/temporal/workflow/proxies", () => ({
  callIntegrationRead,
  callIntegrationWrite,
  // Unused by handleIntegration but imported by the module under test.
  runAgent: vi.fn(),
  runAgentTooled: vi.fn(),
  callMcpTool: vi.fn(),
  callCodeAgent: vi.fn(),
  callCodeAgentHeavy: vi.fn(),
  callTextToSpeech: vi.fn(),
  retryOverride: vi.fn(() => undefined),
}));

// Imported DYNAMICALLY, in beforeAll, deliberately. The suite transforms via unplugin-swc, which
// does NOT apply vitest's `vi.mock` hoisting — a static import of the handler would execute
// `../proxies` (and its `wf.proxyActivities`, which needs a workflow context) BEFORE the mock is
// registered, and the file fails to load. Not top-level await either: apps/worker compiles as
// CommonJS, where tsc rejects it (TS1309).
let handleIntegration: NodeHandler;

function run(provider: string, action: string) {
  return handleIntegration({
    node: { id: "integ", type: "integration" },
    cfg: { provider, action, connectionId: "conn-1", fields: {} },
    ctx: {},
    runCtx: { tenantId: "t1" },
    metaFor: () => ({ tenantId: "t1", executionId: "e1", nodeId: "integ" }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

describe("handleIntegration write/read proxy routing (#910)", () => {
  beforeAll(async () => {
    // `.js` is the node16 spelling of the `.ts` source (TS2835); vite resolves it back.
    ({ handleIntegration } =
      await import("../src/temporal/workflow/node-handlers/ai.js"));
  });

  beforeEach(() => {
    callIntegrationRead.mockClear();
    callIntegrationWrite.mockClear();
  });

  it("routes a WRITE action to the AT-MOST-ONCE proxy", async () => {
    await run("pagerduty", "create_incident");
    expect(callIntegrationWrite).toHaveBeenCalledTimes(1);
    expect(callIntegrationRead).not.toHaveBeenCalled();
  });

  it("routes a READ action to the RETRYABLE proxy", async () => {
    await run("github", "get_issue");
    expect(callIntegrationRead).toHaveBeenCalledTimes(1);
    expect(callIntegrationWrite).not.toHaveBeenCalled();
  });

  it("routes an UNKNOWN action to the retryable proxy without throwing", async () => {
    // Same as the pre-#910 `getIntegrationAction(...)?.write` → undefined. The save gate
    // (`validateGraph`) rejects unknown pairs; the interpreter must stay total.
    await run("nope", "create_thing");
    expect(callIntegrationRead).toHaveBeenCalledTimes(1);
    expect(callIntegrationWrite).not.toHaveBeenCalled();
  });

  it("writes the activity result to ctx[node.id]", async () => {
    const ctx: Record<string, unknown> = {};
    await handleIntegration({
      node: { id: "integ", type: "integration" },
      cfg: {
        provider: "pagerduty",
        action: "create_incident",
        connectionId: "c",
        fields: {},
      },
      ctx,
      runCtx: { tenantId: "t1" },
      metaFor: () => ({ tenantId: "t1", executionId: "e1", nodeId: "integ" }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(ctx.integ).toEqual({ status: 201, body: {} });
  });
});

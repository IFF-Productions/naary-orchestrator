// Agent guardrails (#576) — the FORCED-APPROVAL TOOL GATE in the real interpreter, under
// TestWorkflowEnvironment with all I/O mocked (same harness every other interpreter e2e uses).
//
// This is the durable half of the answer to the activity-boundary problem: an agent's in-loop tool
// calls happen inside ONE activity and Temporal cannot suspend an activity to await a Signal, so a
// forced-approval tool is only pausable where the INTERPRETER owns the call — a standalone
// mcpTool/integration node. These tests exercise exactly that: a real Signal + wf.condition()
// pause, resumed by the same approvalSignal the humanApproval node uses, with the AuditEvent naming
// actor + tool + decision (#576 AC2).
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { APPROVAL_CTX_KEY, approvalSignal, stateQuery } from "@naary/contracts";
import type { GraphDef } from "@naary/dsl";
import { runGraph } from "../src/temporal/workflows";
import { createLocalTestEnv } from "./local-test-env";
import {
  TASK_QUEUE,
  auditEvents,
  harnessState,
  makeWorker,
  mcpCalls,
  integrationCalls,
  notifyCalls,
  resolveToolPolicyCalls,
  waitFor,
} from "./interpreter-harness";

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await createLocalTestEnv();
}, 60_000);

afterAll(async () => {
  await env?.teardown();
});

beforeEach(() => {
  harnessState.toolPolicy = {};
  auditEvents.length = 0;
  resolveToolPolicyCalls.length = 0;
  mcpCalls.length = 0;
  integrationCalls.length = 0;
  notifyCalls.length = 0;
});

/** webhookTrigger → mcpTool → end. */
const toolGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "tool",
      type: "mcpTool",
      config: { connectionId: "c1", tool: "wire_money" },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "tool" },
    { from: "tool", to: "end" },
  ],
};

/** Two tool nodes, so the "policy is resolved ONCE per run" claim is testable. */
const twoToolGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "t1",
      type: "mcpTool",
      config: { connectionId: "c1", tool: "read_a" },
    },
    {
      id: "t2",
      type: "mcpTool",
      config: { connectionId: "c1", tool: "read_b" },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "t1" },
    { from: "t1", to: "t2" },
    { from: "t2", to: "end" },
  ],
};

describe("interpreter — forced-approval tool gate (#576)", () => {
  it("pauses before a forced-approval tool node, exposes the tool ref, and runs the tool only after APPROVAL", async () => {
    harnessState.toolPolicy = { "c1:wire_money": "approval" };
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [toolGraph, { amount: 100 }, { tenantId: "t-gate" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-tool-approve",
      });

      await waitFor(
        async () =>
          (await handle.query(stateQuery)).status === "awaiting_approval",
      );
      const paused = await handle.query(stateQuery);
      expect(paused.currentNodeId).toBe("tool");
      // The awaiting record names WHAT is being approved, so the inbox / Slack / public prompt can
      // show it. A ref only — never the tool's arguments.
      expect(paused.ctx[APPROVAL_CTX_KEY]).toMatchObject({
        nodeId: "tool",
        toolRef: "c1:wire_money",
      });
      // The tool has NOT run while the gate is open.
      expect(mcpCalls).toHaveLength(0);
      // A pause that can last days pages the tenant (best-effort), naming the tool.
      expect(
        notifyCalls.some(
          (n) =>
            n.kind === "approval_pending" &&
            n.title === "Approve tool call: c1:wire_money",
        ),
      ).toBe(true);

      await handle.signal(approvalSignal, {
        approved: true,
        actor: "ada@example.com",
      });

      const result = await handle.result();
      expect(result.status).toBe("completed");
      // NOW the tool ran, exactly once.
      expect(mcpCalls).toEqual([
        expect.objectContaining({ connectionId: "c1", tool: "wire_money" }),
      ]);
      // The awaiting record is cleared once the gate resolves.
      expect(result.ctx[APPROVAL_CTX_KEY]).toBeUndefined();
    });

    // #576 AC2: an AuditEvent naming actor + tool + decision.
    await waitFor(async () => auditEvents.length > 0);
    expect(auditEvents).toEqual([
      expect.objectContaining({
        tenantId: "t-gate",
        actor: "ada@example.com",
        action: "Approved tool c1:wire_money",
        statusCode: 200,
        path: "/executions/e2e-tool-approve/nodes/tool",
      }),
    ]);
  });

  it("REJECTION ends the run as rejected and the tool never runs", async () => {
    harnessState.toolPolicy = { "c1:wire_money": "approval" };
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [toolGraph, { amount: 1 }, { tenantId: "t-gate-no" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-tool-reject",
      });
      await waitFor(
        async () =>
          (await handle.query(stateQuery)).status === "awaiting_approval",
      );
      await handle.signal(approvalSignal, {
        approved: false,
        comment: "not authorised",
        actor: "bob@example.com",
      });
      const result = await handle.result();
      expect(result.status).toBe("rejected");
      expect(mcpCalls).toHaveLength(0);
    });

    await waitFor(async () => auditEvents.length > 0);
    expect(auditEvents[0]).toMatchObject({
      actor: "bob@example.com",
      action: "Rejected tool c1:wire_money",
      statusCode: 403,
    });
  });

  it("a DENIED tool node fails the run non-retryably at run time (a graph the save gate never saw)", async () => {
    harnessState.toolPolicy = { "c1:wire_money": "deny" };
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [toolGraph, {}, { tenantId: "t-deny" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-tool-deny",
      });
      // Temporal wraps the workflow failure; the ApplicationFailure the gate threw is the cause.
      const err = await handle.result().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeDefined();
      const cause = (err as { cause?: { message?: string; type?: string } })
        .cause;
      expect(cause?.type).toBe("GUARDRAIL_TOOL_DENIED");
      expect(cause?.message).toMatch(/guardrail policy/i);
      expect(mcpCalls).toHaveLength(0);
    });

    await waitFor(async () => auditEvents.length > 0);
    expect(auditEvents[0]).toMatchObject({
      actor: "guardrail",
      action: "Blocked denied tool c1:wire_money",
      statusCode: 403,
    });
  });

  it("an INTEGRATION action is gated by the same site (provider:action ref)", async () => {
    harnessState.toolPolicy = { "github:create_issue": "approval" };
    const graph: GraphDef = {
      startNodeId: "trigger",
      nodes: [
        { id: "trigger", type: "webhookTrigger" },
        {
          id: "gh",
          type: "integration",
          config: {
            provider: "github",
            action: "create_issue",
            connectionId: "conn-gh",
            fields: { owner: "o", repo: "r", title: "t" },
          },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "trigger", to: "gh" },
        { from: "gh", to: "end" },
      ],
    };
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [graph, {}, { tenantId: "t-gh" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-tool-integration",
      });
      await waitFor(
        async () =>
          (await handle.query(stateQuery)).status === "awaiting_approval",
      );
      expect(integrationCalls).toHaveLength(0);
      await handle.signal(approvalSignal, { approved: true, actor: "ops" });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(integrationCalls).toHaveLength(1);
    });
  });

  it("an UNRESTRICTED policy evaluates each DISTINCT ref once and changes nothing else", async () => {
    harnessState.toolPolicy = {};
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [twoToolGraph, {}, { tenantId: "t-open" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-tool-open",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(mcpCalls.map((c) => c.tool)).toEqual(["read_a", "read_b"]);
    });
    // One evaluation per distinct RESOLVED ref, memoized under ctx.__toolPolicy.
    expect(resolveToolPolicyCalls).toEqual([
      { tenantId: "t-open", refs: ["c1:read_a"] },
      { tenantId: "t-open", refs: ["c1:read_b"] },
    ]);
    expect(auditEvents).toHaveLength(0);
  });

  it("the same ref reached TWICE is evaluated once (the memo is real)", async () => {
    harnessState.toolPolicy = {};
    const sameRefTwice: GraphDef = {
      startNodeId: "trigger",
      nodes: [
        { id: "trigger", type: "webhookTrigger" },
        {
          id: "t1",
          type: "mcpTool",
          config: { connectionId: "c1", tool: "read_a" },
        },
        {
          id: "t2",
          type: "mcpTool",
          config: { connectionId: "c1", tool: "read_a" },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "trigger", to: "t1" },
        { from: "t1", to: "t2" },
        { from: "t2", to: "end" },
      ],
    };
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [sameRefTwice, {}, { tenantId: "t-memo" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-tool-memo",
      });
      expect((await handle.result()).status).toBe("completed");
    });
    expect(resolveToolPolicyCalls).toEqual([
      { tenantId: "t-memo", refs: ["c1:read_a"] },
    ]);
    expect(mcpCalls).toHaveLength(2);
  });

  /**
   * REGRESSION (found in review): the gate must evaluate the ref it is ACTUALLY about to call.
   *
   * A `{{ }}`-templated tool name is a plain `z.string()` at save time, so the save gate only ever
   * sees the literal `"{{ trigger.body.tool }}"` — which matches no glob and is permitted. If the
   * interpreter had keyed a precomputed projection on the graph's STATIC refs and treated a key miss
   * as "allowed", the resolved `c1:wire_money` would have sailed straight past the deny-list.
   */
  it("a TEMPLATED tool name is evaluated against its RESOLVED ref, not the literal `{{…}}`", async () => {
    harnessState.toolPolicy = { "c1:wire_money": "deny" };
    const templated: GraphDef = {
      startNodeId: "trigger",
      nodes: [
        { id: "trigger", type: "webhookTrigger" },
        {
          id: "tool",
          type: "mcpTool",
          config: { connectionId: "c1", tool: "{{ trigger.tool }}" },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "trigger", to: "tool" },
        { from: "tool", to: "end" },
      ],
    };
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [templated, { tool: "wire_money" }, { tenantId: "t-tmpl" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-tool-templated",
      });
      const err = await handle.result().then(
        () => undefined,
        (e: unknown) => e,
      );
      const cause = (err as { cause?: { type?: string } }).cause;
      expect(cause?.type).toBe("GUARDRAIL_TOOL_DENIED");
      // The tool never ran.
      expect(mcpCalls).toHaveLength(0);
    });
    // The activity was asked about the RESOLVED ref — the whole point of the fix.
    expect(resolveToolPolicyCalls).toEqual([
      { tenantId: "t-tmpl", refs: ["c1:wire_money"] },
    ]);
  });
});

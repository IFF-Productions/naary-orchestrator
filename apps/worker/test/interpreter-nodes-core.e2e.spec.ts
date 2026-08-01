// Per-node behavior: webhook/http/sql/set/sub-workflow/wait/merge/signing/email/totp nodes.
// Split out of interpreter.e2e.spec.ts (issue #496). Shared harness + fixtures
// live in ./interpreter-harness; this file owns its own TestWorkflowEnvironment.
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { createLocalTestEnv } from "./local-test-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvalSignal, stateQuery } from "@naary/contracts";
import { githubReviewGraph, webhookSampleGraph } from "@naary/dsl";
import type { GraphDef } from "@naary/dsl";
import { runGraph } from "../src/temporal/workflows";
import {
  TASK_QUEUE,
  agentCalls,
  notifyCalls,
  totpCalls,
  emailCalls,
  hmacCalls,
  jwtCalls,
  subResolveCalls,
  integrationCalls,
  sqlCalls,
  sqlExecCalls,
  harnessState,
  httpBranchGraph,
  sqlGraph,
  sqlExecGraph,
  firestoreQueryGraph,
  firestoreWriteGraph,
  firestoreQueryCalls,
  firestoreWriteCalls,
  setGraph,
  subParentGraph,
  subStartParentGraph,
  waitGraph,
  stopGraph,
  transformGraph,
  signingGraph,
  emailGraph,
  totpGraph,
  diamondGraph,
  waitFor,
  makeWorker,
} from "./interpreter-harness";

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await createLocalTestEnv();
}, 60_000);

afterAll(async () => {
  await env?.teardown();
});

describe("runGraph interpreter — per-node behavior: data, http, sql, sub-workflows & signing", () => {
  it("webhook graph: the inbound event becomes the trigger node's output", async () => {
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const event = { action: "opened", pull_request: { number: 42 } };
      const handle = await env.client.workflow.start(runGraph, {
        args: [webhookSampleGraph, event, { tenantId: "t-wh" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-webhook",
      });

      await waitFor(
        async () =>
          (await handle.query(stateQuery)).status === "awaiting_approval",
      );
      const paused = await handle.query(stateQuery);
      // the webhookTrigger node exposed the event as its output
      expect(paused.ctx.trigger).toEqual(event);

      await handle.signal(approvalSignal, { approved: true });
      expect((await handle.result()).status).toBe("completed");
    });
  });

  it("B5 reference flow: webhook → get_pull_request(diff) → agent → comment_issue → humanApproval composes", async () => {
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const event = {
        action: "opened",
        number: 99,
        repository: { owner: { login: "octocat" }, name: "hello" },
        pull_request: { number: 99 },
      };
      const handle = await env.client.workflow.start(runGraph, {
        args: [githubReviewGraph, event, { tenantId: "t-ref" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-reference",
      });

      await waitFor(
        async () =>
          (await handle.query(stateQuery)).status === "awaiting_approval",
      );
      const paused = await handle.query(stateQuery);
      // trigger → diff (integration read) → review (agent) → comment (integration write)
      // all ran before the approval pause.
      expect(paused.ctx.trigger).toEqual(event);
      expect(paused.ctx.diff).toMatchObject({ status: "ok", ok: true });
      expect(paused.ctx.review).toMatchObject({ status: "ok" });
      expect(paused.ctx.comment).toMatchObject({ status: "ok" });
      // The interpreter resolved each integration node's fields from UPSTREAM outputs:
      // the diff FETCH uses get_pull_request with owner/repo/number from the trigger,
      // and the comment POST is a comment_issue write on the same PR.
      const fetchCall = integrationCalls[0];
      expect(fetchCall.cfg).toMatchObject({
        provider: "github",
        action: "get_pull_request",
      });
      expect(fetchCall.fields).toMatchObject({
        owner: "octocat",
        repo: "hello",
        pullNumber: 99,
      });
      const commentCall = integrationCalls[integrationCalls.length - 1];
      expect(commentCall.cfg).toMatchObject({
        provider: "github",
        action: "comment_issue",
      });
      expect(commentCall.fields).toMatchObject({ issueNumber: 99 });

      await handle.signal(approvalSignal, { approved: true });
      expect((await handle.result()).status).toBe("completed");
    });
  });

  it("httpRequest: exposes {status,headers,body} in ctx; a 2xx takes the success edge", async () => {
    harnessState.httpResponse = {
      status: "ok",
      httpStatus: 200,
      headers: { "content-type": "application/json" },
      body: { ok: true },
      costUsd: 0,
    };
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [httpBranchGraph, { hello: "world" }, { tenantId: "t-http" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-http-ok",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      // node output is the structured response — the graph branches on .status
      expect(result.ctx.http).toEqual({
        status: 200,
        headers: { "content-type": "application/json" },
        body: { ok: true },
      });
      // success edge (<400) was taken → the error-path agent never ran
      expect(result.ctx.errAgent).toBeUndefined();
    });
  });

  it("httpRequest: a >=400 status routes down the error edge (branching on .status)", async () => {
    harnessState.httpResponse = {
      status: "ok",
      httpStatus: 503,
      headers: {},
      body: { error: "unavailable" },
      costUsd: 0,
    };
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [httpBranchGraph, {}, { tenantId: "t-http-err" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-http-err",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(result.ctx.http).toMatchObject({ status: 503 });
      // ≥400 edge was taken → the error-path agent ran
      expect(result.ctx.errAgent).toMatchObject({ status: "ok" });
    });
  });

  it("sqlQuery: resolves params from upstream + exposes {rows,rowCount} in ctx", async () => {
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [sqlGraph, { userId: 7 }, { tenantId: "t-sql" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-sql",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(result.ctx.lookup).toEqual({
        rows: [{ id: 7, email: "a@b.co" }],
        rowCount: 1,
      });
      // the $1 param was resolved from the trigger's userId (binding, not the sql text)
      const call = sqlCalls[sqlCalls.length - 1];
      expect(call.sql).toBe("SELECT id, email FROM users WHERE id = $1");
      expect(call.params).toEqual([7]);
    });
  });

  it("sqlExec: runs the write + exposes {rowsAffected}; params bound like sqlQuery", async () => {
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [sqlExecGraph, { userId: 7 }, { tenantId: "t-sqlexec" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-sqlexec",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(result.ctx.write).toEqual({ rowsAffected: 2 });
      const call = sqlExecCalls[sqlExecCalls.length - 1];
      expect(call.sql).toBe("UPDATE users SET seen = true WHERE id = $1");
      expect(call.params).toEqual([7]); // bound from trigger.userId, not the SQL text
    });
  });

  it("firestoreQuery: dispatches the node + exposes {documents,count,truncated} in ctx", async () => {
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [firestoreQueryGraph, { userId: "ada" }, { tenantId: "t-fsq" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-firestore-query",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      // NODE_HANDLERS is a Partial<Record<>> with a trailing `return null`, so a missing
      // handler makes the node a SILENT no-op that still reports "completed". Asserting
      // the ctx output — not just the run status — is what catches that.
      expect(result.ctx.lookup).toEqual({
        documents: [
          { id: "ada", name: "…/users/ada", data: { email: "a@b.co" } },
        ],
        count: 1,
        truncated: false,
      });
      // The documentId was bound from the trigger, not hard-coded in the config.
      const call = firestoreQueryCalls[firestoreQueryCalls.length - 1];
      expect(call.documentId).toBe("ada");
      expect(call.action).toBe("get");
      expect(call.collection).toBe("users");
    });
  });

  it("firestoreWrite: dispatches the write + binds a document FIELD from upstream", async () => {
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [firestoreWriteGraph, { userId: 42 }, { tenantId: "t-fsw" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-firestore-write",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(result.ctx.write).toEqual({
        name: "projects/p/databases/(default)/documents/users/ada",
        documentId: "ada",
        deleted: false,
      });
      const call = firestoreWriteCalls[firestoreWriteCalls.length - 1];
      // A `data.*` binding fills one document field and leaves the static ones alone —
      // the same binding shape httpRequest uses for `body.*`.
      expect(call.data).toEqual({
        email: "static@example.com",
        userId: 42,
      });
      expect(call.action).toBe("set");
    });
  });

  it("set: builds its output object from static fields + upstream bindings (pure, no activity)", async () => {
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [setGraph, { userId: "u-42" }, { tenantId: "t-set" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-set",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      // output IS the built object; the binding filled userId from the trigger
      expect(result.ctx.shape).toEqual({ status: "reviewed", userId: "u-42" });
    });
  });

  it("executeSubWorkflow: runs the child, exposes {status,ctx}, and meters child cost into the parent", async () => {
    subResolveCalls.length = 0;
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          subParentGraph,
          { message: "go" },
          { tenantId: "t-sub", environmentId: "e-sub" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-subworkflow",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      // the child graph was resolved by workflowKey (in the activity) AND in the PARENT's env — a
      // sub-workflow inherits its parent's environment (Slice 5b).
      expect(subResolveCalls[subResolveCalls.length - 1]).toEqual({
        tenantId: "t-sub",
        environmentId: "e-sub",
        workflowKey: "child-flow",
      });
      // the node output exposes the child's terminal status + its ctx
      const sub = result.ctx.sub as {
        status: string;
        output: Record<string, unknown>;
        childRunId?: string;
      };
      expect(sub.status).toBe("completed");
      // #960: …and the child's workflowId, so the Run Detail can LINK to the child run.
      // Asserted by RESOLVING it rather than by matching the id format: the whole reason
      // the worker returns the id (instead of the SPA rebuilding
      // `<parentId>-sub-<nodeId>-<step>`) is that it must keep addressing a real run even
      // if that format changes. parentExecution proves it's THIS run's child.
      expect(typeof sub.childRunId).toBe("string");
      const childDesc = await env.client.workflow
        .getHandle(sub.childRunId as string)
        .describe();
      expect(childDesc.workflowId).toBe(sub.childRunId);
      expect(childDesc.parentExecution?.workflowId).toBe("e2e-subworkflow");
      expect(sub.output.worker).toMatchObject({ status: "ok" });
      // internal bookkeeping keys are NOT copied into the parent (bounded payload)
      expect(sub.output.__input).toBeUndefined();
      expect(sub.output.__costUsd).toBeUndefined();
      // the child's agent cost (mock 0.01) was metered into the PARENT budget
      expect(result.ctx.__costUsd).toBeCloseTo(0.01, 5);
    });
  });

  it("executeSubWorkflow: a `start`-entered child can BIND to the input its parent passed", async () => {
    // The reported bug: "a flow triggering a sub flow — the data is not being passed correctly
    // between the workflows". It was arriving (the child's `__input`) but had no node id to be
    // read by, because `start` — unlike every other entry node — published nothing to ctx. So a
    // binding the canvas offers (upstreamOf lists entry nodes) silently resolved to undefined.
    subResolveCalls.length = 0;
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          subStartParentGraph,
          { id: "NAARY-42" },
          { tenantId: "t-sub", environmentId: "e-sub" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-subworkflow-start-input",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      const sub = result.ctx.sub as {
        status: string;
        output: Record<string, unknown>;
      };
      expect(sub.status).toBe("completed");
      // The start node's own output IS the input the parent passed (static `input` merged with
      // the `inputBindings` read off the parent's trigger).
      expect(sub.output.start).toEqual({
        nested: { user: "u-42" },
        ticketId: "NAARY-42",
      });
      // …and, the actual point: a downstream child node BOUND to it reads real values. Both of
      // these were `undefined` before the fix, which is what the user saw.
      expect(sub.output.shape).toEqual({ ticket: "NAARY-42", who: "u-42" });
    });
  });

  it("executeSubWorkflow: refuses to launch past the nesting cap (circuit_open, child never resolved)", async () => {
    subResolveCalls.length = 0;
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      // Start already at the max depth → the node trips the guard before any I/O.
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          subParentGraph,
          { message: "go" },
          { tenantId: "t-depth", subWorkflowDepth: 5 },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-subworkflow-depth",
      });
      const result = await handle.result();
      expect(result.status).toBe("circuit_open");
      // guard fired BEFORE resolving/launching the child
      expect(subResolveCalls).toHaveLength(0);
      expect(result.ctx.sub).toBeUndefined();
    });
  });

  it("executeSubWorkflow: a child that ends non-completed surfaces as a branchable status (parent doesn't crash)", async () => {
    const rejectParentGraph: GraphDef = {
      startNodeId: "trigger",
      nodes: [
        { id: "trigger", type: "webhookTrigger" },
        {
          id: "sub",
          type: "executeSubWorkflow",
          config: { workflowKey: "reject-flow" },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "trigger", to: "sub" },
        { from: "sub", to: "end" },
      ],
    };
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [rejectParentGraph, { message: "go" }, { tenantId: "t-sub-rej" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-subworkflow-reject",
      });
      const result = await handle.result();
      // the child ended non-completed, but the PARENT completed — the child's
      // terminal status is exposed (branchable), not propagated as a parent failure
      expect(result.status).toBe("completed");
      expect((result.ctx.sub as { status: string }).status).toBe(
        "invalid_graph",
      );
    });
  });

  it("wait: pauses on a durable timer, then completes", async () => {
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [waitGraph, { hi: 1 }, { tenantId: "t-wait" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-wait",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
    });
  });

  it("stopAndError: fails the run at the Temporal level with the configured message", async () => {
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [stopGraph, {}, { tenantId: "t-stop" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-stop",
      });
      // The node throws a non-retryable ApplicationFailure → the workflow FAILS
      // (result() rejects). The configured message rides in the underlying
      // ApplicationFailure (WorkflowFailedError.cause), not the top-level error.
      const err = await handle.result().then(
        () => {
          throw new Error("expected the run to fail");
        },
        (e: unknown) => e as { cause?: { message?: string } },
      );
      expect(err.cause?.message).toMatch(/halt: bad input/);
      // the failure fired a best-effort run_failed notification for the tenant
      const notice = notifyCalls.find(
        (n) => n.kind === "run_failed" && n.tenantId === "t-stop",
      );
      expect(notice).toBeTruthy();
      // …carrying WHAT went wrong (#987). This used to be the literal "failed", which only
      // restated the "❌ Run failed" header while the real message, the failure type and the
      // failing node all sat in the workflow and were thrown away.
      expect(notice?.detail).toMatch(/halt: bad input/);
      expect(notice?.errorType).toBe("STOP_AND_ERROR");
      expect(notice?.failedNodeId).toBe("boom");
    });
  });

  it("merge (array): joins parallel branches once, combining their outputs in edge order", async () => {
    const before = agentCalls.filter((c) => c.nodeId === "after").length;
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [diamondGraph("array"), {}, { tenantId: "t-merge" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-merge-array",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      // combined output = [parentA, parentB] in declared inbound-edge order
      expect(result.ctx.join).toEqual([{ a: 1 }, { b: 2 }]);
      // the post-merge agent ran EXACTLY ONCE — the join didn't duplicate downstream
      const after = agentCalls.filter((c) => c.nodeId === "after").length;
      expect(after - before).toBe(1);
      expect(result.ctx.after).toMatchObject({ status: "ok" });
    });
  });

  it("merge (object): combines the inbound parents' outputs into one object", async () => {
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [diamondGraph("object"), {}, { tenantId: "t-merge-obj" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-merge-object",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(result.ctx.join).toEqual({ a: 1, b: 2 });
    });
  });

  it("merge: waits for a genuinely-async inbound branch (agent) before firing", async () => {
    // One branch runs an agent (real activity await), the other is pure — the join
    // must wait for the slow branch, not fire on lucky microtask ordering.
    const asyncDiamond: GraphDef = {
      startNodeId: "trigger",
      nodes: [
        { id: "trigger", type: "webhookTrigger" },
        {
          id: "slow",
          type: "agent",
          config: { provider: "anthropic", model: "claude-opus-4-8" },
        },
        { id: "fast", type: "set", config: { fields: { b: 2 } } },
        { id: "join", type: "merge", config: { mode: "array" } },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "trigger", to: "slow" },
        { from: "trigger", to: "fast" },
        { from: "slow", to: "join" },
        { from: "fast", to: "join" },
        { from: "join", to: "end" },
      ],
    };
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [asyncDiamond, {}, { tenantId: "t-merge-async" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-merge-async",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      // join[0] = the agent branch's output, join[1] = the pure branch's
      const join = result.ctx.join as unknown[];
      expect(join[0]).toMatchObject({ status: "ok" });
      expect(join[1]).toEqual({ b: 2 });
    });
  });

  it("merge: a stranded join (one inbound branch gated off upstream) fails invalid_graph, not silent success", async () => {
    // Both edges INTO the merge are unconditional (validateGraph passes), but a
    // conditional edge UPSTREAM routes only one branch — so the merge gets 1 of 2
    // arrivals and never fires. This must NOT report a clean completion.
    const strandedGraph: GraphDef = {
      startNodeId: "trigger",
      nodes: [
        { id: "trigger", type: "webhookTrigger" },
        { id: "a", type: "set", config: { fields: { a: 1 } } },
        { id: "b", type: "set", config: { fields: { b: 2 } } },
        { id: "join", type: "merge" },
        { id: "end", type: "end" },
      ],
      edges: [
        {
          from: "trigger",
          to: "a",
          condition: { path: "__input.go", op: "eq", value: true },
        },
        {
          from: "trigger",
          to: "b",
          condition: { path: "__input.go", op: "eq", value: false },
        },
        { from: "a", to: "join" },
        { from: "b", to: "join" },
        { from: "join", to: "end" },
      ],
    };
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [strandedGraph, { go: true }, { tenantId: "t-merge-strand" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-merge-strand",
      });
      const result = await handle.result();
      // only branch A fired → merge stranded at 1/2 → surfaced, not "completed"
      expect(result.status).toBe("invalid_graph");
      expect(result.ctx.join).toBeUndefined();
    });
  });

  it("renameKeys + dateTime: reshape keys (pure) then timestamp math (activity)", async () => {
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          transformGraph,
          { user_id: "u-9", email: "x@y.co", secret: "hide", ts: 1_000_000 },
          { tenantId: "t-transform" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-transform",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      // renameKeys: user_id→userId, dropped secret, kept email + ts (unmapped)
      expect(result.ctx.renamed).toEqual({
        userId: "u-9",
        email: "x@y.co",
        ts: 1_000_000,
      });
      // dateTime: base 1_000_000 + 60s = 1_060_000 ms
      expect(result.ctx.when).toMatchObject({ epochMs: 1_060_000 });
    });
  });

  it("hmac + jwt: sign payload then mint a token (keys resolved in-activity)", async () => {
    hmacCalls.length = 0;
    jwtCalls.length = 0;
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          signingGraph,
          { body: { amount: 5 }, userId: "u-7" },
          { tenantId: "t-sign" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-signing",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      // hmac received the RAW bound payload (stringify happens in-activity); output
      // is just the digest (no key)
      expect(hmacCalls[0]).toMatchObject({
        connectionId: "sign-1",
        payload: { amount: 5 },
      });
      expect(result.ctx.sig).toEqual({ digest: 'digest({"amount":5})' });
      // jwt resolved the `sub` claim from the trigger; output is the token
      expect(jwtCalls[0].claims).toMatchObject({ sub: "u-7" });
      expect(result.ctx.tok).toEqual({ token: "jwt.token.sig" });
    });
  });

  it("sendEmail: resolves recipient from upstream + exposes messageId (URI in-activity)", async () => {
    emailCalls.length = 0;
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [emailGraph, { email: "user@corp.co" }, { tenantId: "t-email" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-email",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      // the `to` field was resolved from the trigger; only connectionId (no URI)
      expect(emailCalls[0]).toMatchObject({
        connectionId: "smtp-1",
        to: "user@corp.co",
        subject: "done",
      });
      expect(result.ctx.notify).toEqual({ messageId: "<sent@test>" });
    });
  });

  it("sendEmail with templateId: renders the loaded blocks against ctx (readable html, not a dump)", async () => {
    emailCalls.length = 0;
    // The referenced template's blocks are loaded in-activity (mocked) and rendered by the handler.
    harnessState.loadTemplateResult = {
      subject: "Hi {{ trigger.name }}",
      blocks: [
        {
          id: "h",
          type: "heading",
          level: 1,
          text: "Order {{ trigger.order }}",
        },
        { id: "t", type: "text", html: "<p>Thanks, {{ trigger.name }}.</p>" },
      ],
    };
    const templateGraph: GraphDef = {
      startNodeId: "trigger",
      nodes: [
        { id: "trigger", type: "webhookTrigger" },
        {
          id: "notify",
          type: "sendEmail",
          config: {
            connectionId: "smtp-1",
            subject: "INLINE",
            text: "INLINE BODY",
            templateId: "tmpl-1",
            fieldBindings: { to: { from: "trigger", path: "email" } },
          },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "trigger", to: "notify" },
        { from: "notify", to: "end" },
      ],
    };
    const worker = await makeWorker(env);
    try {
      await worker.runUntil(async () => {
        const handle = await env.client.workflow.start(runGraph, {
          args: [
            templateGraph,
            { email: "a@b.co", name: "Ada", order: 42 },
            { tenantId: "t-email" },
          ],
          taskQueue: TASK_QUEUE,
          workflowId: "e2e-email-template",
        });
        const result = await handle.result();
        expect(result.status).toBe("completed");
        const sent = emailCalls[0];
        // the template subject + body override the inline ones, rendered against ctx
        expect(sent.subject).toBe("Hi Ada");
        expect(sent.html).toContain("<h1>Order 42</h1>");
        expect(sent.html).toContain("<p>Thanks, Ada.</p>");
        // the inline plain-text body is dropped — the template html IS the body
        expect(sent.text).toBeUndefined();
      });
    } finally {
      harnessState.loadTemplateResult = null; // don't leak into other specs
    }
  });

  it("totp: generates a code from the signing connection (seed + clock in-activity)", async () => {
    totpCalls.length = 0;
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [totpGraph, {}, { tenantId: "t-totp" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-totp",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(totpCalls[0]).toMatchObject({ connectionId: "sign-1", digits: 6 });
      expect(result.ctx.code).toEqual({ code: "123456" });
    });
  });
});

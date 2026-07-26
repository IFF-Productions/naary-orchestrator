import * as path from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TASK_QUEUE } from "@naary/contracts";
import { handoffOutputSchema, supervisorHandoffGraph } from "@naary/dsl";
import type { AgentHandoff, GraphDef } from "@naary/dsl";
import type * as activities from "../src/temporal/activities";
import { runGraph } from "../src/temporal/workflows";
import { createLocalTestEnv } from "./local-test-env";

/**
 * Multi-agent supervisor → specialist handoff (#580 Phase 1), end to end through the REAL
 * interpreter (`runGraph`), with the model call mocked so it stays hermetic.
 *
 * What this pins down is the load-bearing claim of the whole design: routing to one of N
 * agents needs NO new engine primitive and NO interpreter change. The supervisor's choice
 * is produced in an activity, lands in ctx as ordinary structured output, and the existing
 * conditional-edge walk (`nextNodes` → `evaluateCondition`) does the rest — which is why
 * the workflow stays deterministic and no `wf.patched()` gate was needed.
 *
 * It also proves the thing a broken handoff would get wrong: exactly ONE specialist runs.
 */

const WORKFLOWS_PATH = path.join(__dirname, "../src/temporal/workflows.ts");

/** Which target the mocked supervisor picks; set per test. */
let chosenTarget = "technical_specialist";
/** Every (nodeId, config) the interpreter handed to runAgent, in order. */
let agentRuns: { nodeId: string; cfg: activities.AgentConfig }[] = [];

const mockActivities = {
  runAgent: async (
    cfg: activities.AgentConfig,
    _input: unknown,
    meta: activities.AgentMeta,
  ): Promise<activities.AgentResult> => {
    agentRuns.push({ nodeId: meta.nodeId, cfg });
    // The supervisor is the node that declares a handoff — answer in the DERIVED shape.
    if (cfg.handoff) {
      return {
        status: "ok",
        output: {
          target: chosenTarget,
          reason: "the request names an HTTP 500 on checkout",
          payload: { question: "Why does checkout 500?", customerTier: "pro" },
        },
        model: cfg.model,
        costUsd: 0.02,
        totalTokens: 120,
      };
    }
    // A specialist: free text, like a schema-less agent.
    return {
      status: "ok",
      output: { text: `handled by ${meta.nodeId}` },
      model: cfg.model,
      costUsd: 0.01,
      totalTokens: 80,
    };
  },
  recordExecution: async (): Promise<void> => undefined,
  setExecutionStatus: async (): Promise<void> => undefined,
  loadVariables: async (): Promise<Record<string, string>> => ({}),
};

let env: TestWorkflowEnvironment;
beforeAll(async () => {
  env = await createLocalTestEnv();
}, 60_000);
afterAll(async () => env?.teardown());
beforeEach(() => {
  agentRuns = [];
  chosenTarget = "technical_specialist";
});

function makeWorker(): Promise<Worker> {
  return Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: WORKFLOWS_PATH,
    activities: mockActivities,
  });
}

async function run(
  graph: GraphDef,
  workflowId: string,
): Promise<{ status: string; ctx: Record<string, unknown> }> {
  const worker = await makeWorker();
  let result!: { status: string; ctx: Record<string, unknown> };
  await worker.runUntil(async () => {
    const handle = await env.client.workflow.start(runGraph, {
      args: [
        graph,
        { message: "Checkout returns a 500 for pro accounts." },
        { tenantId: "t-handoff" },
      ],
      taskQueue: TASK_QUEUE,
      workflowId,
    });
    result = (await handle.result()) as {
      status: string;
      ctx: Record<string, unknown>;
    };
  });
  return result;
}

describe("interpreter — multi-agent handoff (#580)", () => {
  it("routes to the ONE specialist the supervisor chose, and runs no other", async () => {
    chosenTarget = "technical_specialist";
    const res = await run(supervisorHandoffGraph, "wf-handoff-tech");

    expect(res.status).toBe("completed");
    // The supervisor ran, then exactly one specialist. Not two, not all three: an
    // unconditional target edge (the mistake the save-gate refuses) would show up here as
    // three specialist runs and three times the bill.
    expect(agentRuns.map((r) => r.nodeId)).toEqual(["supervisor", "technical"]);
  });

  it("routes to a DIFFERENT specialist purely from the supervisor's output", async () => {
    // Same graph, same edges — only the model's choice changed. That's the point: routing
    // is data, not code.
    chosenTarget = "billing_specialist";
    const res = await run(supervisorHandoffGraph, "wf-handoff-billing");

    expect(res.status).toBe("completed");
    expect(agentRuns.map((r) => r.nodeId)).toEqual(["supervisor", "billing"]);
  });

  it("hands the supervisor's typed payload to the chosen specialist", async () => {
    // The specialist's prompt embeds `{{ supervisor.output.payload }}`, resolved by
    // resolveTemplates in DETERMINISTIC workflow code before the activity is called — so
    // the brief reaches the specialist without any new plumbing.
    chosenTarget = "billing_specialist";
    await run(supervisorHandoffGraph, "wf-handoff-payload");

    const specialist = agentRuns.find((r) => r.nodeId === "billing");
    expect(specialist?.cfg.systemPrompt).toContain("Why does checkout 500?");
    expect(specialist?.cfg.systemPrompt).not.toContain("{{");
  });

  it("passes the handoff declaration through to the activity untouched", async () => {
    // The interpreter must not need to understand `handoff` — it forwards the node config
    // and the ACTIVITY derives the schema. This asserts the config survived the hop, and
    // that the schema the activity would derive is the enum of the declared names.
    await run(supervisorHandoffGraph, "wf-handoff-cfg");

    const supervisor = agentRuns.find((r) => r.nodeId === "supervisor");
    const handoff = supervisor?.cfg.handoff as AgentHandoff;
    expect(handoff.targets.map((t) => t.to)).toEqual([
      "billing",
      "technical",
      "general",
    ]);
    const schema = handoffOutputSchema(handoff) as {
      properties: { target: { enum: string[] } };
    };
    expect(schema.properties.target.enum).toEqual([
      "billing_specialist",
      "technical_specialist",
      "general_specialist",
    ]);
  });

  it("bills every agent that ran, and accumulates their cost on the run", async () => {
    // Per-agent attribution (#580 AC): each specialist is an ordinary node, so each gets
    // its own metered activity call — and the run's total is their sum, not a flat crew fee.
    // (The ledger ROW per nodeId is asserted in agent.activity.spec.ts, where recordUsage
    // is reachable; here the run-level accumulation is what the interpreter owns.)
    const res = await run(supervisorHandoffGraph, "wf-handoff-cost");
    // supervisor 0.02 + exactly one specialist 0.01 (three specialists would be 0.05)
    expect(res.ctx.__costUsd as number).toBeCloseTo(0.03, 9);
    expect(new Set(agentRuns.map((r) => r.nodeId)).size).toBe(agentRuns.length);
  });

  it("ends the run cleanly when the model picks a target with no live branch", async () => {
    // Defence in depth. The derived enum makes this unreachable in practice (the provider
    // constrains generation), but if a target ever arrived that matched no edge, the walk
    // must simply stop — not hang, not throw.
    chosenTarget = "not_a_specialist";
    const res = await run(supervisorHandoffGraph, "wf-handoff-nomatch");
    expect(res.status).toBe("completed");
    expect(agentRuns.map((r) => r.nodeId)).toEqual(["supervisor"]);
  });
});

import { randomUUID } from "node:crypto";
import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { Client, Connection } from "@temporalio/client";
import {
  approvalSignal,
  RUN_GRAPH_WORKFLOW,
  stateQuery,
  TASK_QUEUE,
  type ExecutionState,
} from "@naary/contracts";
import { sampleGraph } from "@naary/dsl";
import type { GraphDef } from "@naary/dsl";
import { getBudget } from "@naary/usage";
import { connectTemporal } from "../temporal/client";

/** Circuit breaker default when a tenant has no budget configured (safety net). */
const DEFAULT_MAX_STEPS_PER_RUN = 50;

/**
 * Wraps the Temporal client: start an execution, signal approval, query state.
 * The client connects once at boot and closes on shutdown (a per-request
 * connection would pass the curl flow but leak connections).
 *
 * The workflow is started by its registered NAME (RUN_GRAPH_WORKFLOW), not by
 * importing runGraph from @naary/worker — that keeps the api decoupled from the
 * worker bundle; Temporal sends the name over the wire either way.
 */
@Injectable()
export class ExecutionsService implements OnModuleInit, OnModuleDestroy {
  private client!: Client;
  private connection!: Connection;

  async onModuleInit(): Promise<void> {
    const { client, connection } = await connectTemporal();
    this.client = client;
    this.connection = connection;
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection?.close();
  }

  async start(tenantId: string): Promise<{ workflowId: string }> {
    return this.startGraph(
      `exec-${tenantId}`,
      sampleGraph,
      { message: "I was charged twice this month" },
      tenantId,
    );
  }

  /** Start a webhook-triggered run; the verified event becomes the trigger output.
   *  The graph is resolved from the endpoint's workflowId by the caller (so the
   *  github-review reference flow is reachable, not just the default graph). */
  async startWebhook(
    tenantId: string,
    graph: GraphDef,
    event: unknown,
  ): Promise<{ workflowId: string }> {
    return this.startGraph(`wh-${tenantId}`, graph, event, tenantId);
  }

  private async startGraph(
    prefix: string,
    graph: GraphDef,
    input: unknown,
    tenantId: string,
  ): Promise<{ workflowId: string }> {
    const workflowId = `${prefix}-${randomUUID()}`;

    // Snapshot the tenant's caps at start and pass them as workflow args, so the
    // workflow enforces deterministically (no DB read in workflow code). The
    // circuit breaker always applies (default when no budget); the per-execution
    // cost cap applies only when a budget is set.
    const budget = await getBudget(tenantId);

    // tenantId rides in workflow args (not a secret); the agent activity fetches
    // the tenant's provider key by tenantId, inside the activity.
    await this.client.workflow.start(RUN_GRAPH_WORKFLOW, {
      args: [
        graph,
        input,
        {
          tenantId,
          perExecutionCapUsd: budget?.perExecutionCapUsd,
          maxStepsPerRun: budget?.maxStepsPerRun ?? DEFAULT_MAX_STEPS_PER_RUN,
        },
      ],
      taskQueue: TASK_QUEUE,
      workflowId,
    });
    return { workflowId };
  }

  async approve(id: string, approved: boolean): Promise<void> {
    await this.client.workflow
      .getHandle(id)
      .signal(approvalSignal, { approved });
  }

  async getState(id: string): Promise<ExecutionState> {
    return this.client.workflow.getHandle(id).query(stateQuery);
  }
}

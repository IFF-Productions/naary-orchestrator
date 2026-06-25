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
import { connectTemporal } from "../temporal/client";

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
    const workflowId = `exec-${tenantId}-${randomUUID()}`;
    // tenantId rides in workflow args (not a secret); the agent activity fetches
    // the tenant's provider key by tenantId, inside the activity.
    await this.client.workflow.start(RUN_GRAPH_WORKFLOW, {
      args: [
        sampleGraph,
        { message: "I was charged twice this month" },
        { tenantId },
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

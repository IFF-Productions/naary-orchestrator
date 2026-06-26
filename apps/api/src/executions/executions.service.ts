import { randomUUID } from "node:crypto";
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import {
  type Client,
  type Connection,
  WorkflowNotFoundError,
} from "@temporalio/client";
import {
  approvalSignal,
  RUN_GRAPH_WORKFLOW,
  stateQuery,
  TASK_QUEUE,
  type ExecutionState,
} from "@naary/contracts";
import { getPrisma } from "@naary/db";
import { getBudget } from "@naary/usage";
import { type GraphSnapshot, GraphsService } from "../graphs/graphs.service";
import { connectTemporal } from "../temporal/client";

/** Circuit breaker default when a tenant has no budget configured (safety net). */
const DEFAULT_MAX_STEPS_PER_RUN = 50;

/** workflowKey of the demo graph that POST /executions starts. */
const DEFAULT_WORKFLOW_KEY = "default";

/**
 * Wraps the Temporal client: start an execution, signal approval, query state.
 * The client connects once at boot and closes on shutdown.
 *
 * Every run is recorded as an `Execution { workflowId, tenantId }` so the control
 * plane can authorize `approve`/`getState` against the caller's tenant — a raw
 * workflowId is never enough to act on a run.
 */
@Injectable()
export class ExecutionsService implements OnModuleInit, OnModuleDestroy {
  private client!: Client;
  private connection!: Connection;

  constructor(private readonly graphs: GraphsService) {}

  async onModuleInit(): Promise<void> {
    const { client, connection } = await connectTemporal();
    this.client = client;
    this.connection = connection;
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection?.close();
  }

  /** Manual start. `tenantId` comes from the authenticated principal (not the body);
   *  the graph is the tenant's current "default" version (must be seeded). */
  async start(
    tenantId: string,
    input?: Record<string, unknown>,
  ): Promise<{ workflowId: string }> {
    const snapshot = await this.graphs.getLatest(
      tenantId,
      DEFAULT_WORKFLOW_KEY,
    );
    if (!snapshot) {
      throw new NotFoundException(
        `No '${DEFAULT_WORKFLOW_KEY}' graph for this tenant — seed one first`,
      );
    }
    return this.startGraph(
      `exec-${tenantId}`,
      snapshot,
      input ?? { message: "I was charged twice this month" },
      tenantId,
    );
  }

  /** Start a webhook-triggered run; the verified event becomes the trigger output.
   *  The caller resolved + snapshotted the graph from the DB. */
  async startWebhook(
    tenantId: string,
    snapshot: GraphSnapshot,
    event: unknown,
  ): Promise<{ workflowId: string }> {
    return this.startGraph(`wh-${tenantId}`, snapshot, event, tenantId);
  }

  private async startGraph(
    prefix: string,
    snapshot: GraphSnapshot,
    input: unknown,
    tenantId: string,
  ): Promise<{ workflowId: string }> {
    const workflowId = `${prefix}-${randomUUID()}`;
    const budget = await getBudget(tenantId);

    // Pass the immutable graph SNAPSHOT (bytes that existed now); the content hash
    // + version ride in the workflow ctx (history) and a Temporal memo so the run
    // is traceable to its exact version and a later edit can't change it.
    await this.client.workflow.start(RUN_GRAPH_WORKFLOW, {
      args: [
        snapshot.graph,
        input,
        {
          tenantId,
          perExecutionCapUsd: budget?.perExecutionCapUsd,
          maxStepsPerRun: budget?.maxStepsPerRun ?? DEFAULT_MAX_STEPS_PER_RUN,
          graphContentHash: snapshot.contentHash,
          graphVersion: snapshot.version,
        },
      ],
      taskQueue: TASK_QUEUE,
      workflowId,
      memo: {
        graphContentHash: snapshot.contentHash,
        graphVersion: snapshot.version,
      },
    });

    // Record ownership so approve/getState can be authorized by tenant.
    await getPrisma().execution.create({ data: { workflowId, tenantId } });
    return { workflowId };
  }

  async approve(
    id: string,
    approved: boolean,
    tenantId: string,
  ): Promise<void> {
    await this.assertOwner(id, tenantId);
    await this.client.workflow
      .getHandle(id)
      .signal(approvalSignal, { approved });
  }

  async getState(id: string, tenantId: string): Promise<ExecutionState> {
    await this.assertOwner(id, tenantId);
    try {
      return await this.client.workflow.getHandle(id).query(stateQuery);
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) {
        throw new NotFoundException("Execution not found");
      }
      throw e;
    }
  }

  /** 404 if the execution is unknown, 403 if it belongs to another tenant. */
  private async assertOwner(
    workflowId: string,
    tenantId: string,
  ): Promise<void> {
    const row = await getPrisma().execution.findUnique({
      where: { workflowId },
    });
    if (!row) throw new NotFoundException("Execution not found");
    if (row.tenantId !== tenantId) {
      throw new ForbiddenException("Execution belongs to another tenant");
    }
  }
}

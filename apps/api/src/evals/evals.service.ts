import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { Client, Connection } from "@temporalio/client";
import { getPrisma, Prisma } from "@naary/db";
import { EVAL_RUN_WORKFLOW, TASK_QUEUE } from "@naary/contracts";
import { getBudget } from "@naary/usage";
import { TracedClass } from "@naary/observability";
// Deep dist import: ./assertions carries zod and must not ride the worker's `@naary/dsl` surface
// (same reasoning as validateGraphConfigs in graphs.service.ts).
import {
  type EvalDatasetBody,
  evalDatasetBodySchema,
} from "@naary/dsl/dist/assertions";
import type { Principal } from "../auth/tenant.decorator";
import { connectTemporal } from "../temporal/client";
import { GraphsService } from "../graphs/graphs.service";
import {
  PermissionsService,
  type WorkflowAction,
} from "../permissions/permissions.service";

/** Cap on a stored dataset body. The whole body becomes ONE activity result that the eval workflow
 *  holds in history, so it must stay well inside Temporal's ~2MB payload limit. */
export const MAX_DATASET_BYTES = 512 * 1024;

export interface EvalDatasetView {
  id: string;
  name: string;
  caseCount: number;
  assertionCount: number;
  updatedAt: string;
}

export interface EvalRunView {
  id: string;
  datasetId: string;
  datasetName: string;
  workflowId: string;
  /** The pinned snapshot this batch measured — the promote-screen comparison key (#575 AC2). */
  graphVersion: number;
  graphContentHash: string;
  status: string;
  totalCases: number;
  passed: number;
  failed: number;
  errored: number;
  costUsd: number | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface EvalCaseResultView {
  caseName: string;
  executionId: string | null;
  verdict: string;
  score: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  /** AssertionOutcome[] — labels/booleans/scores/error codes only, never run or model content. */
  assertions: unknown;
}

/**
 * Workflow evals (#575). Golden datasets live on the `PinnedData` substrate pattern (author-owned
 * Json, env-scoped); an eval RUN is an ordinary Temporal execution of the `evalRun` workflow, which
 * launches one child `runGraph` per case and has an activity score it.
 *
 * PRIVACY: this service reads and returns verdicts, scores, cost and latency. It never reads or
 * returns the run's output or the LLM judge's prose — those never reach Postgres in the first place
 * (see `buildPersistableOutcome` in @naary/dsl/dist/assertions).
 *
 * RBAC (RBAC-GROUPS.md §4): dataset writes are `edit`, reads are `view`, starting an eval batch is
 * `run` — an eval executes the real workflow with real spend, so it is exactly a run.
 */
@Injectable()
@TracedClass()
export class EvalsService implements OnModuleInit, OnModuleDestroy {
  private client!: Client;
  private connection!: Connection;

  constructor(
    private readonly graphs: GraphsService,
    /** @Optional so bare test constructions still work; an ACTOR without wired permissions must
     *  fail CLOSED (never silently skip authz). */
    @Optional() private readonly permissions?: PermissionsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const { client, connection } = await connectTemporal();
    this.client = client;
    this.connection = connection;
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection?.close();
  }

  private async assertActor(
    actor: Principal | undefined,
    action: WorkflowAction,
    workflowKey: string,
    environmentId: string,
  ): Promise<void> {
    if (!actor) return;
    if (!this.permissions) {
      throw new Error("EvalsService: PermissionsService is not wired");
    }
    await this.permissions.assertCan(actor, action, workflowKey, environmentId);
  }

  // --- datasets --------------------------------------------------------------------------------

  async listDatasets(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
    actor?: Principal,
  ): Promise<EvalDatasetView[]> {
    await this.assertActor(actor, "view", workflowKey, environmentId);
    const rows = await getPrisma().evalDataset.findMany({
      where: { tenantId, environmentId, workflowKey },
      orderBy: { name: "asc" },
    });
    return rows.map((r) => {
      const body = r.body as unknown as EvalDatasetBody;
      return {
        id: r.id,
        name: r.name,
        caseCount: body?.cases?.length ?? 0,
        assertionCount: body?.assertions?.length ?? 0,
        updatedAt: r.updatedAt.toISOString(),
      };
    });
  }

  /** The full dataset body (cases + assertions) — the authoring view. */
  async getDataset(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
    name: string,
    actor?: Principal,
  ): Promise<EvalDatasetBody> {
    await this.assertActor(actor, "view", workflowKey, environmentId);
    const row = await getPrisma().evalDataset.findUnique({
      where: {
        tenantId_environmentId_workflowKey_name: {
          tenantId,
          environmentId,
          workflowKey,
          name,
        },
      },
    });
    if (!row) throw new NotFoundException("Eval dataset not found");
    return row.body as unknown as EvalDatasetBody;
  }

  /**
   * Create or replace a dataset. WHOLE-BODY PUT (not a patch): a case list is an ordered set the
   * author edits as a whole, and a merge could never delete a case.
   */
  async saveDataset(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
    name: string,
    body: unknown,
    actor?: Principal,
  ): Promise<EvalDatasetView> {
    await this.assertActor(actor, "edit", workflowKey, environmentId);
    const parsed = evalDatasetBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        `Invalid eval dataset — ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "dataset"} ${i.message}`)
          .join("; ")}`,
      );
    }
    const bytes = Buffer.byteLength(JSON.stringify(parsed.data), "utf8");
    if (bytes > MAX_DATASET_BYTES) {
      throw new BadRequestException(
        `Eval dataset is too large (${bytes} bytes > ${MAX_DATASET_BYTES}). The whole body rides one Temporal activity result — split it into smaller datasets.`,
      );
    }
    const value = parsed.data as unknown as Prisma.InputJsonValue;
    const row = await getPrisma().evalDataset.upsert({
      where: {
        tenantId_environmentId_workflowKey_name: {
          tenantId,
          environmentId,
          workflowKey,
          name,
        },
      },
      create: { tenantId, environmentId, workflowKey, name, body: value },
      update: { body: value },
    });
    const saved = parsed.data as EvalDatasetBody;
    return {
      id: row.id,
      name: row.name,
      caseCount: saved.cases.length,
      assertionCount: saved.assertions?.length ?? 0,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async deleteDataset(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
    name: string,
    actor?: Principal,
  ): Promise<void> {
    await this.assertActor(actor, "edit", workflowKey, environmentId);
    await getPrisma().evalDataset.deleteMany({
      where: { tenantId, environmentId, workflowKey, name },
    });
  }

  // --- runs ------------------------------------------------------------------------------------

  /**
   * Start a batch eval. Snapshots the graph the SAME way a normal run does (pinned version +
   * content hash) and records them on the `EvalRun` row, which is what lets a promote screen
   * compare "vN passed 18/20 vs vN-1 20/20" (#575 AC2).
   */
  async startRun(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
    datasetName: string,
    actor?: Principal,
  ): Promise<EvalRunView> {
    // An eval executes the real workflow with real spend → the `run` verb, not `view`.
    await this.assertActor(actor, "run", workflowKey, environmentId);

    const dataset = await getPrisma().evalDataset.findUnique({
      where: {
        tenantId_environmentId_workflowKey_name: {
          tenantId,
          environmentId,
          workflowKey,
          name: datasetName,
        },
      },
    });
    if (!dataset) throw new NotFoundException("Eval dataset not found");
    const body = dataset.body as unknown as EvalDatasetBody;
    if (!body?.cases?.length) {
      throw new BadRequestException("Eval dataset has no cases");
    }

    const snapshot = await this.graphs.getLatest(
      tenantId,
      environmentId,
      workflowKey,
    );
    if (!snapshot) {
      throw new BadRequestException(
        `No saved graph for '${workflowKey}' in this environment`,
      );
    }

    const budget = await getBudget(tenantId);
    const evalRunId = randomUUID();
    const workflowId = `eval-${evalRunId}`;

    // Row FIRST, then start: the workflow's very first activity reads this row, so it must exist
    // (and a started workflow with no row would be unattributable).
    await getPrisma().evalRun.create({
      data: {
        id: evalRunId,
        tenantId,
        environmentId,
        workflowKey,
        datasetId: dataset.id,
        workflowId,
        graphVersion: snapshot.version,
        graphContentHash: snapshot.contentHash,
        totalCases: body.cases.length,
      },
    });

    await this.client.workflow.start(EVAL_RUN_WORKFLOW, {
      args: [
        {
          tenantId,
          environmentId,
          workflowKey,
          evalRunId,
          graph: snapshot.graph,
          graphContentHash: snapshot.contentHash,
          graphVersion: snapshot.version,
          // Each CASE gets its own per-run cap (they are independent runs, not one budget split).
          perExecutionCapUsd: budget?.perExecutionCapUsd,
          maxStepsPerRun: budget?.maxStepsPerRun,
        },
      ],
      taskQueue: TASK_QUEUE,
      workflowId,
      memo: {
        graphContentHash: snapshot.contentHash,
        graphVersion: snapshot.version,
      },
    });

    return {
      id: evalRunId,
      datasetId: dataset.id,
      datasetName: dataset.name,
      workflowId,
      graphVersion: snapshot.version,
      graphContentHash: snapshot.contentHash,
      status: "running",
      totalCases: body.cases.length,
      passed: 0,
      failed: 0,
      errored: 0,
      costUsd: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
  }

  /** Eval-run history for a workflow, newest first. Each row carries graphVersion +
   *  graphContentHash, so a promote screen can compare versions without another query. */
  async listRuns(
    tenantId: string,
    environmentId: string,
    workflowKey: string,
    limit = 50,
    actor?: Principal,
  ): Promise<EvalRunView[]> {
    await this.assertActor(actor, "view", workflowKey, environmentId);
    const rows = await getPrisma().evalRun.findMany({
      where: { tenantId, environmentId, workflowKey },
      orderBy: { startedAt: "desc" },
      take: Math.min(Math.max(limit, 1), 200),
      include: { dataset: { select: { name: true } } },
    });
    return rows.map((r) => this.toRunView(r));
  }

  /** One eval run with its per-case verdicts (the drill-down). */
  async getRun(
    tenantId: string,
    evalRunId: string,
    actor?: Principal,
  ): Promise<EvalRunView & { cases: EvalCaseResultView[] }> {
    const row = await getPrisma().evalRun.findFirst({
      where: { id: evalRunId, tenantId },
      include: {
        dataset: { select: { name: true } },
        results: { orderBy: { caseName: "asc" } },
      },
    });
    if (!row) throw new NotFoundException("Eval run not found");
    // Gate on the run's OWN workflow (the same shape assertRunAccess uses for a single run).
    await this.assertActor(actor, "view", row.workflowKey, row.environmentId);
    return {
      ...this.toRunView(row),
      cases: row.results.map((c) => ({
        caseName: c.caseName,
        executionId: c.executionId,
        verdict: c.verdict,
        score: c.score === null ? null : Number(c.score),
        costUsd: c.costUsd === null ? null : Number(c.costUsd),
        latencyMs: c.latencyMs,
        assertions: c.assertions,
      })),
    };
  }

  private toRunView(r: {
    id: string;
    datasetId: string;
    dataset: { name: string };
    workflowId: string;
    graphVersion: number;
    graphContentHash: string;
    status: string;
    totalCases: number;
    passed: number;
    failed: number;
    errored: number;
    costUsd: Prisma.Decimal | null;
    startedAt: Date;
    finishedAt: Date | null;
  }): EvalRunView {
    return {
      id: r.id,
      datasetId: r.datasetId,
      datasetName: r.dataset.name,
      workflowId: r.workflowId,
      graphVersion: r.graphVersion,
      graphContentHash: r.graphContentHash,
      status: r.status,
      totalCases: r.totalCases,
      passed: r.passed,
      failed: r.failed,
      errored: r.errored,
      costUsd: r.costUsd === null ? null : Number(r.costUsd),
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    };
  }
}

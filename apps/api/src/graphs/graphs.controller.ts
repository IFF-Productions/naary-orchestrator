import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import type { GraphDef } from "@naary/dsl";
import { TenantId } from "../auth/tenant.decorator";
import { SchedulesService } from "../schedules/schedules.service";
import { GenerateGraphDto, SaveGraphDto } from "./graph.dto";
import { GraphGeneratorService } from "./graph-generator.service";
import { type GraphSummary, GraphsService } from "./graphs.service";

/**
 * Save a compiled graph from the canvas. tenantId comes from the token (never the
 * body). GraphsService.upsert content-hashes + versions it and runs validateGraph
 * (400 on a malformed graph) before it can be persisted or run.
 */
@Controller("graphs")
export class GraphsController {
  constructor(
    private readonly graphs: GraphsService,
    private readonly generator: GraphGeneratorService,
    private readonly schedules: SchedulesService,
  ) {}

  /** List the tenant's workflows (one row per workflowKey, latest version). */
  @Get()
  list(@TenantId() tenantId: string): Promise<GraphSummary[]> {
    return this.graphs.list(tenantId);
  }

  /**
   * AI workflow builder: turn a plain-English description into a DRAFT graph the
   * canvas loads unsaved. Uses the tenant's own provider key (decrypted in-request,
   * never persisted) and returns a validateGraph-checked graph — the user edits and
   * saves via POST /graphs. Not saved here.
   */
  @Post("generate")
  generate(
    @TenantId() tenantId: string,
    @Body() body: GenerateGraphDto,
  ): Promise<{ name: string; graph: GraphDef }> {
    return this.generator.generate(tenantId, body.prompt);
  }

  /** The latest graph for a workflowKey — used to open it in the canvas. */
  @Get(":workflowKey")
  async get(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
  ): Promise<{
    workflowKey: string;
    name: string;
    version: number;
    graph: GraphDef;
  }> {
    const found = await this.graphs.getLatestNamed(tenantId, workflowKey);
    if (!found) {
      throw new NotFoundException(`No graph for workflowKey '${workflowKey}'`);
    }
    return found;
  }

  /** The workflowKey of this workflow's error handler (null if none). */
  @Get(":workflowKey/error-handler")
  async getErrorHandler(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
  ): Promise<{ errorWorkflowKey: string | null }> {
    return {
      errorWorkflowKey: await this.graphs.getErrorHandler(
        tenantId,
        workflowKey,
      ),
    };
  }

  /** Bind (or clear, with null/empty) this workflow's error handler. */
  @Put(":workflowKey/error-handler")
  async setErrorHandler(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
    @Body() body: { errorWorkflowKey?: string | null },
  ): Promise<{ errorWorkflowKey: string | null }> {
    const value = body.errorWorkflowKey?.trim() || null;
    if (value === workflowKey) {
      throw new BadRequestException(
        "A workflow cannot be its own error handler",
      );
    }
    await this.graphs.setErrorHandler(tenantId, workflowKey, value);
    return { errorWorkflowKey: value };
  }

  @Post()
  async save(
    @TenantId() tenantId: string,
    @Body() body: SaveGraphDto,
  ): Promise<{ workflowKey: string; version: number; contentHash: string }> {
    const graph = toGraphDef(body.graph);
    const snap = await this.graphs.upsert(
      tenantId,
      body.workflowKey,
      body.name,
      graph,
    );
    // If this graph is a pollTrigger flow, (re)create its interval schedule so it
    // "runs on its own timer". Best-effort — a scheduling hiccup must not fail a save.
    await this.schedules
      .syncPollSchedule(tenantId, body.workflowKey, graph)
      .catch(() => undefined);
    return {
      workflowKey: body.workflowKey,
      version: snap.version,
      contentHash: snap.contentHash,
    };
  }
}

/** Guard the top-level shape so a non-graph body is a 400, not a 500 inside
 *  validateGraph (which assumes nodes/edges arrays). Deep rules are validateGraph's. */
function toGraphDef(g: Record<string, unknown>): GraphDef {
  if (
    !Array.isArray(g.nodes) ||
    !Array.isArray(g.edges) ||
    typeof g.startNodeId !== "string"
  ) {
    throw new BadRequestException(
      "graph must have { nodes: [], edges: [], startNodeId: string }",
    );
  }
  return g as unknown as GraphDef;
}

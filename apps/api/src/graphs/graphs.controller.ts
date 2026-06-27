import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import type { GraphDef } from "@naary/dsl";
import { TenantId } from "../auth/tenant.decorator";
import { SaveGraphDto } from "./graph.dto";
import { type GraphSummary, GraphsService } from "./graphs.service";

/**
 * Save a compiled graph from the canvas. tenantId comes from the token (never the
 * body). GraphsService.upsert content-hashes + versions it and runs validateGraph
 * (400 on a malformed graph) before it can be persisted or run.
 */
@Controller("graphs")
export class GraphsController {
  constructor(private readonly graphs: GraphsService) {}

  /** List the tenant's workflows (one row per workflowKey, latest version). */
  @Get()
  list(@TenantId() tenantId: string): Promise<GraphSummary[]> {
    return this.graphs.list(tenantId);
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

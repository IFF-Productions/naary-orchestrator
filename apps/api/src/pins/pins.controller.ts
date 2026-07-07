import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { isPureNode, runPureNode } from "@naary/dsl";
import { TenantId } from "../auth/tenant.decorator";
import { GraphsService } from "../graphs/graphs.service";
import { ApiEndpoint } from "../swagger/api-decorators";
import { PinsService } from "./pins.service";

/**
 * Pinned node outputs for the canvas authoring loop (design SINGLE-NODE-EXECUTION.md §5).
 * Graph-scoped by workflowKey; tenant comes from the token, never the body. Pins are authoring-only
 * — the interpreter never reads them.
 */
@ApiBearerAuth("bearer")
@Controller("graphs/:workflowKey")
export class PinsController {
  constructor(
    private readonly pins: PinsService,
    private readonly graphs: GraphsService,
  ) {}

  /**
   * Single-node "Test" (design SINGLE-NODE-EXECUTION.md slice 2): run ONE node against a mini-ctx
   * built from the workflow's pins (+ optional `inputs` override), returning its output — without
   * a full run. Only PURE nodes (set/text/if/…) run here (instant, no Temporal, no secrets);
   * activity/control nodes report `pure:false` (the Temporal path is slice 3).
   */
  @ApiEndpoint({
    summary: "Test-run a single node against pinned/sample inputs",
    notFound: true,
  })
  @Post("nodes/:nodeId/test")
  async test(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
    @Param("nodeId") nodeId: string,
    @Body() body: { inputs?: Record<string, unknown> },
  ): Promise<
    { pure: true; output: unknown } | { pure: false; message: string }
  > {
    const found = await this.graphs.getLatestNamed(tenantId, workflowKey);
    if (!found) {
      throw new NotFoundException(`No graph saved for '${workflowKey}'`);
    }
    const node = found.graph.nodes.find((n) => n.id === nodeId);
    if (!node) {
      throw new NotFoundException(`No node '${nodeId}' in this graph`);
    }
    if (!isPureNode(node.type)) {
      return {
        pure: false,
        message: `"${node.type}" runs an activity or control step — not testable inline yet. Run the full flow, or pin an upstream sample.`,
      };
    }
    // mini-ctx: the workflow's pinned outputs, overridden by any manual inputs.
    const ctx = {
      ...(await this.pins.list(tenantId, workflowKey)),
      ...(body?.inputs ?? {}),
    };
    try {
      return { pure: true, output: runPureNode(node, ctx) };
    } catch (e) {
      throw new BadRequestException(
        e instanceof Error ? e.message : "Node failed to run",
      );
    }
  }

  @ApiEndpoint({
    summary: "List a workflow's pinned node outputs",
    description: "Returns `{ [nodeId]: output }` for the canvas to overlay.",
  })
  @Get("pins")
  list(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
  ): Promise<Record<string, unknown>> {
    return this.pins.list(tenantId, workflowKey);
  }

  @ApiEndpoint({ summary: "Pin (or replace) a node's sample output" })
  @Put("nodes/:nodeId/pin")
  async set(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
    @Param("nodeId") nodeId: string,
    @Body() body: { output: unknown },
  ): Promise<{ pinned: true }> {
    await this.pins.set(tenantId, workflowKey, nodeId, body?.output);
    return { pinned: true };
  }

  @ApiEndpoint({ summary: "Clear a node's pin" })
  @Delete("nodes/:nodeId/pin")
  async clear(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
    @Param("nodeId") nodeId: string,
  ): Promise<{ cleared: boolean }> {
    return { cleared: await this.pins.clear(tenantId, workflowKey, nodeId) };
  }
}

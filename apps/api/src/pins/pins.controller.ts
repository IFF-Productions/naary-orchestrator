import { Body, Controller, Delete, Get, Param, Put } from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { TenantId } from "../auth/tenant.decorator";
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
  constructor(private readonly pins: PinsService) {}

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

import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import type { ExecutionState } from "@naary/contracts";
import { TenantId } from "../auth/tenant.decorator";
import { ApproveDto, StartExecutionDto } from "./execution.dto";
import { ExecutionsService } from "./executions.service";

@Controller("executions")
export class ExecutionsController {
  constructor(private readonly executions: ExecutionsService) {}

  @Post()
  start(
    @TenantId() tenantId: string,
    @Body() body: StartExecutionDto,
  ): Promise<{ workflowId: string }> {
    return this.executions.start(tenantId, body.input, body.workflowKey);
  }

  @Post(":id/approve")
  @HttpCode(202) // explicit: NestJS would otherwise return 201 for a POST
  async approve(
    @TenantId() tenantId: string,
    @Param("id") id: string,
    @Body() body: ApproveDto,
  ): Promise<{ accepted: true }> {
    await this.executions.approve(id, body.approved, tenantId);
    return { accepted: true };
  }

  @Get(":id")
  getState(
    @TenantId() tenantId: string,
    @Param("id") id: string,
  ): Promise<ExecutionState> {
    return this.executions.getState(id, tenantId);
  }
}

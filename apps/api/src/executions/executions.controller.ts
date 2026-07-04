import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { TenantId } from "../auth/tenant.decorator";
import { ApproveDto, StartExecutionDto } from "./execution.dto";
import {
  type AwaitingApproval,
  ExecutionsService,
  type RunEvent,
  type RunStateView,
} from "./executions.service";

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

  /** Recent runs for the authenticated tenant (newest first). */
  @Get()
  listRuns(
    @TenantId() tenantId: string,
  ): Promise<{ workflowId: string; createdAt: string }[]> {
    return this.executions.list(tenantId);
  }

  /** The tenant's runs paused for approval, each with its prompt (the inbox). Must
   *  be declared BEFORE `@Get(":id")` so "awaiting" isn't captured as an :id. */
  @Get("awaiting")
  awaiting(@TenantId() tenantId: string): Promise<AwaitingApproval[]> {
    return this.executions.listAwaiting(tenantId);
  }

  @Post(":id/approve")
  @HttpCode(202) // explicit: NestJS would otherwise return 201 for a POST
  async approve(
    @TenantId() tenantId: string,
    @Param("id") id: string,
    @Body() body: ApproveDto,
  ): Promise<{ accepted: true }> {
    await this.executions.approve(id, body.approved, tenantId, body.comment);
    return { accepted: true };
  }

  @Get(":id")
  getState(
    @TenantId() tenantId: string,
    @Param("id") id: string,
  ): Promise<RunStateView> {
    return this.executions.getState(id, tenantId);
  }

  /** The run's execution log (curated Temporal history). */
  @Get(":id/history")
  history(
    @TenantId() tenantId: string,
    @Param("id") id: string,
  ): Promise<RunEvent[]> {
    return this.executions.history(id, tenantId);
  }
}

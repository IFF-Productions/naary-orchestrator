import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import type { ExecutionState } from "@naary/contracts";
import { ExecutionsService } from "./executions.service";

@Controller("executions")
export class ExecutionsController {
  constructor(private readonly executions: ExecutionsService) {}

  @Post()
  start(): Promise<{ workflowId: string }> {
    return this.executions.start();
  }

  @Post(":id/approve")
  @HttpCode(202) // explicit: NestJS would otherwise return 201 for a POST
  async approve(
    @Param("id") id: string,
    @Body() body: { approved: boolean },
  ): Promise<{ accepted: true }> {
    await this.executions.approve(id, body.approved);
    return { accepted: true };
  }

  @Get(":id")
  getState(@Param("id") id: string): Promise<ExecutionState> {
    return this.executions.getState(id);
  }
}

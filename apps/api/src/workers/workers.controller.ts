import { Controller, ForbiddenException, Get } from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { CurrentPrincipal, type Principal } from "../auth/tenant.decorator";
import { ApiEndpoint } from "../swagger/api-decorators";
import { WorkerResponse } from "./worker.response";
import { WorkersService } from "./workers.service";

/**
 * Worker fleet registry (Queue-mode / Worker view). Operator-only: this is INFRA telemetry (which
 * replicas are connected + their live slot usage), not tenant data — so it's gated to owner/admin,
 * not scoped by tenant. Fed by each worker's direct-DB heartbeat (WorkerHeartbeat).
 */
@ApiBearerAuth("bearer")
@Controller("workers")
export class WorkersController {
  constructor(private readonly workers: WorkersService) {}

  @ApiEndpoint({
    summary: "List worker replicas",
    description:
      "The connected worker fleet with live slot usage (activeActivities/maxActivities), version, and online/stale. Owner/admin only.",
    ok: [WorkerResponse],
  })
  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
  ): Promise<WorkerResponse[]> {
    // Fleet/infra data is operator-only (mirrors tokens.controller's owner/admin gate).
    if (principal.role !== "owner" && principal.role !== "admin") {
      throw new ForbiddenException(
        "Only workspace owners or admins can view the worker fleet.",
      );
    }
    return this.workers.list();
  }
}

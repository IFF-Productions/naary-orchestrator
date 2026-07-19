import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { EnvironmentSel } from "../auth/tenant.decorator";
import { EnvironmentsService } from "../environments/environments.service";
import { ApiEndpoint } from "../swagger/api-decorators";
import { CreateScheduleDto, PauseScheduleDto } from "./schedule.dto";
import { AcceptedResponse, ScheduleResponse } from "./schedule.response";
import { type ScheduleView, SchedulesService } from "./schedules.service";

/** Per-tenant recurring schedules, scoped to the caller's ACTIVE environment
 *  (X-Environment-Id → the tenant's default env when absent). Path tenant is enforced
 *  == token tenant by the global AuthGuard (the /tenants/:id/... rule). */
@ApiBearerAuth("bearer")
@Controller("tenants/:id/schedules")
export class SchedulesController {
  constructor(
    private readonly schedules: SchedulesService,
    private readonly environments: EnvironmentsService,
  ) {}

  @ApiEndpoint({
    summary: "List schedules",
    description: "The active environment's recurring schedules.",
    ok: [ScheduleResponse],
  })
  @Get()
  async list(
    @Param("id") tenantId: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<ScheduleView[]> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.schedules.list(tenantId, envId);
  }

  @ApiEndpoint({
    summary: "Create a schedule",
    description:
      "Creates a cron-backed recurring run for a workflow in the active environment.",
    created: ScheduleResponse,
  })
  @Post()
  async create(
    @Param("id") tenantId: string,
    @Body() body: CreateScheduleDto,
    @EnvironmentSel() envSel?: string,
  ): Promise<ScheduleView> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.schedules.create(tenantId, envId, body.workflowKey, body.cron);
  }

  @ApiEndpoint({
    summary: "Pause or resume a schedule",
    notFound: true,
  })
  @Put(":scheduleId/pause")
  @HttpCode(204)
  async setPaused(
    @Param("id") tenantId: string,
    @Param("scheduleId") scheduleId: string,
    @Body() body: PauseScheduleDto,
  ): Promise<void> {
    await this.schedules.setPaused(tenantId, scheduleId, body.paused);
  }

  @ApiEndpoint({
    summary: "Trigger a schedule now",
    description: "Fires the scheduled run immediately (accepted async).",
    ok: AcceptedResponse,
    notFound: true,
  })
  @Post(":scheduleId/trigger")
  @HttpCode(202)
  async trigger(
    @Param("id") tenantId: string,
    @Param("scheduleId") scheduleId: string,
  ): Promise<{ accepted: true }> {
    await this.schedules.trigger(tenantId, scheduleId);
    return { accepted: true };
  }

  @ApiEndpoint({
    summary: "Delete a schedule",
    notFound: true,
  })
  @Delete(":scheduleId")
  @HttpCode(204)
  async remove(
    @Param("id") tenantId: string,
    @Param("scheduleId") scheduleId: string,
  ): Promise<void> {
    await this.schedules.remove(tenantId, scheduleId);
  }
}

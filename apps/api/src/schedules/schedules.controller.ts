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
import { ApiEndpoint } from "../swagger/api-decorators";
import { CreateScheduleDto, PauseScheduleDto } from "./schedule.dto";
import { AcceptedResponse, ScheduleResponse } from "./schedule.response";
import { type ScheduleView, SchedulesService } from "./schedules.service";

/** Per-tenant recurring schedules. Path tenant is enforced == token tenant by the
 *  global AuthGuard (the /tenants/:id/... rule). */
@ApiBearerAuth("bearer")
@Controller("tenants/:id/schedules")
export class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @ApiEndpoint({
    summary: "List schedules",
    description: "The tenant's recurring schedules.",
    ok: [ScheduleResponse],
  })
  @Get()
  list(@Param("id") tenantId: string): Promise<ScheduleView[]> {
    return this.schedules.list(tenantId);
  }

  @ApiEndpoint({
    summary: "Create a schedule",
    description: "Creates a cron-backed recurring run for a workflow.",
    created: ScheduleResponse,
  })
  @Post()
  create(
    @Param("id") tenantId: string,
    @Body() body: CreateScheduleDto,
  ): Promise<ScheduleView> {
    return this.schedules.create(tenantId, body.workflowKey, body.cron);
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

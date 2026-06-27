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
import { CreateScheduleDto, PauseScheduleDto } from "./schedule.dto";
import { type ScheduleView, SchedulesService } from "./schedules.service";

/** Per-tenant recurring schedules. Path tenant is enforced == token tenant by the
 *  global AuthGuard (the /tenants/:id/... rule). */
@Controller("tenants/:id/schedules")
export class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get()
  list(@Param("id") tenantId: string): Promise<ScheduleView[]> {
    return this.schedules.list(tenantId);
  }

  @Post()
  create(
    @Param("id") tenantId: string,
    @Body() body: CreateScheduleDto,
  ): Promise<ScheduleView> {
    return this.schedules.create(tenantId, body.workflowKey, body.cron);
  }

  @Put(":scheduleId/pause")
  @HttpCode(204)
  async setPaused(
    @Param("id") tenantId: string,
    @Param("scheduleId") scheduleId: string,
    @Body() body: PauseScheduleDto,
  ): Promise<void> {
    await this.schedules.setPaused(tenantId, scheduleId, body.paused);
  }

  @Post(":scheduleId/trigger")
  @HttpCode(202)
  async trigger(
    @Param("id") tenantId: string,
    @Param("scheduleId") scheduleId: string,
  ): Promise<{ accepted: true }> {
    await this.schedules.trigger(tenantId, scheduleId);
    return { accepted: true };
  }

  @Delete(":scheduleId")
  @HttpCode(204)
  async remove(
    @Param("id") tenantId: string,
    @Param("scheduleId") scheduleId: string,
  ): Promise<void> {
    await this.schedules.remove(tenantId, scheduleId);
  }
}

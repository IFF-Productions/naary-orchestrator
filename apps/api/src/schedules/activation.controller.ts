import { Body, Controller, Param, Put } from "@nestjs/common";
import { ApiProperty, ApiBearerAuth } from "@nestjs/swagger";
import { IsBoolean } from "class-validator";
import { ApiEndpoint } from "../swagger/api-decorators";
import { SchedulesService } from "./schedules.service";

export class SetActiveDto {
  @ApiProperty({
    example: false,
    description:
      "true to activate the workflow's triggers, false to deactivate.",
  })
  @IsBoolean()
  active!: boolean;
}

export class WorkflowActiveResponse {
  @ApiProperty({ example: "support-triage" }) workflowKey!: string;
  @ApiProperty({ example: false }) active!: boolean;
}

/**
 * Workflow activation (n8n parity). Toggling here flips the activation flag AND pauses/unpauses the
 * workflow's Temporal schedules in the correct order (SchedulesService.setActive). An inactive
 * workflow's automatic triggers don't fire (webhook/form ingress refused; schedules paused); manual
 * runs are always allowed. Tenant is enforced == token tenant by the global AuthGuard.
 */
@ApiBearerAuth("bearer")
@Controller("tenants/:id/workflows")
export class WorkflowActivationController {
  constructor(private readonly schedules: SchedulesService) {}

  @ApiEndpoint({
    summary: "Activate or deactivate a workflow",
    description:
      "Deactivating stops automatic triggers (webhook/form refused, schedules paused). Manual runs still work.",
    ok: WorkflowActiveResponse,
  })
  @Put(":workflowKey/active")
  async setActive(
    @Param("id") tenantId: string,
    @Param("workflowKey") workflowKey: string,
    @Body() body: SetActiveDto,
  ): Promise<WorkflowActiveResponse> {
    await this.schedules.setActive(tenantId, workflowKey, body.active);
    return { workflowKey, active: body.active };
  }
}

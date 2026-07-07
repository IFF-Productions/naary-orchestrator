import { ApiProperty } from "@nestjs/swagger";

/** A tenant's recurring schedule (backed by a Temporal Schedule). */
export class ScheduleResponse {
  @ApiProperty({ example: "sch_8f3a1c2e" }) id!: string;
  @ApiProperty({ example: "support-triage" }) workflowKey!: string;
  @ApiProperty({
    example: "0 9 * * 1-5",
    description: "Cron expression (e.g. weekdays 9am).",
  })
  cron!: string;
  @ApiProperty({ example: false }) paused!: boolean;
  @ApiProperty({ format: "date-time", example: "2026-07-04T12:00:00.000Z" })
  createdAt!: string;
  @ApiProperty({
    nullable: true,
    format: "date-time",
    example: "2026-07-07T09:00:00.000Z",
    description: "Next fire time from Temporal, or null if unknown/paused.",
  })
  nextRunAt!: string | null;
}

/** Acknowledgement that a manual trigger was accepted (async, 202). */
export class AcceptedResponse {
  @ApiProperty({ example: true }) accepted!: boolean;
}

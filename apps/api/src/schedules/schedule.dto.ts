import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean, IsNotEmpty, IsString } from "class-validator";

export class CreateScheduleDto {
  @ApiProperty({
    example: "support-triage",
    description: "The workflow to run on the schedule.",
  })
  @IsString()
  @IsNotEmpty()
  workflowKey!: string;

  /** Cron expression, e.g. "0 9 * * 1-5" (weekdays 9am). */
  @ApiProperty({
    example: "0 9 * * 1-5",
    description: 'Cron expression, e.g. "0 9 * * 1-5" (weekdays 9am).',
  })
  @IsString()
  @IsNotEmpty()
  cron!: string;
}

export class PauseScheduleDto {
  @ApiProperty({
    example: true,
    description: "true to pause the schedule, false to resume.",
  })
  @IsBoolean()
  paused!: boolean;
}

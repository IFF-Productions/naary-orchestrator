import { IsBoolean, IsNotEmpty, IsString } from "class-validator";

export class CreateScheduleDto {
  @IsString()
  @IsNotEmpty()
  workflowKey!: string;

  /** Cron expression, e.g. "0 9 * * 1-5" (weekdays 9am). */
  @IsString()
  @IsNotEmpty()
  cron!: string;
}

export class PauseScheduleDto {
  @IsBoolean()
  paused!: boolean;
}

import { IsBoolean, IsObject, IsOptional } from "class-validator";

export class StartExecutionDto {
  // tenantId is NOT accepted from the client — it is derived from the API token.
  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;
}

export class ApproveDto {
  @IsBoolean()
  approved!: boolean;
}

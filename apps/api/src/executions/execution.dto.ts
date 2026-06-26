import { IsBoolean, IsObject, IsOptional, IsString } from "class-validator";

export class StartExecutionDto {
  // tenantId is NOT accepted from the client — it is derived from the API token.
  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;

  // Which stored graph to run (its workflowKey). Defaults to "default" so existing
  // callers are unchanged; the canvas saves under "canvas" and runs that.
  @IsOptional()
  @IsString()
  workflowKey?: string;
}

export class ApproveDto {
  @IsBoolean()
  approved!: boolean;
}

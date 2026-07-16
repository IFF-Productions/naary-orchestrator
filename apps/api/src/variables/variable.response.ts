import { ApiProperty } from "@nestjs/swagger";

/** One workspace+environment variable (referenced as `{{ $vars.KEY }}`). */
export class VariableResponse {
  @ApiProperty({ example: "slackChannel" }) key!: string;
  @ApiProperty({ example: "#alerts" }) value!: string;
}

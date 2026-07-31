import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean } from "class-validator";

export class SetSelfHealDto {
  @ApiProperty({
    example: true,
    description:
      "Turn self-healing on or off for this workflow in this environment. Requires `edit` on " +
      "the workflow: it changes what happens when the workflow fails, and authorizes spending " +
      "the workspace's model budget on it.",
  })
  @IsBoolean()
  enabled!: boolean;
}

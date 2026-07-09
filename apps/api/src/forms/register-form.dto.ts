import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

export class RegisterFormDto {
  @ApiProperty({
    example: "contact-form",
    description: "The workflow (workflowKey) this form starts.",
  })
  @IsString()
  @IsNotEmpty()
  workflowId!: string;
}

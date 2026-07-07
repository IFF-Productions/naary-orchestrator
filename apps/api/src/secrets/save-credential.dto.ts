import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

export class SaveCredentialDto {
  @ApiProperty({
    example: "anthropic",
    description:
      "Provider the key belongs to (e.g. anthropic, openai, google).",
  })
  @IsString()
  @IsNotEmpty()
  provider!: string;

  @ApiProperty({
    example: "sk-ant-…",
    description:
      "The provider API key. Validated, encrypted at rest, never echoed back.",
  })
  @IsString()
  @IsNotEmpty()
  apiKey!: string;
}

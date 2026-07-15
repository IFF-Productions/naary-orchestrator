import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class CreateEnvironmentDto {
  @ApiProperty({ example: "Sandbox", description: "Display name." })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

  @ApiProperty({
    example: "sandbox",
    description:
      "Stable header/URL-safe slug (lowercase alphanumeric + hyphens, ≤32 chars).",
  })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  slug!: string;
}

export class RenameEnvironmentDto {
  @ApiPropertyOptional({ example: "Staging" })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;
}

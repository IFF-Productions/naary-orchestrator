import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";

/** #rrggbb — the UI offers a fixed palette, but any hex is accepted. */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export class CreateTagDto {
  @ApiProperty({
    maxLength: 40,
    example: "production",
    description: "Tag name — unique per workspace (trimmed).",
  })
  @IsString()
  @MaxLength(40)
  name!: string;

  @ApiPropertyOptional({
    example: "#6366f1",
    description: "Optional chip color (#rrggbb).",
  })
  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR, { message: "color must be a #rrggbb hex value" })
  color?: string;
}

export class UpdateTagDto {
  @ApiPropertyOptional({ maxLength: 40, example: "prod" })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  name?: string;

  @ApiPropertyOptional({ example: "#0ea5e9" })
  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR, { message: "color must be a #rrggbb hex value" })
  color?: string;
}

/** REPLACE-SET: the workflow ends up with exactly these tags (empty array clears them all). */
export class SetWorkflowTagsDto {
  @ApiProperty({
    type: [String],
    example: ["9a8b7c6d-…"],
    description:
      "Tag ids the workflow should carry — replaces the current set.",
  })
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  tagIds!: string[];
}

import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";

export class CreateCompanyGroupDto {
  @ApiProperty({
    example: "Platform admins",
    description: "Group name — unique per company.",
  })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;
}

export class RenameCompanyGroupDto {
  @ApiProperty({ example: "Platform admins (EU)" })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;
}

/** The six verbs of the group's company-wide grant. PUT replace semantics: absent = false.
 *  v1: always 'all'-scope + all-environments — no scope/keys/env fields on purpose (per-key
 *  and per-env selections don't compose across workspaces; a documented future seam). */
export class CompanyGrantDto {
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  canView?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  canRun?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  canEdit?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  canDelete?: boolean;

  @ApiPropertyOptional({
    example: false,
    description: "share = promote to another environment, nothing more.",
  })
  @IsOptional()
  @IsBoolean()
  canShare?: boolean;

  @ApiPropertyOptional({
    example: false,
    description:
      "Create NEW workflows. Always coherent here — company grants are 'all'-scope.",
  })
  @IsOptional()
  @IsBoolean()
  canCreate?: boolean;
}

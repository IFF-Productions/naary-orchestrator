import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";

export class CreateGroupDto {
  @ApiProperty({
    example: "Support engineers",
    description: "Group name — unique per workspace.",
  })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;
}

export class RenameGroupDto {
  @ApiProperty({ example: "Support engineers (EMEA)" })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;
}

/** Grant fields (create: all optional booleans default false; update: PATCH semantics —
 *  absent fields keep their current value). */
export class GrantDto {
  @ApiPropertyOptional({
    nullable: true,
    example: null,
    description:
      "Environment this grant applies to (an env id of this workspace). " +
      "null/absent = every environment (RBAC-GROUPS.md §8.5).",
  })
  @IsOptional()
  @IsString()
  environmentId?: string | null;

  @ApiPropertyOptional({
    enum: ["all", "selected"],
    example: "all",
    description:
      "'all' = every workflow in the workspace; 'selected' = exactly the listed workflowKeys.",
  })
  @IsOptional()
  @IsIn(["all", "selected"])
  scope?: string;

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
    description: "share = promote to another environment (§8.2), nothing more.",
  })
  @IsOptional()
  @IsBoolean()
  canShare?: boolean;

  @ApiPropertyOptional({
    example: false,
    description:
      "Create NEW workflows (its own verb, §8.3). Valid only with scope 'all' — 400 otherwise.",
  })
  @IsOptional()
  @IsBoolean()
  canCreate?: boolean;

  @ApiPropertyOptional({
    type: [String],
    example: ["support-triage", "billing-digest"],
    description:
      "Workflow keys for scope 'selected' (replace-set on update). Ignored for scope 'all'.",
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  workflowKeys?: string[];

  @ApiPropertyOptional({
    type: [String],
    example: ["tag-id-1"],
    description:
      "Tag ids for scope 'selected' (replace-set on update; must belong to the workspace). " +
      "Effective keys = workflowKeys ∪ every key carrying ANY of these tags (§9 tag-scoped " +
      "grants). NOTE: the workspace's first TagGrant makes tags access-bearing — tag edits " +
      "then require the Promote permission. Ignored for scope 'all'.",
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tagIds?: string[];
}

import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class GrantResponse {
  @ApiProperty({ example: "b7f4…" }) id!: string;
  @ApiPropertyOptional({
    nullable: true,
    example: null,
    description:
      "null = every environment; otherwise the one env this grant applies to.",
  })
  environmentId!: string | null;
  @ApiProperty({ enum: ["all", "selected"] }) scope!: "all" | "selected";
  @ApiProperty() canView!: boolean;
  @ApiProperty() canRun!: boolean;
  @ApiProperty() canEdit!: boolean;
  @ApiProperty() canDelete!: boolean;
  @ApiProperty() canShare!: boolean;
  @ApiProperty() canCreate!: boolean;
  @ApiProperty({ type: [String] }) workflowKeys!: string[];
  @ApiProperty({
    type: [String],
    description:
      "Tag ids carried by this 'selected' grant (effective keys = workflowKeys ∪ keys " +
      "tagged with any of these). Empty for scope 'all'.",
  })
  tagIds!: string[];
}

export class GroupMemberResponse {
  @ApiProperty({ description: "Firebase uid of the member." }) userId!: string;
  @ApiProperty() createdAt!: string;
}

export class GroupTokenResponse {
  @ApiProperty({ description: "ApiToken id attached to the group." })
  tokenId!: string;
  @ApiProperty() createdAt!: string;
}

export class GroupResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: "Support engineers" }) name!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: [GroupMemberResponse] })
  members!: GroupMemberResponse[];
  @ApiProperty({ type: [GroupTokenResponse] }) tokens!: GroupTokenResponse[];
  @ApiProperty({ type: [GrantResponse] }) grants!: GrantResponse[];
}

export class VerbAccessResponse {
  @ApiProperty({
    description: "true = every workflow (keys is then empty).",
  })
  all!: boolean;
  @ApiProperty({ type: [String] }) keys!: string[];
}

export class EffectivePermissionsResponse {
  @ApiProperty({
    description:
      "false = full access (owner/admin, unrestricted token, or a workspace with no grants).",
  })
  restricted!: boolean;
  @ApiProperty() canCreate!: boolean;
  @ApiProperty({ type: VerbAccessResponse }) view!: VerbAccessResponse;
  @ApiProperty({ type: VerbAccessResponse }) run!: VerbAccessResponse;
  @ApiProperty({ type: VerbAccessResponse }) edit!: VerbAccessResponse;
  @ApiProperty({ type: VerbAccessResponse }) delete!: VerbAccessResponse;
  @ApiProperty({ type: VerbAccessResponse }) share!: VerbAccessResponse;
}

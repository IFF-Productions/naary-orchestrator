import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/** One entry in the tenant's activity log. */
export class AuditEventResponse {
  @ApiProperty() id!: string;
  @ApiProperty({
    example: "9xK2mQ…",
    description:
      "The STORED actor id: a Firebase uid, an `sso:…` id, or \"api-token\". Stable — never rewritten.",
  })
  actor!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "user@example.com",
    description:
      "The actor's email from their Membership in this workspace, or null when unresolvable (an API " +
      "token, a member who left, or a Membership predating the email stamp). Render `actorEmail ?? " +
      "actor`; it is never a fabricated value.",
  })
  actorEmail!: string | null;
  @ApiProperty({
    example: "Saved a workflow",
    description: "Human-readable action label.",
  })
  action!: string;
  @ApiProperty({ example: "POST" }) method!: string;
  @ApiProperty({ example: "/graphs" }) path!: string;
  @ApiProperty({ example: 200 }) statusCode!: number;
  @ApiPropertyOptional({
    type: "string",
    nullable: true,
    example: "env_7c1de4",
    description:
      "Canonical Environment.id the actor had selected when acting; null when none. " +
      "The actor's env context, not a resource FK.",
  })
  environmentId!: string | null;
  @ApiProperty({ format: "date-time" }) createdAt!: string;
}

import { ApiProperty } from "@nestjs/swagger";

/** One entry in the tenant's activity log. */
export class AuditEventResponse {
  @ApiProperty() id!: string;
  @ApiProperty({
    example: "user@example.com",
    description: "Who performed the action.",
  })
  actor!: string;
  @ApiProperty({
    example: "Saved a workflow",
    description: "Human-readable action label.",
  })
  action!: string;
  @ApiProperty({ example: "POST" }) method!: string;
  @ApiProperty({ example: "/graphs" }) path!: string;
  @ApiProperty({ example: 200 }) statusCode!: number;
  @ApiProperty({ format: "date-time" }) createdAt!: string;
}

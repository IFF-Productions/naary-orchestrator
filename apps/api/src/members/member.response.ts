import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/** One Team-screen row: an ACTIVE member (a real Membership) or a PENDING invitation. */
export class MemberResponse {
  @ApiProperty({
    example: "firebase-uid-or-invitation-id",
    description:
      "Firebase uid for active rows (the PATCH/DELETE key); invitation id for invited rows.",
  })
  id!: string;
  @ApiPropertyOptional({
    example: "u_7c1de4",
    description: "Firebase uid — present on active rows only.",
  })
  userId?: string;
  @ApiProperty({ example: "teammate@acme.com", format: "email" })
  email!: string;
  @ApiProperty({
    example: "member",
    enum: ["owner", "admin", "member"],
  })
  role!: string;
  @ApiProperty({
    enum: ["active", "invited"],
    description:
      "'active' = a real membership; 'invited' = pending until the invitee signs in with " +
      "a verified matching email.",
  })
  status!: "active" | "invited";
  @ApiProperty({ format: "date-time" }) createdAt!: string;
}

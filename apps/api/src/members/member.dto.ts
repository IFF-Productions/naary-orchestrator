import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEmail, IsIn, IsOptional } from "class-validator";

export class AddMemberDto {
  @ApiProperty({
    format: "email",
    example: "teammate@acme.com",
    description:
      "Email to invite. The invitee joins on sign-in with this email verified.",
  })
  @IsEmail()
  email!: string;

  @ApiPropertyOptional({
    enum: ["owner", "admin", "member"],
    example: "member",
    description:
      "Role the invitee will hold. Defaults to 'member'. Only the workspace owner may " +
      "invite as admin/owner.",
  })
  @IsOptional()
  @IsIn(["owner", "admin", "member"])
  role?: string;
}

export class ChangeRoleDto {
  @ApiProperty({
    enum: ["owner", "admin", "member"],
    example: "admin",
    description:
      "New role for the member. Only the workspace owner may grant or revoke admin/owner.",
  })
  @IsIn(["owner", "admin", "member"])
  role!: string;
}

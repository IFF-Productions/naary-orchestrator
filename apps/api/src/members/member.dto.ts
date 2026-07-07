import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEmail, IsIn, IsOptional } from "class-validator";

export class AddMemberDto {
  @ApiProperty({
    format: "email",
    example: "teammate@acme.com",
    description: "Email of the member to add.",
  })
  @IsEmail()
  email!: string;

  @ApiPropertyOptional({
    enum: ["owner", "admin", "member"],
    example: "member",
    description: "Role to grant. Defaults to 'member'.",
  })
  @IsOptional()
  @IsIn(["owner", "admin", "member"])
  role?: string;
}

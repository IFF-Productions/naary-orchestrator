import { ApiProperty } from "@nestjs/swagger";

/** One workspace member (Team screen directory row). */
export class MemberResponse {
  @ApiProperty({ example: "mem_7c1de4" }) id!: string;
  @ApiProperty({ example: "teammate@acme.com", format: "email" })
  email!: string;
  @ApiProperty({
    example: "member",
    enum: ["owner", "admin", "member"],
  })
  role!: string;
  @ApiProperty({ format: "date-time" }) createdAt!: string;
}

import { ApiProperty } from "@nestjs/swagger";

/** One company the caller belongs to (COMPANIES.md Slice 1). */
export class CompanyViewResponse {
  @ApiProperty({ example: "9f1c…" }) id!: string;
  @ApiProperty({ example: "Acme Holdings" }) name!: string;
  @ApiProperty({ example: "acme-holdings-a1b2c3" }) slug!: string;
  @ApiProperty({
    example: "owner",
    enum: ["owner", "admin"],
    description: "The caller's role in this company.",
  })
  role!: string;
}

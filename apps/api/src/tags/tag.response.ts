import { ApiProperty } from "@nestjs/swagger";

/** One tag + how many workflows carry it. */
export class TagResponse {
  @ApiProperty({ example: "9a8b7c6d-…" }) id!: string;
  @ApiProperty({ example: "production" }) name!: string;
  @ApiProperty({ type: String, nullable: true, example: "#6366f1" }) color!: string | null;
  @ApiProperty({
    example: 3,
    description: "How many workflows carry this tag.",
  })
  workflowCount!: number;
}

/** The tag identity rendered as a chip on a workflow row. */
export class TagRefResponse {
  @ApiProperty({ example: "9a8b7c6d-…" }) id!: string;
  @ApiProperty({ example: "production" }) name!: string;
  @ApiProperty({ type: String, nullable: true, example: "#6366f1" }) color!: string | null;
}

/** Result of an idempotent delete. */
export class TagDeletedResponse {
  @ApiProperty({ example: true }) deleted!: boolean;
}

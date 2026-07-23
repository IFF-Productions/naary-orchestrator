import { ApiProperty } from "@nestjs/swagger";

/** One reusable Form/Email content template. `blocks` is a TemplateBlock[] (block-editor content). */
export class ContentTemplateResponse {
  @ApiProperty({ example: "clx123abc" }) id!: string;
  @ApiProperty({ enum: ["email", "form"], example: "email" })
  kind!: "email" | "form";
  @ApiProperty({ example: "Order shipped" }) name!: string;
  @ApiProperty({ nullable: true, example: "Your order {{ order.id }} shipped" })
  subject!: string | null;
  @ApiProperty({
    type: "array",
    items: { type: "object" },
    description: "Ordered TemplateBlock[] — the block-editor content.",
  })
  blocks!: unknown[];
}

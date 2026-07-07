import { ApiProperty } from "@nestjs/swagger";
import { IsIn, IsNotEmpty, IsString } from "class-validator";
import type { WebhookProvider } from "./webhook.service";

export class RegisterWebhookDto {
  @ApiProperty({
    example: "support-triage",
    description: "The workflow this webhook triggers.",
  })
  @IsString()
  @IsNotEmpty()
  workflowId!: string;

  @ApiProperty({
    enum: ["github", "atlassian", "generic"],
    example: "github",
    description: "Provider whose delivery signature format to verify.",
  })
  @IsIn(["github", "atlassian", "generic"])
  provider!: WebhookProvider;
}

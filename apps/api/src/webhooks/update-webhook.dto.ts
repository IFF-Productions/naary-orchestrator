import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsNotEmpty, IsOptional, IsString } from "class-validator";
import type { WebhookProvider } from "./webhook.service";

/** Patch a webhook endpoint's config in place. Both fields optional — send only what changes. */
export class UpdateWebhookDto {
  @ApiPropertyOptional({
    example: "support-triage",
    description: "Retarget the workflow this webhook triggers.",
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  workflowId?: string;

  @ApiPropertyOptional({
    enum: ["github", "atlassian", "generic"],
    example: "generic",
    description:
      "Change the provider whose signature/delivery scheme is verified.",
  })
  @IsOptional()
  @IsIn(["github", "atlassian", "generic"])
  provider?: WebhookProvider;
}

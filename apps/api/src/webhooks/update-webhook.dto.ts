import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { WEBHOOK_LABEL_MAX, type WebhookProvider } from "./webhook.service";

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

  @ApiPropertyOptional({
    example: "GitHub · acme/api",
    maxLength: WEBHOOK_LABEL_MAX,
    description:
      "Rename the webhook. Send an EMPTY string to clear it — omitting the field leaves it unchanged.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(WEBHOOK_LABEL_MAX)
  label?: string;
}

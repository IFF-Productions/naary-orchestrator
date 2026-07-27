import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { WEBHOOK_LABEL_MAX, type WebhookProvider } from "./webhook.service";

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

  @ApiPropertyOptional({
    example: "GitHub · acme/api",
    maxLength: WEBHOOK_LABEL_MAX,
    description:
      "Optional human name. Display only — two webhooks on the same workflow are otherwise " +
      "indistinguishable in the list. Never part of the ingress capability (that is the opaque id).",
  })
  @IsOptional()
  @IsString()
  @MaxLength(WEBHOOK_LABEL_MAX)
  label?: string;
}

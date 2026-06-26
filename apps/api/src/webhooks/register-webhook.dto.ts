import { IsIn, IsNotEmpty, IsString } from "class-validator";
import type { WebhookProvider } from "./webhook.service";

export class RegisterWebhookDto {
  @IsString()
  @IsNotEmpty()
  workflowId!: string;

  @IsIn(["github", "atlassian", "generic"])
  provider!: WebhookProvider;
}

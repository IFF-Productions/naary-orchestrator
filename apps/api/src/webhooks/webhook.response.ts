import { ApiProperty } from "@nestjs/swagger";

/** A freshly registered webhook — includes the signing secret (returned once). */
export class RegisteredWebhookResponse {
  @ApiProperty({ example: "wh_8f3a1c2e" }) endpointId!: string;
  @ApiProperty({
    example: "/webhooks/ingress/wh_8f3a1c2e",
    description:
      "Path to paste into the provider (host is deployment-specific).",
  })
  ingressPath!: string;
  @ApiProperty({
    example: "3f9a…c1",
    description: "HMAC signing secret — returned exactly once, at creation.",
  })
  signingSecret!: string;
}

/** Public view of a registered webhook — NEVER includes the signing secret. */
export class WebhookEndpointResponse {
  @ApiProperty({ example: "wh_8f3a1c2e" }) id!: string;
  @ApiProperty({ example: "github", enum: ["github", "atlassian", "generic"] })
  provider!: string;
  @ApiProperty({ example: "support-triage" }) workflowId!: string;
  @ApiProperty({ format: "date-time", example: "2026-07-04T12:00:00.000Z" })
  createdAt!: Date;
}

/** A freshly rotated signing secret — returned exactly once (the endpoint id/URL are unchanged). */
export class RotatedSecretResponse {
  @ApiProperty({
    example: "3f9a…c1",
    description:
      "The NEW HMAC signing secret — returned exactly once, on rotation.",
  })
  signingSecret!: string;
}

/** Acknowledgement that a webhook endpoint was deleted. */
export class DeletedResponse {
  @ApiProperty({ example: true }) deleted!: boolean;
}

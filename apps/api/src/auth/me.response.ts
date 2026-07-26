import { ApiProperty } from "@nestjs/swagger";

/** The authenticated principal (who am I). */
export class MeResponse {
  @ApiProperty({
    example: "tenant_abc123",
    description: "The caller's tenantId.",
  })
  tenantId!: string;

  @ApiProperty({
    required: false,
    example: "user@example.com",
    description: "The authenticated subject (user id / email), if any.",
  })
  subject?: string;

  @ApiProperty({
    example: false,
    description:
      "True when this caller is a PLATFORM OPERATOR (the PLATFORM_OPERATORS email allowlist) — i.e. " +
      "runs the deployment, as distinct from owning a workspace in it. False for everyone when that " +
      "env is unset, and always false for API-token callers (they carry no email). Sent so the SPA can " +
      "hide operator-only surfaces; every such endpoint re-checks server-side.",
  })
  isOperator!: boolean;
}

/** The feature flags resolved for the authenticated tenant (booleans only). */
export class MeFlagsResponse {
  @ApiProperty({
    type: "object",
    additionalProperties: { type: "boolean" },
    example: { "chat-rag": true, "new-canvas-inspector": false },
    description:
      "Flag key → enabled, evaluated server-side for THIS tenant only. Never exposes the provider key.",
  })
  flags!: Record<string, boolean>;
}

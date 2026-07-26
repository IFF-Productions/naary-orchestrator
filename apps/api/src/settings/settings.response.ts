import { ApiProperty } from "@nestjs/swagger";

/** Per-tenant settings (null fields = unset). */
export class SettingsResponse {
  @ApiProperty({
    nullable: true,
    example: "Acme Inc.",
    description: "Tenant display name.",
  })
  displayName!: string | null;

  @ApiProperty({
    nullable: true,
    example: "claude-sonnet-4",
    description: "Default model for new agent nodes.",
  })
  defaultModel!: string | null;
}

/**
 * Workspace agent guardrail policy (#576). Documented as a free-form object because the authority
 * on its shape is `agentGuardrailPolicySchema` (zod, in @naary/dsl/dist/registry) — restating it as
 * Swagger decorators would create a second definition of a security contract that could drift.
 */
export class GuardrailPolicyResponse {
  @ApiProperty({
    type: "object",
    additionalProperties: true,
    example: {
      tools: { deny: ["delete_*"], requireApproval: ["github:create_issue"] },
      input: [
        { label: "no-codenames", kind: "keyword", pattern: "Project Bluebird" },
      ],
      output: [
        {
          label: "no-swearing",
          kind: "regex",
          pattern: "damn",
          action: "strip",
        },
      ],
      redact: { enabled: true, kinds: ["email", "phone"] },
    },
    description:
      "Tool allow/deny/forced-approval globs, input/output content rules, and PII redaction opt-in. `{}` = no guardrails.",
  })
  policy!: Record<string, unknown>;
}

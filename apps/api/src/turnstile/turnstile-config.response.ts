import { ApiProperty } from "@nestjs/swagger";

/** Public Turnstile config for an environment — the site key is public; the secret is never
 *  returned (only whether one is set). */
export class TurnstileConfigResponse {
  @ApiProperty({ description: "Cloudflare Turnstile public site key." })
  siteKey!: string;

  @ApiProperty({
    description: "Whether the bot gate is enforced on this env's public pages.",
  })
  enabled!: boolean;

  @ApiProperty({
    description:
      "Whether a secret key is stored (write-only — the value is never returned).",
  })
  hasSecret!: boolean;

  @ApiProperty({
    type: [String],
    description:
      "Allowed solved-Turnstile hostnames (empty ⇒ any). A submission's hostname must match.",
  })
  allowedHostnames!: string[];
}

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
    enum: ["turnstile", "app_check"],
    description:
      "Which bot gate guards this env's public pages: 'turnstile' (the tenant's own Cloudflare keys) or 'app_check' (the platform's Firebase App Check — no tenant keys). App Check is the weaker option: it attests the request came from our app but does not challenge each submission and does NOT enforce allowedHostnames as a bot check.",
  })
  provider!: "turnstile" | "app_check";

  @ApiProperty({
    description:
      "Whether this deployment can verify App Check tokens at all (a Firebase service account is configured). False ⇒ the 'app_check' provider cannot be selected.",
  })
  appCheckAvailable!: boolean;

  @ApiProperty({
    type: [String],
    description:
      "Allowed solved-Turnstile hostnames (empty ⇒ any). A submission's hostname must match. Enforced as a bot check for the 'turnstile' provider ONLY — an App Check token carries no solved hostname. Independently drives embed CORS for both providers.",
  })
  allowedHostnames!: string[];
}

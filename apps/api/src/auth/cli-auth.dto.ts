import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";

/**
 * Request/response bodies for the `naary auth` handshake (#1078 §2 shape B, slice 3).
 *
 * These are DTO CLASSES, not inline body types, because `main.ts` installs a global
 * `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` — with a class it strips
 * unknown fields and rejects extras, and with a bare inline type it validates nothing at all. On an
 * unauthenticated endpoint that difference is the whole input boundary.
 */

export class CliAuthStartDto {
  @ApiPropertyOptional({
    example: "hassans-macbook",
    description:
      "Device name shown in Settings as `naary CLI — <hostname>`, so the session is identifiable and revocable. Sanitized server-side.",
  })
  @IsOptional()
  @IsString()
  // Capped here as WELL as in sanitizeHostname: the pipe rejects an absurd body outright rather
  // than silently truncating megabytes of it.
  @MaxLength(200)
  hostname?: string;
}

export class CliAuthStartResponse {
  @ApiProperty({
    description:
      "The CLI's secret for this handshake. Hold it in memory, never print it, never put it in a URL.",
  })
  deviceCode!: string;

  @ApiProperty({
    example: "PQ4M-TWZ9",
    description:
      "Short code to show the human. They type it into the browser page at `verificationUri`.",
  })
  userCode!: string;

  @ApiProperty({
    example: "https://app.example.com/app/cli-login",
    description:
      "Where the human approves. Server-derived (APP_BASE_URL/CORS_ORIGINS), never from the request. Relative when no public base URL is configured.",
  })
  verificationUri!: string;

  @ApiProperty({
    example: 600,
    description: "Seconds until this handshake expires.",
  })
  expiresIn!: number;

  @ApiProperty({
    example: 5,
    description:
      "Seconds the CLI should wait between /auth/cli/exchange polls.",
  })
  interval!: number;
}

export class CliAuthDecisionDto {
  @ApiProperty({
    example: "PQ4M-TWZ9",
    description:
      "The code shown in the terminal. Case- and separator-insensitive.",
  })
  @IsString()
  @MaxLength(64)
  userCode!: string;
}

export class CliAuthDecisionResponse {
  @ApiProperty({
    example: "approved",
    enum: ["approved", "denied"],
  })
  status!: "approved" | "denied";

  @ApiProperty({
    example: "naary CLI — hassans-macbook",
    description: "Label the minted session will carry in Settings.",
  })
  label!: string;
}

export class CliAuthExchangeDto {
  @ApiProperty({
    description: "The `deviceCode` returned by /auth/cli/start.",
  })
  @IsString()
  @MaxLength(200)
  deviceCode!: string;
}

export class CliAuthRefreshDto {
  @ApiProperty({
    description: "The current `nryr_` refresh token. Rotated on every use.",
  })
  @IsString()
  @MaxLength(200)
  refreshToken!: string;
}

/**
 * `naary auth logout` (#1078 slice 4). Both fields are optional and both are credentials the caller
 * already holds, so presenting either is proof enough to destroy it — the route is @Public for the
 * same reason refresh is. A CLI sends both: the refresh token ends the rotation family, the access
 * token kills the 12-hour bearer that would otherwise outlive the logout.
 */
export class CliAuthLogoutDto {
  @ApiPropertyOptional({
    description:
      "The current `nryr_` refresh token. Its whole rotation family is revoked.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  refreshToken?: string;

  @ApiPropertyOptional({
    description:
      "The current `nry_` access token. Deleted, so the session ends now rather than in 12 hours.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  accessToken?: string;
}

/**
 * The polled response. `status` is the discriminator: `pending` means keep polling, `denied` means
 * stop, and `authorized` carries the tokens exactly once.
 *
 * Every FAILURE (unknown code, expired code, already-redeemed code) is a 400 with one identical
 * body instead of a status here — see the controller.
 */
export class CliAuthExchangeResponse {
  @ApiProperty({
    example: "authorized",
    enum: ["pending", "denied", "authorized"],
  })
  status!: "pending" | "denied" | "authorized";

  @ApiPropertyOptional({
    description:
      "The `nry_` access token. Present only when status=authorized.",
  })
  accessToken?: string;

  @ApiPropertyOptional({
    description: "ISO expiry of the access token (12 hours).",
  })
  accessTokenExpiresAt?: string;

  @ApiPropertyOptional({
    description:
      "The `nryr_` refresh token. Single-use: every refresh returns its successor.",
  })
  refreshToken?: string;

  @ApiPropertyOptional({
    description: "ISO absolute expiry of the refresh family (90 days).",
  })
  refreshTokenExpiresAt?: string;

  @ApiPropertyOptional({
    description: "Workspace the session is bound to.",
  })
  tenantId?: string;
}

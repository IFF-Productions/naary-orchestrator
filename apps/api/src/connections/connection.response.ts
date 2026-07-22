import { ApiProperty } from "@nestjs/swagger";

/** Public view of a connection — NEVER includes the stored token. */
export class ConnectionResponse {
  @ApiProperty({ example: "conn_9f3ab2" }) id!: string;
  @ApiProperty({ example: "tenant_123" }) tenantId!: string;
  @ApiProperty({
    example: "github",
    enum: [
      "github",
      "atlassian",
      "custom",
      "postgres",
      "mssql",
      "mysql",
      "signing",
      "smtp",
    ],
    description: "Connection kind.",
  })
  type!: string;
  @ApiProperty({ example: "Prod GitHub", description: "Display label." })
  label!: string;
  @ApiProperty({
    example: "https://api.github.com",
    description:
      "https URL for MCP/HTTP connections, or a non-secret display host for DB connections.",
  })
  serverUrl!: string;
  @ApiProperty({
    example: "pat",
    enum: ["api_token", "pat", "oauth", "github_app", "connection_string"],
  })
  authMode!: string;
  @ApiProperty({
    type: [String],
    example: ["repo", "read:org"],
    description: "Requested OAuth/token scopes.",
  })
  scopes!: string[];
  @ApiProperty({
    example: "connected",
    enum: ["connected", "needs_reauth", "error"],
  })
  status!: string;
  @ApiProperty({
    example: 3,
    description:
      "How many nodes across the tenant's latest graphs in this env reference this " +
      "connection (#471). 0 = unreferenced (safe to delete).",
  })
  usedByNodeCount!: number;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "xyz1",
    description:
      "Last 4 characters of the stored raw bearer token (#471, pat/api_token modes) — a 'which " +
      "key is this?' hint, like a card's last-4; NEVER the full token. null for connection-string " +
      "(DB/SMTP) secrets, oauth/github_app (which store a JSON grant, not a token), connections " +
      "with no stored token yet, or secrets shorter than 4 chars.",
  })
  credentialLast4!: string | null;
  @ApiProperty({ format: "date-time" }) createdAt!: Date;
}

/** Result of starting interactive OAuth consent — the authorize URL for the browser. */
export class OAuthStartResponse {
  @ApiProperty({
    example: "https://provider.example.com/oauth/authorize?...",
    description: "Redirect the browser here to grant consent.",
  })
  authorizeUrl!: string;
}

/** Result of the OAuth callback — the connection whose refresh token was persisted. */
export class OAuthCallbackResponse {
  @ApiProperty({ example: "conn_9f3ab2" }) connectionId!: string;
}

/** Result of starting a GitHub App install — the github.com install URL for the browser. */
export class GithubAppInstallStartResponse {
  @ApiProperty({
    example: "https://github.com/apps/naary/installations/new?state=...",
    description: "Redirect the browser here to install the app + pick repos.",
  })
  installUrl!: string;
}

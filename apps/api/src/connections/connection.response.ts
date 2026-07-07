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
    enum: ["api_token", "pat", "oauth", "connection_string"],
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

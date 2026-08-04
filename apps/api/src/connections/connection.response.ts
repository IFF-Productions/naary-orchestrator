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
      "firestore",
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
      "An https URL when this server calls the connection over HTTP (MCP/app servers), otherwise a " +
      "non-secret display label — the real endpoint and its credential ride in `token`.",
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

/**
 * Result of testing a connection against its provider (#701).
 *
 * `status` is the OUTCOME of the test, not an HTTP code: `unknown` means we declined to probe
 * (the provider has no non-write, zero-argument read action — e.g. Slack, whose every catalog
 * action writes), which is different from a token that failed. The provider's own HTTP code is
 * `httpStatus`.
 */
export class ConnectionTestResponse {
  @ApiProperty({
    example: true,
    description:
      "True only when the provider answered 2xx. `unknown` is not ok.",
  })
  ok!: boolean;
  @ApiProperty({
    example: "ok",
    enum: ["ok", "failed", "unknown"],
    description:
      "`ok` = the provider accepted the credential. `failed` = it was rejected or unreachable. " +
      "`unknown` = no safe read-only call exists for this provider, so nothing was called.",
  })
  status!: string;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 200,
    description: "The provider's HTTP status, or null when no call was made.",
  })
  httpStatus!: number | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "calendly.get_me",
    description:
      "The `provider.action` that was called — always a catalog action with `write: false` and no " +
      "required fields. Null when nothing safe existed.",
  })
  checkedAction!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "connected",
    enum: ["connected", "needs_reauth", "error"],
    description:
      "The connection's status after the test. Null when the test learned nothing about the " +
      "token (`unknown`) and therefore left the status untouched.",
  })
  connectionStatus!: string | null;
  @ApiProperty({
    example:
      "Calendly answered 200 to calendly.get_me — this connection works.",
    description: "Human-readable explanation. Never contains the credential.",
  })
  message!: string;
}

/**
 * One tool an MCP connection's server advertises (`tools/list`).
 *
 * Every field is authored by whoever runs that server, so the API sanitizes it before it gets
 * here: control characters stripped, lengths capped, an over-large `inputSchema` dropped. The UI
 * must still render `description` as TEXT, never HTML.
 */
export class McpToolResponse {
  @ApiProperty({
    example: "create_issue",
    description:
      "The tool's id — what goes in the mcpTool node's `tool` field.",
  })
  name!: string;
  @ApiProperty({
    example: "Create a new issue in a repository.",
    description:
      "Plain-text description, or empty when the server sent none. Never HTML.",
  })
  description!: string;
  @ApiProperty({
    type: Object,
    required: false,
    example: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" } },
      required: ["owner", "repo"],
    },
    description:
      "JSON Schema for the tool's arguments — the canvas offers its `properties` as binding " +
      "names. Absent when the server sent none, or when the schema was too large to relay.",
  })
  inputSchema?: Record<string, unknown>;
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

/**
 * What an admin needs to register the Atlassian app — so the callback URL is COPIED from us
 * rather than retyped. Both fields are non-secret: the redirect URI rides in every authorize
 * request and in the user's address bar, and `configured` is a BOOLEAN over the platform client
 * id/secret, never the values.
 */
export class AtlassianOAuthConfigResponse {
  @ApiProperty({
    example: "https://app.example.com/api/atlassian/oauth/callback",
    description:
      "The redirect_uri THIS server sends. Must match the app's Callback URL byte for byte — a different host or a trailing slash is rejected as an invalid callback.",
  })
  redirectUri!: string;

  @ApiProperty({
    example: true,
    description:
      "Whether ATLASSIAN_OAUTH_CLIENT_ID and _SECRET are set on the server. False ⇒ starting consent will refuse, so the UI can say so before the user fills the form.",
  })
  configured!: boolean;
}

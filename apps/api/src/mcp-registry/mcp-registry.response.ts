import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import type { McpRegistryServer, McpTrustTier } from "./registry-sanitize";

export class McpRegistryServerResponse implements McpRegistryServer {
  @ApiProperty({ description: "Stable identifier for the server." })
  id!: string;

  @ApiProperty({ description: "Human-readable name." })
  name!: string;

  @ApiProperty({
    description:
      "Short description. PLAIN TEXT — sanitized server-side; clients must render it as text, never as HTML.",
  })
  description!: string;

  @ApiProperty({
    description:
      "The https MCP endpoint to pre-fill as a connection's serverUrl. Always https, credential-free, and never a private/reserved host.",
  })
  transportUrl!: string;

  @ApiProperty({
    enum: ["http"],
    description: "Transport. Only Streamable HTTP is supported today.",
  })
  transport!: "http";

  @ApiProperty({
    enum: ["api_token", "pat", "oauth", "none"],
    description: "Auth scheme to pre-select on the connection form.",
  })
  authMode!: "api_token" | "pat" | "oauth" | "none";

  @ApiProperty({ description: "Whether the user must supply a credential." })
  requiresAuth!: boolean;

  @ApiProperty({
    enum: ["curated", "community"],
    description:
      "Trust tier. 'curated' = vetted, shipped in this repo; 'community' = from the public registry (treat as untrusted).",
  })
  trust!: McpTrustTier;

  @ApiPropertyOptional({
    description:
      "An http/https 'learn more' link. Absent when upstream supplied none or an unsafe scheme.",
  })
  homepage?: string;

  @ApiProperty({ type: [String], description: "Tags/categories." })
  tags!: string[];
}

export class McpRegistryPageResponse {
  @ApiProperty({ type: [McpRegistryServerResponse] })
  servers!: McpRegistryServerResponse[];

  @ApiProperty({
    enum: ["registry", "curated"],
    description:
      "'curated' means the upstream registry was unavailable and this is the degraded (in-repo) list.",
  })
  source!: "registry" | "curated";

  @ApiPropertyOptional({
    description:
      "Why the response is degraded (present only when source is 'curated').",
  })
  degradedReason?: string;

  @ApiProperty({ description: "Date the curated corpus was last reviewed." })
  curatedAsOf!: string;
}

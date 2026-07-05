import { Module } from "@nestjs/common";
import { McpController } from "./mcp.controller";

/**
 * Exposes naary as an MCP server (design docs/design/MCP-SERVER.md, flavor A). ApiTokenService
 * comes from the @Global AuthModule, so no explicit import is needed here.
 */
@Module({
  controllers: [McpController],
})
export class McpModule {}

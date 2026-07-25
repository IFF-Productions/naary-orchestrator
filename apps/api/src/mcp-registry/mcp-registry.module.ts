import { Module } from "@nestjs/common";
import { McpRegistryController } from "./mcp-registry.controller";
import { McpRegistryService } from "./mcp-registry.service";

/** MCP registry browser (#578) — control-plane discovery of public MCP servers. */
@Module({
  controllers: [McpRegistryController],
  providers: [McpRegistryService],
  exports: [McpRegistryService],
})
export class McpRegistryModule {}

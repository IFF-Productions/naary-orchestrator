import { Module } from "@nestjs/common";
import { EnvironmentsModule } from "../environments/environments.module";
import { ExecutionsModule } from "../executions/executions.module";
import { GraphsModule } from "../graphs/graphs.module";
import { McpController } from "./mcp.controller";

/**
 * Exposes naary as an MCP server (design docs/design/MCP-SERVER.md, flavor A). ApiTokenService
 * comes from the @Global AuthModule; GraphsService/ExecutionsService are imported from their
 * modules (both already export the service) to back list_workflows / get_run.
 */
@Module({
  imports: [EnvironmentsModule, GraphsModule, ExecutionsModule],
  controllers: [McpController],
})
export class McpModule {}

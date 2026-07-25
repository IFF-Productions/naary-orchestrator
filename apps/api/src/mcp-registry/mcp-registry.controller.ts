import { Controller, Get, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ApiBearerAuth, ApiQuery } from "@nestjs/swagger";
import { ApiEndpoint } from "../swagger/api-decorators";
import { McpRegistryPageResponse } from "./mcp-registry.response";
import {
  McpRegistryService,
  type McpRegistryPage,
} from "./mcp-registry.service";

/**
 * MCP registry browser (#578). Authenticated like every other route but NOT tenant-scoped — the
 * catalog is global and identical for every tenant (same shape as the built-in workflow templates),
 * so no `@TenantId()` and no tenant data is involved.
 *
 * Throttled tighter than the global default: each call can trigger an outbound fetch to a third
 * party, so this endpoint must not become a way to have our api hammer the registry on demand (the
 * service's short in-process cache is the other half of that).
 */
@ApiBearerAuth("bearer")
@Controller("mcp-registry")
export class McpRegistryController {
  constructor(private readonly registry: McpRegistryService) {}

  @ApiEndpoint({
    summary: "Browse/search public MCP servers",
    description:
      "Lists connectable MCP servers: the curated (vetted) corpus first, then community entries " +
      "from the public MCP registry. Registry data is sanitized server-side — https-only, " +
      "credential-free, non-private transport URLs; plain-text descriptions; http/https links only. " +
      "When the upstream registry is unavailable the response degrades to the curated list " +
      '(`source: "curated"`) rather than failing.',
    ok: McpRegistryPageResponse,
  })
  // OPTIONAL in the spec: without these the Nest plugin marks them required, forcing every
  // generated client to send them.
  @ApiQuery({
    name: "q",
    required: false,
    type: String,
    description: "Substring search over name/description/tags.",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    type: Number,
    description: "Max rows to return (1–200, default 50).",
  })
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get("servers")
  list(
    @Query("q") q?: string,
    @Query("limit") limit?: string,
  ): Promise<McpRegistryPage> {
    // Query strings arrive as strings; a non-numeric limit falls back to the default rather than
    // producing NaN (the service clamps the range).
    const parsed = limit !== undefined ? Number.parseInt(limit, 10) : undefined;
    return this.registry.list({
      q,
      limit:
        parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined,
    });
  }
}

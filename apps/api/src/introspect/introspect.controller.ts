import { Body, Controller, Post } from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import type { GraphQLSchemaSummary, OpenApiSummary } from "@naary/dsl";
import { TenantId } from "../auth/tenant.decorator";
import { ApiEndpoint } from "../swagger/api-decorators";
import { IntrospectService } from "./introspect.service";

interface IntrospectDto {
  /** The spec URL (OpenAPI) or GraphQL endpoint URL. Public https only (SSRF-guarded). */
  url: string;
  /** Optional request headers forwarded VERBATIM (e.g. a bearer token the user pastes). NEVER a
   *  `{{ $secrets.NAME }}` reference — this path does not resolve stored secrets (see the service). */
  headers?: Record<string, string>;
}

/**
 * Authoring-time introspection for node autocomplete (OpenAPI/Swagger + GraphQL). This is an
 * SSRF-adjacent proxy, so it sits behind the tenant auth guard (the `@TenantId()` param resolves only
 * for an authenticated principal) and forwards headers verbatim without ever resolving `$secrets`.
 */
@ApiBearerAuth("bearer")
@Controller("introspect")
export class IntrospectController {
  constructor(private readonly introspect: IntrospectService) {}

  @ApiEndpoint({
    summary: "Introspect an OpenAPI/Swagger spec (JSON) → operation list",
  })
  @Post("openapi")
  openapi(
    @TenantId() _tenantId: string,
    @Body() body: IntrospectDto,
  ): Promise<OpenApiSummary> {
    return this.introspect.openapi(body?.url, body?.headers);
  }

  @ApiEndpoint({
    summary: "Introspect a GraphQL endpoint → schema summary (types/fields)",
  })
  @Post("graphql")
  graphql(
    @TenantId() _tenantId: string,
    @Body() body: IntrospectDto,
  ): Promise<GraphQLSchemaSummary> {
    return this.introspect.graphql(body?.url, body?.headers);
  }
}

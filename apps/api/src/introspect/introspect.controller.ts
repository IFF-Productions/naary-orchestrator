import { Body, Controller, Post } from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import type { GraphQLSchemaSummary, OpenApiSummary } from "@naary/dsl";
import type { SqlSchemaSummary } from "@naary/sql";
import { TenantId } from "../auth/tenant.decorator";
import { ApiEndpoint } from "../swagger/api-decorators";
import { IntrospectService } from "./introspect.service";
import { SqlSchemaService } from "./sql-schema.service";

interface IntrospectDto {
  /** The spec URL (OpenAPI) or GraphQL endpoint URL. Public https only (SSRF-guarded). */
  url: string;
  /** Optional request headers forwarded VERBATIM (e.g. a bearer token the user pastes). NEVER a
   *  `{{ $secrets.NAME }}` reference — this path does not resolve stored secrets (see the service). */
  headers?: Record<string, string>;
}

interface IntrospectSqlDto {
  /** A saved SQL connection (postgres/mysql/mssql) belonging to the calling tenant. */
  connectionId: string;
  /** Bypass AND replace the server-side cache — the editor's "Refresh" button, for a schema that
   *  just changed under a migration. */
  refresh?: boolean;
}

/**
 * Authoring-time introspection for node autocomplete (OpenAPI/Swagger + GraphQL). This is an
 * SSRF-adjacent proxy, so it sits behind the tenant auth guard (the `@TenantId()` param resolves only
 * for an authenticated principal) and forwards headers verbatim without ever resolving `$secrets`.
 */
@ApiBearerAuth("bearer")
@Controller("introspect")
export class IntrospectController {
  constructor(
    private readonly introspect: IntrospectService,
    private readonly sqlSchema: SqlSchemaService,
  ) {}

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

  /**
   * Tables + columns for a saved SQL connection, so the sqlQuery/sqlExec editor can autocomplete
   * them (#1004). Unlike its two siblings the target is NOT caller-supplied: the caller names a
   * `connectionId`, and the connection (and its DSN) is resolved server-side by tenant — so this
   * route cannot be pointed at an arbitrary host, and the credential never reaches the browser.
   */
  @ApiEndpoint({
    summary: "Introspect a SQL connection's schema → tables + columns",
  })
  @Post("sql")
  sql(
    @TenantId() tenantId: string,
    @Body() body: IntrospectSqlDto,
  ): Promise<SqlSchemaSummary> {
    return this.sqlSchema.introspect(tenantId, body?.connectionId, {
      refresh: body?.refresh === true,
    });
  }
}

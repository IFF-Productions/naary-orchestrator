import { Module } from "@nestjs/common";
import { IntrospectController } from "./introspect.controller";
import { IntrospectService } from "./introspect.service";
import { SqlSchemaService } from "./sql-schema.service";

/** Authoring-time introspection (OpenAPI/Swagger, GraphQL + SQL schema) for node autocomplete. */
@Module({
  controllers: [IntrospectController],
  providers: [IntrospectService, SqlSchemaService],
})
export class IntrospectModule {}

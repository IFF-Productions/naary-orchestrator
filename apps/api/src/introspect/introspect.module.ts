import { Module } from "@nestjs/common";
import { EnvironmentsService } from "../environments/environments.service";
import { IntrospectController } from "./introspect.controller";
import { IntrospectService } from "./introspect.service";
import { SqlSchemaService } from "./sql-schema.service";

/** Authoring-time introspection (OpenAPI/Swagger, GraphQL + SQL schema) for node autocomplete.
 *  `EnvironmentsService` is here for the SQL route's active-environment gate (#1004 review). */
@Module({
  controllers: [IntrospectController],
  providers: [IntrospectService, SqlSchemaService, EnvironmentsService],
})
export class IntrospectModule {}

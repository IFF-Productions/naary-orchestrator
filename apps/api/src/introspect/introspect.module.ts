import { Module } from "@nestjs/common";
import { IntrospectController } from "./introspect.controller";
import { IntrospectService } from "./introspect.service";

/** Authoring-time introspection (OpenAPI/Swagger + GraphQL) for node autocomplete. */
@Module({
  controllers: [IntrospectController],
  providers: [IntrospectService],
})
export class IntrospectModule {}

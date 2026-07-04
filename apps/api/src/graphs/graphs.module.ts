import { Global, Module } from "@nestjs/common";
import { CredentialsService } from "@naary/secrets";
import { GraphGeneratorService } from "./graph-generator.service";
import { GraphsController } from "./graphs.controller";
import { GraphsService } from "./graphs.service";

/** Global so ExecutionsService and the webhook ingress can resolve graphs from DB. */
@Global()
@Module({
  controllers: [GraphsController],
  providers: [
    GraphsService,
    GraphGeneratorService,
    // Plain class from @naary/secrets (reads ENCRYPTION_KEY at construction); the
    // generator decrypts the tenant's provider key in-request for the model call.
    { provide: CredentialsService, useFactory: () => new CredentialsService() },
  ],
  exports: [GraphsService],
})
export class GraphsModule {}

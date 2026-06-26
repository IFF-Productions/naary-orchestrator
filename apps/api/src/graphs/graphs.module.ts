import { Global, Module } from "@nestjs/common";
import { GraphsService } from "./graphs.service";

/** Global so ExecutionsService and the webhook ingress can resolve graphs from DB. */
@Global()
@Module({
  providers: [GraphsService],
  exports: [GraphsService],
})
export class GraphsModule {}

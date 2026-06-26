import { Global, Module } from "@nestjs/common";
import { GraphsController } from "./graphs.controller";
import { GraphsService } from "./graphs.service";

/** Global so ExecutionsService and the webhook ingress can resolve graphs from DB. */
@Global()
@Module({
  controllers: [GraphsController],
  providers: [GraphsService],
  exports: [GraphsService],
})
export class GraphsModule {}

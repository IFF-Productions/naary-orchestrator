import { Module } from "@nestjs/common";
import { EnvironmentsController } from "./environments.controller";
import { EnvironmentsService } from "./environments.service";

@Module({
  controllers: [EnvironmentsController],
  providers: [EnvironmentsService],
  exports: [EnvironmentsService], // later slices resolve env ids via this service
})
export class EnvironmentsModule {}

import { Module } from "@nestjs/common";
import { ExecutionsModule } from "./executions/executions.module";

@Module({
  imports: [ExecutionsModule],
})
export class AppModule {}

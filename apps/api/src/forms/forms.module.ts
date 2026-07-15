import { Module } from "@nestjs/common";
import { EnvironmentsModule } from "../environments/environments.module";
import { ExecutionsModule } from "../executions/executions.module";
import { FormService } from "./form.service";
import { FormsAdminController } from "./forms-admin.controller";
import { FormsController } from "./forms.controller";

@Module({
  imports: [EnvironmentsModule, ExecutionsModule], // FormsController reuses ExecutionsService.startForm
  // GraphsService is provided globally (@Global GraphsModule).
  controllers: [FormsController, FormsAdminController],
  providers: [FormService],
})
export class FormsModule {}

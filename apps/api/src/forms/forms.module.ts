import { Module } from "@nestjs/common";
import { ContentTemplatesModule } from "../content-templates/content-templates.module";
import { EnvironmentsModule } from "../environments/environments.module";
import { ExecutionsModule } from "../executions/executions.module";
import { FormService } from "./form.service";
import { FormsAdminController } from "./forms-admin.controller";
import { FormsController } from "./forms.controller";

@Module({
  // ContentTemplatesModule → the form ingress can source fields from a referenced form template.
  imports: [EnvironmentsModule, ExecutionsModule, ContentTemplatesModule], // FormsController reuses ExecutionsService.startForm
  // GraphsService is provided globally (@Global GraphsModule).
  controllers: [FormsController, FormsAdminController],
  providers: [FormService],
})
export class FormsModule {}

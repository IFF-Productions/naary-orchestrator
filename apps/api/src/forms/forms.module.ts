import { Module } from "@nestjs/common";
import { ContentTemplatesModule } from "../content-templates/content-templates.module";
import { EnvironmentsModule } from "../environments/environments.module";
import { ExecutionsModule } from "../executions/executions.module";
import { TurnstileConfigModule } from "../turnstile/turnstile-config.module";
import { FormAssetModule } from "./form-asset.module";
import { FormService } from "./form.service";
import { FormsAdminController } from "./forms-admin.controller";
import { FormsController } from "./forms.controller";

@Module({
  // ContentTemplatesModule → source fields from a referenced form template; TurnstileConfigModule →
  // the bot gate on the public submit + the site key on the definition.
  imports: [
    EnvironmentsModule,
    ExecutionsModule,
    ContentTemplatesModule,
    TurnstileConfigModule,
    // Shared with GraphsModule (the save-time logo ownership check) — see FormAssetModule.
    FormAssetModule,
  ], // FormsController reuses ExecutionsService.startForm
  // GraphsService is provided globally (@Global GraphsModule).
  controllers: [FormsController, FormsAdminController],
  providers: [FormService],
})
export class FormsModule {}

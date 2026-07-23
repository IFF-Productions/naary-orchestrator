import { Module } from "@nestjs/common";
import { EnvironmentsModule } from "../environments/environments.module";
import { ContentTemplatesController } from "./content-templates.controller";
import { ContentTemplatesService } from "./content-templates.service";

/** Form/Email content templates — env-scoped block content authored in the block editor and
 *  rendered by the sendEmail node. Distinct from the workflow starter-templates module. */
@Module({
  imports: [EnvironmentsModule],
  controllers: [ContentTemplatesController],
  providers: [ContentTemplatesService],
  exports: [ContentTemplatesService],
})
export class ContentTemplatesModule {}

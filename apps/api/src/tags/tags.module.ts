import { Module } from "@nestjs/common";
import { EnvironmentsModule } from "../environments/environments.module";
import { TagsController } from "./tags.controller";
import { TagsService } from "./tags.service";

/** Workflow tags — organizational metadata (RBAC slice T1); tenant-wide, not env-scoped.
 *  EnvironmentsModule: the workflow-tags PUT resolves the active env for its G1 edit gate. */
@Module({
  imports: [EnvironmentsModule],
  controllers: [TagsController],
  providers: [TagsService],
})
export class TagsModule {}

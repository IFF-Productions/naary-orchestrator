import { Module } from "@nestjs/common";
import { TagsController } from "./tags.controller";
import { TagsService } from "./tags.service";

/** Workflow tags — organizational metadata (RBAC slice T1); tenant-wide, not env-scoped. */
@Module({
  controllers: [TagsController],
  providers: [TagsService],
})
export class TagsModule {}

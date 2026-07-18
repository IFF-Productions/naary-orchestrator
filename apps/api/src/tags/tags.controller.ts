import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { TenantId } from "../auth/tenant.decorator";
import { ApiEndpoint } from "../swagger/api-decorators";
import { CreateTagDto, SetWorkflowTagsDto, UpdateTagDto } from "./tag.dto";
import {
  TagDeletedResponse,
  TagRefResponse,
  TagResponse,
} from "./tag.response";
import { type TagRef, TagsService, type TagView } from "./tags.service";

/**
 * Workflow tags — organizational metadata (RBAC slice T1; NOT permission-bearing). Mounted at
 * the root with explicit paths so the workflow-attach route (`PUT /graphs/:workflowKey/tags`)
 * lives here without touching graphs.controller.ts. Tags are TENANT-WIDE (not env-scoped):
 * authoring metadata like the workflow's name — promote carries them implicitly.
 */
@ApiBearerAuth("bearer")
@Controller()
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  @ApiEndpoint({
    summary: "List tags",
    description:
      "Every tag in the workspace, with how many workflows carry each.",
    ok: [TagResponse],
  })
  @Get("tags")
  async list(@TenantId() tenantId: string): Promise<TagView[]> {
    return this.tags.list(tenantId);
  }

  @ApiEndpoint({
    summary: "Create a tag",
    description:
      "Name is trimmed and unique per workspace — a duplicate is a 409.",
    created: TagResponse,
    conflict: true,
  })
  @Post("tags")
  @HttpCode(201)
  async create(
    @TenantId() tenantId: string,
    @Body() body: CreateTagDto,
  ): Promise<TagView> {
    return this.tags.create(tenantId, body.name, body.color);
  }

  @ApiEndpoint({
    summary: "Rename or recolor a tag",
    ok: TagRefResponse,
    notFound: true,
    conflict: true,
  })
  @Patch("tags/:tagId")
  async update(
    @TenantId() tenantId: string,
    @Param("tagId") tagId: string,
    @Body() body: UpdateTagDto,
  ): Promise<TagRef> {
    return this.tags.update(tenantId, tagId, body);
  }

  @ApiEndpoint({
    summary: "Delete a tag",
    description:
      "Removes the tag everywhere (workflows lose the chip). Idempotent.",
    ok: TagDeletedResponse,
  })
  @Delete("tags/:tagId")
  @HttpCode(200)
  async remove(
    @TenantId() tenantId: string,
    @Param("tagId") tagId: string,
  ): Promise<{ deleted: true }> {
    await this.tags.remove(tenantId, tagId);
    return { deleted: true };
  }

  @ApiEndpoint({
    summary: "Set a workflow's tags (replace-set)",
    description:
      "The workflow ends up with exactly the given tag ids (empty clears all). Tags attach tenant-wide per workflowKey — the same in every environment.",
    ok: [TagRefResponse],
  })
  @Put("graphs/:workflowKey/tags")
  async setWorkflowTags(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
    @Body() body: SetWorkflowTagsDto,
  ): Promise<TagRef[]> {
    return this.tags.setWorkflowTags(tenantId, workflowKey, body.tagIds);
  }
}

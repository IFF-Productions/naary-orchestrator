import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { EnvironmentSel, TenantId } from "../auth/tenant.decorator";
import { EnvironmentsService } from "../environments/environments.service";
import { ApiEndpoint } from "../swagger/api-decorators";
import { ContentTemplateResponse } from "./content-template.response";
import {
  type ContentTemplateInput,
  type ContentTemplateView,
  ContentTemplatesService,
} from "./content-templates.service";

/**
 * Form/Email content-templates CRUD — scoped to the ACTIVE environment (X-Environment-Id →
 * EnvironmentsService), like Variables. Referenced by id from a `sendEmail` node's `templateId`;
 * the worker loads + renders the blocks in-activity. DISTINCT from `/templates` (built-in workflow
 * starter graphs). See docs/design/TEMPLATE-EDITOR.md.
 */
@ApiBearerAuth("bearer")
@Controller("content-templates")
export class ContentTemplatesController {
  constructor(
    private readonly templates: ContentTemplatesService,
    private readonly environments: EnvironmentsService,
  ) {}

  @ApiEndpoint({
    summary: "List content templates (active environment)",
    ok: [ContentTemplateResponse],
  })
  @Get()
  async list(
    @TenantId() tenantId: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<ContentTemplateView[]> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.templates.list(tenantId, envId);
  }

  @ApiEndpoint({
    summary: "Get a content template",
    ok: ContentTemplateResponse,
  })
  @Get(":id")
  async get(
    @TenantId() tenantId: string,
    @Param("id") id: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<ContentTemplateView> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.templates.get(tenantId, envId, id);
  }

  @ApiEndpoint({
    summary: "Create a content template (active environment)",
    ok: ContentTemplateResponse,
  })
  @Post()
  async create(
    @TenantId() tenantId: string,
    @Body() body: ContentTemplateInput,
    @EnvironmentSel() envSel?: string,
  ): Promise<ContentTemplateView> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.templates.create(tenantId, envId, body);
  }

  @ApiEndpoint({
    summary: "Update a content template",
    ok: ContentTemplateResponse,
  })
  @Put(":id")
  async update(
    @TenantId() tenantId: string,
    @Param("id") id: string,
    @Body() body: ContentTemplateInput,
    @EnvironmentSel() envSel?: string,
  ): Promise<ContentTemplateView> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.templates.update(tenantId, envId, id, body);
  }

  @ApiEndpoint({ summary: "Delete a content template (active environment)" })
  @Delete(":id")
  @HttpCode(204)
  async remove(
    @TenantId() tenantId: string,
    @Param("id") id: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<void> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    await this.templates.remove(tenantId, envId, id);
  }
}

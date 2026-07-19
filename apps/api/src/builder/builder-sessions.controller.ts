import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { EnvironmentSel, TenantId } from "../auth/tenant.decorator";
import { EnvironmentsService } from "../environments/environments.service";
import { ApiEndpoint, ApiStandardErrors } from "../swagger/api-decorators";
import {
  BuilderSessionResponse,
  BuilderSessionSummaryResponse,
} from "./builder-session.response";
import { BuilderSessionsService } from "./builder-sessions.service";
import { CloseSessionDto, OpenSessionDto } from "./builder.dto";

/**
 * Conversational AI builder — session lifecycle (Slice 1). Open a session to iteratively build a
 * workflow via chat, resume it later, and close it on save or when done. The streaming edit-turn
 * endpoint (which appends turns and rewrites the working draft) lands in Slice 2. Every route is
 * scoped to the caller's active workspace + environment.
 */
@ApiBearerAuth("bearer")
@ApiStandardErrors({ notFound: true })
@Controller("builder/sessions")
export class BuilderSessionsController {
  constructor(
    private readonly sessions: BuilderSessionsService,
    private readonly environments: EnvironmentsService,
  ) {}

  @ApiEndpoint({
    summary: "Open a builder session",
    created: BuilderSessionResponse,
  })
  @Post()
  async open(
    @TenantId() tenantId: string,
    @Body() body: OpenSessionDto,
    @EnvironmentSel() envSel?: string,
  ): Promise<BuilderSessionResponse> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.sessions.open(tenantId, envId, {
      workflowKey: body?.workflowKey,
      title: body?.title,
    });
  }

  @ApiEndpoint({
    summary: "List open builder sessions (resume list)",
    ok: [BuilderSessionSummaryResponse],
  })
  @Get()
  async listOpen(
    @TenantId() tenantId: string,
  ): Promise<BuilderSessionSummaryResponse[]> {
    return this.sessions.listOpen(tenantId);
  }

  @ApiEndpoint({
    summary: "Get / resume a builder session",
    ok: BuilderSessionResponse,
  })
  @Get(":id")
  async get(
    @TenantId() tenantId: string,
    @Param("id") id: string,
  ): Promise<BuilderSessionResponse> {
    return this.sessions.get(tenantId, id);
  }

  @ApiEndpoint({
    summary: "Close a builder session",
    ok: BuilderSessionResponse,
  })
  @Post(":id/close")
  @HttpCode(200)
  async close(
    @TenantId() tenantId: string,
    @Param("id") id: string,
    @Body() body: CloseSessionDto,
  ): Promise<BuilderSessionResponse> {
    return this.sessions.close(tenantId, id, body.reason);
  }
}

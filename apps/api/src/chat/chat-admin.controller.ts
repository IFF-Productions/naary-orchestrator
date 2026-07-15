import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { EnvironmentSel } from "../auth/tenant.decorator";
import { EnvironmentsService } from "../environments/environments.service";
import { ApiEndpoint } from "../swagger/api-decorators";
import {
  ChatDeletedResponse,
  ChatEndpointResponse,
  RegisteredChatResponse,
} from "./chat.response";
import {
  type ChatEndpointView,
  type RegisteredChat,
  ChatService,
} from "./chat.service";
import { RegisterChatDto } from "./register-chat.dto";

/** Tenant-scoped management of hosted chat endpoints (the public ingress is ChatController). */
@ApiBearerAuth("bearer")
@Controller("tenants/:id/chats")
export class ChatAdminController {
  constructor(
    private readonly chats: ChatService,
    private readonly environments: EnvironmentsService,
  ) {}

  @ApiEndpoint({
    summary: "Register a hosted chat",
    description:
      "Returns the public chat path. Requires a monthly budget cap (the anonymous endpoint's spend backstop).",
    created: RegisteredChatResponse,
  })
  @Post()
  async register(
    @Param("id") tenantId: string,
    @Body() body: RegisterChatDto,
    @EnvironmentSel() envSel?: string,
  ): Promise<RegisteredChat> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.chats.createEndpoint(tenantId, envId, body.workflowId);
  }

  @ApiEndpoint({ summary: "List chat endpoints", ok: [ChatEndpointResponse] })
  @Get()
  list(@Param("id") tenantId: string): Promise<ChatEndpointView[]> {
    return this.chats.list(tenantId);
  }

  @ApiEndpoint({
    summary: "Delete a chat endpoint",
    description: "Tenant-scoped; 404 if it isn't this tenant's.",
    ok: ChatDeletedResponse,
    notFound: true,
  })
  @Delete(":chatId")
  async remove(
    @Param("id") tenantId: string,
    @Param("chatId") chatId: string,
  ): Promise<{ deleted: true }> {
    const ok = await this.chats.deleteEndpoint(tenantId, chatId);
    if (!ok) throw new NotFoundException("Chat endpoint not found");
    return { deleted: true };
  }
}

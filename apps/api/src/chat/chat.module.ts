import { Module } from "@nestjs/common";
import { ExecutionsModule } from "../executions/executions.module";
import { ChatAdminController } from "./chat-admin.controller";
import { ChatController } from "./chat.controller";
import { ChatService } from "./chat.service";

@Module({
  imports: [ExecutionsModule], // ChatController reuses ExecutionsService.startChatAwaitResponse
  // GraphsService is provided globally (@Global GraphsModule).
  controllers: [ChatController, ChatAdminController],
  providers: [ChatService],
})
export class ChatModule {}

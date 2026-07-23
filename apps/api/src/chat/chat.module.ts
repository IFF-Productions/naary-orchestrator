import { Module } from "@nestjs/common";
import { EnvironmentsModule } from "../environments/environments.module";
import { ExecutionsModule } from "../executions/executions.module";
import { TurnstileConfigModule } from "../turnstile/turnstile-config.module";
import { ChatAdminController } from "./chat-admin.controller";
import { ChatController } from "./chat.controller";
import { ChatService } from "./chat.service";

@Module({
  // TurnstileConfigModule → the bot gate on the public message + the site key on the definition.
  imports: [EnvironmentsModule, ExecutionsModule, TurnstileConfigModule], // ChatController reuses ExecutionsService.startChatAwaitResponse
  // GraphsService is provided globally (@Global GraphsModule).
  controllers: [ChatController, ChatAdminController],
  providers: [ChatService],
})
export class ChatModule {}
